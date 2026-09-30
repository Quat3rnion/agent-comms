//! Shared server state and the world (users and channels).

use crate::channel::Channel;
use crate::config::{Config, Secrets};
use crate::module::{Cx, Module};
use crate::user::{LinkHandle, Role, Sink, User, UserId};
use crate::util::{fold, now_ms, unix_now};
use agent_comms_proto::Message;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Arc;

pub type SharedState = Arc<ServerState>;

pub struct ServerState {
    pub config: Config,
    pub secrets: parking_lot::RwLock<Secrets>,
    pub world: parking_lot::Mutex<World>,
    pub modules: Vec<Arc<dyn Module>>,
    pub started: i64,
}

impl ServerState {
    pub fn new(config: Config, secrets: Secrets, modules: Vec<Arc<dyn Module>>) -> ServerState {
        ServerState {
            config,
            secrets: parking_lot::RwLock::new(secrets),
            world: parking_lot::Mutex::new(World::new()),
            modules,
            started: unix_now(),
        }
    }

    /// Lock the world and run `f` with a command context.
    pub fn with_world<R>(&self, f: impl FnOnce(&mut Cx<'_>) -> R) -> R {
        let mut guard = self.world.lock();
        let mut cx = Cx {
            world: &mut guard,
            state: self,
        };
        f(&mut cx)
    }
}

/// Tags that a client without `message-tags` can get, with the capability
/// that enables each one.
const TAG_CAPS: &[(&str, &str)] = &[
    ("time", "server-time"),
    ("account", "account-tag"),
    ("batch", "batch"),
    ("label", "labeled-response"),
];

pub struct World {
    pub users: HashMap<UserId, User>,
    /// Folded nick to user.
    pub nicks: HashMap<String, UserId>,
    /// Folded alias to user.
    pub aliases: HashMap<String, UserId>,
    /// Folded account name to virtual user.
    pub accounts: HashMap<String, UserId>,
    /// Folded channel name to channel.
    pub channels: HashMap<String, Channel>,
    next_uid: u64,
    last_ms: i64,
    next_batch: u64,
}

impl Default for World {
    fn default() -> Self {
        Self::new()
    }
}

impl World {
    pub fn new() -> World {
        World {
            users: HashMap::new(),
            nicks: HashMap::new(),
            aliases: HashMap::new(),
            accounts: HashMap::new(),
            channels: HashMap::new(),
            next_uid: 1,
            last_ms: 0,
            next_batch: 1,
        }
    }

    pub fn alloc_uid(&mut self) -> UserId {
        let id = UserId(self.next_uid);
        self.next_uid += 1;
        id
    }

    /// Strictly increasing time in Unix milliseconds, never before now.
    pub fn next_time_ms(&mut self) -> i64 {
        let t = now_ms().max(self.last_ms + 1);
        self.last_ms = t;
        t
    }

    pub fn batch_id(&mut self) -> String {
        let id = self.next_batch;
        self.next_batch += 1;
        format!("b{id}")
    }

    pub fn user(&self, uid: UserId) -> Option<&User> {
        self.users.get(&uid)
    }

    pub fn user_mut(&mut self, uid: UserId) -> Option<&mut User> {
        self.users.get_mut(&uid)
    }

    /// Find a user by nick, then by alias.
    pub fn find_nick(&self, nick: &str) -> Option<UserId> {
        let f = fold(nick);
        self.nicks.get(&f).or_else(|| self.aliases.get(&f)).copied()
    }

    pub fn find_account(&self, account: &str) -> Option<UserId> {
        self.accounts.get(&fold(account)).copied()
    }

    pub fn nick_in_use(&self, nick: &str) -> bool {
        let f = fold(nick);
        self.nicks.contains_key(&f) || self.aliases.contains_key(&f)
    }

    /// Insert a user. A registered user also goes into the nick index.
    pub fn add_user(&mut self, user: User) {
        if user.registered && user.nick != "*" {
            self.nicks.insert(fold(&user.nick), user.id);
        }
        self.users.insert(user.id, user);
    }

    pub fn add_alias(&mut self, uid: UserId, alias: &str) {
        self.aliases.insert(fold(alias), uid);
    }

    pub fn remove_aliases(&mut self, uid: UserId) {
        self.aliases.retain(|_, v| *v != uid);
    }

    /// Send a message to one user, filtered by the capabilities of the user.
    /// This does not use the label buffer; see `Cx::send`.
    pub fn send_to(&self, uid: UserId, m: &Message) {
        let Some(u) = self.users.get(&uid) else {
            return;
        };
        let line = if u.has_cap("message-tags") || m.tags.is_empty() {
            m.to_line()
        } else {
            let mut out = m.clone();
            out.tags.retain(|(k, _)| {
                TAG_CAPS
                    .iter()
                    .any(|(tag, cap)| k == *tag && u.has_cap(cap))
            });
            out.to_line()
        };
        match &u.sink {
            Sink::Socket(o) => {
                o.send_line(&line);
            }
            Sink::Virtual {
                account,
                link: Some(link),
            } => {
                let d = Message::new("DELIVER", vec![account.clone(), line]);
                link.tx.send_line(&d.to_line());
            }
            Sink::Virtual { link: None, .. } => {}
        }
    }

    pub fn send_numeric(&self, server_name: &str, uid: UserId, code: &str, params: Vec<String>) {
        let nick = self
            .user(uid)
            .map(|u| u.nick.clone())
            .unwrap_or_else(|| "*".to_string());
        let mut all = vec![nick];
        all.extend(params);
        self.send_to(
            uid,
            &Message::new(code, all).with_source(server_name.to_string()),
        );
    }

    /// Members of a channel (folded name).
    pub fn channel_members(&self, folded: &str) -> Vec<UserId> {
        self.channels
            .get(folded)
            .map(|c| c.members.keys().copied().collect())
            .unwrap_or_default()
    }

    /// Users that share a channel with `uid`, without `uid`.
    pub fn peers_of(&self, uid: UserId) -> BTreeSet<UserId> {
        let mut out = BTreeSet::new();
        if let Some(u) = self.users.get(&uid) {
            for ch in &u.channels {
                if let Some(c) = self.channels.get(ch) {
                    out.extend(c.members.keys().copied());
                }
            }
        }
        out.remove(&uid);
        out
    }

    /// Create a registered virtual user for a link account.
    #[expect(clippy::too_many_arguments, reason = "signature is a shared contract")]
    pub fn create_virtual_user(
        &mut self,
        account: &str,
        nick: &str,
        realname: &str,
        role: Role,
        parent: Option<UserId>,
        owner: Option<String>,
        link: Option<LinkHandle>,
    ) -> UserId {
        let id = self.alloc_uid();
        let user = User {
            id,
            nick: nick.to_string(),
            username: account.to_string(),
            realname: realname.to_string(),
            host: "agent-comms.local".to_string(),
            account: Some(account.to_string()),
            role,
            caps: HashSet::new(),
            away: None,
            channels: HashSet::new(),
            registered: true,
            sink: Sink::Virtual {
                account: account.to_string(),
                link,
            },
            parent,
            owner,
            last_activity: std::time::Instant::now(),
            signon: unix_now(),
            label: None,
            label_buf: None,
        };
        self.accounts.insert(fold(account), id);
        self.add_user(user);
        id
    }
}
