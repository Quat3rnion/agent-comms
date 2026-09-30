//! Server burst (section 4.2): `BURST`, extension lines, replay (section 4.3),
//! `ENDBURST`, then attach the link handle to the accounts of the link.

use super::{LinkCtx, LinkShared};
use crate::module::Cx;
use crate::modules::authority::relation;
use crate::modules::history::render_stored;
use crate::state::SharedState;
use crate::store::{Store, StoredMessage};
use crate::user::{Role, Sink};
use crate::util::fold;
use agent_comms_proto::{vendor_tag, Message};
use std::collections::HashSet;
use std::sync::Arc;

/// Maximum number of stored messages replayed for one account.
const REPLAY_LIMIT: usize = 10_000;

/// Send the server burst to the link and attach the link to its accounts.
pub fn server_burst(shared: &Arc<LinkShared>, state: &SharedState, ctx: &mut LinkCtx) {
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

    let mut seen = HashSet::new();
    let accounts: Vec<String> = ctx
        .accounts
        .iter()
        .filter(|a| seen.insert(fold(a)))
        .cloned()
        .collect();

    // Hold the world lock so that no live fan-out can come between the lines.
    state.with_world(|cx| {
        ctx.send(&Message::new("BURST", Vec::new()));
        for line in &ext_lines {
            ctx.send(line);
        }

        if let Some(store) = shared.hub.store() {
            replay(cx, store, ctx, &accounts, operator.as_deref());
        }

        ctx.send(&Message::new("ENDBURST", Vec::new()));

        for account in &accounts {
            let Some(uid) = cx.world.find_account(account) else {
                continue;
            };
            let dormant = match cx.world.user_mut(uid) {
                Some(u) => {
                    u.sink = Sink::Virtual {
                        account: account.clone(),
                        link: Some(ctx.entry.handle.clone()),
                    };
                    u.away.as_deref() == Some("dormant")
                }
                None => false,
            };
            if dormant {
                crate::ops::set_away(cx, uid, Some("idle".to_string()));
            }
        }
    });

    shared.hub.set_established(&ctx.entry.name, true);
}

/// Write the replay batch for `accounts` and advance their delivery cursors.
fn replay(
    cx: &mut Cx<'_>,
    store: &Store,
    ctx: &LinkCtx,
    accounts: &[String],
    operator: Option<&str>,
) {
    let id = format!("r{}", cx.world.batch_id());
    let server_name = cx.server_name().to_string();
    let mut opened = false;

    for account in accounts {
        let rows = match pending(store, account) {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!(account = %account, error = %e, "replay: store read failed");
                continue;
            }
        };
        for stored in rows {
            let lines = render_stored(&stored, &server_name, None);
            for mut inner in lines {
                if carries_message_tags(&inner) {
                    set_authority_tags(cx, &mut inner, &stored, account, operator);
                }
                if !opened {
                    ctx.send(&Message::new(
                        "BATCH",
                        vec![format!("+{id}"), "agent-comms.local/replay".to_string()],
                    ));
                    opened = true;
                }
                let deliver = Message::new("DELIVER", vec![account.clone(), inner.to_line()])
                    .with_tag("batch", Some(id.clone()));
                ctx.send(&deliver);
            }
            if let Err(e) = store.set_cursor(account, stored.seq) {
                tracing::warn!(account = %account, error = %e, "replay: cursor update failed");
            }
        }
    }

    if opened {
        ctx.send(&Message::new("BATCH", vec![format!("-{id}")]));
    }
}

/// Stored PRIVMSG and NOTICE messages after the delivery cursor of `account`,
/// in `seq` order (same selection as `history::replay_lines_with`).
fn pending(store: &Store, account: &str) -> crate::store::StoreResult<Vec<StoredMessage>> {
    let cursor = store.get_cursor(account)?;
    Ok(store
        .replay_for(account, cursor, REPLAY_LIMIT)?
        .into_iter()
        .filter(|m| m.command == "PRIVMSG" || m.command == "NOTICE")
        .collect())
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
