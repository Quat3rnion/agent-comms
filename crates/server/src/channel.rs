//! Channel state.

use crate::user::UserId;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MemberModes {
    pub op: bool,
    pub voice: bool,
}

impl MemberModes {
    /// Highest prefix character (`@`, `+`, or empty).
    pub fn prefix(&self) -> &'static str {
        if self.op {
            "@"
        } else if self.voice {
            "+"
        } else {
            ""
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChanModes {
    pub invite_only: bool,
    pub moderated: bool,
    pub no_external: bool,
    pub secret: bool,
    pub topic_ops: bool,
    pub key: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug)]
pub struct Channel {
    pub name: String,
    /// Text, setter, and Unix time.
    pub topic: Option<(String, String, i64)>,
    pub created: i64,
    pub members: BTreeMap<UserId, MemberModes>,
    pub modes: ChanModes,
    /// Mask, setter, and Unix time.
    pub bans: Vec<(String, String, i64)>,
}

impl Channel {
    pub fn new(name: impl Into<String>, now: i64) -> Channel {
        Channel {
            name: name.into(),
            topic: None,
            created: now,
            members: BTreeMap::new(),
            modes: ChanModes {
                no_external: true,
                topic_ops: true,
                ..ChanModes::default()
            },
            bans: Vec::new(),
        }
    }

    /// Mode string with parameters, for example `+ntk key`.
    pub fn mode_string(&self) -> String {
        let m = &self.modes;
        let mut flags = String::from("+");
        let mut args = Vec::new();
        if m.invite_only {
            flags.push('i');
        }
        if m.moderated {
            flags.push('m');
        }
        if m.no_external {
            flags.push('n');
        }
        if m.secret {
            flags.push('s');
        }
        if m.topic_ops {
            flags.push('t');
        }
        if let Some(k) = &m.key {
            flags.push('k');
            args.push(k.clone());
        }
        if let Some(l) = m.limit {
            flags.push('l');
            args.push(l.to_string());
        }
        if args.is_empty() {
            flags
        } else {
            format!("{} {}", flags, args.join(" "))
        }
    }

    pub fn is_member(&self, uid: UserId) -> bool {
        self.members.contains_key(&uid)
    }

    pub fn is_op(&self, uid: UserId) -> bool {
        self.members.get(&uid).is_some_and(|m| m.op)
    }
}
