//! Channel commands: JOIN, PART, TOPIC, NAMES, LIST, KICK, MODE, INVITE.

use crate::module::Cx;
use crate::ops;
use crate::user::UserId;
use crate::util::{fold, unix_now, valid_channel};
use agent_comms_proto::{numeric, Message};

const RPL_BANLIST: &str = "367";
const RPL_ENDOFBANLIST: &str = "368";
const NAMES_LINE_MAX: usize = 400;

/// Handle a channel command. Returns false when the command is not a channel
/// command (or MODE on a nick).
pub fn handle(cx: &mut Cx<'_>, uid: UserId, msg: &Message) -> bool {
    match msg.command_upper().as_str() {
        "JOIN" => join(cx, uid, msg),
        "PART" => part(cx, uid, msg),
        "TOPIC" => topic(cx, uid, msg),
        "NAMES" => names_cmd(cx, uid, msg),
        "LIST" => list(cx, uid, msg),
        "KICK" => kick(cx, uid, msg),
        "MODE" => {
            if !msg.param(0).is_some_and(|t| t.starts_with('#')) {
                return false;
            }
            mode(cx, uid, msg)
        }
        "INVITE" => invite(cx, uid, msg),
        _ => return false,
    }
    true
}

fn need_more(cx: &mut Cx<'_>, uid: UserId, cmd: &str) {
    cx.numeric(
        uid,
        numeric::ERR_NEEDMOREPARAMS,
        vec![cmd.into(), "Not enough parameters".into()],
    );
}

fn no_such_channel(cx: &mut Cx<'_>, uid: UserId, name: &str) {
    cx.numeric(
        uid,
        numeric::ERR_NOSUCHCHANNEL,
        vec![name.into(), "No such channel".into()],
    );
}

fn not_on_channel(cx: &mut Cx<'_>, uid: UserId, name: &str) {
    cx.numeric(
        uid,
        numeric::ERR_NOTONCHANNEL,
        vec![name.into(), "You're not on that channel".into()],
    );
}

fn not_op(cx: &mut Cx<'_>, uid: UserId, name: &str) {
    cx.numeric(
        uid,
        numeric::ERR_CHANOPRIVSNEEDED,
        vec![name.into(), "You're not channel operator".into()],
    );
}

fn source_of(cx: &Cx<'_>, uid: UserId) -> String {
    cx.world
        .user(uid)
        .map(|u| u.source())
        .unwrap_or_else(|| "*".into())
}

fn broadcast(cx: &mut Cx<'_>, key: &str, m: &Message) {
    for member in cx.world.channel_members(key) {
        cx.send(member, m.clone());
    }
}

/// Glob match with `*` and `?`, on already folded strings.
fn glob(pat: &[char], s: &[char]) -> bool {
    let (mut p, mut i) = (0, 0);
    let (mut star, mut mark) = (None, 0);
    while i < s.len() {
        if p < pat.len() && (pat[p] == '?' || pat[p] == s[i]) {
            p += 1;
            i += 1;
        } else if p < pat.len() && pat[p] == '*' {
            star = Some(p);
            p += 1;
            mark = i;
        } else if let Some(sp) = star {
            p = sp + 1;
            mark += 1;
            i = mark;
        } else {
            return false;
        }
    }
    while p < pat.len() && pat[p] == '*' {
        p += 1;
    }
    p == pat.len()
}

fn mask_matches(mask: &str, source: &str) -> bool {
    let p: Vec<char> = fold(mask).chars().collect();
    let s: Vec<char> = fold(source).chars().collect();
    glob(&p, &s)
}

/// Remove a member without a PART message and call the `on_part` hooks.
fn remove_member(cx: &mut Cx<'_>, uid: UserId, key: &str) {
    let Some(display) = cx.world.channels.get(key).map(|c| c.name.clone()) else {
        return;
    };
    if let Some(c) = cx.world.channels.get_mut(key) {
        c.members.remove(&uid);
        if c.members.is_empty() {
            cx.world.channels.remove(key);
        }
    }
    if let Some(u) = cx.world.user_mut(uid) {
        u.channels.remove(key);
    }
    let state = cx.state;
    for m in &state.modules {
        m.on_part(cx, uid, &display);
    }
}

fn send_topic(cx: &mut Cx<'_>, uid: UserId, key: &str, always: bool) {
    let Some(c) = cx.world.channels.get(key) else {
        return;
    };
    let name = c.name.clone();
    match c.topic.clone() {
        Some((text, setter, time)) => {
            cx.numeric(uid, numeric::RPL_TOPIC, vec![name.clone(), text]);
            cx.numeric(
                uid,
                numeric::RPL_TOPICWHOTIME,
                vec![name, setter, time.to_string()],
            );
        }
        None if always => {
            cx.numeric(
                uid,
                numeric::RPL_NOTOPIC,
                vec![name, "No topic is set".into()],
            );
        }
        None => {}
    }
}

/// Send 353 lines and 366 for one channel (folded key).
fn send_names(cx: &mut Cx<'_>, uid: UserId, key: &str) {
    let Some(c) = cx.world.channels.get(key) else {
        return;
    };
    let name = c.name.clone();
    let kind = if c.modes.secret { "@" } else { "=" };
    let entries: Vec<String> = c
        .members
        .iter()
        .filter_map(|(id, mm)| {
            cx.world
                .user(*id)
                .map(|u| format!("{}{}", mm.prefix(), u.nick))
        })
        .collect();
    let mut line = String::new();
    let mut lines = Vec::new();
    for e in entries {
        if !line.is_empty() && line.len() + 1 + e.len() > NAMES_LINE_MAX {
            lines.push(std::mem::take(&mut line));
        }
        if !line.is_empty() {
            line.push(' ');
        }
        line.push_str(&e);
    }
    if !line.is_empty() {
        lines.push(line);
    }
    for l in lines {
        cx.numeric(
            uid,
            numeric::RPL_NAMREPLY,
            vec![kind.into(), name.clone(), l],
        );
    }
    cx.numeric(
        uid,
        numeric::RPL_ENDOFNAMES,
        vec![name, "End of /NAMES list".into()],
    );
}

fn join(cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
    let Some(chans) = msg.param(0) else {
        return need_more(cx, uid, "JOIN");
    };
    if chans == "0" {
        let keys: Vec<String> = cx
            .world
            .user(uid)
            .map(|u| u.channels.iter().cloned().collect())
            .unwrap_or_default();
        for k in keys {
            ops::part(cx, uid, &k, None);
        }
        return;
    }
    let keys: Vec<&str> = msg
        .param(1)
        .map(|k| k.split(',').collect())
        .unwrap_or_default();
    let source = source_of(cx, uid);
    for (i, chan) in chans.split(',').enumerate() {
        if chan.is_empty() {
            continue;
        }
        if !valid_channel(chan) {
            no_such_channel(cx, uid, chan);
            continue;
        }
        let key = fold(chan);
        if let Some(c) = cx.world.channels.get(&key) {
            if c.is_member(uid) {
                continue;
            }
            let name = c.name.clone();
            let err = if c.bans.iter().any(|(m, _, _)| mask_matches(m, &source)) {
                Some((numeric::ERR_BANNEDFROMCHAN, "Cannot join channel (+b)"))
            } else if c.modes.invite_only {
                Some((numeric::ERR_INVITEONLYCHAN, "Cannot join channel (+i)"))
            } else if c
                .modes
                .key
                .as_deref()
                .is_some_and(|k| keys.get(i).copied() != Some(k))
            {
                Some((numeric::ERR_BADCHANNELKEY, "Cannot join channel (+k)"))
            } else if c.modes.limit.is_some_and(|l| c.members.len() >= l) {
                Some((numeric::ERR_CHANNELISFULL, "Cannot join channel (+l)"))
            } else {
                None
            };
            if let Some((code, text)) = err {
                cx.numeric(uid, code, vec![name, text.into()]);
                continue;
            }
        }
        if ops::join(cx, uid, chan, true) {
            send_topic(cx, uid, &key, false);
            send_names(cx, uid, &key);
        }
    }
}

fn part(cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
    let Some(chans) = msg.param(0) else {
        return need_more(cx, uid, "PART");
    };
    let reason = msg.param(1);
    for chan in chans.split(',').filter(|c| !c.is_empty()) {
        let key = fold(chan);
        match cx.world.channels.get(&key) {
            None => no_such_channel(cx, uid, chan),
            Some(c) if !c.is_member(uid) => {
                let name = c.name.clone();
                not_on_channel(cx, uid, &name);
            }
            Some(_) => {
                ops::part(cx, uid, chan, reason);
            }
        }
    }
}

fn topic(cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
    let Some(chan) = msg.param(0) else {
        return need_more(cx, uid, "TOPIC");
    };
    let key = fold(chan);
    let Some(c) = cx.world.channels.get(&key) else {
        return no_such_channel(cx, uid, chan);
    };
    let name = c.name.clone();
    let member = c.is_member(uid);
    let op = c.is_op(uid);
    let topic_ops = c.modes.topic_ops;
    let secret = c.modes.secret;
    let Some(text) = msg.param(1) else {
        if secret && !member {
            return not_on_channel(cx, uid, &name);
        }
        return send_topic(cx, uid, &key, true);
    };
    if !member {
        return not_on_channel(cx, uid, &name);
    }
    if topic_ops && !op {
        return not_op(cx, uid, &name);
    }
    let (nick, source) = match cx.world.user(uid) {
        Some(u) => (u.nick.clone(), u.source()),
        None => return,
    };
    if let Some(c) = cx.world.channels.get_mut(&key) {
        c.topic = if text.is_empty() {
            None
        } else {
            Some((text.to_string(), nick, unix_now()))
        };
    }
    let m = Message::new("TOPIC", vec![name, text.to_string()]).with_source(source);
    broadcast(cx, &key, &m);
}

fn names_cmd(cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
    let Some(chans) = msg.param(0) else {
        cx.numeric(
            uid,
            numeric::RPL_ENDOFNAMES,
            vec!["*".into(), "End of /NAMES list".into()],
        );
        return;
    };
    for chan in chans.split(',').filter(|c| !c.is_empty()) {
        let key = fold(chan);
        let visible = cx
            .world
            .channels
            .get(&key)
            .is_some_and(|c| !c.modes.secret || c.is_member(uid));
        if visible {
            send_names(cx, uid, &key);
        } else {
            cx.numeric(
                uid,
                numeric::RPL_ENDOFNAMES,
                vec![chan.into(), "End of /NAMES list".into()],
            );
        }
    }
}

fn list(cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
    let wanted: Option<Vec<String>> = msg
        .param(0)
        .filter(|p| !p.is_empty())
        .map(|p| p.split(',').filter(|c| !c.is_empty()).map(fold).collect());
    cx.numeric(
        uid,
        numeric::RPL_LISTSTART,
        vec!["Channel".into(), "Users  Name".into()],
    );
    let mut rows: Vec<(String, Vec<String>)> = cx
        .world
        .channels
        .iter()
        .filter(|(k, _)| wanted.as_ref().is_none_or(|w| w.contains(k)))
        .filter(|(_, c)| !c.modes.secret || c.is_member(uid))
        .map(|(k, c)| {
            (
                k.clone(),
                vec![
                    c.name.clone(),
                    c.members.len().to_string(),
                    c.topic.as_ref().map(|t| t.0.clone()).unwrap_or_default(),
                ],
            )
        })
        .collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    for (_, params) in rows {
        cx.numeric(uid, numeric::RPL_LIST, params);
    }
    cx.numeric(uid, numeric::RPL_LISTEND, vec!["End of /LIST".into()]);
}

fn kick(cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
    let (Some(chan), Some(nicks)) = (msg.param(0), msg.param(1)) else {
        return need_more(cx, uid, "KICK");
    };
    let key = fold(chan);
    let Some(c) = cx.world.channels.get(&key) else {
        return no_such_channel(cx, uid, chan);
    };
    let name = c.name.clone();
    if !c.is_member(uid) {
        return not_on_channel(cx, uid, &name);
    }
    if !c.is_op(uid) {
        return not_op(cx, uid, &name);
    }
    let (kicker_nick, source) = match cx.world.user(uid) {
        Some(u) => (u.nick.clone(), u.source()),
        None => return,
    };
    let reason = msg.param(2).map(str::to_string).unwrap_or(kicker_nick);
    for nick in nicks.split(',').filter(|n| !n.is_empty()) {
        let target = cx.world.find_nick(nick);
        let on_chan =
            target.is_some_and(|t| cx.world.channels.get(&key).is_some_and(|c| c.is_member(t)));
        let (Some(target), true) = (target, on_chan) else {
            cx.numeric(
                uid,
                numeric::ERR_USERNOTINCHANNEL,
                vec![
                    nick.into(),
                    name.clone(),
                    "They aren't on that channel".into(),
                ],
            );
            continue;
        };
        let target_nick = cx
            .world
            .user(target)
            .map(|u| u.nick.clone())
            .unwrap_or_else(|| nick.to_string());
        let m = Message::new("KICK", vec![name.clone(), target_nick, reason.clone()])
            .with_source(source.clone());
        broadcast(cx, &key, &m);
        remove_member(cx, target, &key);
    }
}

fn send_ban_list(cx: &mut Cx<'_>, uid: UserId, key: &str) {
    let Some(c) = cx.world.channels.get(key) else {
        return;
    };
    let name = c.name.clone();
    let bans = c.bans.clone();
    for (mask, setter, time) in bans {
        cx.numeric(
            uid,
            RPL_BANLIST,
            vec![name.clone(), mask, setter, time.to_string()],
        );
    }
    cx.numeric(
        uid,
        RPL_ENDOFBANLIST,
        vec![name, "End of channel ban list".into()],
    );
}

fn mode(cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
    let Some(chan) = msg.param(0) else {
        return need_more(cx, uid, "MODE");
    };
    let key = fold(chan);
    let Some(c) = cx.world.channels.get(&key) else {
        return no_such_channel(cx, uid, chan);
    };
    let name = c.name.clone();
    let is_op = c.is_op(uid);
    let is_member = c.is_member(uid);
    let Some(modestr) = msg.param(1) else {
        let ms = c.mode_string();
        let created = c.created;
        let mut params = vec![name.clone()];
        let mut parts = ms.split(' ');
        let flags = parts.next().unwrap_or("+").to_string();
        params.push(flags);
        if is_member {
            params.extend(parts.map(str::to_string));
        }
        cx.numeric(uid, numeric::RPL_CHANNELMODEIS, params);
        cx.numeric(
            uid,
            numeric::RPL_CREATIONTIME,
            vec![name, created.to_string()],
        );
        return;
    };

    let setter = match cx.world.user(uid) {
        Some(u) => u.nick.clone(),
        None => return,
    };
    let source = source_of(cx, uid);
    let mut args = msg.params.iter().skip(2).map(String::as_str);
    let mut adding = true;
    let mut out_flags = String::new();
    let mut out_sign: Option<bool> = None;
    let mut out_args: Vec<String> = Vec::new();
    let mut denied = false;

    for ch in modestr.chars() {
        match ch {
            '+' => {
                adding = true;
                continue;
            }
            '-' => {
                adding = false;
                continue;
            }
            _ => {}
        }
        if !"imnstklovb".contains(ch) {
            cx.numeric(
                uid,
                numeric::ERR_UNKNOWNMODE,
                vec![ch.to_string(), "is unknown mode char to me".into()],
            );
            continue;
        }
        // Parameter, taken before the privilege check so parsing stays aligned.
        let arg = match ch {
            'k' | 'o' | 'v' | 'b' => args.next(),
            'l' if adding => args.next(),
            _ => None,
        };
        if ch == 'b' && arg.is_none() {
            send_ban_list(cx, uid, &key);
            continue;
        }
        if matches!(ch, 'k' | 'o' | 'v') && arg.is_none() && (adding || ch != 'k') {
            need_more(cx, uid, "MODE");
            continue;
        }
        if ch == 'l' && adding && arg.is_none() {
            need_more(cx, uid, "MODE");
            continue;
        }
        if !is_op {
            if !denied {
                not_op(cx, uid, &name);
                denied = true;
            }
            continue;
        }

        let Some(c) = cx.world.channels.get_mut(&key) else {
            return;
        };
        let mut applied_arg: Option<String> = None;
        let applied = match ch {
            'i' => std::mem::replace(&mut c.modes.invite_only, adding) != adding,
            'm' => std::mem::replace(&mut c.modes.moderated, adding) != adding,
            'n' => std::mem::replace(&mut c.modes.no_external, adding) != adding,
            's' => std::mem::replace(&mut c.modes.secret, adding) != adding,
            't' => std::mem::replace(&mut c.modes.topic_ops, adding) != adding,
            'k' => {
                if adding {
                    let k = arg.unwrap_or_default().to_string();
                    if k.is_empty() || k.contains(' ') {
                        false
                    } else {
                        c.modes.key = Some(k.clone());
                        applied_arg = Some(k);
                        true
                    }
                } else if c.modes.key.take().is_some() {
                    applied_arg = Some("*".into());
                    true
                } else {
                    false
                }
            }
            'l' => {
                if adding {
                    match arg.and_then(|a| a.parse::<usize>().ok()).filter(|n| *n > 0) {
                        Some(n) => {
                            c.modes.limit = Some(n);
                            applied_arg = Some(n.to_string());
                            true
                        }
                        None => false,
                    }
                } else {
                    c.modes.limit.take().is_some()
                }
            }
            'b' => {
                let mask = arg.unwrap_or_default().to_string();
                let f = fold(&mask);
                let pos = c.bans.iter().position(|(m, _, _)| fold(m) == f);
                match (adding, pos) {
                    (true, None) => {
                        c.bans.push((mask.clone(), setter.clone(), unix_now()));
                        applied_arg = Some(mask);
                        true
                    }
                    (false, Some(p)) => {
                        let (m, _, _) = c.bans.remove(p);
                        applied_arg = Some(m);
                        true
                    }
                    _ => false,
                }
            }
            'o' | 'v' => {
                let nick = arg.unwrap_or_default();
                let target = cx.world.find_nick(nick);
                let Some(target) = target else {
                    cx.numeric(
                        uid,
                        numeric::ERR_NOSUCHNICK,
                        vec![nick.into(), "No such nick/channel".into()],
                    );
                    continue;
                };
                let target_nick = cx
                    .world
                    .user(target)
                    .map(|u| u.nick.clone())
                    .unwrap_or_else(|| nick.to_string());
                let Some(mm) = cx
                    .world
                    .channels
                    .get_mut(&key)
                    .and_then(|c| c.members.get_mut(&target))
                else {
                    cx.numeric(
                        uid,
                        numeric::ERR_USERNOTINCHANNEL,
                        vec![
                            target_nick,
                            name.clone(),
                            "They aren't on that channel".into(),
                        ],
                    );
                    continue;
                };
                let flag = if ch == 'o' { &mut mm.op } else { &mut mm.voice };
                let changed = std::mem::replace(flag, adding) != adding;
                applied_arg = Some(target_nick);
                changed
            }
            _ => false,
        };
        if !applied {
            continue;
        }
        if out_sign != Some(adding) {
            out_flags.push(if adding { '+' } else { '-' });
            out_sign = Some(adding);
        }
        out_flags.push(ch);
        if let Some(a) = applied_arg {
            out_args.push(a);
        }
    }

    if out_flags.is_empty() {
        return;
    }
    let mut params = vec![name, out_flags];
    params.extend(out_args);
    let m = Message::new("MODE", params).with_source(source);
    broadcast(cx, &key, &m);
}

fn invite(cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
    let (Some(nick), Some(chan)) = (msg.param(0), msg.param(1)) else {
        return need_more(cx, uid, "INVITE");
    };
    let Some(target) = cx.world.find_nick(nick) else {
        cx.numeric(
            uid,
            numeric::ERR_NOSUCHNICK,
            vec![nick.into(), "No such nick/channel".into()],
        );
        return;
    };
    let key = fold(chan);
    let Some(c) = cx.world.channels.get(&key) else {
        return no_such_channel(cx, uid, chan);
    };
    let name = c.name.clone();
    if !c.is_member(uid) {
        return not_on_channel(cx, uid, &name);
    }
    if c.modes.invite_only && !c.is_op(uid) {
        return not_op(cx, uid, &name);
    }
    let target_nick = cx
        .world
        .user(target)
        .map(|u| u.nick.clone())
        .unwrap_or_else(|| nick.to_string());
    if c.is_member(target) {
        cx.numeric(
            uid,
            numeric::ERR_USERONCHANNEL,
            vec![target_nick, name, "is already on channel".into()],
        );
        return;
    }
    let source = source_of(cx, uid);
    cx.numeric(
        uid,
        numeric::RPL_INVITING,
        vec![target_nick.clone(), name.clone()],
    );
    let m = Message::new("INVITE", vec![target_nick, name]).with_source(source);
    cx.send(target, m);
}
