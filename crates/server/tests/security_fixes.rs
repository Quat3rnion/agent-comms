mod common;
mod linkutil;

use agent_comms_proto::Message;
use agent_comms_server::handlers::message::{pending_batch_count, sweep_pending};
use linkutil::*;
use std::time::{Duration, Instant};

const P: &str = "/tmp/x/a.rs";
const P2: &str = "/tmp/x/b.rs";

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

fn is_batch_fail(m: &Message, code: &str) -> bool {
    m.command_upper() == "FAIL" && m.param(0) == Some("BATCH") && m.param(1) == Some(code)
}

fn is_fail(m: &Message, verb: &str, code: &str) -> bool {
    is_cmd(m, "FAIL") && m.param(0) == Some(verb) && m.param(1) == Some(code)
}

/// Wait until `f` is true, for at most 3 seconds.
async fn eventually(f: impl Fn() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if f() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    f()
}

// Finding A: open batches are released when the user quits.
#[tokio::test]
async fn multiline_batch_dropped_on_quit() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let state = srv.state();
    let mut c = guest(srv.local_addr, "batcher").await;

    c.send("BATCH +ml draft/multiline #lobby").await;
    for i in 0..150 {
        c.send(&format!("@batch=ml PRIVMSG #lobby :line {i}")).await;
    }
    client_sync(&mut c, "s1").await;
    assert_eq!(pending_batch_count(&state), 1);

    c.send("QUIT :bye").await;
    assert!(
        eventually(|| pending_batch_count(&state) == 0).await,
        "batch kept after QUIT"
    );
}

// Finding A: a user has at most one open batch.
#[tokio::test]
async fn multiline_one_batch_per_user() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let state = srv.state();
    let mut c = guest(srv.local_addr, "batcher").await;

    c.send("BATCH +one draft/multiline #lobby").await;
    c.send("@batch=one PRIVMSG #lobby :first").await;
    c.send("BATCH +two draft/multiline #lobby").await;
    c.expect(|m| is_batch_fail(m, "MULTILINE_INVALID")).await;
    client_sync(&mut c, "s1").await;
    assert_eq!(pending_batch_count(&state), 1);

    c.send("@batch=one PRIVMSG #lobby :late").await;
    c.expect(|m| is_batch_fail(m, "MULTILINE_INVALID")).await;
}

// Finding A: a batch older than 60 seconds is dropped.
#[tokio::test]
async fn multiline_batch_expires() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let state = srv.state();
    let mut c = guest(srv.local_addr, "batcher").await;

    c.send("BATCH +ml draft/multiline #lobby").await;
    c.send("@batch=ml PRIVMSG #lobby :line").await;
    client_sync(&mut c, "s1").await;
    assert_eq!(pending_batch_count(&state), 1);

    assert_eq!(sweep_pending(&state, Instant::now()), 0);
    assert_eq!(
        sweep_pending(&state, Instant::now() + Duration::from_secs(61)),
        1
    );
    assert_eq!(pending_batch_count(&state), 0);

    c.send("BATCH -ml").await;
    c.expect(|m| is_batch_fail(m, "MULTILINE_INVALID")).await;
}

// Finding B: a link cannot CLAIM or RELEASE for a dormant account of
// another link.
#[tokio::test]
async fn dormant_account_claims_refused_for_other_link() {
    let dir = tmp();
    let mut cfg = link_config(dir.path());
    cfg.limits.claim_idle_secs = 60;
    let srv = start_cfg(cfg).await;

    let mut x = link_a(srv.local_addr).await;
    let mut op = operator(srv.local_addr).await;
    join_names(&mut op, "#webapp").await;

    x.send(&format!("CLAIM ses_A {P}")).await;
    x.expect(|m| is_cmd(m, "CLAIMSET") && m.params.last().map(String::as_str) == Some(P))
        .await;

    drop(x);
    op.expect(|m| {
        m.command_upper() == "AWAY"
            && m.param(0) == Some("dormant")
            && m.source_nick() == Some("fix-auth")
    })
    .await;

    let (mut y, _) = linked(srv.local_addr, LINK_B, &[]).await;
    y.send(&format!("RELEASE ses_A {P}")).await;
    let f = y.expect(|m| is_cmd(m, "FAIL")).await;
    assert!(is_fail(&f, "RELEASE", "UNKNOWN_ACCOUNT"), "{}", f.to_line());

    y.send(&format!("CLAIM ses_A {P2}")).await;
    let f = y.expect(|m| is_cmd(m, "FAIL")).await;
    assert!(is_fail(&f, "CLAIM", "UNKNOWN_ACCOUNT"), "{}", f.to_line());

    y.sync().await;
    assert!(y
        .try_expect(Duration::from_millis(300), |m| is_cmd(m, "CLAIMDEL")
            || (is_cmd(m, "CLAIMSET")
                && m.params.last().map(String::as_str) == Some(P2)))
        .await
        .is_none());

    op.send("CLAIMS").await;
    let all = notices_until(&mut op, "end of CLAIMS", Duration::from_secs(3)).await;
    assert!(
        all.iter()
            .any(|l| l.starts_with(&format!("fix-auth holds {P} since "))),
        "{all:?}"
    );
    assert!(!all.iter().any(|l| l.contains(P2)), "{all:?}");
}
