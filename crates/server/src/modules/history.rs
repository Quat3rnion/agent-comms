//! Message history: storage, `CHATHISTORY`, and `MARKREAD`.

use crate::config::Config;
use crate::module::{CapSpec, Cx, Flow, MessageEvent, Module, MsgTarget};
use crate::state::SharedState;
use crate::store::{
    self, format_time_ms, parse_time, Bound, NewMessage, Store, StoreResult, StoredMessage,
    MAX_HISTORY_LIMIT,
};
use crate::user::{Sink, UserId};
use crate::util;
use agent_comms_proto::{escape_tag_value, Message};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const PURGE_INTERVAL: Duration = Duration::from_secs(3600);
const DAY_MS: i64 = 86_400_000;

pub struct HistoryModule {
    store: Arc<Store>,
    retention_days: u32,
    last_purge: Mutex<Option<Instant>>,
    /// Read markers of users without an account, in memory only. Keyed by
    /// the pseudo account key `guest:<uid>`, then by folded target.
    guest_markers: Mutex<HashMap<String, HashMap<String, i64>>>,
}

impl HistoryModule {
    pub fn new(store: Arc<Store>, config: &Config) -> Self {
        HistoryModule {
            store,
            retention_days: config.limits.history_retention_days,
            last_purge: Mutex::new(None),
            guest_markers: Mutex::new(HashMap::new()),
        }
    }
}

/// Read marker owner: an account (stored in SQLite) or a per-connection
/// pseudo account key `guest:<uid>` (stored in memory).
enum MarkerKey {
    Account(String),
    Guest(String),
}

fn guest_key(uid: UserId) -> String {
    format!("guest:{}", uid.0)
}

impl HistoryModule {
    fn marker_key(cx: &Cx<'_>, uid: UserId) -> Option<MarkerKey> {
        let u = cx.world.user(uid)?;
        Some(match &u.account {
            Some(a) => MarkerKey::Account(a.clone()),
            None => MarkerKey::Guest(guest_key(uid)),
        })
    }

    fn get_marker(&self, key: &MarkerKey, tf: &str) -> StoreResult<Option<i64>> {
        match key {
            MarkerKey::Account(a) => self.store.get_marker(a, tf),
            MarkerKey::Guest(g) => Ok(self
                .guest_markers
                .lock()
                .get(g)
                .and_then(|m| m.get(tf))
                .copied()),
        }
    }

    /// Set the marker if `ts` is newer. Returns the stored value.
    fn set_marker(&self, key: &MarkerKey, tf: &str, target: &str, ts: i64) -> StoreResult<i64> {
        match key {
            MarkerKey::Account(a) => self.store.set_marker(a, tf, target, ts),
            MarkerKey::Guest(g) => {
                let mut all = self.guest_markers.lock();
                let v = all
                    .entry(g.clone())
                    .or_default()
                    .entry(tf.to_string())
                    .or_insert(ts);
                *v = (*v).max(ts);
                Ok(*v)
            }
        }
    }
}

/// A CHATHISTORY reference: `*` or a bound.
enum Ref {
    Star,
    At(Bound),
}

fn parse_ref(s: &str) -> Option<Ref> {
    if s == "*" {
        return Some(Ref::Star);
    }
    if let Some(id) = s.strip_prefix("msgid=") {
        return (!id.is_empty()).then(|| Ref::At(Bound::MsgId(id.to_string())));
    }
    s.strip_prefix("timestamp=")
        .and_then(parse_time)
        .map(|t| Ref::At(Bound::Time(t)))
}

fn parse_bound(s: &str) -> Option<Bound> {
    match parse_ref(s)? {
        Ref::Star => None,
        Ref::At(b) => Some(b),
    }
}

fn parse_limit(s: &str) -> Option<usize> {
    s.parse::<usize>()
        .ok()
        .filter(|n| *n > 0)
        .map(|n| n.min(MAX_HISTORY_LIMIT))
}

fn is_channel_name(s: &str) -> bool {
    s.starts_with('#') || s.starts_with('&')
}

/// Serialize the client-only (`+`) tags of a message, without `@`.
fn client_tag_section(m: &Message) -> String {
    m.tags
        .iter()
        .filter(|(k, _)| k.starts_with('+'))
        .map(|(k, v)| match v.as_deref().filter(|v| !v.is_empty()) {
            Some(v) => format!("{k}={}", escape_tag_value(v)),
            None => k.clone(),
        })
        .collect::<Vec<_>>()
        .join(";")
}

/// Parse a stored tag section back into tags.
fn parse_tag_section(section: &str) -> Vec<(String, Option<String>)> {
    if section.is_empty() {
        return Vec::new();
    }
    Message::parse(&format!("@{section} X"))
        .map(|m| m.tags)
        .unwrap_or_default()
}

fn base_tags(stored: &StoredMessage) -> Vec<(String, Option<String>)> {
    let mut tags = vec![
        ("time".to_string(), Some(format_time_ms(stored.time_ms))),
        ("msgid".to_string(), Some(stored.msgid.clone())),
    ];
    if let Some(a) = &stored.sender_account {
        tags.push(("account".to_string(), Some(a.clone())));
    }
    for (k, v) in parse_tag_section(&stored.tags) {
        if !tags.iter().any(|(e, _)| *e == k) {
            tags.push((k, v));
        }
    }
    tags
}

fn render(
    stored: &StoredMessage,
    server_name: &str,
    batch: Option<&str>,
    multiline: bool,
) -> Vec<Message> {
    let source = stored.sender_source.clone();
    let mut tags = base_tags(stored);
    if let Some(b) = batch {
        tags.push(("batch".to_string(), Some(b.to_string())));
    }
    let line = |text: &str| {
        Message::new(
            stored.command.clone(),
            vec![stored.target.clone(), text.to_string()],
        )
        .with_source(source.clone())
    };

    if stored.lines.len() <= 1 {
        let mut m = line(stored.lines.first().map(String::as_str).unwrap_or(""));
        m.tags = tags;
        return vec![m];
    }

    if !multiline {
        return stored
            .lines
            .iter()
            .enumerate()
            .map(|(i, text)| {
                let mut m = line(text);
                m.tags = tags.clone();
                if i > 0 {
                    m.remove_tag("msgid");
                }
                m
            })
            .collect();
    }

    let id = format!("ml{}", stored.seq);
    let mut out = Vec::with_capacity(stored.lines.len() + 2);
    let mut open = Message::new(
        "BATCH",
        vec![
            format!("+{id}"),
            "draft/multiline".to_string(),
            stored.target.clone(),
        ],
    )
    .with_source(source.clone());
    open.tags = tags;
    out.push(open);
    for text in &stored.lines {
        out.push(line(text).with_tag("batch", Some(id.clone())));
    }
    let mut close = Message::new("BATCH", vec![format!("-{id}")]);
    if !server_name.is_empty() {
        close.source = Some(server_name.to_string());
    }
    if let Some(b) = batch {
        close.set_tag("batch", Some(b.to_string()));
    }
    out.push(close);
    out
}

/// The server lines for one stored message. A message with more than one
/// line is a `draft/multiline` batch with the message tags on the opening
/// line. `batch` is the outer batch ID, if any. An empty `server_name` gives
/// a closing `BATCH` line without a source.
pub fn render_stored(
    stored: &StoredMessage,
    server_name: &str,
    batch: Option<&str>,
) -> Vec<Message> {
    render(stored, server_name, batch, true)
}

/// Messages after the delivery cursor of `account`, rendered, as
/// `(seq, lines)` in `seq` order.
pub fn replay_lines(
    store: &Store,
    account: &str,
    limit: usize,
) -> StoreResult<Vec<(i64, Vec<Message>)>> {
    replay_lines_with(store, account, "", limit)
}

/// Same as [`replay_lines`], with the server name as the source of the
/// closing `BATCH` lines.
pub fn replay_lines_with(
    store: &Store,
    account: &str,
    server_name: &str,
    limit: usize,
) -> StoreResult<Vec<(i64, Vec<Message>)>> {
    let cursor = store.get_cursor(account)?;
    Ok(store
        .replay_for(account, cursor, limit)?
        .into_iter()
        .filter(|m| m.command == "PRIVMSG" || m.command == "NOTICE")
        .map(|m| (m.seq, render_stored(&m, server_name, None)))
        .collect())
}

fn fail(cx: &mut Cx<'_>, uid: UserId, params: Vec<String>) {
    let m = Message::new("FAIL", params).with_source(cx.server_name().to_string());
    cx.send(uid, m);
}

fn invalid_params(cx: &mut Cx<'_>, uid: UserId, sub: &str, text: &str) {
    fail(
        cx,
        uid,
        vec![
            "CHATHISTORY".into(),
            "INVALID_PARAMS".into(),
            sub.to_string(),
            text.to_string(),
        ],
    );
}

fn markread_line(server: &str, target: &str, value: Option<i64>) -> Message {
    let v = match value {
        Some(t) => format!("timestamp={}", format_time_ms(t)),
        None => "*".to_string(),
    };
    Message::new("MARKREAD", vec![target.to_string(), v]).with_source(server.to_string())
}

impl HistoryModule {
    fn chathistory(&self, cx: &mut Cx<'_>, uid: UserId, account: &str, msg: &Message) {
        let sub = msg.param(0).unwrap_or("").to_ascii_uppercase();

        if sub == "TARGETS" {
            let (Some(a), Some(b), Some(limit)) = (
                msg.param(1).and_then(parse_bound),
                msg.param(2).and_then(parse_bound),
                msg.param(3).and_then(parse_limit),
            ) else {
                invalid_params(cx, uid, &sub, "Invalid parameters");
                return;
            };
            let (Bound::Time(a), Bound::Time(b)) = (a, b) else {
                invalid_params(cx, uid, &sub, "TARGETS needs timestamp references");
                return;
            };
            self.targets(cx, uid, account, a, b, limit);
            return;
        }

        if !matches!(
            sub.as_str(),
            "LATEST" | "BEFORE" | "AFTER" | "AROUND" | "BETWEEN"
        ) {
            invalid_params(cx, uid, &sub, "Unknown subcommand");
            return;
        }
        let Some(target) = msg.param(1).filter(|t| !t.is_empty() && *t != "*") else {
            invalid_params(cx, uid, &sub, "Missing target");
            return;
        };
        let target = target.to_string();
        let visible = if is_channel_name(&target) {
            cx.world
                .channels
                .get(&util::fold(&target))
                .is_some_and(|c| c.is_member(uid))
        } else {
            true
        };
        if !visible {
            fail(
                cx,
                uid,
                vec![
                    "CHATHISTORY".into(),
                    "INVALID_TARGET".into(),
                    sub.clone(),
                    target.clone(),
                    "Messages could not be retrieved".into(),
                ],
            );
            return;
        }
        let tf = store::fold(&target);
        let st = &self.store;

        let result = match sub.as_str() {
            "BETWEEN" => {
                let (Some(a), Some(b), Some(limit)) = (
                    msg.param(2).and_then(parse_bound),
                    msg.param(3).and_then(parse_bound),
                    msg.param(4).and_then(parse_limit),
                ) else {
                    invalid_params(cx, uid, &sub, "Invalid parameters");
                    return;
                };
                st.history_between(account, &tf, a, b, limit)
            }
            _ => {
                let (Some(r), Some(limit)) = (
                    msg.param(2).and_then(parse_ref),
                    msg.param(3).and_then(parse_limit),
                ) else {
                    invalid_params(cx, uid, &sub, "Invalid parameters");
                    return;
                };
                match (sub.as_str(), r) {
                    ("LATEST", Ref::Star) => st.history_latest(account, &tf, None, limit),
                    ("LATEST", Ref::At(b)) => st.history_latest(account, &tf, Some(b), limit),
                    ("BEFORE", Ref::At(b)) => st.history_before(account, &tf, b, limit),
                    ("AFTER", Ref::At(b)) => st.history_after(account, &tf, b, limit),
                    ("AROUND", Ref::At(b)) => self.around(account, &tf, b, limit),
                    _ => {
                        invalid_params(cx, uid, &sub, "Invalid message reference");
                        return;
                    }
                }
            }
        };

        match result {
            Ok(msgs) => self.send_batch(cx, uid, &target, &msgs),
            Err(e) => {
                tracing::warn!("chathistory query failed: {e}");
                fail(
                    cx,
                    uid,
                    vec![
                        "CHATHISTORY".into(),
                        "MESSAGE_ERROR".into(),
                        sub.clone(),
                        target,
                        "Messages could not be retrieved".into(),
                    ],
                );
            }
        }
    }

    /// Messages before and after a reference. A message ID reference in a
    /// channel includes the referenced message.
    fn around(
        &self,
        account: &str,
        tf: &str,
        b: Bound,
        limit: usize,
    ) -> StoreResult<Vec<StoredMessage>> {
        let center = match &b {
            Bound::MsgId(id) => self
                .store
                .message_by_msgid(id)?
                .filter(|m| m.is_channel && store::fold(&m.target) == tf),
            Bound::Time(_) => None,
        };
        let room = limit.saturating_sub(center.is_some() as usize);
        let mut out = self
            .store
            .history_before(account, tf, b.clone(), room / 2)?;
        out.extend(center);
        let rest = limit.saturating_sub(out.len());
        out.extend(self.store.history_after(account, tf, b, rest)?);
        Ok(out)
    }

    fn send_batch(&self, cx: &mut Cx<'_>, uid: UserId, target: &str, msgs: &[StoredMessage]) {
        let server = cx.server_name().to_string();
        let multiline = cx
            .world
            .user(uid)
            .is_some_and(|u| u.has_cap("draft/multiline"));
        let id = cx.world.batch_id();
        cx.send(
            uid,
            Message::new(
                "BATCH",
                vec![
                    format!("+{id}"),
                    "chathistory".to_string(),
                    target.to_string(),
                ],
            )
            .with_source(server.clone()),
        );
        for m in msgs {
            for line in render(m, &server, Some(&id), multiline) {
                cx.send(uid, line);
            }
        }
        cx.send(
            uid,
            Message::new("BATCH", vec![format!("-{id}")]).with_source(server),
        );
    }

    fn targets(&self, cx: &mut Cx<'_>, uid: UserId, account: &str, a: i64, b: i64, limit: usize) {
        let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
        let mut items = match self.store.history_targets(account, lo, hi, limit) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("chathistory targets failed: {e}");
                fail(
                    cx,
                    uid,
                    vec![
                        "CHATHISTORY".into(),
                        "MESSAGE_ERROR".into(),
                        "TARGETS".into(),
                        "Targets could not be retrieved".into(),
                    ],
                );
                return;
            }
        };
        // Channels that the user is in now, also when the store has no
        // membership rows for the account.
        let names: Vec<String> = cx
            .world
            .user(uid)
            .map(|u| {
                u.channels
                    .iter()
                    .filter_map(|k| cx.world.channels.get(k).map(|c| c.name.clone()))
                    .collect()
            })
            .unwrap_or_default();
        for name in names {
            let tf = store::fold(&name);
            if items.iter().any(|(t, _)| store::fold(t) == tf) {
                continue;
            }
            match self.store.history_latest(account, &tf, None, 1) {
                Ok(v) => {
                    if let Some(m) = v.last().filter(|m| m.time_ms > lo && m.time_ms < hi) {
                        items.push((name, m.time_ms));
                    }
                }
                Err(e) => tracing::warn!("chathistory targets failed: {e}"),
            }
        }
        items.sort_by(|x, y| x.1.cmp(&y.1).then_with(|| x.0.cmp(&y.0)));
        if items.len() > limit {
            items.drain(..items.len() - limit);
        }

        let server = cx.server_name().to_string();
        let id = cx.world.batch_id();
        cx.send(
            uid,
            Message::new(
                "BATCH",
                vec![format!("+{id}"), "draft/chathistory-targets".to_string()],
            )
            .with_source(server.clone()),
        );
        for (t, ms) in items {
            let m = Message::new(
                "CHATHISTORY",
                vec!["TARGETS".to_string(), t, format_time_ms(ms)],
            )
            .with_source(server.clone())
            .with_tag("batch", Some(id.clone()));
            cx.send(uid, m);
        }
        cx.send(
            uid,
            Message::new("BATCH", vec![format!("-{id}")]).with_source(server),
        );
    }

    fn markread(&self, cx: &mut Cx<'_>, uid: UserId, key: &MarkerKey, msg: &Message) {
        let Some(target) = msg.param(0).filter(|t| !t.is_empty() && *t != "*") else {
            fail(
                cx,
                uid,
                vec![
                    "MARKREAD".into(),
                    "NEED_MORE_PARAMS".into(),
                    "Missing target".into(),
                ],
            );
            return;
        };
        let target = target.to_string();
        let tf = store::fold(&target);
        let server = cx.server_name().to_string();

        let Some(value) = msg.param(1) else {
            match self.get_marker(key, &tf) {
                Ok(v) => cx.send(uid, markread_line(&server, &target, v)),
                Err(e) => {
                    tracing::warn!("read marker lookup failed: {e}");
                    fail(
                        cx,
                        uid,
                        vec![
                            "MARKREAD".into(),
                            "INTERNAL_ERROR".into(),
                            target,
                            "Read marker could not be read".into(),
                        ],
                    );
                }
            }
            return;
        };

        let Some(ts) = value.strip_prefix("timestamp=").and_then(parse_time) else {
            fail(
                cx,
                uid,
                vec![
                    "MARKREAD".into(),
                    "INVALID_PARAMS".into(),
                    target,
                    "Invalid timestamp".into(),
                ],
            );
            return;
        };
        let stored = match self.set_marker(key, &tf, &target, ts) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("read marker update failed: {e}");
                fail(
                    cx,
                    uid,
                    vec![
                        "MARKREAD".into(),
                        "INTERNAL_ERROR".into(),
                        target,
                        "Read marker could not be set".into(),
                    ],
                );
                return;
            }
        };
        let line = markread_line(&server, &target, Some(stored));
        cx.send(uid, line.clone());
        let MarkerKey::Account(account) = key else {
            return;
        };
        let others: Vec<UserId> = cx
            .world
            .users
            .values()
            .filter(|u| {
                u.id != uid
                    && u.registered
                    && u.has_cap("draft/read-marker")
                    && u.account
                        .as_deref()
                        .is_some_and(|a| a.eq_ignore_ascii_case(account))
            })
            .map(|u| u.id)
            .collect();
        for other in others {
            cx.send(other, line.clone());
        }
    }
}

impl Module for HistoryModule {
    fn name(&self) -> &'static str {
        "history"
    }

    fn caps(&self) -> Vec<CapSpec> {
        vec![
            CapSpec {
                name: "draft/chathistory",
                value: None,
            },
            CapSpec {
                name: "draft/read-marker",
                value: None,
            },
            CapSpec {
                name: "draft/event-playback",
                value: None,
            },
        ]
    }

    fn isupport(&self) -> Vec<String> {
        vec![
            format!("CHATHISTORY={MAX_HISTORY_LIMIT}"),
            "MSGREFTYPES=msgid,timestamp".to_string(),
        ]
    }

    fn on_command(&self, cx: &mut Cx<'_>, uid: UserId, msg: &Message) -> Flow {
        let cmd = msg.command_upper();
        if cmd != "CHATHISTORY" && cmd != "MARKREAD" {
            return Flow::Continue;
        }
        let Some(u) = cx.world.user(uid) else {
            return Flow::Continue;
        };
        if !u.registered {
            return Flow::Continue;
        }
        if cmd == "MARKREAD" {
            if let Some(key) = Self::marker_key(cx, uid) {
                self.markread(cx, uid, &key, msg);
            }
            return Flow::Handled;
        }
        let Some(account) = u.account.clone() else {
            fail(
                cx,
                uid,
                vec![
                    cmd,
                    "ACCOUNT_REQUIRED".into(),
                    "You must be logged in to use this command".into(),
                ],
            );
            return Flow::Handled;
        };
        self.chathistory(cx, uid, &account, msg);
        Flow::Handled
    }

    fn on_stored(&self, cx: &mut Cx<'_>, ev: &MessageEvent, recipients: &[UserId]) {
        if ev.command != "PRIVMSG" && ev.command != "NOTICE" {
            return;
        }
        let (sender_account, sender_nick, sender_source) = match cx.world.user(ev.sender) {
            Some(u) => (u.account.clone(), u.nick.clone(), u.source()),
            None => {
                let source = ev.msg.source.clone().unwrap_or_default();
                let nick = ev.msg.source_nick().unwrap_or("").to_string();
                (ev.msg.tag("account").map(str::to_string), nick, source)
            }
        };
        let lines: Vec<String> = if ev.lines.is_empty() {
            vec![ev.msg.param(1).unwrap_or("").to_string()]
        } else {
            ev.lines
                .iter()
                .map(|l| l.param(1).unwrap_or("").to_string())
                .collect()
        };
        let (is_channel, dm_account) = match &ev.target {
            MsgTarget::Channel(_) => (true, None),
            MsgTarget::User(t) => (false, cx.world.user(*t).and_then(|u| u.account.clone())),
        };

        let mut accounts: Vec<String> = Vec::new();
        for r in recipients {
            let Some(u) = cx.world.user(*r) else {
                continue;
            };
            if let (Sink::Virtual { .. }, Some(a)) = (&u.sink, &u.account) {
                if !accounts.contains(a) {
                    accounts.push(a.clone());
                }
            }
        }
        if let MsgTarget::User(t) = &ev.target {
            if let Some(u) = cx.world.user(*t) {
                if let (Sink::Virtual { .. }, Some(a)) = (&u.sink, &u.account) {
                    if !accounts.contains(a) {
                        accounts.push(a.clone());
                    }
                }
            }
        }

        let nm = NewMessage {
            msgid: ev.msgid.clone(),
            time_ms: ev.time_ms,
            sender_account,
            sender_nick,
            sender_source,
            target: ev.target_name.clone(),
            is_channel,
            command: ev.command.clone(),
            tags: client_tag_section(&ev.msg),
            lines,
            dm_account,
        };
        if let Err(e) = self.store.insert_message(&nm, &accounts) {
            tracing::warn!("storing message {} failed: {e}", ev.msgid);
        }
    }

    fn on_join(&self, cx: &mut Cx<'_>, uid: UserId, channel: &str) {
        if !cx
            .world
            .user(uid)
            .is_some_and(|u| u.has_cap("draft/read-marker"))
        {
            return;
        }
        let Some(key) = Self::marker_key(cx, uid) else {
            return;
        };
        match self.get_marker(&key, &store::fold(channel)) {
            Ok(v) => {
                let line = markread_line(cx.server_name(), channel, v);
                cx.send(uid, line);
            }
            Err(e) => tracing::warn!("read marker lookup failed: {e}"),
        }
    }

    fn on_quit(&self, _cx: &mut Cx<'_>, uid: UserId, _reason: &str) {
        self.guest_markers.lock().remove(&guest_key(uid));
    }

    fn on_tick(&self, _state: &SharedState, now: SystemTime) {
        if self.retention_days == 0 {
            return;
        }
        {
            let mut last = self.last_purge.lock();
            if last.is_some_and(|t| t.elapsed() < PURGE_INTERVAL) {
                return;
            }
            *last = Some(Instant::now());
        }
        let now_ms = now
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let cutoff = now_ms - i64::from(self.retention_days) * DAY_MS;
        match self.store.purge_older_than(cutoff) {
            Ok(n) => tracing::info!("history purge removed {n} messages"),
            Err(e) => tracing::warn!("history purge failed: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored(lines: &[&str]) -> StoredMessage {
        StoredMessage {
            seq: 7,
            msgid: "M1".into(),
            time_ms: 1_234,
            sender_account: Some("acc".into()),
            sender_nick: "nick".into(),
            sender_source: "nick!acc@h".into(),
            target: "#c".into(),
            is_channel: true,
            command: "PRIVMSG".into(),
            tags: "+x=a\\sb".into(),
            lines: lines.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn single_line() {
        let out = render_stored(&stored(&["hi there"]), "srv", Some("b1"));
        assert_eq!(out.len(), 1);
        assert_eq!(
            out[0].to_line(),
            "@time=1970-01-01T00:00:01.234Z;msgid=M1;account=acc;+x=a\\sb;batch=b1 \
             :nick!acc@h PRIVMSG #c :hi there"
        );
    }

    #[test]
    fn multiline_batch() {
        let out = render_stored(&stored(&["a", "b"]), "srv", None);
        let lines: Vec<String> = out.iter().map(Message::to_line).collect();
        assert_eq!(lines.len(), 4);
        assert!(lines[0].ends_with(":nick!acc@h BATCH +ml7 draft/multiline #c"));
        assert!(lines[0].contains("msgid=M1"));
        assert_eq!(lines[1], "@batch=ml7 :nick!acc@h PRIVMSG #c a");
        assert_eq!(lines[3], ":srv BATCH -ml7");
    }

    #[test]
    fn plain_lines() {
        let out = render(&stored(&["a", "b"]), "srv", Some("b1"), false);
        assert_eq!(out.len(), 2);
        assert!(out[0].has_tag("msgid"));
        assert!(!out[1].has_tag("msgid"));
    }

    #[test]
    fn tag_section_roundtrip() {
        let m = Message::parse("@+a=x\\sy;msgid=z;+b :s PRIVMSG #c :t").unwrap();
        let s = client_tag_section(&m);
        assert_eq!(s, "+a=x\\sy;+b");
        let tags = parse_tag_section(&s);
        assert_eq!(tags[0], ("+a".to_string(), Some("x y".to_string())));
        assert_eq!(tags[1], ("+b".to_string(), None));
    }
}
