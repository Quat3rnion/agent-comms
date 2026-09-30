use agent_comms_proto::{Limits, Message};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

fn message_to_json(m: &Message) -> Value {
    let tags: Vec<Value> = m
        .tags
        .iter()
        .map(|(k, v)| match v {
            Some(v) => json!([k, v]),
            None => json!([k, Value::Null]),
        })
        .collect();
    json!({
        "tags": tags,
        "source": m.source,
        "command": m.command,
        "params": m.params,
    })
}

#[test]
fn link_fixtures_round_trip() {
    let dir = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/link"));
    let mut txt_files: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()))
        .map(|entry| entry.expect("dir entry").path())
        .filter(|p| p.extension().is_some_and(|e| e == "txt"))
        .collect();
    txt_files.sort();
    assert!(
        txt_files.len() >= 3,
        "expected at least 3 fixtures, found {}",
        txt_files.len()
    );

    for txt in &txt_files {
        let json_path = txt.with_extension("json");
        let text = fs::read_to_string(txt).expect("read txt fixture");
        let expected: Value = serde_json::from_str(
            &fs::read_to_string(&json_path)
                .unwrap_or_else(|e| panic!("cannot read {}: {e}", json_path.display())),
        )
        .expect("parse json fixture");
        let expected = expected.as_array().expect("json fixture is an array");

        let lines: Vec<&str> = text
            .lines()
            .filter(|l| !l.is_empty() && !l.starts_with("//"))
            .collect();
        assert_eq!(
            lines.len(),
            expected.len(),
            "line count mismatch in {}",
            txt.display()
        );

        for (line, want) in lines.iter().zip(expected) {
            let msg = Message::parse_with(line, Limits::LINK)
                .unwrap_or_else(|e| panic!("{}: cannot parse {line:?}: {e}", txt.display()));
            assert_eq!(
                &message_to_json(&msg),
                want,
                "{}: parse mismatch for {line:?}",
                txt.display()
            );
            assert_eq!(
                &msg.to_line(),
                line,
                "{}: round trip mismatch",
                txt.display()
            );
        }
    }
}
