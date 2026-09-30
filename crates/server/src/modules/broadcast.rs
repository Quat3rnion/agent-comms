//! Broadcast tags: `@here` and `@all` in channel PRIVMSG.

use crate::module::{Cx, Flow, MessageEvent, Module, MsgTarget};
use crate::user::Role;
use agent_comms_proto::{vendor_tag, Message};

pub struct BroadcastModule;

fn is_boundary(c: char) -> bool {
    c.is_whitespace() || (c.is_ascii_punctuation() && !matches!(c, '@' | '-' | '_'))
}

fn has_word(text: &str, word: &str) -> bool {
    text.match_indices(word).any(|(i, _)| {
        let before = text[..i].chars().next_back().is_none_or(is_boundary);
        let after = text[i + word.len()..]
            .chars()
            .next()
            .is_none_or(is_boundary);
        before && after
    })
}

/// Broadcast kind of a text: `Some("all")` when it has the word `@all`,
/// `Some("here")` when it has only `@here`, else `None`.
pub fn detect(text: &str) -> Option<&'static str> {
    if has_word(text, "@all") {
        Some("all")
    } else if has_word(text, "@here") {
        Some("here")
    } else {
        None
    }
}

impl Module for BroadcastModule {
    fn name(&self) -> &'static str {
        "broadcast"
    }

    fn on_message(&self, cx: &mut Cx<'_>, ev: &mut MessageEvent) -> Flow {
        let key = vendor_tag("broadcast");
        ev.msg.remove_tag(&key);
        ev.msg.remove_tag(&format!("+{key}"));
        if !ev.command.eq_ignore_ascii_case("PRIVMSG")
            || !matches!(ev.target, MsgTarget::Channel(_))
        {
            return Flow::Continue;
        }

        let texts = ev
            .msg
            .params
            .last()
            .into_iter()
            .chain(ev.lines.iter().filter_map(|l| l.params.last()));
        let mut kind = None;
        for text in texts {
            match detect(text) {
                Some("all") => {
                    kind = Some("all");
                    break;
                }
                Some(k) => kind = Some(k),
                None => {}
            }
        }
        let Some(kind) = kind else {
            return Flow::Continue;
        };

        if kind == "all"
            && !cx
                .world
                .user(ev.sender)
                .is_some_and(|u| u.role == Role::Operator)
        {
            let fail = Message::new(
                "FAIL",
                vec![
                    "PRIVMSG".into(),
                    "BROADCASTDENIED".into(),
                    ev.target_name.clone(),
                    "@all is reserved for the operator".into(),
                ],
            )
            .with_source(cx.server_name().to_string());
            ev.reject = Some(fail);
            return Flow::Continue;
        }

        ev.msg.set_tag(&key, Some(kind.to_string()));
        Flow::Continue
    }
}
