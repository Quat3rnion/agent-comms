mod common;

use agent_comms_proto::Message;
use agent_comms_server::config::{Config, Secrets};
use agent_comms_server::Running;
use common::*;
use std::time::Duration;
use tempfile::TempDir;

const OP_ACCOUNT: &str = "operator";
const OP_PASSWORD: &str = "correct horse battery staple";

async fn setup_with(f: impl FnOnce(&mut Config)) -> (TempDir, Running) {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut cfg = test_config(dir.path());
    f(&mut cfg);
    let srv = start_server(cfg, test_secrets(OP_ACCOUNT, OP_PASSWORD)).await;
    (dir, srv)
}

async fn setup() -> (TempDir, Running) {
    setup_with(|_| {}).await
}

async fn client(srv: &Running) -> TestClient {
    TestClient::connect(srv.local_addr).await
}

/// JOIN a channel and wait for the end of NAMES.
async fn join(c: &mut TestClient, chan: &str) {
    c.send(&format!("JOIN {chan}")).await;
    let chan = chan.to_string();
    c.expect(move |m| m.command == "366" && m.param(1) == Some(chan.as_str()))
        .await;
}

/// Wait until `c` sees `nick` join `chan`.
async fn saw_join(c: &mut TestClient, nick: &str, chan: &str) {
    let nick = nick.to_string();
    let chan = chan.to_string();
    c.expect(move |m| {
        m.command_upper() == "JOIN"
            && m.source_nick() == Some(nick.as_str())
            && m.param(0) == Some(chan.as_str())
    })
    .await;
}

fn is_privmsg(m: &Message, text: &str) -> bool {
    m.command_upper() == "PRIVMSG" && m.param(1) == Some(text)
}

/// Collect every line that arrives within `dur`.
async fn collect(c: &mut TestClient, dur: Duration) -> Vec<Message> {
    let mut out = Vec::new();
    let deadline = tokio::time::Instant::now() + dur;
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            break;
        }
        match c.try_recv(left).await {
            Some(m) => out.push(m),
            None => break,
        }
    }
    out
}

#[tokio::test]
async fn welcome() {
    let (_d, srv) = setup().await;
    let mut c = client(&srv).await;
    c.nick = "a".into();
    c.send("NICK a").await;
    c.send("USER a 0 * :a test").await;
    c.expect_numeric("001").await;
    c.expect_numeric("002").await;
    c.expect_numeric("003").await;
    c.expect_numeric("004").await;
    c.expect(|m| m.command == "005" && m.params.iter().any(|p| p == "CASEMAPPING=rfc1459"))
        .await;
}

#[tokio::test]
async fn sasl_success() {
    let (_d, srv) = setup().await;
    let mut op = client(&srv).await;
    op.register_sasl("op", OP_ACCOUNT, OP_PASSWORD, &[])
        .await
        .expect("SASL must succeed");

    let mut b = client(&srv).await;
    b.register("b").await;
    b.send("WHOIS op").await;
    let m = b.expect_numeric("313").await;
    assert_eq!(m.param(1), Some("op"));
    let m = b.expect_numeric("330").await;
    assert_eq!(m.param(1), Some("op"));
    assert_eq!(m.param(2), Some(OP_ACCOUNT));
    b.expect_numeric("318").await;
}

#[tokio::test]
async fn sasl_failure() {
    let (_d, srv) = setup().await;
    let mut c = client(&srv).await;
    let res = c
        .register_sasl("op", OP_ACCOUNT, "wrong password", &[])
        .await;
    let err = res.expect_err("SASL with a wrong password must fail");
    assert_eq!(err.command, "904");
}

#[tokio::test]
async fn require_sasl() {
    let (_d, srv) = setup_with(|c| c.require_sasl = true).await;
    let mut c = client(&srv).await;
    c.nick = "a".into();
    c.send("NICK a").await;
    c.send("USER a 0 * :a test").await;
    let m = c.expect_command("ERROR").await;
    let reason = m.params.join(" ");
    assert!(
        reason.to_ascii_uppercase().contains("SASL"),
        "ERROR must mention SASL: {reason:?}"
    );
    assert!(c.closed().await, "connection must close after ERROR");
}

#[tokio::test]
async fn join_privmsg_tags() {
    let (_d, srv) = setup().await;
    let mut a = client(&srv).await;
    a.register_caps("a", &["message-tags", "server-time"]).await;
    let mut b = client(&srv).await;
    b.register("b").await;
    join(&mut a, "#c").await;
    join(&mut b, "#c").await;
    saw_join(&mut a, "b", "#c").await;

    b.send("PRIVMSG #c :hi").await;
    let m = a.expect(|m| is_privmsg(m, "hi")).await;
    assert_eq!(m.param(0), Some("#c"));
    assert!(m.has_tag("time"), "missing time tag: {m:?}");
    assert!(
        m.tag("msgid").is_some_and(|v| !v.is_empty()),
        "missing msgid tag: {m:?}"
    );
    assert!(
        m.source.as_deref().is_some_and(|s| s.starts_with("b!")),
        "unexpected source: {m:?}"
    );

    let rest = collect(&mut b, Duration::from_millis(500)).await;
    assert!(
        !rest.iter().any(|m| m.command_upper() == "PRIVMSG"),
        "sender without echo-message must not get its message back: {rest:?}"
    );
}

#[tokio::test]
async fn echo_message() {
    let (_d, srv) = setup().await;
    let mut a = client(&srv).await;
    a.register_caps("a", &["echo-message", "message-tags"])
        .await;
    join(&mut a, "#c").await;
    a.send("PRIVMSG #c :hello self").await;
    let m = a.expect(|m| is_privmsg(m, "hello self")).await;
    assert!(m.source_nick() == Some("a"), "unexpected source: {m:?}");
    assert!(
        m.tag("msgid").is_some_and(|v| !v.is_empty()),
        "missing msgid tag: {m:?}"
    );
}

#[tokio::test]
async fn dm_and_away() {
    let (_d, srv) = setup().await;
    let mut a = client(&srv).await;
    a.register("a").await;
    let mut b = client(&srv).await;
    b.register("b").await;

    a.send("AWAY :lunch").await;
    a.expect_numeric("306").await;

    b.send("PRIVMSG a :are you there").await;
    let m = b.expect_numeric("301").await;
    assert_eq!(m.param(1), Some("a"));
    assert_eq!(m.params.last().map(String::as_str), Some("lunch"));

    let m = a.expect(|m| is_privmsg(m, "are you there")).await;
    assert_eq!(m.param(0), Some("a"));
    assert_eq!(m.source_nick(), Some("b"));
}

#[tokio::test]
async fn away_notify() {
    let (_d, srv) = setup().await;
    let mut a = client(&srv).await;
    a.register_caps("a", &["away-notify"]).await;
    let mut b = client(&srv).await;
    b.register("b").await;
    join(&mut a, "#c").await;
    join(&mut b, "#c").await;
    saw_join(&mut a, "b", "#c").await;

    b.send("AWAY :x").await;
    let m = a
        .expect(|m| m.command_upper() == "AWAY" && m.source_nick() == Some("b"))
        .await;
    assert_eq!(m.param(0), Some("x"));

    b.send("AWAY").await;
    let m = a
        .expect(|m| m.command_upper() == "AWAY" && m.source_nick() == Some("b"))
        .await;
    assert!(m.params.is_empty(), "AWAY back must have no params: {m:?}");
}

#[tokio::test]
async fn labeled_ack() {
    let (_d, srv) = setup().await;
    let mut a = client(&srv).await;
    a.register_caps("a", &["labeled-response", "batch", "message-tags"])
        .await;

    a.send("@label=abc PONG x").await;
    let m = a.expect_command("ACK").await;
    assert_eq!(m.tag("label"), Some("abc"));

    a.send("@label=q1 WHOIS a").await;
    let start = a
        .expect(|m| {
            m.command_upper() == "BATCH"
                && m.param(0).is_some_and(|p| p.starts_with('+'))
                && m.param(1) == Some("labeled-response")
        })
        .await;
    assert_eq!(start.tag("label"), Some("q1"));
    let id = start.param(0).unwrap()[1..].to_string();

    let id2 = id.clone();
    let m = a.expect(move |m| m.command == "311").await;
    assert_eq!(
        m.tag("batch"),
        Some(id2.as_str()),
        "311 not in batch: {m:?}"
    );
    let id3 = id.clone();
    let m = a.expect(move |m| m.command == "318").await;
    assert_eq!(
        m.tag("batch"),
        Some(id3.as_str()),
        "318 not in batch: {m:?}"
    );
    let end = format!("-{id}");
    a.expect(move |m| m.command_upper() == "BATCH" && m.param(0) == Some(end.as_str()))
        .await;
}

#[tokio::test]
async fn multiline() {
    let (_d, srv) = setup().await;
    let mut a = client(&srv).await;
    a.register_caps("a", &["batch", "draft/multiline", "message-tags"])
        .await;
    let mut b = client(&srv).await;
    b.register("b").await;
    let mut c = client(&srv).await;
    c.register_caps("c", &["draft/multiline", "batch", "message-tags"])
        .await;
    join(&mut a, "#c").await;
    join(&mut b, "#c").await;
    join(&mut c, "#c").await;
    saw_join(&mut a, "c", "#c").await;
    saw_join(&mut b, "c", "#c").await;

    c.send("BATCH +m1 draft/multiline #c").await;
    c.send("@batch=m1 PRIVMSG #c :line one").await;
    c.send("@batch=m1 PRIVMSG #c :line two").await;
    c.send("BATCH -m1").await;

    let start = a
        .expect(|m| {
            m.command_upper() == "BATCH"
                && m.param(0).is_some_and(|p| p.starts_with('+'))
                && m.param(1) == Some("draft/multiline")
        })
        .await;
    assert_eq!(start.param(2), Some("#c"));
    let id = start.param(0).unwrap()[1..].to_string();
    for text in ["line one", "line two"] {
        let m = a.expect(move |m| m.command_upper() == "PRIVMSG").await;
        assert_eq!(m.param(1), Some(text));
        assert_eq!(m.tag("batch"), Some(id.as_str()), "not in batch: {m:?}");
        assert_eq!(m.source_nick(), Some("c"));
    }
    let end = format!("-{id}");
    let m = a.expect_command("BATCH").await;
    assert_eq!(m.param(0), Some(end.as_str()));

    for text in ["line one", "line two"] {
        let m = b.expect(move |m| m.command_upper() == "PRIVMSG").await;
        assert_eq!(m.param(1), Some(text));
        assert!(!m.has_tag("batch"), "plain client got batch tag: {m:?}");
        assert_eq!(m.source_nick(), Some("c"));
    }
    let rest = collect(&mut b, Duration::from_millis(300)).await;
    assert!(
        !rest.iter().any(|m| m.command_upper() == "BATCH"),
        "plain client must not get BATCH: {rest:?}"
    );
}

#[tokio::test]
async fn multiline_too_big() {
    let (_d, srv) = setup_with(|c| c.limits.max_message_bytes = 20).await;
    let mut c = client(&srv).await;
    c.register_caps("c", &["draft/multiline", "batch", "message-tags"])
        .await;
    join(&mut c, "#c").await;

    // 2 x 15 bytes = 30 bytes, more than the limit of 20.
    c.send("BATCH +m1 draft/multiline #c").await;
    c.send("@batch=m1 PRIVMSG #c :aaaaaaaaaaaaaaa").await;
    c.send("@batch=m1 PRIVMSG #c :bbbbbbbbbbbbbbb").await;
    c.send("BATCH -m1").await;

    let m = c
        .expect(|m| m.command_upper() == "FAIL" && m.param(0) == Some("BATCH"))
        .await;
    assert_eq!(m.param(1), Some("MULTILINE_MAX_BYTES"), "{m:?}");
}

#[tokio::test]
async fn strip_authority_tags() {
    let (_d, srv) = setup().await;
    let mut a = client(&srv).await;
    a.register_caps("a", &["message-tags"]).await;
    let mut b = client(&srv).await;
    b.register_caps("b", &["message-tags"]).await;
    join(&mut a, "#c").await;
    join(&mut b, "#c").await;
    saw_join(&mut a, "b", "#c").await;

    b.send("@+agent-comms.local/role=operator;+agent-comms.local/hop=2 PRIVMSG #c :x")
        .await;
    let m = a.expect(|m| is_privmsg(m, "x")).await;
    assert!(
        !m.tags
            .iter()
            .any(|(k, _)| k.contains("agent-comms.local/role")),
        "authority tag was not stripped: {m:?}"
    );
    assert_eq!(
        m.tag("+agent-comms.local/hop"),
        Some("2"),
        "client tag was lost: {m:?}"
    );
}

#[tokio::test]
async fn nick_collision() {
    let (_d, srv) = setup().await;
    let mut a = client(&srv).await;
    a.register("a").await;
    let mut b = client(&srv).await;
    b.nick = "b?".into();
    b.send("NICK a").await;
    b.expect_numeric("433").await;
}

#[tokio::test]
async fn unknown_command() {
    let (_d, srv) = setup().await;
    let mut a = client(&srv).await;
    a.register("a").await;
    a.send("FOO").await;
    let m = a.expect_numeric("421").await;
    assert!(
        m.params.iter().any(|p| p.eq_ignore_ascii_case("FOO")),
        "{m:?}"
    );
}

#[tokio::test]
async fn not_registered() {
    let (_d, srv) = setup().await;
    let mut a = client(&srv).await;
    a.send("JOIN #c").await;
    a.expect_numeric("451").await;
}

#[tokio::test]
async fn topic_names_list() {
    let (_d, srv) = setup().await;
    let mut a = client(&srv).await;
    a.register("a").await;
    join(&mut a, "#c").await;
    a.send("TOPIC #c :hello world").await;
    let m = a.expect_command("TOPIC").await;
    assert_eq!(m.param(1), Some("hello world"));

    let mut b = client(&srv).await;
    b.register("b").await;
    b.send("JOIN #c").await;
    let m = b.expect_numeric("332").await;
    assert_eq!(m.param(1), Some("#c"));
    assert_eq!(m.params.last().map(String::as_str), Some("hello world"));
    let m = b.expect_numeric("353").await;
    let names = m.params.last().cloned().unwrap_or_default();
    assert!(
        names
            .split(' ')
            .any(|n| n.trim_start_matches(['@', '+']) == "a"),
        "NAMES must list a: {names:?}"
    );
    b.expect_numeric("366").await;

    b.send("LIST").await;
    let m = b
        .expect(|m| m.command == "322" && m.param(1) == Some("#c"))
        .await;
    assert_eq!(m.param(2), Some("2"), "user count: {m:?}");
    b.expect_numeric("323").await;
}

#[tokio::test]
async fn kick_and_modes() {
    let (_d, srv) = setup().await;
    let mut a = client(&srv).await;
    a.register("a").await;
    let mut b = client(&srv).await;
    b.register("b").await;
    join(&mut a, "#c").await;
    join(&mut b, "#c").await;
    saw_join(&mut a, "b", "#c").await;

    a.send("MODE #c +m").await;
    a.expect(|m| m.command_upper() == "MODE" && m.param(1) == Some("+m"))
        .await;

    b.send("PRIVMSG #c :can you hear me").await;
    let m = b.expect_numeric("404").await;
    assert_eq!(m.param(1), Some("#c"));

    a.send("KICK #c b :out").await;
    let m = b.expect_command("KICK").await;
    assert_eq!(m.param(0), Some("#c"));
    assert_eq!(m.param(1), Some("b"));
    assert_eq!(m.source_nick(), Some("a"));
}

#[tokio::test]
async fn non_loopback_requires_tls() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = test_config(dir.path());
    cfg.bind = "0.0.0.0:0".parse().unwrap();
    cfg.tls = None;
    let res = agent_comms_server::start(cfg, Secrets::default()).await;
    assert!(res.is_err(), "non-loopback bind without TLS must fail");
}

#[tokio::test]
async fn flood() {
    let (_d, srv) = setup_with(|c| {
        c.limits.flood_burst = 5;
        c.limits.flood_rate_per_sec = 1;
    })
    .await;
    let mut a = client(&srv).await;
    a.register("a").await;

    for i in 0..200 {
        if !a.send_quiet(&format!("PING flood{i}")).await {
            break;
        }
    }

    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(
            !left.is_zero(),
            "flood did not disconnect the client in 15 s"
        );
        match a.try_recv(left).await {
            None => break, // EOF (or timeout, caught by the assert above)
            Some(m) if m.command_upper() == "ERROR" => {
                let reason = m.params.join(" ");
                assert!(
                    reason.contains("Excess Flood"),
                    "unexpected ERROR: {reason:?}"
                );
                break;
            }
            Some(_) => continue,
        }
    }
    assert!(
        tokio::time::Instant::now() < deadline,
        "flood did not disconnect the client in 15 s"
    );
}

#[tokio::test]
async fn quit_notifies() {
    let (_d, srv) = setup().await;
    let mut a = client(&srv).await;
    a.register("a").await;
    let mut b = client(&srv).await;
    b.register("b").await;
    join(&mut a, "#c").await;
    join(&mut b, "#c").await;
    saw_join(&mut a, "b", "#c").await;

    b.send("QUIT :bye").await;
    let m = a
        .expect(|m| m.command_upper() == "QUIT" && m.source_nick() == Some("b"))
        .await;
    let reason = m.params.join(" ");
    assert!(reason.contains("bye"), "QUIT reason: {reason:?}");
}
