mod common;
mod linkutil;

use agent_comms_proto::Message;
use linkutil::*;
use std::time::Duration;

const SHORT: Duration = Duration::from_millis(400);

/// Third account on link A: `ses_D` / `helper`, project `webapp`.
const INTRO_D: &str = "INTRODUCE ses_D helper * operator agent webapp :Helper";

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

async fn start_limits(
    dir: &std::path::Path,
    link: (u32, u32),
    account: (u32, u32),
) -> agent_comms_server::Running {
    let mut cfg = link_config(dir);
    cfg.limits.link_flood_burst = link.0;
    cfg.limits.link_flood_rate_per_sec = link.1;
    cfg.limits.account_flood_burst = account.0;
    cfg.limits.account_flood_rate_per_sec = account.1;
    start_cfg(cfg).await
}

fn is_ack(m: &Message, label: &str) -> bool {
    (is_cmd(m, "SENT") || is_cmd(m, "SENDFAIL")) && m.tag("label") == Some(label)
}

fn is_flood(m: &Message) -> bool {
    is_cmd(m, "SENDFAIL") && m.param(1) == Some("FLOOD")
}

/// Wait for the SENT or SENDFAIL with `label`.
async fn ack(l: &mut FakeLink, label: &str) -> Message {
    let label = label.to_string();
    l.expect(move |m| is_ack(m, &label)).await
}

#[tokio::test]
async fn account_flood_limit() {
    let dir = tmp();
    let srv = start_limits(dir.path(), (5000, 1000), (5, 1)).await;
    let mut a = link_a(srv.local_addr).await;

    for n in 0..10 {
        a.send(&format!("@label=f{n} SEND ses_A :PRIVMSG #webapp :m{n}"))
            .await;
    }
    for n in 0..10 {
        let m = ack(&mut a, &format!("f{n}")).await;
        assert_eq!(m.param(0), Some("ses_A"), "{}", m.to_line());
        if n < 5 {
            assert!(is_cmd(&m, "SENT"), "message {n}: {}", m.to_line());
        } else {
            assert!(is_flood(&m), "message {n}: {}", m.to_line());
            assert_eq!(
                m.params.last().map(String::as_str),
                Some("too many messages; slow down")
            );
        }
    }

    // Another account on the same link has its own bucket.
    a.send("@label=b1 SEND ses_B :PRIVMSG #webapp :other").await;
    let m = ack(&mut a, "b1").await;
    assert!(is_cmd(&m, "SENT"), "{}", m.to_line());

    // The link stays up and the bucket refills.
    tokio::time::sleep(Duration::from_millis(2100)).await;
    a.send("@label=late SEND ses_A :PRIVMSG #webapp :later")
        .await;
    let m = ack(&mut a, "late").await;
    assert!(is_cmd(&m, "SENT"), "{}", m.to_line());
}

#[tokio::test]
async fn link_flood_limit() {
    let dir = tmp();
    let srv = start_limits(dir.path(), (8, 1), (1000, 1000)).await;
    let (mut a, _) = linked(srv.local_addr, LINK_A, &[INTRO_A, INTRO_B, INTRO_D]).await;

    let accounts = ["ses_A", "ses_B", "ses_D"];
    for acct in accounts {
        for n in 0..4 {
            a.send(&format!(
                "@label={acct}-{n} SEND {acct} :PRIVMSG #webapp :{n}"
            ))
            .await;
        }
    }
    let mut sent = 0;
    let mut flood = 0;
    for acct in accounts {
        for n in 0..4 {
            let m = ack(&mut a, &format!("{acct}-{n}")).await;
            assert_eq!(m.param(0), Some(acct), "{}", m.to_line());
            if is_cmd(&m, "SENT") {
                sent += 1;
            } else {
                assert!(is_flood(&m), "{}", m.to_line());
                flood += 1;
            }
        }
    }
    assert!(sent <= 8, "{sent} messages sent over a link burst of 8");
    assert_eq!(sent + flood, 12);
    assert!(flood >= 4, "only {flood} messages refused");

    // The link is not disconnected.
    a.sync().await;
}

#[tokio::test]
async fn query_flood_limit() {
    let dir = tmp();
    let srv = start_limits(dir.path(), (5000, 1000), (2, 1)).await;
    let mut a = link_a(srv.local_addr).await;

    for n in 0..4 {
        a.send(&format!("@label=q{n} SEND ses_A :NAMES #webapp"))
            .await;
    }
    for n in 2..4 {
        let label = format!("q{n}");
        let m = a
            .expect(|m| is_cmd(m, "FAIL") && m.tag("label") == Some(label.as_str()))
            .await;
        assert_eq!(m.param(0), Some("SEND"), "{}", m.to_line());
        assert_eq!(m.param(1), Some("FLOOD"), "{}", m.to_line());
        assert_eq!(m.param(2), Some("ses_A"), "{}", m.to_line());
        assert_eq!(
            m.params.last().map(String::as_str),
            Some("too many requests")
        );
    }
    assert!(
        a.try_expect(SHORT, |m| is_cmd(m, "FAIL") && m.param(1) == Some("FLOOD"))
            .await
            .is_none(),
        "an accepted query got FLOOD"
    );
    a.sync().await;
}

#[tokio::test]
async fn multiline_counts_once() {
    let dir = tmp();
    let srv = start_limits(dir.path(), (5000, 1000), (2, 1)).await;
    let mut a = link_a(srv.local_addr).await;

    a.send("@label=p1 SEND ses_A :PRIVMSG #webapp :single")
        .await;
    let m = ack(&mut a, "p1").await;
    assert!(is_cmd(&m, "SENT"), "{}", m.to_line());

    // One token for the whole batch.
    a.send("SEND ses_A :BATCH +b1 draft/multiline #webapp")
        .await;
    for n in 0..3 {
        a.send(&format!("SEND ses_A :@batch=b1 PRIVMSG #webapp :line {n}"))
            .await;
    }
    a.send("@label=m1 SEND ses_A :BATCH -b1").await;
    let m = ack(&mut a, "m1").await;
    assert!(is_cmd(&m, "SENT"), "{}", m.to_line());

    // The bucket is empty now: a refused batch gets one SENDFAIL, at its end.
    a.send("SEND ses_A :BATCH +b2 draft/multiline #webapp")
        .await;
    for n in 0..3 {
        a.send(&format!("SEND ses_A :@batch=b2 PRIVMSG #webapp :more {n}"))
            .await;
    }
    a.send("@label=m2 SEND ses_A :BATCH -b2").await;
    let m = ack(&mut a, "m2").await;
    assert!(is_flood(&m), "{}", m.to_line());
    assert!(
        a.try_expect(SHORT, |m| {
            is_cmd(m, "SENT")
                || is_cmd(m, "SENDFAIL")
                || (is_deliver_for(m, "ses_B")
                    && inner(m)
                        .params
                        .last()
                        .is_some_and(|t| t.starts_with("more ")))
        })
        .await
        .is_none(),
        "a batch got more than one ack, or a refused batch was delivered"
    );
}
