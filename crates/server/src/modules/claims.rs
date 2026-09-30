//! File claims (link protocol section 8): `CLAIM` and `RELEASE` from links,
//! `CLAIMSET` / `CLAIMFAIL` / `CLAIMDEL` to links, deadlines, and the operator
//! commands `CLAIMS`, `CLAIM --force`, and `RELEASE`.
//!
//! Lock order: every change to the claim set runs with the world lock held
//! (through `with_world`, or the `Cx` of `on_command`). The in-memory map lock
//! is taken only inside the world lock, and is never held across a hub call.

use crate::config::Config;
use crate::module::{Cx, Flow, Module};
use crate::modules::hub::{link_of_account, LinkEntry, LinkExtension, LinkHub};
use crate::state::{SharedState, World};
use crate::store::ClaimRow;
use crate::user::{Role, UserId};
use crate::util::{fold, unix_now};
use agent_comms_proto::numeric::{ERR_NEEDMOREPARAMS, ERR_NOPRIVILEGES};
use agent_comms_proto::Message;
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// Maximum length of a parent chain that `same_family` walks.
const MAX_DEPTH: usize = 64;

/// Maximum length of a claim path, in bytes.
const MAX_PATH_BYTES: usize = 4096;

pub struct ClaimsModule {
    hub: Arc<LinkHub>,
    idle_secs: u64,
    /// Claims by path, used when the hub has no store.
    mem: Mutex<HashMap<String, ClaimRow>>,
    /// Unix second of the last expiry check.
    last_expiry_check: Mutex<i64>,
}

/// Root ancestor of `uid` (the user itself when it has no parent).
fn root_of(world: &World, uid: UserId) -> UserId {
    let mut cur = uid;
    for _ in 0..MAX_DEPTH {
        match world.user(cur).and_then(|u| u.parent) {
            Some(p) => cur = p,
            None => break,
        }
    }
    cur
}

/// Family check: both accounts have the same root ancestor (walk parents via
/// the world; unknown → only equal to itself).
pub fn same_family(world: &World, a: &str, b: &str) -> bool {
    if fold(a) == fold(b) {
        return true;
    }
    match (world.find_account(a), world.find_account(b)) {
        (Some(ua), Some(ub)) => root_of(world, ua) == root_of(world, ub),
        _ => false,
    }
}

/// Path rule of section 8.1: absolute, not empty, at most 4096 bytes, no NUL,
/// CR, or LF, and no `.` or `..` component.
fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= MAX_PATH_BYTES
        && path.starts_with('/')
        && !path.contains(['\0', '\r', '\n'])
        && !path.split('/').any(|c| c == "." || c == "..")
}

fn claimset(c: &ClaimRow) -> Message {
    Message::new(
        "CLAIMSET",
        vec![
            c.holder_account.clone(),
            c.holder_nick.clone(),
            c.since.to_string(),
            c.deadline.to_string(),
            c.path.clone(),
        ],
    )
}

fn claimdel(path: &str) -> Message {
    Message::new("CLAIMDEL", vec![path.to_string()])
}

fn labeled(msg: Message, label: Option<&str>) -> Message {
    match label {
        Some(l) => msg.with_tag("label", Some(l.to_string())),
        None => msg,
    }
}

fn fail(verb: &str, code: &str, account: &str, text: &str) -> Message {
    Message::new(
        "FAIL",
        vec![
            verb.to_string(),
            code.to_string(),
            account.to_string(),
            text.to_string(),
        ],
    )
}

impl ClaimsModule {
    pub fn new(hub: Arc<LinkHub>, config: &Config) -> Arc<ClaimsModule> {
        Arc::new(ClaimsModule {
            hub,
            idle_secs: config.limits.claim_idle_secs,
            mem: Mutex::new(HashMap::new()),
            last_expiry_check: Mutex::new(0),
        })
    }

    fn deadline_from(&self, now: i64) -> i64 {
        now.saturating_add(i64::try_from(self.idle_secs).unwrap_or(i64::MAX))
    }

    // ---- storage (SQLite when the hub has a store, else memory) ----

    fn get(&self, path: &str) -> Option<ClaimRow> {
        match self.hub.store() {
            Some(s) => s.get_claim(path).unwrap_or_else(|e| {
                tracing::warn!("claims: get_claim failed: {e}");
                None
            }),
            None => self.mem.lock().get(path).cloned(),
        }
    }

    fn put(&self, claim: &ClaimRow) {
        match self.hub.store() {
            Some(s) => {
                if let Err(e) = s.put_claim(claim) {
                    tracing::warn!("claims: put_claim failed: {e}");
                }
            }
            None => {
                self.mem.lock().insert(claim.path.clone(), claim.clone());
            }
        }
    }

    fn delete(&self, path: &str) -> bool {
        match self.hub.store() {
            Some(s) => s.delete_claim(path).unwrap_or_else(|e| {
                tracing::warn!("claims: delete_claim failed: {e}");
                false
            }),
            None => self.mem.lock().remove(path).is_some(),
        }
    }

    /// All claims, ordered by path.
    fn all(&self) -> Vec<ClaimRow> {
        match self.hub.store() {
            Some(s) => s.claims().unwrap_or_else(|e| {
                tracing::warn!("claims: claims failed: {e}");
                Vec::new()
            }),
            None => {
                let mut v: Vec<ClaimRow> = self.mem.lock().values().cloned().collect();
                v.sort_by(|a, b| a.path.cmp(&b.path));
                v
            }
        }
    }

    /// Claims held by `account` (casefolded compare).
    fn of(&self, account: &str) -> Vec<ClaimRow> {
        let f = fold(account);
        self.all()
            .into_iter()
            .filter(|c| fold(&c.holder_account) == f)
            .collect()
    }

    fn expired(&self, now: i64) -> Vec<ClaimRow> {
        match self.hub.store() {
            Some(s) => s.expired_claims(now).unwrap_or_else(|e| {
                tracing::warn!("claims: expired_claims failed: {e}");
                Vec::new()
            }),
            None => {
                let mut v: Vec<ClaimRow> = self
                    .mem
                    .lock()
                    .values()
                    .filter(|c| c.deadline <= now)
                    .cloned()
                    .collect();
                v.sort_by(|a, b| a.path.cmp(&b.path));
                v
            }
        }
    }

    // ---- shared actions ----

    /// Remove the claim on `path` and broadcast `CLAIMDEL`. Returns true when
    /// a claim existed.
    fn remove_and_announce(&self, path: &str, requester: Option<(&str, Option<&str>)>) -> bool {
        if self.delete(path) {
            self.hub.broadcast_labeled(&claimdel(path), requester);
            true
        } else {
            false
        }
    }

    fn expire(&self, now: i64) {
        for c in self.expired(now) {
            // Re-read: a refresh can have moved the deadline.
            if self.get(&c.path).is_some_and(|cur| cur.deadline <= now) {
                self.remove_and_announce(&c.path, None);
            }
        }
    }

    fn link_claim(&self, world: &World, link: &LinkEntry, msg: &Message) {
        let label = msg.tag("label");
        let reply = |m: Message| {
            link.handle.tx.send_line(&labeled(m, label).to_line());
        };
        if msg.params.len() < 2 {
            let account = msg.param(0).unwrap_or("*");
            reply(fail(
                "CLAIM",
                "INVALID_PARAMS",
                account,
                "Usage: CLAIM <account> <path>",
            ));
            return;
        }
        let account = msg.params[0].as_str();
        let path = msg.params[1..].join(" ");
        let Some(holder) = owned_account(world, link, account) else {
            reply(fail(
                "CLAIM",
                "UNKNOWN_ACCOUNT",
                account,
                "No such account on this link",
            ));
            return;
        };
        if !valid_path(&path) {
            reply(fail(
                "CLAIM",
                "INVALID_PATH",
                account,
                "Path must be absolute and canonical, without NUL, CR or LF, at most 4096 bytes",
            ));
            return;
        }
        let (holder_account, holder_nick) = holder;
        let now = unix_now();
        let deadline = self.deadline_from(now);
        let since = match self.get(&path) {
            None => now,
            Some(cur) if fold(&cur.holder_account) == fold(&holder_account) => cur.since,
            Some(cur) if same_family(world, &cur.holder_account, &holder_account) => now,
            Some(cur) => {
                let nick = world
                    .find_account(&cur.holder_account)
                    .and_then(|u| world.user(u))
                    .map(|u| u.nick.clone())
                    .unwrap_or(cur.holder_nick);
                reply(Message::new(
                    "CLAIMFAIL",
                    vec![account.to_string(), nick, cur.since.to_string(), path],
                ));
                return;
            }
        };
        let row = ClaimRow {
            path,
            holder_account,
            holder_nick,
            since,
            deadline,
        };
        self.put(&row);
        self.hub
            .broadcast_labeled(&claimset(&row), Some((link.name.as_str(), label)));
    }

    fn link_release(&self, world: &World, link: &LinkEntry, msg: &Message) {
        let label = msg.tag("label");
        let reply = |m: Message| {
            link.handle.tx.send_line(&labeled(m, label).to_line());
        };
        if msg.params.len() < 2 {
            let account = msg.param(0).unwrap_or("*");
            reply(fail(
                "RELEASE",
                "INVALID_PARAMS",
                account,
                "Usage: RELEASE <account> <path>",
            ));
            return;
        }
        let account = msg.params[0].as_str();
        let path = msg.params[1..].join(" ");
        if owned_account(world, link, account).is_none() {
            reply(fail(
                "RELEASE",
                "UNKNOWN_ACCOUNT",
                account,
                "No such account on this link",
            ));
            return;
        }
        match self.get(&path) {
            Some(cur) if fold(&cur.holder_account) == fold(account) => {
                self.remove_and_announce(&path, Some((link.name.as_str(), label)));
            }
            _ => reply(fail(
                "RELEASE",
                "NOT_HELD",
                account,
                "The account does not hold this path",
            )),
        }
    }

    // ---- client commands ----

    fn notice(cx: &mut Cx<'_>, uid: UserId, text: String) {
        let nick = cx
            .world
            .user(uid)
            .map(|u| u.nick.clone())
            .unwrap_or_else(|| "*".to_string());
        let m = Message::new("NOTICE", vec![nick, text]).with_source(cx.server_name().to_string());
        cx.send(uid, m);
    }

    fn cmd_claims(&self, cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
        let now = unix_now();
        let arg = (!msg.params.is_empty()).then(|| msg.params.join(" "));
        let claims: Vec<ClaimRow> = match arg.as_deref() {
            None => self.all(),
            Some(ch) if ch.starts_with('#') => {
                let members: HashSet<String> = cx
                    .world
                    .channel_members(&fold(ch))
                    .into_iter()
                    .filter_map(|m| {
                        cx.world
                            .user(m)
                            .and_then(|u| u.account.as_deref())
                            .map(fold)
                    })
                    .collect();
                self.all()
                    .into_iter()
                    .filter(|c| members.contains(&fold(&c.holder_account)))
                    .collect()
            }
            Some(path) => self.get(path).into_iter().collect(),
        };
        for c in claims.into_iter().filter(|c| c.deadline > now) {
            let nick = cx
                .world
                .find_account(&c.holder_account)
                .and_then(|u| cx.world.user(u))
                .map(|u| u.nick.clone())
                .unwrap_or(c.holder_nick);
            Self::notice(
                cx,
                uid,
                format!(
                    "{nick} holds {} since {} until {}",
                    c.path, c.since, c.deadline
                ),
            );
        }
        Self::notice(cx, uid, "end of CLAIMS".to_string());
    }

    fn cmd_force_release(&self, cx: &mut Cx<'_>, uid: UserId, path: &str) {
        if self.remove_and_announce(path, None) {
            Self::notice(cx, uid, format!("released {path}"));
        } else {
            Self::notice(cx, uid, format!("no claim on {path}"));
        }
    }
}

/// The canonical account name and current nick of `account`, when the account
/// exists and `link` may act for it (owned by this link, or not attached to
/// any link yet, as during the link burst).
fn owned_account(world: &World, link: &LinkEntry, account: &str) -> Option<(String, String)> {
    let uid = world.find_account(account)?;
    match link_of_account(world, account) {
        Some(h) if h.name != link.name => return None,
        _ => {}
    }
    let u = world.user(uid)?;
    let canonical = u.account.clone().unwrap_or_else(|| account.to_string());
    Some((canonical, u.nick.clone()))
}

impl Module for ClaimsModule {
    fn name(&self) -> &'static str {
        "claims"
    }

    fn on_command(&self, cx: &mut Cx<'_>, user: UserId, msg: &Message) -> Flow {
        let cmd = msg.command_upper();
        if !matches!(cmd.as_str(), "CLAIMS" | "CLAIM" | "RELEASE") {
            return Flow::Continue;
        }
        let Some(u) = cx.world.user(user) else {
            return Flow::Continue;
        };
        if !u.registered {
            return Flow::Continue;
        }
        let is_op = u.role == Role::Operator;
        match cmd.as_str() {
            "CLAIMS" => self.cmd_claims(cx, user, msg),
            "CLAIM" => {
                if !is_op {
                    cx.numeric(
                        user,
                        ERR_NOPRIVILEGES,
                        vec!["Permission Denied- You're not an IRC operator".to_string()],
                    );
                } else if msg.param(0) == Some("--force") && msg.params.len() >= 2 {
                    let path = msg.params[1..].join(" ");
                    self.cmd_force_release(cx, user, &path);
                } else {
                    Self::notice(cx, user, "usage: CLAIM --force <path>".to_string());
                }
            }
            _ => {
                if !is_op {
                    cx.numeric(
                        user,
                        ERR_NOPRIVILEGES,
                        vec!["Permission Denied- You're not an IRC operator".to_string()],
                    );
                } else if msg.params.is_empty() {
                    cx.numeric(
                        user,
                        ERR_NEEDMOREPARAMS,
                        vec!["RELEASE".to_string(), "Not enough parameters".to_string()],
                    );
                } else {
                    let path = msg.params.join(" ");
                    self.cmd_force_release(cx, user, &path);
                }
            }
        }
        Flow::Handled
    }

    fn on_tick(&self, state: &SharedState, now: SystemTime) {
        let now = now
            .duration_since(UNIX_EPOCH)
            .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
            .unwrap_or(0);
        {
            let mut last = self.last_expiry_check.lock();
            if *last == now {
                return;
            }
            *last = now;
        }
        if self.expired(now).is_empty() {
            return;
        }
        // The world lock serializes all changes to the claim set.
        state.with_world(|_cx| self.expire(now));
    }
}

impl LinkExtension for ClaimsModule {
    fn on_link_verb(&self, state: &SharedState, link: &LinkEntry, msg: &Message) -> bool {
        match msg.command_upper().as_str() {
            "CLAIM" => {
                state.with_world(|cx| self.link_claim(cx.world, link, msg));
                true
            }
            "RELEASE" => {
                state.with_world(|cx| self.link_release(cx.world, link, msg));
                true
            }
            _ => false,
        }
    }

    fn burst_lines(&self, _state: &SharedState) -> Vec<Message> {
        let now = unix_now();
        self.all()
            .iter()
            .filter(|c| c.deadline > now)
            .map(claimset)
            .collect()
    }

    fn on_account_state(&self, state: &SharedState, account: &str, busy: bool) {
        if !busy {
            return;
        }
        state.with_world(|_cx| {
            let deadline = self.deadline_from(unix_now());
            for mut c in self.of(account) {
                c.deadline = deadline;
                self.put(&c);
                self.hub.broadcast(&claimset(&c));
            }
        });
    }

    fn on_account_nick(&self, state: &SharedState, account: &str, nick: &str) {
        state.with_world(|_cx| {
            for mut c in self.of(account) {
                if c.holder_nick != nick {
                    c.holder_nick = nick.to_string();
                    self.put(&c);
                }
            }
        });
    }

    fn on_account_retired(&self, state: &SharedState, account: &str) {
        state.with_world(|_cx| {
            for c in self.of(account) {
                self.remove_and_announce(&c.path, None);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn world() -> World {
        let mut w = World::new();
        let root = w.create_virtual_user("ses_root", "root", "r", Role::Agent, None, None, None);
        let child = w.create_virtual_user(
            "ses_child",
            "child",
            "c",
            Role::Agent,
            Some(root),
            None,
            None,
        );
        w.create_virtual_user(
            "ses_grand",
            "grand",
            "g",
            Role::Agent,
            Some(child),
            None,
            None,
        );
        w.create_virtual_user("ses_sib", "sib", "s", Role::Agent, Some(root), None, None);
        w.create_virtual_user("ses_other", "other", "o", Role::Agent, None, None, None);
        w
    }

    #[test]
    fn family() {
        let w = world();
        assert!(same_family(&w, "ses_root", "ses_child"));
        assert!(same_family(&w, "ses_grand", "ses_root"));
        assert!(same_family(&w, "ses_grand", "ses_sib"));
        assert!(same_family(&w, "SES_CHILD", "ses_child"));
        assert!(!same_family(&w, "ses_other", "ses_root"));
        assert!(!same_family(&w, "ses_other", "ses_grand"));
        assert!(same_family(&w, "ses_unknown", "ses_unknown"));
        assert!(!same_family(&w, "ses_unknown", "ses_root"));
        assert!(!same_family(&w, "ses_unknown", "ses_nobody"));
    }

    #[test]
    fn paths() {
        assert!(valid_path("/home/dev/webapp/src/auth.rs"));
        assert!(valid_path("/home/dev/webapp/docs/API guide.md"));
        assert!(!valid_path(""));
        assert!(!valid_path("relative/path"));
        assert!(!valid_path("/a\nb"));
        assert!(!valid_path("/a\rb"));
        assert!(!valid_path("/a\0b"));
        assert!(!valid_path("/a/../b"));
        assert!(!valid_path("/a/./b"));
        assert!(valid_path(&format!("/{}", "a".repeat(MAX_PATH_BYTES - 1))));
        assert!(!valid_path(&format!("/{}", "a".repeat(MAX_PATH_BYTES))));
    }
}
