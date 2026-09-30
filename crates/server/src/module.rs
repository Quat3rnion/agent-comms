//! Module trait and the command context.

use crate::config::Config;
use crate::conn::LineConn;
use crate::state::{ServerState, SharedState, World};
use crate::user::UserId;
use agent_comms_proto::Message;

pub enum Flow {
    Continue,
    Handled,
}

pub struct CapSpec {
    pub name: &'static str,
    pub value: Option<String>,
}

#[derive(Clone, Debug)]
pub enum MsgTarget {
    Channel(String),
    User(UserId),
}

#[derive(Clone, Debug)]
pub struct MessageEvent {
    pub sender: UserId,
    pub command: String,
    pub target: MsgTarget,
    pub target_name: String,
    pub msg: Message,
    pub lines: Vec<Message>,
    pub msgid: String,
    pub time_ms: i64,
    pub reject: Option<Message>,
}

pub struct Cx<'a> {
    pub world: &'a mut World,
    pub state: &'a ServerState,
}

impl Cx<'_> {
    pub fn server_name(&self) -> &str {
        &self.state.config.server_name
    }

    pub fn config(&self) -> &Config {
        &self.state.config
    }

    /// Send a message to a user. While the user runs a labeled command, the
    /// message goes into the label buffer of that user.
    pub fn send(&mut self, uid: UserId, m: Message) {
        if let Some(u) = self.world.users.get_mut(&uid) {
            if let Some(buf) = u.label_buf.as_mut() {
                buf.push(m);
                return;
            }
        }
        self.world.send_to(uid, &m);
    }

    /// Send a numeric from the server. The first parameter is the nick of the
    /// target, or `*`.
    pub fn numeric(&mut self, uid: UserId, code: &str, params: Vec<String>) {
        let nick = self
            .world
            .user(uid)
            .map(|u| u.nick.clone())
            .unwrap_or_else(|| "*".to_string());
        let mut all = Vec::with_capacity(params.len() + 1);
        all.push(nick);
        all.extend(params);
        let m = Message::new(code, all).with_source(self.state.config.server_name.clone());
        self.send(uid, m);
    }

    /// Strictly increasing server time in Unix milliseconds.
    pub fn now_ms(&mut self) -> i64 {
        self.world.next_time_ms()
    }
}

pub trait Module: Send + Sync + 'static {
    fn name(&self) -> &'static str;
    fn caps(&self) -> Vec<CapSpec> {
        vec![]
    }
    fn isupport(&self) -> Vec<String> {
        vec![]
    }
    fn on_command(&self, _cx: &mut Cx<'_>, _user: UserId, _msg: &Message) -> Flow {
        Flow::Continue
    }
    fn on_message(&self, _cx: &mut Cx<'_>, _ev: &mut MessageEvent) -> Flow {
        Flow::Continue
    }
    fn on_deliver(
        &self,
        _cx: &mut Cx<'_>,
        _ev: &MessageEvent,
        _recipient: UserId,
        _out: &mut Message,
    ) {
    }
    fn on_stored(&self, _cx: &mut Cx<'_>, _ev: &MessageEvent, _recipients: &[UserId]) {}
    fn on_join(&self, _cx: &mut Cx<'_>, _user: UserId, _channel: &str) {}
    fn on_part(&self, _cx: &mut Cx<'_>, _user: UserId, _channel: &str) {}
    fn on_nick(&self, _cx: &mut Cx<'_>, _user: UserId, _old: &str, _new: &str) {}
    fn on_quit(&self, _cx: &mut Cx<'_>, _user: UserId, _reason: &str) {}
    fn on_tick(&self, _state: &SharedState, _now: std::time::SystemTime) {}
    fn take_link(&self, _state: SharedState, conn: LineConn, _first: Message) -> Option<LineConn> {
        Some(conn)
    }
}
