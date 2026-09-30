//! Server side of the link protocol (docs/link-protocol.md).
//!
//! File layout (one responsibility each):
//! - `session.rs`: connection task: handshake, authentication, rate limit,
//!   replacement, state machine, keepalive, verb dispatch, disconnect.
//! - `accounts.rs`: INTRODUCE, RENAME, RETIRE, STATE, family channels,
//!   restore after server restart, dormant presence, membership persistence,
//!   inactivity retirement.
//! - `send.rs`: SEND (inner client commands), SEND flood control, SENT/SENDFAIL
//!   acks, delivery cursor updates.
//! - `replay.rs`: the server burst (BURST, extension lines, replay, ENDBURST)
//!   and attaching the link handle to its accounts.
//!
//! Locking: never call a `LinkExtension` method while the world lock is held.

pub mod accounts;
pub mod replay;
pub mod send;
pub mod session;

use crate::config::Config;
use crate::conn::LineConn;
use crate::module::{Cx, Flow, MessageEvent, Module};
use crate::modules::hub::{LinkEntry, LinkHub};
use crate::state::SharedState;
use crate::user::UserId;
use agent_comms_proto::Message;
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

/// State shared by all link sessions and the module hooks.
pub struct LinkShared {
    pub hub: Arc<LinkHub>,
    pub config: Config,
    /// Failed handshakes for each source address (timestamps in the last minute).
    pub auth_failures: parking_lot::Mutex<HashMap<IpAddr, Vec<Instant>>>,
    /// While a SEND of a PRIVMSG/NOTICE/TAGMSG runs for a virtual user, the
    /// msgid of the event that the user produced (filled by `on_message`).
    pub captured: parking_lot::Mutex<HashMap<UserId, String>>,
    /// Set after stored accounts were restored as dormant users.
    pub restored: AtomicBool,
    /// Last inactivity-retirement check.
    pub last_inactivity_check: parking_lot::Mutex<Option<Instant>>,
    /// SEND flood state for each link name, created on the first SEND.
    /// Kept across reconnects, so that a reconnect does not refill it.
    pub link_flood: parking_lot::Mutex<HashMap<String, send::LinkFlood>>,
    /// SEND message bucket and last use for each account (folded ID).
    pub account_flood: parking_lot::Mutex<HashMap<String, send::AccountFlood>>,
}

/// Link protocol states (section 2.6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkPhase {
    Linked,
    Bursting,
    Syncing,
    Established,
}

/// Per-connection context, owned by the session task.
pub struct LinkCtx {
    pub entry: LinkEntry,
    pub phase: LinkPhase,
    /// Accounts (original case) introduced in the current burst or later.
    pub accounts: Vec<String>,
}

impl LinkCtx {
    /// Queue one line to this link (ignored when the queue is closed).
    pub fn send(&self, m: &Message) {
        self.entry.handle.tx.send_line(&m.to_line());
    }

    /// Queue a reply that copies the label of `req` (section 5).
    pub fn reply(&self, req: &Message, m: Message) {
        let m = match req.tag("label").filter(|l| !l.is_empty()) {
            Some(l) => m.with_tag("label", Some(l.to_string())),
            None => m,
        };
        self.send(&m);
    }

    /// `FAIL <verb> <code> [<context>...] :<description>` with the request label.
    pub fn fail(&self, req: &Message, code: &str, context: &[&str], description: &str) {
        let mut params = vec![req.command_upper(), code.to_string()];
        params.extend(context.iter().map(|s| s.to_string()));
        params.push(description.to_string());
        self.reply(req, Message::new("FAIL", params));
    }

    /// True when this link can act for `account`: the link is attached to it
    /// (it introduced the account, and did not disconnect since).
    pub fn owns(&self, shared: &LinkShared, account: &str) -> bool {
        shared.hub.is_attached(account, &self.entry.name)
    }
}

pub struct LinkModule {
    shared: Arc<LinkShared>,
}

impl LinkModule {
    pub fn new(hub: Arc<LinkHub>, config: &Config) -> LinkModule {
        LinkModule {
            shared: Arc::new(LinkShared {
                hub,
                config: config.clone(),
                auth_failures: parking_lot::Mutex::new(HashMap::new()),
                captured: parking_lot::Mutex::new(HashMap::new()),
                restored: AtomicBool::new(false),
                last_inactivity_check: parking_lot::Mutex::new(None),
                link_flood: parking_lot::Mutex::new(HashMap::new()),
                account_flood: parking_lot::Mutex::new(HashMap::new()),
            }),
        }
    }
}

impl Module for LinkModule {
    fn name(&self) -> &'static str {
        "link"
    }

    fn take_link(&self, state: SharedState, conn: LineConn, first: Message) -> Option<LineConn> {
        session::spawn(self.shared.clone(), state, conn, first);
        None
    }

    fn on_message(&self, cx: &mut Cx<'_>, ev: &mut MessageEvent) -> Flow {
        send::on_message(&self.shared, cx, ev);
        Flow::Continue
    }

    fn on_stored(&self, cx: &mut Cx<'_>, ev: &MessageEvent, recipients: &[UserId]) {
        send::on_stored(&self.shared, cx, ev, recipients);
    }

    fn on_join(&self, cx: &mut Cx<'_>, user: UserId, channel: &str) {
        accounts::on_join(&self.shared, cx, user, channel);
    }

    fn on_part(&self, cx: &mut Cx<'_>, user: UserId, channel: &str) {
        accounts::on_part(&self.shared, cx, user, channel);
    }

    fn on_secrets_reloaded(&self, _state: &SharedState, links_changed: bool) -> usize {
        if links_changed {
            self.shared.hub.close_all("credentials changed")
        } else {
            0
        }
    }

    fn on_tick(&self, state: &SharedState, now: std::time::SystemTime) {
        accounts::on_tick(&self.shared, state, now);
    }
}
