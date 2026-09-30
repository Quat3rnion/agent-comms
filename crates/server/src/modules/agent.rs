//! `AGENT` verb: the operator asks links about their agents (section 9 of the
//! link protocol).
//!
//! Lock order: world lock, then `inner`. Code that holds `inner` MUST NOT lock
//! the world.

use crate::config::Config;
use crate::module::{Cx, Flow, Module};
use crate::modules::hub::{link_of_account, LinkEntry, LinkExtension, LinkHub};
use crate::state::SharedState;
use crate::user::{Role, Sink, UserId};
use crate::util::fold;
use agent_comms_proto::{numeric, Message};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Maximum length in bytes of a relayed reply text.
const MAX_REPLY_BYTES: usize = 400;

const VERBS: &[&str] = &["STATUS", "INTERRUPT", "RESUME"];

/// One request on a link that has no `AGENTEND` yet.
struct Pending {
    op_id: u64,
    account: String,
    nick: String,
    link: String,
    deadline: Instant,
}

/// One `AGENT` command of an operator.
struct Operation {
    operator: UserId,
    verb: String,
    remaining: usize,
}

#[derive(Default)]
struct Inner {
    pending: HashMap<String, Pending>,
    ops: HashMap<u64, Operation>,
    next_op: u64,
}

/// A notice to an operator: (operator, text).
type Notice = (UserId, String);

pub struct AgentModule {
    hub: Arc<LinkHub>,
    timeout: Duration,
    inner: parking_lot::Mutex<Inner>,
    next_id: AtomicU64,
}

/// Request ID for the counter value `n`. It uses only `[A-Za-z0-9]`.
fn request_id(n: u64) -> String {
    format!("r{n}")
}

/// Remove CR and LF, then cut to `max` bytes on a char boundary.
fn clean_text(text: &str, max: usize) -> String {
    let mut s: String = text.chars().filter(|c| *c != '\r' && *c != '\n').collect();
    if s.len() > max {
        let mut end = max;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
    }
    s
}

fn tagged(nick: &str, text: &str) -> String {
    format!("[{nick}] {text}")
}

fn end_text(verb: &str) -> String {
    format!("end of AGENT {verb}")
}

/// Send notices from the server to operators. Gone operators are skipped.
fn deliver(cx: &mut Cx<'_>, notices: Vec<Notice>) {
    for (uid, text) in notices {
        let Some(nick) = cx.world.user(uid).map(|u| u.nick.clone()) else {
            continue;
        };
        let m = Message::new("NOTICE", vec![nick, text]).with_source(cx.server_name().to_string());
        cx.send(uid, m);
    }
}

impl Inner {
    /// Mark request `id` complete. Adds the final notice when its operation
    /// is complete. Returns false when the ID is unknown.
    fn complete(&mut self, id: &str, out: &mut Vec<Notice>) -> bool {
        let Some(p) = self.pending.remove(id) else {
            return false;
        };
        self.finish_one(p.op_id, out);
        true
    }

    fn finish_one(&mut self, op_id: u64, out: &mut Vec<Notice>) {
        let done = match self.ops.get_mut(&op_id) {
            Some(op) => {
                op.remaining = op.remaining.saturating_sub(1);
                op.remaining == 0
            }
            None => false,
        };
        if done {
            if let Some(op) = self.ops.remove(&op_id) {
                out.push((op.operator, end_text(&op.verb)));
            }
        }
    }
}

impl AgentModule {
    pub fn new(hub: Arc<LinkHub>, config: &Config) -> Arc<AgentModule> {
        Arc::new(AgentModule {
            hub,
            timeout: Duration::from_secs(config.limits.agent_request_timeout_secs),
            inner: parking_lot::Mutex::new(Inner::default()),
            next_id: AtomicU64::new(1),
        })
    }

    fn next_request_id(&self) -> String {
        request_id(self.next_id.fetch_add(1, Ordering::Relaxed))
    }

    fn notice(cx: &mut Cx<'_>, uid: UserId, text: String) {
        deliver(cx, vec![(uid, text)]);
    }

    /// Collect the (account, nick) targets. Returns None when an error was
    /// sent.
    fn targets(
        cx: &mut Cx<'_>,
        uid: UserId,
        verb: &str,
        target: &str,
    ) -> Option<Vec<(String, String)>> {
        if verb == "STATUS" && target.starts_with('#') {
            let folded = fold(target);
            if !cx.world.channels.contains_key(&folded) {
                cx.numeric(
                    uid,
                    numeric::ERR_NOSUCHCHANNEL,
                    vec![target.to_string(), "No such channel".into()],
                );
                return None;
            }
            let mut members = cx.world.channel_members(&folded);
            members.sort();
            let out = members
                .into_iter()
                .filter_map(|m| cx.world.user(m))
                .filter_map(|u| match &u.sink {
                    Sink::Virtual { account, .. } => Some((account.clone(), u.nick.clone())),
                    Sink::Socket(_) => None,
                })
                .collect();
            return Some(out);
        }
        let Some(tuid) = cx.world.find_nick(target) else {
            cx.numeric(
                uid,
                numeric::ERR_NOSUCHNICK,
                vec![target.to_string(), "No such nick".into()],
            );
            return None;
        };
        let (account, nick) = match cx.world.user(tuid) {
            Some(u) => match &u.sink {
                Sink::Virtual { account, .. } => (Some(account.clone()), u.nick.clone()),
                Sink::Socket(_) => (None, u.nick.clone()),
            },
            None => (None, target.to_string()),
        };
        match account {
            Some(a) => Some(vec![(a, nick)]),
            None => {
                Self::notice(cx, uid, tagged(&nick, "not an agent"));
                // An empty target list completes the operation at once, so
                // the operator still gets "end of AGENT <verb>".
                Some(Vec::new())
            }
        }
    }

    fn handle_agent(&self, cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
        let role = cx.world.user(uid).map(|u| u.role);
        if role != Some(Role::Operator) {
            cx.numeric(
                uid,
                numeric::ERR_NOPRIVILEGES,
                vec!["Permission Denied- You're not an IRC operator".into()],
            );
            return;
        }
        let (Some(verb), Some(target)) = (msg.param(0), msg.param(1)) else {
            cx.numeric(
                uid,
                numeric::ERR_NEEDMOREPARAMS,
                vec!["AGENT".into(), "Not enough parameters".into()],
            );
            return;
        };
        if target.is_empty() {
            cx.numeric(
                uid,
                numeric::ERR_NEEDMOREPARAMS,
                vec!["AGENT".into(), "Not enough parameters".into()],
            );
            return;
        }
        let verb = verb.to_ascii_uppercase();
        if !VERBS.contains(&verb.as_str()) {
            Self::notice(cx, uid, "unknown AGENT verb".to_string());
            return;
        }
        let Some(targets) = Self::targets(cx, uid, &verb, target) else {
            return;
        };

        let mut notices: Vec<Notice> = Vec::new();
        {
            let mut inner = self.inner.lock();
            inner.next_op += 1;
            let op_id = inner.next_op;
            inner.ops.insert(
                op_id,
                Operation {
                    operator: uid,
                    verb: verb.clone(),
                    remaining: targets.len(),
                },
            );
            if targets.is_empty() {
                inner.ops.remove(&op_id);
                notices.push((uid, end_text(&verb)));
            }
            let deadline = Instant::now() + self.timeout;
            for (account, nick) in targets {
                let sent = match link_of_account(cx.world, &account) {
                    Some(handle) => {
                        let id = self.next_request_id();
                        let m =
                            Message::new("AGENT", vec![id.clone(), verb.clone(), account.clone()]);
                        let ok = if self.hub.get(&handle.name).is_some() {
                            self.hub.send(&handle.name, &m)
                        } else {
                            handle.tx.send_line(&m.to_line())
                        };
                        if ok {
                            inner.pending.insert(
                                id,
                                Pending {
                                    op_id,
                                    account: account.clone(),
                                    nick: nick.clone(),
                                    link: handle.name.clone(),
                                    deadline,
                                },
                            );
                            true
                        } else {
                            false
                        }
                    }
                    None => false,
                };
                if !sent {
                    notices.push((uid, tagged(&nick, "dormant (link offline)")));
                    inner.finish_one(op_id, &mut notices);
                }
            }
        }
        deliver(cx, notices);
    }
}

impl Module for AgentModule {
    fn name(&self) -> &'static str {
        "agent"
    }

    fn on_command(&self, cx: &mut Cx<'_>, uid: UserId, msg: &Message) -> Flow {
        if msg.command_upper() != "AGENT" {
            return Flow::Continue;
        }
        match cx.world.user(uid) {
            Some(u) if u.registered => {}
            _ => return Flow::Continue,
        }
        self.handle_agent(cx, uid, msg);
        Flow::Handled
    }

    fn on_tick(&self, state: &SharedState, _now: std::time::SystemTime) {
        let now = Instant::now();
        let mut notices: Vec<Notice> = Vec::new();
        {
            let mut inner = self.inner.lock();
            let expired: Vec<String> = inner
                .pending
                .iter()
                .filter(|(_, p)| p.deadline <= now)
                .map(|(id, _)| id.clone())
                .collect();
            for id in expired {
                if let Some(p) = inner.pending.get(&id) {
                    let op_id = p.op_id;
                    let nick = p.nick.clone();
                    if let Some(op) = inner.ops.get(&op_id) {
                        notices.push((op.operator, tagged(&nick, "no reply")));
                    }
                    inner.complete(&id, &mut notices);
                }
            }
        }
        if !notices.is_empty() {
            state.with_world(|cx| deliver(cx, notices));
        }
    }
}

impl LinkExtension for AgentModule {
    fn on_link_verb(&self, state: &SharedState, link: &LinkEntry, msg: &Message) -> bool {
        let mut notices: Vec<Notice> = Vec::new();
        match msg.command_upper().as_str() {
            "AGENTREPLY" => {
                let (Some(id), Some(account)) = (msg.param(0), msg.param(1)) else {
                    return true;
                };
                let text = clean_text(msg.param(2).unwrap_or(""), MAX_REPLY_BYTES);
                let inner = self.inner.lock();
                if let Some(p) = inner.pending.get(id) {
                    if p.link == link.name && fold(&p.account) == fold(account) {
                        if let Some(op) = inner.ops.get(&p.op_id) {
                            notices.push((op.operator, tagged(&p.nick, &text)));
                        }
                    }
                }
            }
            "AGENTEND" => {
                let Some(id) = msg.param(0) else {
                    return true;
                };
                let mut inner = self.inner.lock();
                let owned = inner.pending.get(id).is_some_and(|p| p.link == link.name);
                if owned {
                    inner.complete(id, &mut notices);
                }
            }
            "FAIL" => {
                if !msg
                    .param(0)
                    .is_some_and(|c| c.eq_ignore_ascii_case("AGENT"))
                {
                    return false;
                }
            }
            _ => return false,
        }
        if !notices.is_empty() {
            state.with_world(|cx| deliver(cx, notices));
        }
        true
    }

    fn on_link_down(&self, state: &SharedState, link_name: &str) {
        let mut notices: Vec<Notice> = Vec::new();
        {
            let mut inner = self.inner.lock();
            let mut ids: Vec<String> = inner
                .pending
                .iter()
                .filter(|(_, p)| p.link == link_name)
                .map(|(id, _)| id.clone())
                .collect();
            ids.sort();
            for id in ids {
                if let Some(p) = inner.pending.get(&id) {
                    let nick = p.nick.clone();
                    if let Some(op) = inner.ops.get(&p.op_id) {
                        notices.push((op.operator, tagged(&nick, "dormant (link offline)")));
                    }
                    inner.complete(&id, &mut notices);
                }
            }
        }
        if !notices.is_empty() {
            state.with_world(|cx| deliver(cx, notices));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_alphanumeric() {
        let id = request_id(42);
        assert_eq!(id, "r42");
        assert!(id.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn ids_are_unique() {
        let n = AtomicU64::new(1);
        let a = request_id(n.fetch_add(1, Ordering::Relaxed));
        let b = request_id(n.fetch_add(1, Ordering::Relaxed));
        assert_ne!(a, b);
    }

    #[test]
    fn cut_short_text_unchanged() {
        assert_eq!(clean_text("idle", 400), "idle");
    }

    #[test]
    fn cut_removes_cr_lf() {
        assert_eq!(clean_text("a\r\nb\nc", 400), "abc");
    }

    #[test]
    fn cut_at_byte_limit() {
        let s = "x".repeat(500);
        assert_eq!(clean_text(&s, 400).len(), 400);
    }

    #[test]
    fn cut_on_char_boundary() {
        // "é" is 2 bytes; 399 ASCII bytes + "é" would be 401.
        let s = format!("{}é", "x".repeat(399));
        let out = clean_text(&s, 400);
        assert_eq!(out.len(), 399);
        assert!(out.is_char_boundary(out.len()));
    }

    #[test]
    fn operation_completes_once() {
        let mut inner = Inner::default();
        inner.ops.insert(
            1,
            Operation {
                operator: UserId(7),
                verb: "STATUS".into(),
                remaining: 2,
            },
        );
        for id in ["r1", "r2"] {
            inner.pending.insert(
                id.into(),
                Pending {
                    op_id: 1,
                    account: "a".into(),
                    nick: "n".into(),
                    link: "l".into(),
                    deadline: Instant::now(),
                },
            );
        }
        let mut out = Vec::new();
        assert!(inner.complete("r1", &mut out));
        assert!(out.is_empty());
        assert!(!inner.complete("r1", &mut out));
        assert!(inner.complete("r2", &mut out));
        assert_eq!(out, vec![(UserId(7), "end of AGENT STATUS".to_string())]);
        assert!(inner.ops.is_empty());
    }
}
