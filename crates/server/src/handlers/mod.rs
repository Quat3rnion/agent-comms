//! Command handlers. This is a stub; later work replaces it.

use crate::module::Cx;
use crate::user::UserId;
use agent_comms_proto::{numeric, Message};

/// Route one command from a user.
pub fn dispatch(cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
    cx.numeric(
        uid,
        numeric::ERR_UNKNOWNCOMMAND,
        vec![msg.command.clone(), "Unknown command".into()],
    );
}

/// Called after a user completes registration.
pub fn on_registered(_cx: &mut Cx<'_>, _uid: UserId) {}
