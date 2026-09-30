//! Command handlers.

pub mod channel;
pub mod message;
pub mod query;
pub mod registration;

use crate::module::Cx;
use crate::user::UserId;
use agent_comms_proto::{numeric, Message};

/// Commands that a user can send before registration completes.
const PRE_REGISTRATION: &[&str] = &[
    "CAP",
    "NICK",
    "USER",
    "PASS",
    "PING",
    "PONG",
    "QUIT",
    "AUTHENTICATE",
];

/// Route one command from a user.
pub fn dispatch(cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
    let cmd = msg.command_upper();
    let Some(registered) = cx.world.user(uid).map(|u| u.registered) else {
        return;
    };
    if !registered {
        if PRE_REGISTRATION.contains(&cmd.as_str()) {
            registration::handle(cx, uid, msg);
        } else {
            cx.numeric(
                uid,
                numeric::ERR_NOTREGISTERED,
                vec!["You have not registered".into()],
            );
        }
        return;
    }
    let handled = registration::handle(cx, uid, msg)
        || channel::handle(cx, uid, msg)
        || message::handle(cx, uid, msg)
        || query::handle(cx, uid, msg);
    if !handled {
        cx.numeric(
            uid,
            numeric::ERR_UNKNOWNCOMMAND,
            vec![cmd, "Unknown command".into()],
        );
    }
}

/// Called after a user completes registration.
pub fn on_registered(cx: &mut Cx<'_>, uid: UserId) {
    registration::on_registered(cx, uid);
}
