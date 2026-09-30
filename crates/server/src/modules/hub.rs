//! Link directory and extension points shared by the link, claims, and agent
//! modules. This file is a contract between those modules.
//!
//! Lock order: a caller MAY hold the world lock when it calls a `LinkHub`
//! method. `LinkHub` methods never lock the world. The link module MUST NOT
//! hold the world lock when it calls a `LinkExtension` method, because
//! extensions lock the world themselves.

use crate::state::{SharedState, World};
use crate::store::Store;
use crate::user::{LinkHandle, Sink};
use crate::util::fold;
use agent_comms_proto::Message;
use std::collections::HashMap;
use std::sync::Arc;

/// One connected link.
#[derive(Clone)]
pub struct LinkEntry {
    /// Link name from `LINK` (unique).
    pub name: String,
    /// Owner of the credential that the link used.
    pub owner: String,
    /// Outbound queue of the link connection.
    pub handle: LinkHandle,
    /// True after the server sent its `ENDBURST` to this link.
    pub established: bool,
}

/// Hooks that the link module calls. Claims and agent modules implement it.
pub trait LinkExtension: Send + Sync + 'static {
    /// A link verb that the link module does not handle itself (for example
    /// `CLAIM`, `RELEASE`, `AGENTREPLY`, `AGENTEND`). Return true when handled.
    fn on_link_verb(&self, _state: &SharedState, _link: &LinkEntry, _msg: &Message) -> bool {
        false
    }
    /// Lines for the server burst, sent after `BURST` and before the replay
    /// (for example `CLAIMSET` for every claim).
    fn burst_lines(&self, _state: &SharedState) -> Vec<Message> {
        Vec::new()
    }
    /// The server sent `ENDBURST` to this link.
    fn on_link_up(&self, _state: &SharedState, _link: &LinkEntry) {}
    /// The link connection closed (or was replaced).
    fn on_link_down(&self, _state: &SharedState, _link_name: &str) {}
    /// `STATE <account> busy|idle` from the owner link.
    fn on_account_state(&self, _state: &SharedState, _account: &str, _busy: bool) {}
    /// The account now has the nick `nick` (after `INTRODUCE` or `RENAME`).
    fn on_account_nick(&self, _state: &SharedState, _account: &str, _nick: &str) {}
    /// The account retired (by `RETIRE` or by inactivity).
    fn on_account_retired(&self, _state: &SharedState, _account: &str) {}
}

/// Directory of connected links plus registered extensions.
pub struct LinkHub {
    links: parking_lot::Mutex<HashMap<String, LinkEntry>>,
    exts: parking_lot::RwLock<Vec<Arc<dyn LinkExtension>>>,
    store: Option<Arc<Store>>,
}

impl LinkHub {
    pub fn new(store: Option<Arc<Store>>) -> LinkHub {
        LinkHub {
            links: parking_lot::Mutex::new(HashMap::new()),
            exts: parking_lot::RwLock::new(Vec::new()),
            store,
        }
    }

    /// Shared SQLite store, when persistence is enabled.
    pub fn store(&self) -> Option<&Arc<Store>> {
        self.store.as_ref()
    }

    pub fn register_extension(&self, ext: Arc<dyn LinkExtension>) {
        self.exts.write().push(ext);
    }

    /// Snapshot of the extensions (call them without holding any lock).
    pub fn extensions(&self) -> Vec<Arc<dyn LinkExtension>> {
        self.exts.read().clone()
    }

    /// Add or replace a link. Returns the replaced entry.
    pub fn insert(&self, entry: LinkEntry) -> Option<LinkEntry> {
        self.links.lock().insert(entry.name.clone(), entry)
    }

    /// Remove a link, but only if its handle is still `handle` (a newer link
    /// with the same name is kept).
    pub fn remove_if_current(&self, name: &str, handle: &LinkHandle) -> bool {
        let mut links = self.links.lock();
        match links.get(name) {
            Some(e) if e.handle.tx.same_channel(&handle.tx) => {
                links.remove(name);
                true
            }
            _ => false,
        }
    }

    pub fn get(&self, name: &str) -> Option<LinkEntry> {
        self.links.lock().get(name).cloned()
    }

    pub fn set_established(&self, name: &str, established: bool) {
        if let Some(e) = self.links.lock().get_mut(name) {
            e.established = established;
        }
    }

    /// All links whose server burst is complete.
    pub fn established(&self) -> Vec<LinkEntry> {
        self.links
            .lock()
            .values()
            .filter(|e| e.established)
            .cloned()
            .collect()
    }

    /// Send one line to every established link.
    pub fn broadcast(&self, msg: &Message) {
        let line = msg.to_line();
        for e in self.links.lock().values().filter(|e| e.established) {
            e.handle.tx.send_line(&line);
        }
    }

    /// Send one line to every established link except `except`, and send
    /// `labeled` (the same line with a label) to `except` when it is Some.
    pub fn broadcast_labeled(&self, msg: &Message, requester: Option<(&str, Option<&str>)>) {
        let plain = msg.to_line();
        for e in self.links.lock().values().filter(|e| e.established) {
            match requester {
                Some((name, Some(label))) if e.name == name => {
                    let l = msg.clone().with_tag("label", Some(label.to_string()));
                    e.handle.tx.send_line(&l.to_line());
                }
                _ => {
                    e.handle.tx.send_line(&plain);
                }
            }
        }
    }

    /// Send one line to the named link (established or not). Returns false
    /// when the link is not connected.
    pub fn send(&self, name: &str, msg: &Message) -> bool {
        match self.links.lock().get(name) {
            Some(e) => e.handle.tx.send_line(&msg.to_line()),
            None => false,
        }
    }
}

/// The link handle of the link that owns `account` now, if it is connected.
pub fn link_of_account(world: &World, account: &str) -> Option<LinkHandle> {
    let uid = world.accounts.get(&fold(account))?;
    match &world.user(*uid)?.sink {
        Sink::Virtual { link, .. } => link.clone(),
        Sink::Socket(_) => None,
    }
}
