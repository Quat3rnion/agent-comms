//! SEND (section 7): inner client commands of a link account, SENT/SENDFAIL
//! acknowledgements, and delivery cursor updates (section 4.3).

use super::{LinkCtx, LinkShared};
use crate::handlers;
use crate::module::{Cx, Flow, MessageEvent};
use crate::ops;
use crate::state::SharedState;
use crate::user::{Sink, UserId};
use crate::util::unix_now;
use agent_comms_proto::{Limits, Message};
use std::sync::Arc;

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
