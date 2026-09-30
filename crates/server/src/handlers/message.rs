//! PRIVMSG, NOTICE, TAGMSG, and client `draft/multiline` batches.

use crate::module::{Cx, MessageEvent, MsgTarget};
use crate::state::ServerState;
use crate::user::UserId;
use crate::util::{fold, format_time_ms, new_msgid};
use agent_comms_proto::{numeric, Message, Tags, TAG_VENDOR};
use std::collections::HashMap;
use std::sync::OnceLock;

/// Maximum number of targets in one comma list.
const MAX_TARGETS: usize = 4;
/// Maximum number of lines in one multiline batch.
const MAX_LINES: usize = 200;
const CONCAT_TAG: &str = "draft/multiline-concat";
/// Vendor tags that only the server sets.
const AUTHORITY_TAGS: &[&str] = &["role", "parent", "rel", "broadcast"];

/// Client multiline batch that is open.
struct PendingBatch {
    reference: String,
    target: String,
    command: Option<String>,
    tags: Tags,
    /// Label of the opening BATCH; the response to the batch carries it.
    label: Option<String>,
    /// Text and concat flag of each line.
    lines: Vec<(String, bool)>,
    count: usize,
    bytes: usize,
    invalid: bool,
}

/// Open batches, keyed by server instance and user.
type PendingMap = HashMap<(usize, UserId), PendingBatch>;

fn pending() -> &'static parking_lot::Mutex<PendingMap> {
    static PENDING: OnceLock<parking_lot::Mutex<PendingMap>> = OnceLock::new();
    PENDING.get_or_init(|| parking_lot::Mutex::new(HashMap::new()))
}

fn key(cx: &Cx<'_>, uid: UserId) -> (usize, UserId) {
    (cx.state as *const ServerState as usize, uid)
}

pub fn handle(cx: &mut Cx<'_>, uid: UserId, msg: &Message) -> bool {
    match msg.command_upper().as_str() {
        cmd @ ("PRIVMSG" | "NOTICE") => {
            if msg.has_tag("batch") {
                collect_line(cx, uid, cmd, msg);
            } else {
                send_message(cx, uid, cmd, msg);
            }
        }
        "TAGMSG" => send_message(cx, uid, "TAGMSG", msg),
        "BATCH" => batch(cx, uid, msg),
        _ => return false,
    }
    true
}

/// Client-only tags that a sender can forward.
fn client_tags(msg: &Message) -> Tags {
    msg.tags
        .iter()
        .filter(|(k, _)| {
            let Some(name) = k.strip_prefix('+') else {
                return false;
            };
            !AUTHORITY_TAGS
                .iter()
                .any(|t| name == format!("{TAG_VENDOR}/{t}"))
        })
        .cloned()
        .collect()
}

/// Client-only tags of `msg`, kept only when the sender has `message-tags`.
fn sender_tags(cx: &Cx<'_>, uid: UserId, msg: &Message) -> Tags {
    if cx
        .world
        .user(uid)
        .is_some_and(|u| u.has_cap("message-tags"))
    {
        client_tags(msg)
    } else {
        Vec::new()
    }
}

fn fail(cx: &mut Cx<'_>, uid: UserId, params: Vec<String>) {
    let mut all = vec!["BATCH".to_string()];
    all.extend(params);
    let m = Message::new("FAIL", all).with_source(cx.server_name().to_string());
    cx.send(uid, m);
}

/// Resolve one target. Sends the error numeric (not for NOTICE) and returns
/// `None` when the sender cannot send to it.
fn resolve(cx: &mut Cx<'_>, uid: UserId, cmd: &str, target: &str) -> Option<(MsgTarget, String)> {
    let quiet = cmd == "NOTICE";
    if target.starts_with('#') {
        let res = match cx.world.channels.get(&fold(target)) {
            None => Err(numeric::ERR_NOSUCHCHANNEL),
            Some(c) => {
                let member = c.members.get(&uid).copied();
                let blocked = (c.modes.no_external && member.is_none())
                    || (c.modes.moderated && !member.is_some_and(|m| m.op || m.voice));
                if blocked {
                    Err(numeric::ERR_CANNOTSENDTOCHAN)
                } else {
                    Ok(c.name.clone())
                }
            }
        };
        match res {
            Ok(name) => Some((MsgTarget::Channel(name.clone()), name)),
            Err(code) => {
                if !quiet {
                    let text = if code == numeric::ERR_NOSUCHCHANNEL {
                        "No such channel"
                    } else {
                        "Cannot send to channel"
                    };
                    cx.numeric(uid, code, vec![target.to_string(), text.into()]);
                }
                None
            }
        }
    } else {
        let found = cx
            .world
            .find_nick(target)
            .and_then(|t| cx.world.user(t).map(|u| (t, u.nick.clone())));
        match found {
            Some((t, nick)) => Some((MsgTarget::User(t), nick)),
            None => {
                if !quiet {
                    cx.numeric(
                        uid,
                        numeric::ERR_NOSUCHNICK,
                        vec![target.to_string(), "No such nick/channel".into()],
                    );
                }
                None
            }
        }
    }
}

/// Build the canonical message and send the event to the modules.
#[expect(clippy::too_many_arguments, reason = "internal helper")]
fn deliver(
    cx: &mut Cx<'_>,
    uid: UserId,
    cmd: &str,
    target: MsgTarget,
    display: String,
    text: Option<&str>,
    tags: Tags,
    lines: Vec<Message>,
) {
    let Some((source, account)) = cx.world.user(uid).map(|u| (u.source(), u.account.clone()))
    else {
        return;
    };
    let time_ms = cx.now_ms();
    let msgid = new_msgid();
    let mut m = Message::new(cmd, vec![display.clone()]).with_source(source);
    if let Some(t) = text {
        m.params.push(t.to_string());
    }
    m.tags = tags;
    m.set_tag("time", Some(format_time_ms(time_ms)));
    m.set_tag("msgid", Some(msgid.clone()));
    if let Some(a) = account {
        m.set_tag("account", Some(a));
    }

    if cmd == "PRIVMSG" {
        if let MsgTarget::User(t) = target {
            let away = cx
                .world
                .user(t)
                .and_then(|u| u.away.clone().map(|a| (u.nick.clone(), a)));
            if let Some((nick, reason)) = away {
                cx.numeric(uid, numeric::RPL_AWAY, vec![nick, reason]);
            }
        }
    }

    let ev = MessageEvent {
        sender: uid,
        command: cmd.to_string(),
        target,
        target_name: display,
        msg: m,
        lines,
        msgid,
        time_ms,
        reject: None,
    };
    crate::ops::fanout(cx, ev);
}

fn send_message(cx: &mut Cx<'_>, uid: UserId, cmd: &str, msg: &Message) {
    let quiet = cmd == "NOTICE";
    let targets = match msg.param(0) {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => {
            if !quiet {
                cx.numeric(
                    uid,
                    numeric::ERR_NORECIPIENT,
                    vec![format!("No recipient given ({cmd})")],
                );
            }
            return;
        }
    };
    let text = if cmd == "TAGMSG" {
        None
    } else {
        match msg.param(1) {
            Some(t) if !t.is_empty() => Some(t),
            _ => {
                if !quiet {
                    cx.numeric(
                        uid,
                        numeric::ERR_NOTEXTTOSEND,
                        vec!["No text to send".into()],
                    );
                }
                return;
            }
        }
    };
    if text.is_some_and(|t| t.len() > cx.config().limits.max_message_bytes) {
        if !quiet {
            cx.numeric(
                uid,
                numeric::ERR_INPUTTOOLONG,
                vec!["Input line was too long".into()],
            );
        }
        return;
    }

    let tags = sender_tags(cx, uid, msg);
    for target in targets
        .split(',')
        .filter(|t| !t.is_empty())
        .take(MAX_TARGETS)
    {
        let Some((t, display)) = resolve(cx, uid, cmd, target) else {
            continue;
        };
        deliver(cx, uid, cmd, t, display, text, tags.clone(), vec![]);
    }
}

fn batch(cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
    let Some(reference) = msg.param(0).filter(|r| r.len() > 1) else {
        cx.numeric(
            uid,
            numeric::ERR_NEEDMOREPARAMS,
            vec!["BATCH".into(), "Not enough parameters".into()],
        );
        return;
    };
    if let Some(r) = reference.strip_prefix('+') {
        open_batch(cx, uid, r, msg);
    } else if let Some(r) = reference.strip_prefix('-') {
        close_batch(cx, uid, r);
    } else {
        fail(
            cx,
            uid,
            vec!["MULTILINE_INVALID".into(), "Invalid batch reference".into()],
        );
    }
}

fn open_batch(cx: &mut Cx<'_>, uid: UserId, reference: &str, msg: &Message) {
    let kind = msg.param(1).unwrap_or("");
    if kind != "draft/multiline" {
        fail(
            cx,
            uid,
            vec![
                "UNKNOWN_TYPE".into(),
                kind.to_string(),
                "Unsupported batch type".into(),
            ],
        );
        return;
    }
    let Some(target) = msg.param(2).filter(|t| !t.is_empty() && !t.contains(',')) else {
        fail(
            cx,
            uid,
            vec![
                "MULTILINE_INVALID".into(),
                "Invalid multiline batch target".into(),
            ],
        );
        return;
    };
    // The response to a labeled BATCH comes when the batch closes, so the
    // opening command itself gets no ACK.
    let label = msg.tag("label").filter(|l| !l.is_empty()).and_then(|l| {
        let u = cx.world.user_mut(uid)?;
        if !u.has_cap("labeled-response") || u.label.as_deref() != Some(l) {
            return None;
        }
        if u.label_buf.as_ref().is_some_and(|b| !b.is_empty()) {
            return None;
        }
        u.label = None;
        u.label_buf = None;
        Some(l.to_string())
    });
    let tags = sender_tags(cx, uid, msg);
    let k = key(cx, uid);
    pending().lock().insert(
        k,
        PendingBatch {
            reference: reference.to_string(),
            target: target.to_string(),
            command: None,
            tags,
            label,
            lines: Vec::new(),
            count: 0,
            bytes: 0,
            invalid: false,
        },
    );
}

fn collect_line(cx: &mut Cx<'_>, uid: UserId, cmd: &str, msg: &Message) {
    let reference = msg.tag("batch").unwrap_or("");
    let max = cx.config().limits.max_message_bytes;
    let k = key(cx, uid);
    let mut map = pending().lock();
    let Some(p) = map.get_mut(&k).filter(|p| p.reference == reference) else {
        drop(map);
        fail(
            cx,
            uid,
            vec!["MULTILINE_INVALID".into(), "Unknown batch reference".into()],
        );
        return;
    };
    let target_ok = msg.param(0).is_some_and(|t| fold(t) == fold(&p.target));
    let cmd_ok = !matches!(p.command.as_deref(), Some(c) if c != cmd);
    if !target_ok || !cmd_ok {
        p.invalid = true;
        return;
    }
    let text = msg.param(1).unwrap_or("");
    let concat = msg.has_tag(CONCAT_TAG);
    if concat && text.is_empty() {
        p.invalid = true;
        return;
    }
    if p.command.is_none() {
        p.command = Some(cmd.to_string());
        let extra = if cx
            .world
            .user(uid)
            .is_some_and(|u| u.has_cap("message-tags"))
        {
            client_tags(msg)
        } else {
            Vec::new()
        };
        for (k, v) in extra {
            if !p.tags.iter().any(|(t, _)| *t == k) {
                p.tags.push((k, v));
            }
        }
    }
    if p.count > 0 && !concat {
        p.bytes += 1;
    }
    p.bytes += text.len();
    p.count += 1;
    // Stop storing text after a limit is exceeded; the close reports it.
    if p.count <= MAX_LINES && p.bytes <= max {
        p.lines.push((text.to_string(), concat));
    }
}

fn close_batch(cx: &mut Cx<'_>, uid: UserId, reference: &str) {
    let k = key(cx, uid);
    let p = {
        let mut map = pending().lock();
        if map.get(&k).is_some_and(|p| p.reference == reference) {
            map.remove(&k)
        } else {
            None
        }
    };
    let Some(p) = p else {
        fail(
            cx,
            uid,
            vec!["MULTILINE_INVALID".into(), "Unknown batch reference".into()],
        );
        return;
    };
    // Collect the response under the label of the opening BATCH.
    let label = p.label.clone().filter(|_| {
        cx.world
            .user(uid)
            .is_some_and(|u| u.label_buf.is_none() && u.has_cap("labeled-response"))
    });
    if let Some(l) = &label {
        if let Some(u) = cx.world.user_mut(uid) {
            u.label = Some(l.clone());
            u.label_buf = Some(Vec::new());
        }
    }
    finish_batch(cx, uid, p);
    if let Some(l) = label {
        crate::ops::flush_label(cx, uid, l);
    }
}

fn finish_batch(cx: &mut Cx<'_>, uid: UserId, p: PendingBatch) {
    let max = cx.config().limits.max_message_bytes;
    let cmd = match (&p.command, p.invalid) {
        (Some(c), false) => c.clone(),
        _ => {
            fail(
                cx,
                uid,
                vec!["MULTILINE_INVALID".into(), "Invalid multiline batch".into()],
            );
            return;
        }
    };
    if p.count > MAX_LINES {
        fail(
            cx,
            uid,
            vec![
                "MULTILINE_MAX_LINES".into(),
                MAX_LINES.to_string(),
                "Too many lines in multiline batch".into(),
            ],
        );
        return;
    }
    if p.bytes > max {
        fail(
            cx,
            uid,
            vec![
                "MULTILINE_MAX_BYTES".into(),
                max.to_string(),
                "Multiline batch is too long".into(),
            ],
        );
        return;
    }
    if p.lines.iter().all(|(t, _)| t.is_empty()) {
        fail(
            cx,
            uid,
            vec![
                "MULTILINE_INVALID".into(),
                "Multiline batch has no text".into(),
            ],
        );
        return;
    }

    let Some((target, display)) = resolve(cx, uid, &cmd, &p.target) else {
        return;
    };
    let first = p
        .lines
        .iter()
        .map(|(t, _)| t)
        .find(|t| !t.is_empty())
        .cloned()
        .unwrap_or_default();
    let lines: Vec<Message> = if p.lines.len() > 1 {
        p.lines
            .iter()
            .map(|(text, concat)| {
                let mut m = Message::new(cmd.as_str(), vec![display.clone(), text.clone()]);
                if *concat {
                    m.set_tag(CONCAT_TAG, None);
                }
                m
            })
            .collect()
    } else {
        Vec::new()
    };
    deliver(cx, uid, &cmd, target, display, Some(&first), p.tags, lines);
}
