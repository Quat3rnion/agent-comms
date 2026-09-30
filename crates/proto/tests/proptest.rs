use agent_comms_proto::{Limits, Message, Tags};
use proptest::collection::vec;
use proptest::option;
use proptest::prelude::*;

fn tags_strategy() -> impl Strategy<Value = Tags> {
    vec(("\\+?[a-z/.-]{1,10}", option::of("[^\\x00]{0,40}")), 0..5).prop_map(|raw| {
        let mut tags: Tags = Vec::new();
        for (key, value) in raw {
            if tags.iter().any(|(k, _)| *k == key) {
                continue;
            }
            let value = value.filter(|v| !v.is_empty());
            tags.push((key, value));
        }
        tags
    })
}

fn message_strategy() -> impl Strategy<Value = Message> {
    (
        tags_strategy(),
        option::of("[a-zA-Z0-9.!@_-]{1,20}"),
        "[A-Za-z]{1,10}",
        vec("[a-zA-Z0-9#&!.,_-][a-zA-Z0-9#&!.,:_-]{0,20}", 0..=14),
        option::of("[^\\r\\n\\x00]{0,60}"),
    )
        .prop_map(|(tags, source, command, mut params, last)| {
            if let Some(last) = last {
                params.push(last);
            }
            Message {
                tags,
                source,
                command,
                params,
            }
        })
}

proptest! {
    #[test]
    fn to_line_then_parse_is_identity(msg in message_strategy()) {
        let line = msg.to_line();
        let parsed = Message::parse_with(&line, Limits::LINK);
        prop_assert_eq!(parsed, Ok(msg));
    }

    #[test]
    fn parse_never_panics(s in ".*") {
        let _ = Message::parse_with(&s, Limits::LINK);
        let _ = Message::parse(&s);
    }
}
