//! World operations that notify users and call module hooks.

use crate::channel::{Channel, MemberModes};
use crate::handlers;
use crate::module::{Cx, Flow, MessageEvent, MsgTarget};
use crate::state::SharedState;
use crate::user::{Sink, UserId};
use crate::util::{fold, unix_now, valid_nick};
use agent_comms_proto::Message;
use std::collections::BTreeSet;

/// Add a user to a channel. Creates the channel (with the user as operator)
/// if it does not exist. Returns false when the user is already a member or
/// does not exist.
pub fn join(cx: &mut Cx<'_>, uid: UserId, chan: &str, notify_self: bool) -> bool {
    let key = fold(chan);
    let Some(source) = cx.world.user(uid).map(|u| u.source()) else {
        return false;
    };
    if cx
        .world
        .channels
        .get(&key)
        .is_some_and(|c| c.is_member(uid))
    {
        return false;
    }
    let channel = cx
        .world
        .channels
        .entry(key.clone())
        .or_insert_with(|| Channel::new(chan, unix_now()));
    let first = channel.members.is_empty();
    channel.members.insert(
        uid,
        MemberModes {
            op: first,
            voice: false,
        },
    );
    let display = channel.name.clone();
    if let Some(u) = cx.world.user_mut(uid) {
        u.channels.insert(key.clone());
    }

    let m = Message::new("JOIN", vec![display.clone()]).with_source(source.clone());
    for member in cx.world.channel_members(&key) {
        if member != uid || notify_self {
            cx.send(member, m.clone());
        }
    }
    let away = cx.world.user(uid).and_then(|u| u.away.clone());
    if let Some(reason) = away {
        let a = Message::new("AWAY", vec![reason]).with_source(source);
        for member in cx.world.channel_members(&key) {
            if member != uid
                && cx
                    .world
                    .user(member)
                    .is_some_and(|p| p.has_cap("away-notify"))
            {
                cx.send(member, a.clone());
            }
        }
    }
    let state = cx.state;
    for module in &state.modules {
        module.on_join(cx, uid, &display);
    }
    true
}

/// Remove a user from a channel. Sends PART to all members, the user too.
/// Returns false when the user is not a member.
pub fn part(cx: &mut Cx<'_>, uid: UserId, chan: &str, reason: Option<&str>) -> bool {
    let key = fold(chan);
    let Some(source) = cx.world.user(uid).map(|u| u.source()) else {
        return false;
    };
    let Some(display) = cx
        .world
        .channels
        .get(&key)
        .filter(|c| c.is_member(uid))
        .map(|c| c.name.clone())
    else {
        return false;
    };
    let mut params = vec![display.clone()];
    if let Some(r) = reason {
        params.push(r.to_string());
    }
    let m = Message::new("PART", params).with_source(source);
    for member in cx.world.channel_members(&key) {
        cx.send(member, m.clone());
    }
    remove_member(cx, uid, &key);
    let state = cx.state;
    for module in &state.modules {
        module.on_part(cx, uid, &display);
    }
    true
}

fn remove_member(cx: &mut Cx<'_>, uid: UserId, key: &str) {
    if let Some(c) = cx.world.channels.get_mut(key) {
        c.members.remove(&uid);
        if c.members.is_empty() {
            cx.world.channels.remove(key);
        }
    }
    if let Some(u) = cx.world.user_mut(uid) {
        u.channels.remove(key);
    }
}

/// Change the nick of a user. A registered user sends NICK to itself and to
/// its peers.
pub fn rename(cx: &mut Cx<'_>, uid: UserId, new: &str) -> Result<(), &'static str> {
    if !valid_nick(new, cx.state.config.limits.nick_max_len) {
        return Err("Erroneous nickname");
    }
    if cx.world.find_nick(new).is_some_and(|o| o != uid) {
        return Err("Nickname is already in use");
    }
    let Some(u) = cx.world.user(uid) else {
        return Err("No such user");
    };
    let old = u.nick.clone();
    let old_source = u.source();
    let registered = u.registered;
    if old == new {
        return Ok(());
    }

    let old_key = fold(&old);
    if cx.world.nicks.get(&old_key) == Some(&uid) {
        cx.world.nicks.remove(&old_key);
    }
    cx.world.nicks.insert(fold(new), uid);
    if let Some(u) = cx.world.user_mut(uid) {
        u.nick = new.to_string();
    }
    if !registered {
        return Ok(());
    }

    let m = Message::new("NICK", vec![new.to_string()]).with_source(old_source);
    cx.send(uid, m.clone());
    for peer in cx.world.peers_of(uid) {
        cx.send(peer, m.clone());
    }
    let state = cx.state;
    for module in &state.modules {
        module.on_nick(cx, uid, &old, new);
    }
    Ok(())
}

/// Set or clear the away message. Peers with `away-notify` get AWAY.
pub fn set_away(cx: &mut Cx<'_>, uid: UserId, away: Option<String>) {
    let Some(u) = cx.world.user_mut(uid) else {
        return;
    };
    u.away = away.clone();
    let source = u.source();
    let registered = u.registered;
    if !registered {
        return;
    }
    let params = away.into_iter().collect();
    let m = Message::new("AWAY", params).with_source(source);
    for peer in cx.world.peers_of(uid) {
        if cx
            .world
            .user(peer)
            .is_some_and(|p| p.has_cap("away-notify"))
        {
            cx.send(peer, m.clone());
        }
    }
}

/// Remove a user from the world. Peers get QUIT; a socket user gets ERROR and
/// its connection closes.
pub fn quit(cx: &mut Cx<'_>, uid: UserId, reason: &str) {
    let Some(u) = cx.world.user(uid) else {
        return;
    };
    let source = u.source();
    let registered = u.registered;
    let host = u.host.clone();
    let channels: Vec<String> = u.channels.iter().cloned().collect();

    if registered {
        let m = Message::new("QUIT", vec![reason.to_string()]).with_source(source);
        for peer in cx.world.peers_of(uid) {
            cx.send(peer, m.clone());
        }
    }
    let state = cx.state;
    for module in &state.modules {
        module.on_quit(cx, uid, reason);
    }
    crate::handlers::message::forget_user(state, uid);
    for key in channels {
        remove_member(cx, uid, &key);
    }
    cx.world.nicks.retain(|_, v| *v != uid);
    cx.world.remove_aliases(uid);
    cx.world.accounts.retain(|_, v| *v != uid);
    if let Some(u) = cx.world.users.remove(&uid) {
        if let Sink::Socket(o) = &u.sink {
            let err = Message::new(
                "ERROR",
                vec![format!("Closing Link: {} ({})", host, reason)],
            );
            o.send_line(&err.to_line());
            o.close();
        }
    }
}

/// Send `m` to `r`. When `direct` is set, skip the label buffer.
fn send(cx: &mut Cx<'_>, r: UserId, direct: bool, m: Message) {
    if direct {
        cx.world.send_to(r, &m);
    } else {
        cx.send(r, m);
    }
}

/// Deliver a PRIVMSG, NOTICE, or TAGMSG event to its recipients.
pub fn fanout(cx: &mut Cx<'_>, mut ev: MessageEvent) {
    let state = cx.state;
    let mut consumed = false;
    for module in &state.modules {
        let flow = module.on_message(cx, &mut ev);
        if ev.reject.is_some() {
            break;
        }
        if let Flow::Handled = flow {
            consumed = true;
            break;
        }
    }
    if let Some(r) = ev.reject.take() {
        cx.send(ev.sender, r);
        return;
    }
    if consumed {
        return;
    }

    let echo = cx
        .world
        .user(ev.sender)
        .is_some_and(|u| u.has_cap("echo-message"));
    // Each delivery is a recipient and a flag. When the flag is set, the
    // message goes to the socket directly, not into the label buffer: a
    // labeled message to self with echo-message gives one labeled echo and
    // one unlabeled delivery.
    let mut deliveries: Vec<(UserId, bool)> = match &ev.target {
        MsgTarget::Channel(name) => cx
            .world
            .channel_members(&fold(name))
            .into_iter()
            .filter(|m| *m != ev.sender)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .map(|m| (m, false))
            .collect(),
        MsgTarget::User(u) => vec![(*u, echo && *u == ev.sender)],
    };
    if echo {
        deliveries.push((ev.sender, false));
    }
    if ev.command == "TAGMSG" {
        deliveries.retain(|(r, _)| cx.world.user(*r).is_some_and(|u| u.has_cap("message-tags")));
    }
    let recipients: Vec<UserId> = deliveries
        .iter()
        .map(|(r, _)| *r)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();

    for &(r, direct) in &deliveries {
        let mut out = ev.msg.clone();
        for module in &state.modules {
            module.on_deliver(cx, &ev, r, &mut out);
        }
        if ev.lines.is_empty() {
            send(cx, r, direct, out);
            continue;
        }
        let multiline = cx
            .world
            .user(r)
            .is_some_and(|u| u.has_cap("draft/multiline"));
        if multiline {
            let id = cx.world.batch_id();
            let open = Message {
                tags: out.tags.clone(),
                source: out.source.clone(),
                command: "BATCH".into(),
                params: vec![
                    format!("+{id}"),
                    "draft/multiline".into(),
                    ev.target_name.clone(),
                ],
            };
            send(cx, r, direct, open);
            for line in &ev.lines {
                let mut m = line.clone();
                if m.source.is_none() {
                    m.source = out.source.clone();
                }
                m.set_tag("batch", Some(id.clone()));
                send(cx, r, direct, m);
            }
            let close = Message::new("BATCH", vec![format!("-{id}")])
                .with_source(cx.state.config.server_name.clone());
            send(cx, r, direct, close);
        } else {
            // Clients without multiline get each line that has text; only
            // the first line carries the msgid.
            let texts = ev
                .lines
                .iter()
                .filter(|l| l.param(1).is_some_and(|t| !t.is_empty()));
            for (i, line) in texts.enumerate() {
                let mut m = line.clone();
                m.source = out.source.clone().or(m.source);
                m.tags = out.tags.clone();
                if i > 0 {
                    m.remove_tag("msgid");
                }
                send(cx, r, direct, m);
            }
        }
    }

    for module in &state.modules {
        module.on_stored(cx, &ev, &recipients);
    }
}

/// Run one command for a user under the world lock, with labeled-response.
pub fn dispatch_as(state: &SharedState, uid: UserId, msg: Message) {
    state.with_world(|cx| {
        let label = msg
            .tag("label")
            .filter(|l| !l.is_empty())
            .map(str::to_string);
        let labeled = match (&label, cx.world.user_mut(uid)) {
            (Some(l), Some(u)) if u.has_cap("labeled-response") => {
                u.label = Some(l.clone());
                u.label_buf = Some(Vec::new());
                true
            }
            _ => false,
        };

        let st = cx.state;
        let mut handled = false;
        for module in &st.modules {
            if let Flow::Handled = module.on_command(cx, uid, &msg) {
                handled = true;
                break;
            }
        }
        if !handled {
            handlers::dispatch(cx, uid, &msg);
        }

        if labeled {
            flush_label(cx, uid, label.unwrap_or_default());
        }
    });
}

/// End a labeled command: send the label buffer of the user with `label`.
/// Does nothing when a handler moved the label to a later command.
pub fn flush_label(cx: &mut Cx<'_>, uid: UserId, label: String) {
    let Some(u) = cx.world.user_mut(uid) else {
        return;
    };
    let Some(buf) = u.label_buf.take() else {
        return;
    };
    u.label = None;
    let server = cx.state.config.server_name.clone();
    match buf.len() {
        0 => {
            let ack = Message::new("ACK", vec![])
                .with_source(server)
                .with_tag("label", Some(label));
            cx.world.send_to(uid, &ack);
        }
        1 => {
            let mut m = buf.into_iter().next().expect("one line");
            m.set_tag("label", Some(label));
            cx.world.send_to(uid, &m);
        }
        _ if is_one_batch(&buf) => {
            for (i, mut m) in buf.into_iter().enumerate() {
                if i == 0 {
                    m.set_tag("label", Some(label.clone()));
                }
                cx.world.send_to(uid, &m);
            }
        }
        _ => {
            let id = cx.world.batch_id();
            let open = Message::new("BATCH", vec![format!("+{id}"), "labeled-response".into()])
                .with_source(server.clone())
                .with_tag("label", Some(label));
            cx.world.send_to(uid, &open);
            for mut m in buf {
                if !m.has_tag("batch") {
                    m.set_tag("batch", Some(id.clone()));
                }
                cx.world.send_to(uid, &m);
            }
            let close = Message::new("BATCH", vec![format!("-{id}")]).with_source(server);
            cx.world.send_to(uid, &close);
        }
    }
}

/// True when `buf` is exactly one batch: an opening BATCH, lines in that
/// batch, and the closing BATCH.
fn is_one_batch(buf: &[Message]) -> bool {
    let (Some(first), Some(last)) = (buf.first(), buf.last()) else {
        return false;
    };
    let Some(id) = first
        .param(0)
        .filter(|_| first.command == "BATCH")
        .and_then(|p| p.strip_prefix('+'))
    else {
        return false;
    };
    let closes =
        last.command == "BATCH" && last.param(0).and_then(|p| p.strip_prefix('-')) == Some(id);
    closes
        && buf.len() >= 2
        && buf[1..buf.len() - 1]
            .iter()
            .all(|m| m.tag("batch") == Some(id))
}
