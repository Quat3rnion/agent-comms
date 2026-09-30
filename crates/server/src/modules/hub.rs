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
use std::time::Instant;

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
    /// `STATE <account> busy|idle` from an attached link.
    fn on_account_state(&self, _state: &SharedState, _account: &str, _busy: bool) {}
    /// The account now has the nick `nick` (after `INTRODUCE` or `RENAME`).
    fn on_account_nick(&self, _state: &SharedState, _account: &str, _nick: &str) {}
    /// The account retired (by `RETIRE` or by inactivity).
    fn on_account_retired(&self, _state: &SharedState, _account: &str) {}
}

/// One link attached to an account (section "Shared accounts" of the link
/// protocol). Several links can be attached to one account at the same time.
#[derive(Clone)]
pub struct Attachment {
    pub link_name: String,
    pub handle: LinkHandle,
    /// Last `STATE` from this link: true for `busy`.
    pub busy: bool,
    /// Time of the last `STATE busy` from this link.
    pub last_busy_at: Option<Instant>,
    pub attached_at: Instant,
    /// True after the server burst of the link (or when the link attached the
    /// account after its burst). Only live attachments get deliveries.
    pub live: bool,
}

/// Aggregate presence of an account over its attached links.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Presence {
    /// At least one attached link reports `busy`.
    Busy,
    /// Links are attached, and all report `idle`.
    Idle,
    /// No link is attached.
    Dormant,
}

impl Presence {
    /// The AWAY reason for this presence (`None`: not away).
    pub fn away(self) -> Option<&'static str> {
        match self {
            Presence::Busy => None,
            Presence::Idle => Some("idle"),
            Presence::Dormant => Some("dormant"),
        }
    }
}

/// Directory of connected links plus registered extensions.
pub struct LinkHub {
    links: parking_lot::Mutex<HashMap<String, LinkEntry>>,
    exts: parking_lot::RwLock<Vec<Arc<dyn LinkExtension>>>,
    store: Option<Arc<Store>>,
    /// Attached links of each account (folded account ID), in attach order.
    attached: parking_lot::Mutex<HashMap<String, Vec<Attachment>>>,
}

/// The attachment that gets the deliveries of an account: the live link with
/// the most recent busy report (a link that is busy now first), else the
/// earliest attached live link.
fn pick_primary(list: &[Attachment]) -> Option<&Attachment> {
    let mut best: Option<&Attachment> = None;
    for a in list.iter().filter(|a| a.live && !a.handle.tx.is_closed()) {
        let better = match best {
            None => true,
            Some(b) => (a.busy, a.last_busy_at) > (b.busy, b.last_busy_at),
        };
        if better {
            best = Some(a);
        }
    }
    best
}

impl LinkHub {
    pub fn new(store: Option<Arc<Store>>) -> LinkHub {
        LinkHub {
            links: parking_lot::Mutex::new(HashMap::new()),
            exts: parking_lot::RwLock::new(Vec::new()),
            store,
            attached: parking_lot::Mutex::new(HashMap::new()),
        }
    }

    // ---- account attachments ----

    /// Attach the link `handle` to `account`. An attachment of the same link
    /// name stays (idempotent); a new connection of that name replaces the
    /// handle and resets the busy state. `live`: the link gets deliveries now.
    pub fn attach(&self, account: &str, handle: &LinkHandle, live: bool) {
        let mut map = self.attached.lock();
        let list = map.entry(fold(account)).or_default();
        match list.iter_mut().find(|a| a.link_name == handle.name) {
            Some(a) if a.handle.tx.same_channel(&handle.tx) => a.live |= live,
            Some(a) => {
                a.handle = handle.clone();
                a.busy = false;
                a.last_busy_at = None;
                a.live = live;
            }
            None => list.push(Attachment {
                link_name: handle.name.clone(),
                handle: handle.clone(),
                busy: false,
                last_busy_at: None,
                attached_at: Instant::now(),
                live,
            }),
        }
    }

    /// Mark the attachment of `link_name` to `account` live. Returns false
    /// when the link is not attached.
    pub fn set_live(&self, account: &str, link_name: &str) -> bool {
        let mut map = self.attached.lock();
        match map
            .get_mut(&fold(account))
            .and_then(|l| l.iter_mut().find(|a| a.link_name == link_name))
        {
            Some(a) => {
                a.live = true;
                true
            }
            None => false,
        }
    }

    /// True when `link_name` is attached to `account`.
    pub fn is_attached(&self, account: &str, link_name: &str) -> bool {
        self.attached
            .lock()
            .get(&fold(account))
            .is_some_and(|l| l.iter().any(|a| a.link_name == link_name))
    }

    /// True when a live link other than `link_name` is attached to `account`.
    pub fn has_other_live(&self, account: &str, link_name: &str) -> bool {
        self.attached.lock().get(&fold(account)).is_some_and(|l| {
            l.iter()
                .any(|a| a.live && a.link_name != link_name && !a.handle.tx.is_closed())
        })
    }

    /// Names of the links attached to `account`, in attach order.
    pub fn attached_links(&self, account: &str) -> Vec<String> {
        self.attached
            .lock()
            .get(&fold(account))
            .map(|l| l.iter().map(|a| a.link_name.clone()).collect())
            .unwrap_or_default()
    }

    /// Record `STATE busy|idle` from `link_name`. Returns false when the link
    /// is not attached.
    pub fn set_busy(&self, account: &str, link_name: &str, busy: bool) -> bool {
        let mut map = self.attached.lock();
        match map
            .get_mut(&fold(account))
            .and_then(|l| l.iter_mut().find(|a| a.link_name == link_name))
        {
            Some(a) => {
                a.busy = busy;
                if busy {
                    a.last_busy_at = Some(Instant::now());
                }
                true
            }
            None => false,
        }
    }

    /// Handle of the primary link of `account` (the link that gets the
    /// deliveries), if any.
    pub fn primary(&self, account: &str) -> Option<LinkHandle> {
        let map = self.attached.lock();
        pick_primary(map.get(&fold(account))?).map(|a| a.handle.clone())
    }

    /// Aggregate presence of `account`.
    pub fn presence(&self, account: &str) -> Presence {
        match self.attached.lock().get(&fold(account)) {
            None => Presence::Dormant,
            Some(l) if l.is_empty() => Presence::Dormant,
            Some(l) if l.iter().any(|a| a.busy) => Presence::Busy,
            Some(_) => Presence::Idle,
        }
    }

    /// Remove the connection `handle` from every account. Returns the folded
    /// accounts that it was attached to.
    pub fn detach_link(&self, handle: &LinkHandle) -> Vec<String> {
        let mut map = self.attached.lock();
        let mut out = Vec::new();
        map.retain(|key, list| {
            let before = list.len();
            list.retain(|a| !(a.link_name == handle.name && a.handle.tx.same_channel(&handle.tx)));
            if list.len() != before {
                out.push(key.clone());
            }
            !list.is_empty()
        });
        out
    }

    /// Forget all attachments of `account`. Returns the removed link names.
    pub fn remove_account(&self, account: &str) -> Vec<String> {
        self.attached
            .lock()
            .remove(&fold(account))
            .map(|l| l.into_iter().map(|a| a.link_name).collect())
            .unwrap_or_default()
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

    /// Close every connected link (all of them must authenticate again).
    /// Returns the number of links closed.
    pub fn close_all(&self, reason: &str) -> usize {
        let links = self.links.lock();
        for e in links.values() {
            e.handle.tx.close_with(reason);
        }
        links.len()
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

/// The link handle of the primary link of `account` (the link that gets its
/// deliveries), if one is attached.
pub fn link_of_account(world: &World, account: &str) -> Option<LinkHandle> {
    let uid = world.accounts.get(&fold(account))?;
    match &world.user(*uid)?.sink {
        Sink::Virtual { link, .. } => link.clone(),
        Sink::Socket(_) => None,
    }
}
