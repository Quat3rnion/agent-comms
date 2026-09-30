//! SEND (section 7): inner client commands of a link account, SENT/SENDFAIL
//! acknowledgements, and delivery cursor updates (section 4.3).

use super::{LinkCtx, LinkShared};
use crate::flood::TokenBucket;
use crate::handlers;
use crate::module::{Cx, Flow, MessageEvent};
use crate::ops;
use crate::state::SharedState;
use crate::user::{Sink, UserId};
use crate::util::unix_now;
use agent_comms_proto::{Limits, Message};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Flood state entries unused for this time are removed.
const FLOOD_IDLE: Duration = Duration::from_secs(600);

/// Maximum open multiline batches that one link can have.
const MAX_OPEN_BATCHES: usize = 64;

/// SEND flood state of one link (section 7.2, code FLOOD).
pub struct LinkFlood {
    /// One token for each SEND line.
    bucket: TokenBucket,
    last: Instant,
    /// Open multiline batches: (folded account, reference) to true when the
    /// opening line was accepted, false when it was refused.
    batches: HashMap<(String, String), bool>,
}

/// SEND flood state of one account: one token for each message and query.
pub struct AccountFlood {
    bucket: TokenBucket,
    last: Instant,
}

/// Flood-control class of one inner line.
#[derive(Clone, Copy)]
enum Line<'a> {
    /// Standalone PRIVMSG, NOTICE or TAGMSG.
    Message,
    /// Query command.
    Query,
    /// `BATCH +<ref> draft/multiline ...`.
    Open(&'a str),
    /// Message line inside a multiline batch.
    Part(&'a str),
    /// `BATCH -<ref>`.
    Close(&'a str),
}

enum Verdict {
    /// Run the line.
    Pass,
    /// Do not run the line and send no reply.
    Drop,
    /// Do not run the line and reply with code FLOOD.
    Flood,
}

/// Charge the link and account buckets for one inner line.
///
/// Each SEND line costs one link token. Each message and query costs one
/// account token; a multiline batch costs one account token at its opening
/// line. Lines inside, and the closing line of, an accepted batch are never
/// refused, so that the batch stays whole. When the opening line of a batch is
/// refused, the server drops its message lines and sends one SENDFAIL FLOOD at
/// the closing line.
fn check_flood(shared: &LinkShared, link: &str, account: &str, line: Line<'_>) -> Verdict {
    let limits = &shared.config.limits;
    let now = Instant::now();
    let folded = crate::util::fold(account);

    let mut links = shared.link_flood.lock();
    if !links.contains_key(link) {
        links.retain(|_, f| now.duration_since(f.last) <= FLOOD_IDLE);
        links.insert(
            link.to_string(),
            LinkFlood {
                bucket: TokenBucket::new(limits.link_flood_burst, limits.link_flood_rate_per_sec),
                last: now,
                batches: HashMap::new(),
            },
        );
    }
    let Some(lf) = links.get_mut(link) else {
        return Verdict::Pass;
    };
    lf.last = now;

    let reference = match line {
        Line::Part(r) | Line::Close(r) => {
            let close = matches!(line, Line::Close(_));
            let key = (folded, r.to_string());
            let known = if close {
                lf.batches.remove(&key)
            } else {
                lf.batches.get(&key).copied()
            };
            return match known {
                Some(accepted) => {
                    let _ = lf.bucket.take();
                    match (accepted, close) {
                        (true, _) => Verdict::Pass,
                        (false, true) => Verdict::Flood,
                        (false, false) => Verdict::Drop,
                    }
                }
                None if lf.bucket.try_take() => Verdict::Pass,
                None if close => Verdict::Flood,
                None => Verdict::Drop,
            };
        }
        Line::Open(r) => Some(r),
        Line::Message | Line::Query => None,
    };

    let accepted = lf.bucket.try_take() && {
        let mut accounts = shared.account_flood.lock();
        if !accounts.contains_key(&folded) {
            accounts.retain(|_, f| now.duration_since(f.last) <= FLOOD_IDLE);
            accounts.insert(
                folded.clone(),
                AccountFlood {
                    bucket: TokenBucket::new(
                        limits.account_flood_burst,
                        limits.account_flood_rate_per_sec,
                    ),
                    last: now,
                },
            );
        }
        accounts.get_mut(&folded).is_some_and(|af| {
            af.last = now;
            af.bucket.try_take()
        })
    };

    match reference {
        Some(r) => {
            if lf.batches.len() >= MAX_OPEN_BATCHES {
                lf.batches.clear();
            }
            lf.batches.insert((folded, r.to_string()), accepted);
            if accepted {
                Verdict::Pass
            } else {
                Verdict::Drop
            }
        }
        None if accepted => Verdict::Pass,
        None => Verdict::Flood,
    }
}

/// Inner commands that a link can send for an account.
const ALLOWED: &[&str] = &[
    "PRIVMSG",
    "NOTICE",
    "TAGMSG",
    "JOIN",
    "PART",
    "TOPIC",
    "NAMES",
    "WHO",
    "WHOIS",
    "CHATHISTORY",
    "MARKREAD",
    "BATCH",
];

/// How the server runs one inner line.
enum Kind {
    /// A message (or the closing line of a multiline batch): one SENT or
    /// SENDFAIL.
    Message,
    /// A line inside a multiline batch, or the opening line: no ack.
    BatchPart,
    /// A query command: replies come in DELIVER lines, with labeled-response.
    Query,
}

/// `SEND <account> :<inner line>`.
pub fn handle(shared: &Arc<LinkShared>, state: &SharedState, ctx: &mut LinkCtx, msg: &Message) {
    let (Some(account), Some(line)) = (msg.param(0), msg.param(1)) else {
        ctx.fail(
            msg,
            "INVALID_PARAMS",
            &[],
            "SEND needs an account and a line",
        );
        return;
    };
    let account = account.to_string();
    let uid = state.with_world(|cx| cx.world.find_account(&account));
    let Some(uid) = uid.filter(|_| ctx.owns(shared, &account)) else {
        ctx.fail(
            msg,
            "UNKNOWN_ACCOUNT",
            &[&account],
            "No such account on this link",
        );
        return;
    };

    let mut inner = match Message::parse_with(line, Limits::LINK) {
        Ok(m) => m,
        Err(e) => {
            ctx.fail(
                msg,
                "INVALID_LINE",
                &[&account],
                &format!("Invalid inner line: {e}"),
            );
            return;
        }
    };
    let cmd = inner.command_upper();
    inner.command = cmd.clone();
    if !ALLOWED.contains(&cmd.as_str()) {
        ctx.fail(
            msg,
            "FORBIDDEN_COMMAND",
            &[&account],
            &format!("{cmd} is not allowed in SEND"),
        );
        return;
    }
    inner.source = None;
    inner.tags.retain(|(k, _)| {
        k.starts_with('+') || k == "label" || k == "batch" || k == "draft/multiline-concat"
    });

    let kind = match cmd.as_str() {
        "BATCH" => {
            let reference = inner.param(0).unwrap_or("");
            if reference.len() > 1 && reference.starts_with('-') && inner.params.len() == 1 {
                Kind::Message
            } else if reference.len() > 1
                && reference.starts_with('+')
                && inner.param(1) == Some("draft/multiline")
                && inner.param(2).is_some_and(|t| !t.is_empty())
            {
                Kind::BatchPart
            } else {
                ctx.fail(
                    msg,
                    "FORBIDDEN_COMMAND",
                    &[&account],
                    "Only draft/multiline batches are allowed in SEND",
                );
                return;
            }
        }
        "PRIVMSG" | "NOTICE" | "TAGMSG" if inner.has_tag("batch") => Kind::BatchPart,
        "PRIVMSG" | "NOTICE" | "TAGMSG" => Kind::Message,
        _ => Kind::Query,
    };

    let line_kind = match cmd.as_str() {
        "BATCH" => {
            let reference = inner.param(0).unwrap_or("");
            match reference.strip_prefix('+') {
                Some(r) => Line::Open(r),
                None => Line::Close(reference.get(1..).unwrap_or("")),
            }
        }
        _ => match (&kind, inner.tag("batch")) {
            (Kind::BatchPart, Some(r)) => Line::Part(r),
            (Kind::Query, _) => Line::Query,
            _ => Line::Message,
        },
    };
    match check_flood(shared, &ctx.entry.name, &account, line_kind) {
        Verdict::Pass => {}
        Verdict::Drop => return,
        Verdict::Flood => {
            if let Kind::Query = kind {
                ctx.fail(msg, "FLOOD", &[&account], "too many requests");
            } else {
                ctx.reply(
                    msg,
                    sendfail(&account, "FLOOD", "too many messages; slow down"),
                );
            }
            return;
        }
    }

    if let Some(store) = shared.hub.store() {
        let _ = store.touch(&account, unix_now());
    }

    match kind {
        Kind::Query => ops::dispatch_as(state, uid, inner),
        Kind::BatchPart => {
            // Labels have no effect on message lines (section 7.2).
            inner.remove_tag("label");
            ops::dispatch_as(state, uid, inner);
        }
        Kind::Message => {
            inner.remove_tag("label");
            let max = state.config.limits.max_message_bytes;
            let too_long = matches!(cmd.as_str(), "PRIVMSG" | "NOTICE")
                && inner.param(1).is_some_and(|t| t.len() > max);
            let reply = if too_long {
                sendfail(&account, "TOOLONG", "Message is too long")
            } else {
                capture(shared, state, uid, &account, &inner)
            };
            ctx.reply(msg, reply);
        }
    }
}

/// Run a message command for `uid` and collect the replies to the sender.
/// Returns the SENT or SENDFAIL line.
fn capture(
    shared: &Arc<LinkShared>,
    state: &SharedState,
    uid: UserId,
    account: &str,
    inner: &Message,
) -> Message {
    let result = state.with_world(|cx| {
        let u = cx.world.user_mut(uid)?;
        // The buffer collects every reply to the sender while the command
        // runs; without an inner label, no handler flushes it.
        let saved = u.label_buf.replace(Vec::new());
        shared.captured.lock().remove(&uid);

        let st = cx.state;
        let mut handled = false;
        for module in &st.modules {
            if let Flow::Handled = module.on_command(cx, uid, inner) {
                handled = true;
                break;
            }
        }
        if !handled {
            handlers::dispatch(cx, uid, inner);
        }

        let buf = match cx.world.user_mut(uid) {
            Some(u) => std::mem::replace(&mut u.label_buf, saved).unwrap_or_default(),
            None => Vec::new(),
        };
        let msgid = shared.captured.lock().remove(&uid);

        let mut error = None;
        for m in buf {
            match classify(&m) {
                Some(e) => {
                    if error.is_none() {
                        error = Some(e);
                    }
                }
                None => cx.world.send_to(uid, &m),
            }
        }
        Some((error, msgid))
    });

    match result {
        None => sendfail(account, "INVALID", "No such account"),
        Some((Some((code, reason)), _)) => sendfail(account, code, &reason),
        Some((None, Some(msgid))) => Message::new("SENT", vec![account.to_string(), msgid]),
        Some((None, None)) => sendfail(account, "INVALID", "message not sent"),
    }
}

fn sendfail(account: &str, code: &str, reason: &str) -> Message {
    Message::new(
        "SENDFAIL",
        vec![account.to_string(), code.to_string(), reason.to_string()],
    )
}

/// SENDFAIL code and reason for an error reply, or None for other lines.
fn classify(m: &Message) -> Option<(&'static str, String)> {
    let reason = m.params.last().cloned().unwrap_or_default();
    if m.command == "FAIL" {
        let code = match (m.param(0), m.param(1)) {
            (_, Some("BROADCASTDENIED")) => "BROADCASTDENIED",
            (Some("BATCH"), Some("MULTILINE_MAX_BYTES")) => "TOOLONG",
            _ => "INVALID",
        };
        return Some((code, reason));
    }
    let numeric = m.command.len() == 3 && m.command.bytes().all(|b| b.is_ascii_digit());
    if !numeric || !(m.command.starts_with('4') || m.command.starts_with('5')) {
        return None;
    }
    let code = match m.command.as_str() {
        "401" => "NOSUCHNICK",
        "403" => "NOSUCHCHANNEL",
        "404" => "CANNOTSEND",
        "417" => "TOOLONG",
        _ => "INVALID",
    };
    Some((code, reason))
}

/// Record the msgid of a message that a virtual user sends.
pub fn on_message(shared: &Arc<LinkShared>, cx: &mut Cx<'_>, ev: &mut MessageEvent) {
    let is_virtual = cx
        .world
        .user(ev.sender)
        .is_some_and(|u| matches!(u.sink, Sink::Virtual { .. }));
    if is_virtual {
        shared.captured.lock().insert(ev.sender, ev.msgid.clone());
    }
}

/// Move the delivery cursor of each connected link account that got the
/// message (section 4.3). Dormant accounts keep their cursor, so the message
/// is replayed later.
pub fn on_stored(
    shared: &Arc<LinkShared>,
    cx: &mut Cx<'_>,
    ev: &MessageEvent,
    recipients: &[UserId],
) {
    if ev.command != "PRIVMSG" && ev.command != "NOTICE" {
        return;
    }
    let Some(store) = shared.hub.store() else {
        return;
    };
    let accounts: Vec<String> = recipients
        .iter()
        .filter_map(|r| match cx.world.user(*r).map(|u| &u.sink) {
            Some(Sink::Virtual {
                account,
                link: Some(_),
            }) => Some(account.clone()),
            _ => None,
        })
        .collect();
    if accounts.is_empty() {
        return;
    }
    let seq = match store.seq_by_msgid(&ev.msgid) {
        Ok(Some(seq)) => seq,
        Ok(None) => return,
        Err(e) => {
            tracing::warn!(msgid = %ev.msgid, error = %e, "link: cannot find stored message");
            return;
        }
    };
    // Deferred, in one statement loop: this runs under the world lock.
    if let Err(e) = store.set_cursors(&accounts, seq) {
        tracing::warn!(error = %e, "link: cannot set delivery cursors");
    }
}
