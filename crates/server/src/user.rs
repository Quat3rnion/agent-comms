//! Users, outbound queues, and delivery sinks.

use agent_comms_proto::Message;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, Notify};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct UserId(pub u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Operator,
    Agent,
    Guest,
}

impl Role {
    pub fn as_str(&self) -> &'static str {
        match self {
            Role::Operator => "operator",
            Role::Agent => "agent",
            Role::Guest => "guest",
        }
    }
}

/// Bounded outbound line queue of one connection.
#[derive(Clone)]
pub struct Outbound {
    tx: mpsc::Sender<Arc<str>>,
    closed: Arc<AtomicBool>,
    close_notify: Arc<Notify>,
    reason: Arc<parking_lot::Mutex<Option<String>>>,
}

impl Outbound {
    pub fn new(cap: usize) -> (Outbound, mpsc::Receiver<Arc<str>>) {
        let (tx, rx) = mpsc::channel(cap.max(1));
        (
            Outbound {
                tx,
                closed: Arc::new(AtomicBool::new(false)),
                close_notify: Arc::new(Notify::new()),
                reason: Arc::new(parking_lot::Mutex::new(None)),
            },
            rx,
        )
    }

    /// True when both handles feed the same connection.
    pub fn same_channel(&self, other: &Outbound) -> bool {
        self.tx.same_channel(&other.tx)
    }

    /// Queue one line (without CRLF). Returns false when the line was dropped.
    pub fn send_line(&self, line: &str) -> bool {
        if self.is_closed() {
            return false;
        }
        match self.tx.try_send(Arc::from(line)) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.close_with("SendQ exceeded");
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                self.close();
                false
            }
        }
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.close_notify.notify_waiters();
    }

    /// Close and remember the reason (the first reason wins).
    pub fn close_with(&self, reason: &str) {
        {
            let mut r = self.reason.lock();
            if r.is_none() {
                *r = Some(reason.to_string());
            }
        }
        self.close();
    }

    /// Reason given to `close_with`, if any.
    pub fn close_reason(&self) -> Option<String> {
        self.reason.lock().clone()
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Completes when the outbound is closed.
    pub async fn closed_notified(&self) {
        loop {
            let notified = self.close_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_closed() {
                return;
            }
            notified.await;
        }
    }
}

#[derive(Clone)]
pub struct LinkHandle {
    pub name: String,
    pub tx: Outbound,
}

pub enum Sink {
    Socket(Outbound),
    Virtual {
        account: String,
        link: Option<LinkHandle>,
    },
}

/// Capabilities that a virtual (link) user always has.
pub const VIRTUAL_CAPS: &[&str] = &[
    "message-tags",
    "server-time",
    "msgid",
    "account-tag",
    "away-notify",
    "batch",
    "labeled-response",
    "draft/multiline",
    "draft/chathistory",
    "draft/read-marker",
    "draft/event-playback",
];

/// SASL exchange that runs now.
#[derive(Clone, Debug, Default)]
pub struct SaslState {
    /// Mechanism name (uppercase).
    pub mechanism: String,
    /// Base64 chunks received so far.
    pub buffer: String,
}

/// Registration state of a connection.
#[derive(Clone, Debug, Default)]
pub struct RegState {
    pub nick_set: bool,
    pub user_set: bool,
    /// True between `CAP LS`/`CAP REQ` and `CAP END`.
    pub cap_negotiating: bool,
    /// CAP version given in `CAP LS` (0 when not given).
    pub cap_version: u32,
    pub sasl: Option<SaslState>,
}

pub struct User {
    pub id: UserId,
    pub nick: String,
    pub username: String,
    pub realname: String,
    pub host: String,
    pub account: Option<String>,
    pub role: Role,
    pub caps: HashSet<String>,
    pub away: Option<String>,
    /// Folded channel names.
    pub channels: HashSet<String>,
    pub registered: bool,
    pub sink: Sink,
    pub parent: Option<UserId>,
    pub owner: Option<String>,
    pub last_activity: std::time::Instant,
    pub signon: i64,
    /// Label of the labeled command that runs now.
    pub label: Option<String>,
    pub label_buf: Option<Vec<Message>>,
    pub reg: RegState,
}

impl User {
    /// New unregistered socket user.
    pub fn new_socket(id: UserId, host: String, tx: Outbound, signon: i64) -> User {
        User {
            id,
            nick: "*".to_string(),
            username: String::new(),
            realname: String::new(),
            host,
            account: None,
            role: Role::Guest,
            caps: HashSet::new(),
            away: None,
            channels: HashSet::new(),
            registered: false,
            sink: Sink::Socket(tx),
            parent: None,
            owner: None,
            last_activity: std::time::Instant::now(),
            signon,
            label: None,
            label_buf: None,
            reg: RegState::default(),
        }
    }

    pub fn source(&self) -> String {
        format!("{}!{}@{}", self.nick, self.username, self.host)
    }

    pub fn has_cap(&self, cap: &str) -> bool {
        match &self.sink {
            Sink::Virtual { .. } => VIRTUAL_CAPS.contains(&cap),
            Sink::Socket(_) => self.caps.contains(cap),
        }
    }

    pub fn is_virtual(&self) -> bool {
        matches!(self.sink, Sink::Virtual { .. })
    }

    /// Outbound queue of a socket user.
    pub fn outbound(&self) -> Option<&Outbound> {
        match &self.sink {
            Sink::Socket(o) => Some(o),
            Sink::Virtual { .. } => None,
        }
    }
}
