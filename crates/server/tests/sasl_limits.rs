//! SASL verification runs outside the world lock and has admission limits.
//!
//! Documented behaviour: after `MAX_FAILURES` (10) failed attempts from one IP
//! address in 60 s, the server refuses all further attempts from that address
//! with `904` and does no hash check. This also applies to an attempt with
//! the correct password, until the window ends.

mod common;

use agent_comms_proto::Message;
use agent_comms_server::config::Config;
use agent_comms_server::Running;
use base64::Engine;
use common::*;
use std::time::{Duration, Instant};
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

fn plain(account: &str, password: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(format!("\0{account}\0{password}"))
}

/// Send CAP LS, CAP REQ sasl, NICK, and USER, and wait for the ACK.
async fn begin(c: &mut TestClient, nick: &str) {
    c.nick = nick.to_string();
    c.send("CAP LS 302").await;
    c.send("CAP REQ :sasl").await;
    c.expect(|m| m.command_upper() == "CAP" && m.param(1) == Some("ACK"))
        .await;
    c.send(&format!("NICK {nick}")).await;
    c.send(&format!("USER {nick} 0 * :{nick} test")).await;
}

/// Start a PLAIN exchange and wait for the `+` challenge.
async fn start_plain(c: &mut TestClient) {
    c.send("AUTHENTICATE PLAIN").await;
    c.expect(|m| m.command_upper() == "AUTHENTICATE" && m.param(0) == Some("+"))
        .await;
}

fn is_result(m: &Message) -> bool {
    m.command == "903" || m.command == "904"
}

/// Do one PLAIN attempt. Returns the result numeric and the time from the
/// payload to the result.
async fn attempt(c: &mut TestClient, password: &str) -> (Message, Duration) {
    start_plain(c).await;
    let t = Instant::now();
    c.send(&format!("AUTHENTICATE {}", plain(OP_ACCOUNT, password)))
        .await;
    let m = c.expect(is_result).await;
    (m, t.elapsed())
}

#[tokio::test]
async fn correct_login_gives_operator() {
    let (_d, srv) = setup().await;
    let mut c = TestClient::connect(srv.local_addr).await;
    c.register_sasl("op", OP_ACCOUNT, OP_PASSWORD, &[])
        .await
        .expect("SASL with the correct password must succeed");
    c.send("WHOIS op").await;
    let m = c.expect_numeric("313").await;
    assert_eq!(m.param(1), Some("op"));
}

#[tokio::test]
async fn wrong_password_fails() {
    let (_d, srv) = setup().await;
    let mut c = TestClient::connect(srv.local_addr).await;
    let err = c
        .register_sasl("op", OP_ACCOUNT, "wrong password", &[])
        .await
        .expect_err("SASL with a wrong password must fail");
    assert_eq!(err.command, "904");
}

#[tokio::test]
async fn pipelined_cap_end_waits_for_result() {
    let (_d, srv) = setup().await;
    let mut c = TestClient::connect(srv.local_addr).await;
    begin(&mut c, "op").await;
    start_plain(&mut c).await;
    c.send(&format!("AUTHENTICATE {}", plain(OP_ACCOUNT, OP_PASSWORD)))
        .await;
    c.send("CAP END").await;
    let m = c.expect(|m| is_result(m) || m.command == "001").await;
    assert_eq!(m.command, "903", "903 must come before 001: {m:?}");
    c.expect_numeric("001").await;
    c.send("WHOIS op").await;
    c.expect_numeric("313").await;
}

#[tokio::test]
async fn failure_limit_refuses_without_hashing() {
    let (_d, srv) = setup().await;
    let mut c = TestClient::connect(srv.local_addr).await;
    begin(&mut c, "guest").await;

    for i in 0..10 {
        let (m, _) = attempt(&mut c, "wrong password").await;
        assert_eq!(m.command, "904", "attempt {i}: {m:?}");
    }
    for i in 10..12 {
        let (m, took) = attempt(&mut c, "wrong password").await;
        assert_eq!(m.command, "904", "attempt {i}: {m:?}");
        assert!(
            took < Duration::from_millis(100),
            "a limited attempt must return without a hash check, took {took:?}"
        );
    }

    // The limit also refuses the correct password within the window.
    let (m, took) = attempt(&mut c, OP_PASSWORD).await;
    assert_eq!(m.command, "904", "correct password must be refused: {m:?}");
    assert!(took < Duration::from_millis(100), "took {took:?}");

    // Without require_sasl, registration continues as a guest.
    c.send("CAP END").await;
    c.expect_numeric("001").await;
}

#[tokio::test]
async fn failure_limit_closes_when_sasl_required() {
    let (_d, srv) = setup_with(|c| c.require_sasl = true).await;
    let mut c = TestClient::connect(srv.local_addr).await;
    begin(&mut c, "guest").await;
    for i in 0..10 {
        let (m, _) = attempt(&mut c, "wrong password").await;
        assert_eq!(m.command, "904", "attempt {i}: {m:?}");
    }
    let (m, _) = attempt(&mut c, OP_PASSWORD).await;
    assert_eq!(m.command, "904");
    c.expect_command("ERROR").await;
    assert!(c.closed().await, "connection must close after ERROR");
}

#[tokio::test]
async fn verification_does_not_stall_world() {
    let (_d, srv) = setup().await;
    let mut b = TestClient::connect(srv.local_addr).await;
    b.register("b").await;

    let mut authers = Vec::new();
    for i in 0..8 {
        let mut c = TestClient::connect(srv.local_addr).await;
        begin(&mut c, &format!("op{i}")).await;
        start_plain(&mut c).await;
        authers.push(c);
    }
    let payload = format!("AUTHENTICATE {}", plain(OP_ACCOUNT, OP_PASSWORD));
    for c in &mut authers {
        c.send(&payload).await;
    }

    let t = Instant::now();
    b.send("PING :probe").await;
    b.expect(|m| m.command_upper() == "PONG" && m.param(1) == Some("probe"))
        .await;
    let took = t.elapsed();
    assert!(
        took < Duration::from_millis(200),
        "PONG took {took:?} while SASL verifications ran"
    );

    for c in &mut authers {
        let m = c.expect_within(Duration::from_secs(10), is_result).await;
        assert_eq!(m.command, "903", "{m:?}");
    }
}
