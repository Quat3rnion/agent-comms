//! Authority tags: `role`, `parent`, and `rel` on delivered messages.

use crate::module::{Cx, MessageEvent, Module};
use crate::state::World;
use crate::user::{Role, UserId};
use agent_comms_proto::{vendor_tag, Message};

/// Maximum length of a parent chain that `relation` walks.
const MAX_DEPTH: usize = 64;

const AUTHORITY_TAGS: &[&str] = &["role", "parent", "rel"];

pub struct AuthorityModule;

/// True when `ancestor` is a parent, or a transitive parent, of `uid`.
fn is_ancestor(world: &World, ancestor: UserId, uid: UserId) -> bool {
    let mut cur = world.user(uid).and_then(|u| u.parent);
    for _ in 0..MAX_DEPTH {
        match cur {
            Some(p) if p == ancestor => return true,
            Some(p) => cur = world.user(p).and_then(|u| u.parent),
            None => return false,
        }
    }
    false
}

/// Relation of `sender` to `recipient`: `operator`, `ancestor`, `descendant`,
/// or `peer`.
pub fn relation(world: &World, sender: UserId, recipient: UserId) -> &'static str {
    if world.user(sender).is_some_and(|u| u.role == Role::Operator) {
        return "operator";
    }
    if is_ancestor(world, sender, recipient) {
        return "ancestor";
    }
    if is_ancestor(world, recipient, sender) {
        return "descendant";
    }
    "peer"
}

fn strip_authority_tags(out: &mut Message) {
    for name in AUTHORITY_TAGS {
        let key = vendor_tag(name);
        out.remove_tag(&key);
        out.remove_tag(&format!("+{key}"));
    }
}

impl Module for AuthorityModule {
    fn name(&self) -> &'static str {
        "authority"
    }

    fn on_deliver(&self, cx: &mut Cx<'_>, ev: &MessageEvent, recipient: UserId, out: &mut Message) {
        let command = ev.command.to_ascii_uppercase();
        if !matches!(command.as_str(), "PRIVMSG" | "NOTICE" | "TAGMSG") {
            return;
        }
        strip_authority_tags(out);
        let Some(sender) = cx.world.user(ev.sender) else {
            return;
        };
        let role = if sender.role == Role::Operator {
            "operator"
        } else {
            "agent"
        };
        let parent_nick = sender
            .parent
            .and_then(|p| cx.world.user(p))
            .map(|p| p.nick.clone());
        let rel = relation(cx.world, ev.sender, recipient);

        out.set_tag(&vendor_tag("role"), Some(role.to_string()));
        if let Some(nick) = parent_nick {
            out.set_tag(&vendor_tag("parent"), Some(nick));
        }
        out.set_tag(&vendor_tag("rel"), Some(rel.to_string()));
    }
}
