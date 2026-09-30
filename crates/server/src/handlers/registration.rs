//! Registration commands: CAP, NICK, USER, PASS, PING, PONG, QUIT, and
//! AUTHENTICATE, and the welcome burst.

use crate::caps;
use crate::module::Cx;
use crate::ops;
use crate::sasl;
use crate::user::UserId;
use crate::util::{format_time_ms, valid_nick};
use agent_comms_proto::{numeric, Message};

pub const VERSION: &str = "agent-comms-0.1";
const USER_MODES: &str = "i";
const CHANNEL_MODES: &str = "bklimnostv";
/// Approximate maximum size of one CAP reply line.
const CAP_LINE_MAX: usize = 400;
const ISUPPORT_PER_LINE: usize = 13;
const ERR_INVALIDCAPCMD: &str = "410";

/// Handle a registration command. Returns true when the command was handled.
pub fn handle(cx: &mut Cx<'_>, uid: UserId, msg: &Message) -> bool {
    match msg.command_upper().as_str() {
        "CAP" => cap(cx, uid, msg),
        "NICK" => nick(cx, uid, msg),
        "USER" => user(cx, uid, msg),
        "PASS" => {}
        "PING" => ping(cx, uid, msg),
        "PONG" => {}
        "QUIT" => {
            let reason = match msg.param(0).filter(|r| !r.is_empty()) {
                Some(r) => format!("Quit: {r}"),
                None => "Quit".to_string(),
            };
            ops::quit(cx, uid, &reason);
        }
        "AUTHENTICATE" => sasl::handle(cx, uid, msg),
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

fn is_registered(cx: &Cx<'_>, uid: UserId) -> bool {
    cx.world.user(uid).is_some_and(|u| u.registered)
}

// ---------------------------------------------------------------- CAP

fn cap(cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
    let Some(sub) = msg.param(0).map(str::to_ascii_uppercase) else {
        need_more(cx, uid, "CAP");
        return;
    };
    match sub.as_str() {
        "LS" => cap_ls(cx, uid, msg),
        "LIST" => cap_list(cx, uid),
        "REQ" => cap_req(cx, uid, msg),
        "END" => {
            let registered = match cx.world.user_mut(uid) {
                Some(u) => {
                    u.reg.cap_negotiating = false;
                    u.registered
                }
                None => return,
            };
            if !registered {
                try_complete(cx, uid);
            }
        }
        _ => cx.numeric(
            uid,
            ERR_INVALIDCAPCMD,
            vec![sub.clone(), "Invalid CAP command".into()],
        ),
    }
}

fn cap_ls(cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
    let version: u32 = msg.param(1).and_then(|v| v.parse().ok()).unwrap_or(0);
    let all = caps::all_caps(cx);
    let Some(u) = cx.world.user_mut(uid) else {
        return;
    };
    if !u.registered {
        u.reg.cap_negotiating = true;
    }
    u.reg.cap_version = u.reg.cap_version.max(version);
    let v302 = u.reg.cap_version >= 302;
    if v302 {
        u.caps.insert("cap-notify".to_string());
    }
    let tokens: Vec<String> = all
        .into_iter()
        .map(|(name, value)| match value {
            Some(v) if v302 && !v.is_empty() => format!("{name}={v}"),
            _ => name,
        })
        .collect();
    send_cap_lines(cx, uid, "LS", tokens);
}

fn cap_list(cx: &mut Cx<'_>, uid: UserId) {
    let Some(u) = cx.world.user(uid) else {
        return;
    };
    let mut tokens: Vec<String> = u.caps.iter().cloned().collect();
    tokens.sort();
    send_cap_lines(cx, uid, "LIST", tokens);
}

/// Send a CAP LS or LIST reply. Long replies use `*` continuation lines.
fn send_cap_lines(cx: &mut Cx<'_>, uid: UserId, sub: &str, tokens: Vec<String>) {
    let nick = cx
        .world
        .user(uid)
        .map(|u| u.nick.clone())
        .unwrap_or_else(|| "*".into());
    let overhead = format!(":{} CAP {} {} * :", cx.server_name(), nick, sub).len();
    let budget = CAP_LINE_MAX.saturating_sub(overhead).max(100);

    let mut lines: Vec<String> = Vec::new();
    let mut cur = String::new();
    for t in tokens {
        if !cur.is_empty() && cur.len() + 1 + t.len() > budget {
            lines.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(&t);
    }
    lines.push(cur);

    let last = lines.len() - 1;
    for (i, line) in lines.into_iter().enumerate() {
        let params = if i < last {
            vec![sub.to_string(), "*".into(), line]
        } else {
            vec![sub.to_string(), line]
        };
        cx.numeric(uid, "CAP", params);
    }
}

fn cap_req(cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
    let list = msg.param(1).unwrap_or("").trim().to_string();
    let all = caps::all_caps(cx);
    let Some(u) = cx.world.user_mut(uid) else {
        return;
    };
    if !u.registered {
        u.reg.cap_negotiating = true;
    }
    let v302 = u.reg.cap_version >= 302;

    let mut changes: Vec<(bool, String)> = Vec::new();
    let mut ok = !list.is_empty();
    for tok in list.split_ascii_whitespace() {
        let (add, name) = match tok.strip_prefix('-') {
            Some(n) => (false, n),
            None => (true, tok),
        };
        let known = all.iter().any(|(n, _)| n == name);
        let locked = !add && v302 && name == "cap-notify";
        if !known || locked {
            ok = false;
            break;
        }
        changes.push((add, name.to_string()));
    }

    if ok {
        for (add, name) in changes {
            if add {
                u.caps.insert(name);
            } else {
                u.caps.remove(&name);
            }
        }
    }
    let sub = if ok { "ACK" } else { "NAK" };
    cx.numeric(uid, "CAP", vec![sub.into(), list]);
}

// ---------------------------------------------------------------- NICK / USER

fn nick(cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
    let Some(new) = msg.param(0).filter(|n| !n.is_empty()).map(str::to_string) else {
        cx.numeric(
            uid,
            numeric::ERR_NONICKNAMEGIVEN,
            vec!["No nickname given".into()],
        );
        return;
    };
    if !valid_nick(&new, cx.config().limits.nick_max_len) {
        cx.numeric(
            uid,
            numeric::ERR_ERRONEUSNICKNAME,
            vec![new, "Erroneous nickname".into()],
        );
        return;
    }
    if cx.world.find_nick(&new).is_some_and(|o| o != uid) {
        cx.numeric(
            uid,
            numeric::ERR_NICKNAMEINUSE,
            vec![new, "Nickname is already in use".into()],
        );
        return;
    }
    if let Err(e) = ops::rename(cx, uid, &new) {
        let code = if e == "Nickname is already in use" {
            numeric::ERR_NICKNAMEINUSE
        } else {
            numeric::ERR_ERRONEUSNICKNAME
        };
        cx.numeric(uid, code, vec![new, e.to_string()]);
        return;
    }
    let registered = match cx.world.user_mut(uid) {
        Some(u) => {
            u.reg.nick_set = true;
            u.registered
        }
        None => return,
    };
    if !registered {
        try_complete(cx, uid);
    }
}

fn user(cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
    if is_registered(cx, uid) {
        cx.numeric(
            uid,
            numeric::ERR_ALREADYREGISTERED,
            vec!["You may not reregister".into()],
        );
        return;
    }
    if msg.params.len() < 4 || msg.params[0].is_empty() || msg.params[3].is_empty() {
        need_more(cx, uid, "USER");
        return;
    }
    let username: String = msg.params[0]
        .chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, '@' | '!' | ':' | '\0'))
        .take(32)
        .collect();
    let username = if username.is_empty() {
        "user".to_string()
    } else {
        username
    };
    let realname = msg.params[3].clone();
    if let Some(u) = cx.world.user_mut(uid) {
        u.username = username;
        u.realname = realname;
        u.reg.user_set = true;
    }
    try_complete(cx, uid);
}

// ---------------------------------------------------------------- PING

fn ping(cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
    let Some(token) = msg.param(0).map(str::to_string) else {
        need_more(cx, uid, "PING");
        return;
    };
    let server = cx.server_name().to_string();
    let m = Message::new("PONG", vec![server.clone(), token]).with_source(server);
    cx.send(uid, m);
}

// ---------------------------------------------------------------- completion

/// Complete registration when NICK and USER are known and CAP negotiation
/// is not in progress.
fn try_complete(cx: &mut Cx<'_>, uid: UserId) {
    let Some(u) = cx.world.user(uid) else {
        return;
    };
    if u.registered || !u.reg.nick_set || !u.reg.user_set || u.reg.cap_negotiating {
        return;
    }
    if cx.config().require_sasl && u.account.is_none() {
        let reason = "SASL authentication required";
        cx.world
            .send_to(uid, &Message::new("ERROR", vec![reason.to_string()]));
        ops::quit(cx, uid, reason);
        return;
    }
    if let Some(u) = cx.world.user_mut(uid) {
        u.registered = true;
        u.reg.sasl = None;
    }
    on_registered(cx, uid);
}

/// Send the welcome burst: 001-005, LUSERS, and MOTD.
pub fn on_registered(cx: &mut Cx<'_>, uid: UserId) {
    let Some(nick) = cx.world.user(uid).map(|u| u.nick.clone()) else {
        return;
    };
    let server = cx.server_name().to_string();
    let config = cx.config().clone();

    cx.numeric(
        uid,
        numeric::RPL_WELCOME,
        vec![format!("Welcome to the agent-comms network, {nick}")],
    );
    cx.numeric(
        uid,
        numeric::RPL_YOURHOST,
        vec![format!("Your host is {server}, running version {VERSION}")],
    );
    let created = format_time_ms(cx.state.started.saturating_mul(1000));
    cx.numeric(
        uid,
        numeric::RPL_CREATED,
        vec![format!("This server was created {created}")],
    );
    cx.numeric(
        uid,
        numeric::RPL_MYINFO,
        vec![
            server.clone(),
            VERSION.into(),
            USER_MODES.into(),
            CHANNEL_MODES.into(),
        ],
    );

    let mut tokens: Vec<String> = vec![
        "CASEMAPPING=rfc1459".into(),
        "CHANTYPES=#".into(),
        format!("NICKLEN={}", config.limits.nick_max_len),
        "CHANNELLEN=128".into(),
        "TOPICLEN=390".into(),
        "PREFIX=(ov)@+".into(),
        "CHANMODES=b,k,l,imnst".into(),
        "NETWORK=agent-comms".into(),
        "UTF8ONLY".into(),
        "MAXTARGETS=4".into(),
    ];
    for module in &cx.state.modules {
        tokens.extend(module.isupport());
    }
    for chunk in tokens.chunks(ISUPPORT_PER_LINE) {
        let mut params: Vec<String> = chunk.to_vec();
        params.push("are supported by this server".into());
        cx.numeric(uid, numeric::RPL_ISUPPORT, params);
    }

    let users = cx.world.users.values().filter(|u| u.registered).count();
    cx.numeric(
        uid,
        numeric::RPL_LUSERCLIENT,
        vec![format!(
            "There are {users} users and 0 invisible on 1 servers"
        )],
    );

    match config.motd.as_deref().filter(|m| !m.is_empty()) {
        Some(motd) => {
            cx.numeric(
                uid,
                numeric::RPL_MOTDSTART,
                vec![format!("- {server} Message of the day - ")],
            );
            for line in motd.lines() {
                cx.numeric(uid, numeric::RPL_MOTD, vec![format!("- {line}")]);
            }
            cx.numeric(
                uid,
                numeric::RPL_ENDOFMOTD,
                vec!["End of /MOTD command.".into()],
            );
        }
        None => cx.numeric(
            uid,
            numeric::ERR_NOMOTD,
            vec!["MOTD File is missing".into()],
        ),
    }
}
