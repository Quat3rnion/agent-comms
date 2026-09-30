//! Server burst (section 4.2): `BURST`, extension lines, replay (section 4.3),
//! `ENDBURST`, then attach the link handle to the accounts of the link.

use super::{LinkCtx, LinkShared};
use crate::module::Cx;
use crate::modules::authority::relation;
use crate::modules::history::render_stored;
use crate::state::SharedState;
use crate::store::{Store, StoredMessage};
use crate::user::{Outbound, Role};
use crate::util::fold;
use agent_comms_proto::{vendor_tag, Message};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

/// Maximum number of stored messages replayed for one account in one query.
const REPLAY_CHUNK: usize = 500;
/// The final replay step runs under the world lock without backpressure. It
/// runs only when the pending lines fit in this part of the free queue space.
const FINAL_SHARE: usize = 2;
/// Maximum number of replay passes with backpressure.
const MAX_PASSES: usize = 8;

/// Send the server burst to the link and attach the link to its accounts.
///
/// The replay has backpressure: most of it is queued outside the world lock,
/// and each line waits for space in the link queue. The accounts of the link
/// are not attached yet, so no live fan-out comes between the lines, and
/// messages stored meanwhile are pending for the next replay step. The last
/// step (the rest of the replay, `ENDBURST`, and attach) holds the world lock,
/// so that no message is stored between the replay and the attach.
pub async fn server_burst(shared: &Arc<LinkShared>, state: &SharedState, ctx: &mut LinkCtx) {
    // Extensions lock the world themselves: collect their lines first.
    let ext_lines: Vec<Message> = shared
        .hub
        .extensions()
        .iter()
        .flat_map(|e| e.burst_lines(state))
        .collect();
    let operator = state
        .secrets
        .read()
        .operator
        .as_ref()
        .map(|o| o.account.clone());

    let link_name = ctx.entry.name.clone();
    let mut seen = HashSet::new();
    let accounts: Vec<String> = ctx
        .accounts
        .iter()
        .filter(|a| seen.insert(fold(a)))
        .filter(|a| shared.hub.is_attached(a, &link_name))
        .cloned()
        .collect();
    // Replay only for accounts that no other live link serves: another live
    // link already got the messages (the delivery cursor is per account).
    let to_replay: Vec<String> = accounts
        .iter()
        .filter(|a| !shared.hub.has_other_live(a, &link_name))
        .cloned()
        .collect();

    let out = ctx.entry.handle.tx.clone();
    let stall = Duration::from_secs(state.config.limits.link_timeout_secs.max(1));
    let send = |m: Message| {
        let out = out.clone();
        async move { out.send_line_wait(&m.to_line(), stall).await }
    };

    if !send(Message::new("BURST", Vec::new())).await {
        return;
    }
    for line in ext_lines {
        if !send(line).await {
            return;
        }
    }

    let store = shared.hub.store().cloned();
    let mut batch = ReplayBatch {
        id: state.with_world(|cx| format!("r{}", cx.world.batch_id())),
        opened: false,
    };
    if let Some(store) = &store {
        for _ in 0..MAX_PASSES {
            // Lines replayed in this pass: an estimate of the lines that
            // arrive during the next pass.
            let mut replayed = 0;
            for account in &to_replay {
                if shared.hub.has_other_live(account, &link_name) {
                    continue;
                }
                let op = operator.as_deref();
                match replay_account(state, store, &out, &mut batch, account, op, stall).await {
                    Some(n) => replayed += n,
                    None => return,
                }
            }
            // Stop when the rest fits in the queue without waiting.
            if replayed == 0 || out.free() / FINAL_SHARE > replayed {
                break;
            }
        }
    }

    let hub = shared.hub.clone();
    state.with_world(|cx| {
        if let Some(store) = &store {
            // Check again under the world lock: another link can have gone
            // down (or come up) during the replay passes.
            let last: Vec<String> = accounts
                .iter()
                .filter(|a| !hub.has_other_live(a, &link_name))
                .cloned()
                .collect();
            replay_final(cx, store, ctx, &mut batch, &last, operator.as_deref());
        }
        if batch.opened {
            ctx.send(&Message::new("BATCH", vec![format!("-{}", batch.id)]));
        }

        ctx.send(&Message::new("ENDBURST", Vec::new()));

        for account in &accounts {
            let Some(uid) = cx.world.find_account(account) else {
                continue;
            };
            if hub.set_live(account, &link_name) {
                super::accounts::sync_account(cx, &hub, uid, account);
            }
        }
    });

    shared.hub.set_established(&ctx.entry.name, true);
}

/// The replay batch of one server burst.
struct ReplayBatch {
    id: String,
    opened: bool,
}

impl ReplayBatch {
    /// `BATCH +<id>` when the batch is not open yet.
    fn open_line(&mut self) -> Option<Message> {
        if self.opened {
            return None;
        }
        self.opened = true;
        Some(Message::new(
            "BATCH",
            vec![
                format!("+{}", self.id),
                "agent-comms.local/replay".to_string(),
            ],
        ))
    }

    fn deliver(&self, account: &str, inner: &Message) -> Message {
        Message::new("DELIVER", vec![account.to_string(), inner.to_line()])
            .with_tag("batch", Some(self.id.clone()))
    }
}

/// Replay the pending messages of `account` with backpressure, in chunks,
/// until none is pending. The cursor moves after the lines of each message
/// are queued. Returns the number of queued lines, or `None` when the link
/// closed.
async fn replay_account(
    state: &SharedState,
    store: &Store,
    out: &Outbound,
    batch: &mut ReplayBatch,
    account: &str,
    operator: Option<&str>,
    stall: Duration,
) -> Option<usize> {
    let mut queued = 0;
    loop {
        let (rows, last_seq) = match pending(store, account, REPLAY_CHUNK) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(account = %account, error = %e, "replay: store read failed");
                return Some(queued);
            }
        };
        let Some(last_seq) = last_seq else {
            return Some(queued);
        };
        let rendered = state.with_world(|cx| render(cx, &rows, account, operator));
        for (seq, lines) in rendered {
            for inner in lines {
                if let Some(open) = batch.open_line() {
                    if !out.send_line_wait(&open.to_line(), stall).await {
                        return None;
                    }
                }
                let line = batch.deliver(account, &inner).to_line();
                if !out.send_line_wait(&line, stall).await {
                    return None;
                }
                queued += 1;
            }
            set_cursor(store, account, seq);
        }
        // Rows that are not PRIVMSG or NOTICE are skipped, but the cursor
        // moves past them.
        set_cursor(store, account, last_seq);
    }
}

/// Last replay step, under the world lock: queue what is still pending
/// without waiting. When a line is dropped, the link is closing and the
/// cursor stays, so the next burst replays the message again.
fn replay_final(
    cx: &mut Cx<'_>,
    store: &Store,
    ctx: &LinkCtx,
    batch: &mut ReplayBatch,
    accounts: &[String],
    operator: Option<&str>,
) {
    for account in accounts {
        loop {
            let (rows, last_seq) = match pending(store, account, REPLAY_CHUNK) {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!(account = %account, error = %e, "replay: store read failed");
                    break;
                }
            };
            let Some(last_seq) = last_seq else {
                break;
            };
            for (seq, lines) in render(cx, &rows, account, operator) {
                for inner in lines {
                    if let Some(open) = batch.open_line() {
                        ctx.send(&open);
                    }
                    if !ctx
                        .entry
                        .handle
                        .tx
                        .send_line(&batch.deliver(account, &inner).to_line())
                    {
                        return;
                    }
                }
                set_cursor(store, account, seq);
            }
            set_cursor(store, account, last_seq);
        }
    }
}

/// Inner lines of each stored message, with the authority tags for the
/// recipient `account`.
fn render(
    cx: &Cx<'_>,
    rows: &[StoredMessage],
    account: &str,
    operator: Option<&str>,
) -> Vec<(i64, Vec<Message>)> {
    let server_name = cx.server_name().to_string();
    rows.iter()
        .map(|stored| {
            let mut lines = render_stored(stored, &server_name, None);
            for inner in &mut lines {
                if carries_message_tags(inner) {
                    set_authority_tags(cx, inner, stored, account, operator);
                }
            }
            (stored.seq, lines)
        })
        .collect()
}

fn set_cursor(store: &Store, account: &str, seq: i64) {
    if let Err(e) = store.set_cursor(account, seq) {
        tracing::warn!(account = %account, error = %e, "replay: cursor update failed");
    }
}

/// Up to `limit` stored messages after the delivery cursor of `account`, in
/// `seq` order: the PRIVMSG and NOTICE messages (same selection as
/// `history::replay_lines_with`), and the `seq` of the last row read (`None`
/// when nothing is pending).
fn pending(
    store: &Store,
    account: &str,
    limit: usize,
) -> crate::store::StoreResult<(Vec<StoredMessage>, Option<i64>)> {
    let cursor = store.get_cursor(account)?;
    let rows = store.replay_for(account, cursor, limit)?;
    let last = rows.last().map(|m| m.seq);
    let rows = rows
        .into_iter()
        .filter(|m| m.command == "PRIVMSG" || m.command == "NOTICE")
        .collect();
    Ok((rows, last))
}

/// True for the line that holds the message tags: a single message line, or
/// the opening line of a `draft/multiline` batch.
fn carries_message_tags(m: &Message) -> bool {
    match m.command_upper().as_str() {
        "PRIVMSG" | "NOTICE" | "TAGMSG" => m.tag("batch").is_none(),
        "BATCH" => m.params.first().is_some_and(|p| p.starts_with('+')),
        _ => false,
    }
}

/// Set `role`, `parent`, and `rel` of a replayed line for the recipient
/// `account` (section 7.3).
fn set_authority_tags(
    cx: &Cx<'_>,
    m: &mut Message,
    stored: &StoredMessage,
    account: &str,
    operator: Option<&str>,
) {
    let role_key = vendor_tag("role");
    let parent_key = vendor_tag("parent");
    let rel_key = vendor_tag("rel");
    let world = &*cx.world;
    let recipient = world.find_account(account);
    let sender = stored
        .sender_account
        .as_deref()
        .and_then(|a| world.find_account(a))
        .and_then(|uid| world.user(uid).map(|u| (uid, u)));

    match sender {
        Some((uid, u)) => {
            let role = if u.role == Role::Operator {
                "operator"
            } else {
                "agent"
            };
            m.set_tag(&role_key, Some(role.to_string()));
            match u.parent.and_then(|p| world.user(p)) {
                Some(p) => m.set_tag(&parent_key, Some(p.nick.clone())),
                None => m.remove_tag(&parent_key),
            }
            let rel = match recipient {
                Some(r) => relation(world, uid, r),
                None if role == "operator" => "operator",
                None => "peer",
            };
            m.set_tag(&rel_key, Some(rel.to_string()));
        }
        None => {
            let is_operator = match (stored.sender_account.as_deref(), operator) {
                (Some(a), Some(op)) => fold(a) == fold(op),
                _ => false,
            };
            if m.tag(&role_key).is_none() || is_operator {
                let role = if is_operator { "operator" } else { "agent" };
                m.set_tag(&role_key, Some(role.to_string()));
            }
            let rel = if m.tag(&role_key) == Some("operator") {
                "operator"
            } else {
                "peer"
            };
            m.set_tag(&rel_key, Some(rel.to_string()));
        }
    }
}
