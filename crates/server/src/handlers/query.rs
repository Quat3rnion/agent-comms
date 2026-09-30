//! Query commands: WHO, WHOIS, AWAY, user MODE, USERHOST, ISON, MOTD, LUSERS,
//! VERSION, and TIME.

use crate::module::Cx;
use crate::ops;
use crate::user::{Role, User, UserId};
use crate::util::{fold, format_time_ms, now_ms};
use agent_comms_proto::{numeric, Message};

const RPL_USERHOST: &str = "302";
const RPL_ISON: &str = "303";
const RPL_VERSION: &str = "351";
const RPL_TIME: &str = "391";

pub fn handle(cx: &mut Cx<'_>, uid: UserId, msg: &Message) -> bool {
    match msg.command_upper().as_str() {
        "WHO" => who(cx, uid, msg),
        "WHOIS" => whois(cx, uid, msg),
        "AWAY" => away(cx, uid, msg),
        "MODE" => return user_mode(cx, uid, msg),
        "USERHOST" => userhost(cx, uid, msg),
        "ISON" => ison(cx, uid, msg),
        "MOTD" => motd(cx, uid),
        "LUSERS" => lusers(cx, uid),
        "VERSION" => version(cx, uid),
        "TIME" => time(cx, uid),
        _ => return false,
    }
    true
}

fn need_more(cx: &mut Cx<'_>, uid: UserId, cmd: &str) {
    cx.numeric(
        uid,
        numeric::ERR_NEEDMOREPARAMS,
        vec![cmd.to_string(), "Not enough parameters".into()],
    );
}

/// `H` or `G`, then `*` for an operator, then the channel prefix.
fn who_flags(u: &User, prefix: &str) -> String {
    let mut f = String::from(if u.away.is_some() { "G" } else { "H" });
    if u.role == Role::Operator {
        f.push('*');
    }
    f.push_str(prefix);
    f
}

fn who_line(server: &str, chan: &str, u: &User, prefix: &str) -> Vec<String> {
    vec![
        chan.to_string(),
        u.username.clone(),
        u.host.clone(),
        server.to_string(),
        u.nick.clone(),
        who_flags(u, prefix),
        format!("0 {}", u.realname),
    ]
}

fn who(cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
    let mask = msg
        .param(0)
        .filter(|m| !m.is_empty())
        .unwrap_or("*")
        .to_string();
    let server = cx.server_name().to_string();
    let mut rows = Vec::new();
    if mask.starts_with('#') {
        if let Some(c) = cx.world.channels.get(&fold(&mask)) {
            if !c.modes.secret || c.is_member(uid) {
                for (m, modes) in &c.members {
                    if let Some(u) = cx.world.user(*m) {
                        rows.push(who_line(&server, &c.name, u, modes.prefix()));
                    }
                }
            }
        }
    } else if let Some(u) = cx.world.find_nick(&mask).and_then(|t| cx.world.user(t)) {
        rows.push(who_line(&server, "*", u, ""));
    }
    for row in rows {
        cx.numeric(uid, numeric::RPL_WHOREPLY, row);
    }
    cx.numeric(
        uid,
        numeric::RPL_ENDOFWHO,
        vec![mask, "End of WHO list".into()],
    );
}

fn whois(cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
    let Some(arg) = msg.params.last().filter(|p| !p.is_empty()) else {
        cx.numeric(
            uid,
            numeric::ERR_NONICKNAMEGIVEN,
            vec!["No nickname given".into()],
        );
        return;
    };
    let nick = arg.split(',').next().unwrap_or("").to_string();
    let server = cx.server_name().to_string();
    let Some(target) = cx.world.find_nick(&nick) else {
        cx.numeric(
            uid,
            numeric::ERR_NOSUCHNICK,
            vec![nick.clone(), "No such nick/channel".into()],
        );
        cx.numeric(
            uid,
            numeric::RPL_ENDOFWHOIS,
            vec![nick, "End of WHOIS list".into()],
        );
        return;
    };
    let Some(u) = cx.world.user(target) else {
        return;
    };

    let name = u.nick.clone();
    let mut replies: Vec<(&str, Vec<String>)> = vec![(
        numeric::RPL_WHOISUSER,
        vec![
            name.clone(),
            u.username.clone(),
            u.host.clone(),
            "*".into(),
            u.realname.clone(),
        ],
    )];

    let mut chans: Vec<String> = u
        .channels
        .iter()
        .filter_map(|key| cx.world.channels.get(key))
        .filter(|c| !c.modes.secret || c.is_member(uid))
        .map(|c| {
            let prefix = c.members.get(&target).map(|m| m.prefix()).unwrap_or("");
            format!("{prefix}{}", c.name)
        })
        .collect();
    chans.sort();
    if !chans.is_empty() {
        replies.push((
            numeric::RPL_WHOISCHANNELS,
            vec![name.clone(), chans.join(" ")],
        ));
    }
    replies.push((
        numeric::RPL_WHOISSERVER,
        vec![name.clone(), server, "agent-comms".into()],
    ));
    if u.role == Role::Operator {
        replies.push((
            numeric::RPL_WHOISOPERATOR,
            vec![name.clone(), "is an IRC operator".into()],
        ));
    }
    if let Some(a) = &u.account {
        replies.push((
            numeric::RPL_WHOISACCOUNT,
            vec![name.clone(), a.clone(), "is logged in as".into()],
        ));
    }
    if let Some(a) = &u.away {
        replies.push((numeric::RPL_AWAY, vec![name.clone(), a.clone()]));
    }
    replies.push((
        numeric::RPL_WHOISIDLE,
        vec![
            name.clone(),
            u.last_activity.elapsed().as_secs().to_string(),
            u.signon.to_string(),
            "seconds idle, signon time".into(),
        ],
    ));
    replies.push((
        numeric::RPL_ENDOFWHOIS,
        vec![name, "End of WHOIS list".into()],
    ));

    for (code, params) in replies {
        cx.numeric(uid, code, params);
    }
}

fn away(cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
    match msg.param(0).filter(|m| !m.is_empty()) {
        Some(reason) => {
            ops::set_away(cx, uid, Some(reason.to_string()));
            cx.numeric(
                uid,
                numeric::RPL_NOWAWAY,
                vec!["You have been marked as being away".into()],
            );
        }
        None => {
            ops::set_away(cx, uid, None);
            cx.numeric(
                uid,
                numeric::RPL_UNAWAY,
                vec!["You are no longer marked as being away".into()],
            );
        }
    }
}

/// MODE for a nick target. Returns false for a channel target.
fn user_mode(cx: &mut Cx<'_>, uid: UserId, msg: &Message) -> bool {
    let Some(target) = msg.param(0).filter(|t| !t.is_empty()) else {
        return false;
    };
    if target.starts_with('#') {
        return false;
    }
    let own = cx
        .world
        .user(uid)
        .is_some_and(|u| fold(&u.nick) == fold(target));
    if !own {
        cx.numeric(
            uid,
            numeric::ERR_USERSDONTMATCH,
            vec!["Cant change mode for other users".into()],
        );
        return true;
    }
    match msg.param(1) {
        None => {
            cx.numeric(uid, numeric::RPL_UMODEIS, vec!["+i".into()]);
        }
        Some(modes) => {
            if modes.chars().any(|c| !matches!(c, '+' | '-' | 'i')) {
                cx.numeric(
                    uid,
                    numeric::ERR_UMODEUNKNOWNFLAG,
                    vec!["Unknown MODE flag".into()],
                );
            }
        }
    }
    true
}

fn userhost(cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
    if msg.params.is_empty() {
        need_more(cx, uid, "USERHOST");
        return;
    }
    let entries: Vec<String> = msg
        .params
        .iter()
        .flat_map(|p| p.split_whitespace())
        .take(5)
        .filter_map(|n| cx.world.find_nick(n).and_then(|t| cx.world.user(t)))
        .map(|u| {
            format!(
                "{}{}={}{}@{}",
                u.nick,
                if u.role == Role::Operator { "*" } else { "" },
                if u.away.is_some() { "-" } else { "+" },
                u.username,
                u.host
            )
        })
        .collect();
    cx.numeric(uid, RPL_USERHOST, vec![entries.join(" ")]);
}

fn ison(cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
    if msg.params.is_empty() {
        need_more(cx, uid, "ISON");
        return;
    }
    let online: Vec<String> = msg
        .params
        .iter()
        .flat_map(|p| p.split_whitespace())
        .filter_map(|n| cx.world.find_nick(n).and_then(|t| cx.world.user(t)))
        .map(|u| u.nick.clone())
        .collect();
    cx.numeric(uid, RPL_ISON, vec![online.join(" ")]);
}

fn motd(cx: &mut Cx<'_>, uid: UserId) {
    let server = cx.server_name().to_string();
    let Some(text) = cx.config().motd.clone() else {
        cx.numeric(
            uid,
            numeric::ERR_NOMOTD,
            vec!["MOTD File is missing".into()],
        );
        return;
    };
    cx.numeric(
        uid,
        numeric::RPL_MOTDSTART,
        vec![format!("- {server} Message of the day - ")],
    );
    for line in text.lines() {
        cx.numeric(uid, numeric::RPL_MOTD, vec![format!("- {line}")]);
    }
    cx.numeric(
        uid,
        numeric::RPL_ENDOFMOTD,
        vec!["End of /MOTD command.".into()],
    );
}

fn lusers(cx: &mut Cx<'_>, uid: UserId) {
    let users = cx.world.users.values().filter(|u| u.registered).count();
    cx.numeric(
        uid,
        numeric::RPL_LUSERCLIENT,
        vec![format!(
            "There are {users} users and 0 invisible on 1 servers"
        )],
    );
}

fn version(cx: &mut Cx<'_>, uid: UserId) {
    let server = cx.server_name().to_string();
    cx.numeric(
        uid,
        RPL_VERSION,
        vec![
            format!("agent-comms-{}", env!("CARGO_PKG_VERSION")),
            server,
            String::new(),
        ],
    );
}

fn time(cx: &mut Cx<'_>, uid: UserId) {
    let server = cx.server_name().to_string();
    cx.numeric(uid, RPL_TIME, vec![server, format_time_ms(now_ms())]);
}
