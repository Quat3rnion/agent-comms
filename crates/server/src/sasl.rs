//! SASL authentication (`AUTHENTICATE`) with the PLAIN mechanism.

use crate::module::Cx;
use crate::user::{Role, SaslState, UserId};
use agent_comms_proto::{numeric, Message};
use argon2::{Argon2, PasswordHash, PasswordVerifier};
use base64::Engine;

/// Size of a full chunk. A chunk of this size means that more data follows.
const CHUNK: usize = 400;
/// Maximum size of the complete base64 payload.
const MAX_PAYLOAD: usize = 8192;

/// Handle one `AUTHENTICATE` command.
pub fn handle(cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
    let Some(arg) = msg.param(0).map(str::to_string) else {
        cx.numeric(
            uid,
            numeric::ERR_NEEDMOREPARAMS,
            vec!["AUTHENTICATE".into(), "Not enough parameters".into()],
        );
        return;
    };
    let Some(u) = cx.world.user(uid) else {
        return;
    };
    let in_progress = u.reg.sasl.is_some();
    let logged_in = u.account.is_some();

    if arg == "*" {
        clear(cx, uid);
        cx.numeric(
            uid,
            numeric::ERR_SASLABORTED,
            vec!["SASL authentication aborted".into()],
        );
        return;
    }
    if logged_in {
        clear(cx, uid);
        cx.numeric(
            uid,
            numeric::ERR_SASLALREADY,
            vec!["You have already authenticated using SASL".into()],
        );
        return;
    }

    if !in_progress {
        let mech = arg.to_ascii_uppercase();
        if mech != "PLAIN" {
            cx.numeric(
                uid,
                numeric::RPL_SASLMECHS,
                vec!["PLAIN".into(), "are available SASL mechanisms".into()],
            );
            fail(cx, uid);
            return;
        }
        if let Some(u) = cx.world.user_mut(uid) {
            u.reg.sasl = Some(SaslState {
                mechanism: mech,
                buffer: String::new(),
            });
        }
        cx.send(uid, Message::new("AUTHENTICATE", vec!["+".into()]));
        return;
    }

    if arg.len() > CHUNK {
        too_long(cx, uid);
        return;
    }
    let done = arg.len() < CHUNK;
    let buffer = {
        let Some(state) = cx.world.user_mut(uid).and_then(|u| u.reg.sasl.as_mut()) else {
            return;
        };
        if arg != "+" {
            state.buffer.push_str(&arg);
        }
        if state.buffer.len() > MAX_PAYLOAD {
            None
        } else if done {
            Some(Some(std::mem::take(&mut state.buffer)))
        } else {
            Some(None)
        }
    };
    let payload = match buffer {
        None => {
            too_long(cx, uid);
            return;
        }
        Some(None) => return,
        Some(Some(p)) => p,
    };
    clear(cx, uid);

    match verify_plain(cx, &payload) {
        Some(account) => succeed(cx, uid, account),
        None => fail(cx, uid),
    }
}

/// Decode a PLAIN payload and check it. Returns the account on success.
fn verify_plain(cx: &Cx<'_>, payload: &str) -> Option<String> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(payload.as_bytes())
        .ok()?;
    let mut parts = raw.split(|b| *b == 0);
    let authzid = std::str::from_utf8(parts.next()?).ok()?;
    let authcid = std::str::from_utf8(parts.next()?).ok()?;
    let password = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    if !authzid.is_empty() && authzid != authcid {
        return None;
    }

    let (account, hash) = {
        let secrets = cx.state.secrets.read();
        let op = secrets.operator.as_ref()?;
        (op.account.clone(), op.password_hash.clone())
    };
    if authcid != account {
        return None;
    }
    // TODO: Argon2 verification is CPU-heavy and runs under the world lock.
    // Move it to a blocking task when more accounts use SASL.
    let parsed = PasswordHash::new(&hash).ok()?;
    Argon2::default()
        .verify_password(password, &parsed)
        .ok()
        .map(|()| account)
}

fn succeed(cx: &mut Cx<'_>, uid: UserId, account: String) {
    let Some(u) = cx.world.user_mut(uid) else {
        return;
    };
    u.account = Some(account.clone());
    u.role = Role::Operator;
    let source = u.source();
    cx.numeric(
        uid,
        numeric::RPL_LOGGEDIN,
        vec![
            source,
            account.clone(),
            format!("You are now logged in as {account}"),
        ],
    );
    cx.numeric(
        uid,
        numeric::RPL_SASLSUCCESS,
        vec!["SASL authentication successful".into()],
    );
}

fn fail(cx: &mut Cx<'_>, uid: UserId) {
    clear(cx, uid);
    cx.numeric(
        uid,
        numeric::ERR_SASLFAIL,
        vec!["SASL authentication failed".into()],
    );
}

fn too_long(cx: &mut Cx<'_>, uid: UserId) {
    clear(cx, uid);
    cx.numeric(
        uid,
        numeric::ERR_SASLTOOLONG,
        vec!["SASL message too long".into()],
    );
}

fn clear(cx: &mut Cx<'_>, uid: UserId) {
    if let Some(u) = cx.world.user_mut(uid) {
        u.reg.sasl = None;
    }
}
