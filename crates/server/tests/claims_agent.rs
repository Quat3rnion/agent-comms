mod common;
mod linkutil;

use agent_comms_proto::Message;
use linkutil::*;
use std::path::Path;
use std::time::{Duration, Instant};

const P: &str = "/tmp/x/a.rs";

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

/// Server whose claims last `idle` seconds.
async fn start_idle(dir: &Path, idle: u64) -> agent_comms_server::Running {
    let mut cfg = link_config(dir);
    cfg.limits.claim_idle_secs = idle;
    start_cfg(cfg).await
}

fn is_claimset(m: &Message, holder: &str, path: &str) -> bool {
    is_cmd(m, "CLAIMSET")
        && m.param(0) == Some(holder)
        && m.params.last().map(String::as_str) == Some(path)
}

fn is_claimdel(m: &Message, path: &str) -> bool {
    is_cmd(m, "CLAIMDEL") && m.params.last().map(String::as_str) == Some(path)
}

fn num(m: &Message, i: usize) -> u64 {
    m.param(i)
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| panic!("parameter {i} is not a Unix time: {}", m.to_line()))
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

// 20
#[tokio::test]
async fn claim_grant_broadcast() {
    let dir = tmp();
    let srv = start_idle(dir.path(), 60).await;
    let mut a = link_a(srv.local_addr).await;
    let mut b = link_b(srv.local_addr).await;

    a.send(&format!("@label=c1 CLAIM ses_A {P}")).await;
    let m = a.expect(|m| is_claimset(m, "ses_A", P)).await;
    assert_eq!(m.tag("label"), Some("c1"));
    assert_eq!(m.param(1), Some("fix-auth"));
    assert_eq!(m.params.len(), 5, "{}", m.to_line());
    let since = num(&m, 2);
    let deadline = num(&m, 3);
    assert!(since.abs_diff(now_unix()) <= 5, "since {since} is not now");
    assert!(
        (59..=61).contains(&(deadline - since)),
        "deadline {deadline} is not since + claim_idle_secs"
    );

    let mb = b.expect(|m| is_claimset(m, "ses_A", P)).await;
    assert!(!mb.has_tag("label"), "label on another link's copy");
    assert_eq!(mb.params, m.params);

    // A refresh keeps `since`.
    a.send(&format!("CLAIM ses_A {P}")).await;
    let r = a.expect(|m| is_claimset(m, "ses_A", P)).await;
    assert_eq!(num(&r, 2), since);
}

// 21
#[tokio::test]
async fn claim_conflict() {
    let dir = tmp();
    let srv = start_idle(dir.path(), 60).await;
    let mut a = link_a(srv.local_addr).await;
    let mut b = link_b(srv.local_addr).await;

    a.send(&format!("CLAIM ses_A {P}")).await;
    let set = a.expect(|m| is_claimset(m, "ses_A", P)).await;
    b.expect(|m| is_claimset(m, "ses_A", P)).await;

    b.send(&format!("@label=c2 CLAIM ses_C {P}")).await;
    let f = b.expect_cmd("CLAIMFAIL").await;
    assert_eq!(f.tag("label"), Some("c2"));
    assert_eq!(f.param(0), Some("ses_C"));
    assert_eq!(f.param(1), Some("fix-auth"));
    assert_eq!(f.param(2), set.param(2));
    assert_eq!(f.param(3), Some(P));
    assert_eq!(f.params.len(), 4);

    // The refusal goes to the requesting link only.
    assert!(a
        .try_expect(Duration::from_millis(500), |m| is_cmd(m, "CLAIMFAIL")
            || is_claimset(m, "ses_C", P))
        .await
        .is_none());

    b.send(&format!("CLAIM ses_A {P}")).await;
    let m = b.expect_cmd("FAIL").await;
    assert_eq!(m.param(0), Some("CLAIM"));
    assert_eq!(m.param(1), Some("UNKNOWN_ACCOUNT"));
}

// 22
#[tokio::test]
async fn claim_family_move() {
    let dir = tmp();
    let srv = start_idle(dir.path(), 60).await;
    let mut a = link_a(srv.local_addr).await;
    let mut b = link_b(srv.local_addr).await;

    a.send(&format!("CLAIM ses_A {P}")).await;
    let first = a.expect(|m| is_claimset(m, "ses_A", P)).await;

    a.send(&format!("@label=c3 CLAIM ses_B {P}")).await;
    let m = a.expect(|m| is_claimset(m, "ses_B", P)).await;
    assert_eq!(m.tag("label"), Some("c3"));
    assert_eq!(m.param(1), Some("fix-auth|explore1"));
    assert!(num(&m, 2) >= num(&first, 2));
    let mb = b.expect(|m| is_claimset(m, "ses_B", P)).await;
    assert_eq!(mb.param(1), Some("fix-auth|explore1"));

    // The parent can take it back.
    a.send(&format!("CLAIM ses_A {P}")).await;
    a.expect(|m| is_claimset(m, "ses_A", P)).await;

    a.send("CLAIM ses_A relative/path.rs").await;
    let m = a.expect_cmd("FAIL").await;
    assert_eq!(m.param(0), Some("CLAIM"));
    assert_eq!(m.param(1), Some("INVALID_PATH"));
    assert_eq!(m.param(2), Some("ses_A"));
}

// 23
#[tokio::test]
async fn claim_path_with_space() {
    let dir = tmp();
    let srv = start_idle(dir.path(), 60).await;
    let mut a = link_a(srv.local_addr).await;
    let mut b = link_b(srv.local_addr).await;
    let path = "/tmp/x/API guide.md";

    b.send(&format!("CLAIM ses_C :{path}")).await;
    let m = b.expect(|m| is_claimset(m, "ses_C", path)).await;
    assert_eq!(m.params.len(), 5, "{}", m.to_line());
    let since = m.param(2).unwrap().to_string();
    a.expect(|m| is_claimset(m, "ses_C", path)).await;

    a.send(&format!("CLAIM ses_A :{path}")).await;
    let f = a.expect_cmd("CLAIMFAIL").await;
    assert_eq!(f.param(1), Some("docs-bot"));
    assert_eq!(f.param(2), Some(since.as_str()));
    assert_eq!(f.params.last().map(String::as_str), Some(path));

    b.send(&format!("RELEASE ses_C :{path}")).await;
    b.expect(|m| is_claimdel(m, path)).await;
    a.expect(|m| is_claimdel(m, path)).await;
}

// 24
#[tokio::test]
async fn release_and_expiry() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut a = link_a(srv.local_addr).await;
    let mut b = link_b(srv.local_addr).await;

    a.send(&format!("CLAIM ses_A {P}")).await;
    a.expect(|m| is_claimset(m, "ses_A", P)).await;
    a.send(&format!("@label=r1 RELEASE ses_A {P}")).await;
    let d = a.expect(|m| is_claimdel(m, P)).await;
    assert_eq!(d.tag("label"), Some("r1"));
    assert_eq!(d.params.len(), 1);
    let db = b.expect(|m| is_claimdel(m, P)).await;
    assert!(!db.has_tag("label"));

    a.send("RELEASE ses_A /tmp/x/none.rs").await;
    let m = a.expect_cmd("FAIL").await;
    assert_eq!(m.param(0), Some("RELEASE"));
    assert_eq!(m.param(1), Some("NOT_HELD"));
    assert_eq!(m.param(2), Some("ses_A"));

    let p2 = "/tmp/x/b.rs";
    a.send(&format!("CLAIM ses_A {p2}")).await;
    let set = a.expect(|m| is_claimset(m, "ses_A", p2)).await;
    assert!(num(&set, 3) - num(&set, 2) <= 4, "{}", set.to_line());
    let t0 = Instant::now();
    b.expect_within(Duration::from_secs(7), |m| is_claimdel(m, p2))
        .await;
    a.expect_within(Duration::from_secs(2), |m| is_claimdel(m, p2))
        .await;
    assert!(
        t0.elapsed() >= Duration::from_millis(1500),
        "claim expired too early: {:?}",
        t0.elapsed()
    );
}

#[tokio::test]
async fn state_busy_refreshes_claims() {
    let dir = tmp();
    let srv = start_idle(dir.path(), 60).await;
    let mut a = link_a(srv.local_addr).await;
    let mut b = link_b(srv.local_addr).await;
    a.send(&format!("CLAIM ses_A {P}")).await;
    let first = a.expect(|m| is_claimset(m, "ses_A", P)).await;
    b.expect(|m| is_claimset(m, "ses_A", P)).await;

    tokio::time::sleep(Duration::from_millis(1100)).await;
    a.send("STATE ses_A busy").await;
    let r = b.expect(|m| is_claimset(m, "ses_A", P)).await;
    assert_eq!(num(&r, 2), num(&first, 2));
    assert!(num(&r, 3) > num(&first, 3));
}

#[tokio::test]
async fn retire_releases_claims() {
    let dir = tmp();
    let srv = start_idle(dir.path(), 60).await;
    let mut a = link_a(srv.local_addr).await;
    let mut b = link_b(srv.local_addr).await;
    a.send(&format!("CLAIM ses_B {P}")).await;
    b.expect(|m| is_claimset(m, "ses_B", P)).await;
    a.send("RETIRE ses_B").await;
    b.expect(|m| is_claimdel(m, P)).await;
    let m = a.expect_cmd("RETIRED").await;
    assert_eq!(m.param(0), Some("ses_B"));
}

// 25
#[tokio::test]
async fn claims_in_burst_and_persist() {
    let dir = tmp();
    let mut cfg = link_config(dir.path());
    cfg.limits.claim_idle_secs = 120;
    let srv = start_cfg(cfg.clone()).await;
    let mut a = link_a(srv.local_addr).await;
    a.send(&format!("CLAIM ses_A {P}")).await;
    let set = a.expect(|m| is_claimset(m, "ses_A", P)).await;
    drop(a);
    tokio::time::sleep(Duration::from_millis(300)).await;
    srv.shutdown().await.expect("shutdown");
    tokio::time::sleep(Duration::from_millis(200)).await;

    let srv = start_cfg(cfg).await;
    let (_a, burst) = linked(srv.local_addr, LINK_A, &[INTRO_A, INTRO_B]).await;
    let bi = burst
        .iter()
        .position(|m| is_cmd(m, "BURST"))
        .expect("BURST");
    let ci = burst
        .iter()
        .position(|m| is_claimset(m, "ses_A", P))
        .unwrap_or_else(|| panic!("claim lost across restart:\n{}", dump(&burst)));
    assert!(bi < ci, "{}", dump(&burst));
    assert_eq!(burst[ci].param(1), Some("fix-auth"));
    assert_eq!(burst[ci].param(2), set.param(2));

    // Another link sees the claim in its server burst too.
    let (_b, burst) = linked(srv.local_addr, LINK_B, &[INTRO_C]).await;
    assert!(
        burst.iter().any(|m| is_claimset(m, "ses_A", P)),
        "{}",
        dump(&burst)
    );
}

#[tokio::test]
async fn claim_during_link_burst() {
    let dir = tmp();
    let srv = start_idle(dir.path(), 60).await;
    let claim = format!("CLAIM ses_A {P}");
    let (_a, burst) = linked(srv.local_addr, LINK_A, &[INTRO_A, INTRO_B, claim.as_str()]).await;
    let bi = burst
        .iter()
        .position(|m| is_cmd(m, "BURST"))
        .expect("BURST");
    let sets: Vec<usize> = burst
        .iter()
        .enumerate()
        .filter(|(_, m)| is_claimset(m, "ses_A", P))
        .map(|(i, _)| i)
        .collect();
    assert_eq!(sets.len(), 1, "{}", dump(&burst));
    assert!(
        sets[0] > bi,
        "CLAIMSET during the link burst:\n{}",
        dump(&burst)
    );
}

// 26
#[tokio::test]
async fn operator_claims_commands() {
    let dir = tmp();
    let srv = start_idle(dir.path(), 60).await;
    let mut a = link_a(srv.local_addr).await;
    let (mut b, _) = linked(
        srv.local_addr,
        LINK_B,
        &["INTRODUCE ses_C docs-bot * operator agent other :Docs"],
    )
    .await;
    let pc = "/tmp/y/c.rs";
    a.send(&format!("CLAIM ses_A {P}")).await;
    let sa = a.expect(|m| is_claimset(m, "ses_A", P)).await;
    b.send(&format!("CLAIM ses_C {pc}")).await;
    b.expect(|m| is_claimset(m, "ses_C", pc)).await;
    a.expect(|m| is_claimset(m, "ses_C", pc)).await;

    let mut op = operator(srv.local_addr).await;
    let t = Duration::from_secs(3);
    op.send("CLAIMS").await;
    let all = notices_until(&mut op, "end of CLAIMS", t).await;
    let line_a = format!(
        "fix-auth holds {P} since {} until {}",
        sa.param(2).unwrap(),
        sa.param(3).unwrap()
    );
    assert!(all.contains(&line_a), "{all:?}");
    assert!(
        all.iter()
            .any(|l| l.starts_with(&format!("docs-bot holds {pc} since "))),
        "{all:?}"
    );

    op.send("CLAIMS #webapp").await;
    let chan = notices_until(&mut op, "end of CLAIMS", t).await;
    assert!(chan.contains(&line_a), "{chan:?}");
    assert!(!chan.iter().any(|l| l.contains(pc)), "{chan:?}");

    op.send(&format!("CLAIMS {pc}")).await;
    let one = notices_until(&mut op, "end of CLAIMS", t).await;
    let holds: Vec<&String> = one.iter().filter(|l| l.contains(" holds ")).collect();
    assert_eq!(holds.len(), 1, "{one:?}");
    assert!(holds[0].starts_with("docs-bot holds "), "{one:?}");

    op.send("CLAIM /tmp/x/a.rs").await;
    let u = op
        .expect(|m| {
            m.command_upper() == "NOTICE"
                && m.params.last().is_some_and(|t| t.starts_with("usage:"))
        })
        .await;
    assert_eq!(
        u.params.last().map(String::as_str),
        Some("usage: CLAIM --force <path>")
    );

    op.send(&format!("CLAIM --force {P}")).await;
    a.expect(|m| is_claimdel(m, P)).await;
    b.expect(|m| is_claimdel(m, P)).await;

    let mut g = guest(srv.local_addr, "guest").await;
    g.send(&format!("CLAIM --force {pc}")).await;
    g.expect_numeric("481").await;
    g.send(&format!("RELEASE {pc}")).await;
    g.expect_numeric("481").await;
    assert!(b
        .try_expect(Duration::from_millis(500), |m| is_claimdel(m, pc))
        .await
        .is_none());

    op.send(&format!("RELEASE {pc}")).await;
    b.expect(|m| is_claimdel(m, pc)).await;
}

/// Only the `[<nick>] ...` relay lines.
fn relayed(got: Vec<String>) -> Vec<String> {
    got.into_iter().filter(|t| t.starts_with('[')).collect()
}

fn is_agent_req(m: &Message, verb: &str, account: &str) -> bool {
    is_cmd(m, "AGENT") && m.param(1) == Some(verb) && m.param(2) == Some(account)
}

fn req_id(m: &Message) -> String {
    let id = m.param(0).expect("request id").to_string();
    assert!(
        !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric()),
        "bad request id: {}",
        m.to_line()
    );
    id
}

// 27
#[tokio::test]
async fn agent_status_roundtrip() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut a = link_a(srv.local_addr).await;
    let mut op = operator(srv.local_addr).await;

    op.send("AGENT STATUS fix-auth").await;
    let req = a.expect(|m| is_agent_req(m, "STATUS", "ses_A")).await;
    let id = req_id(&req);
    a.send(&format!("AGENTREPLY {id} ses_A :busy, editing"))
        .await;
    a.send(&format!("AGENTEND {id}")).await;

    let got = notices_until(&mut op, "end of AGENT STATUS", Duration::from_secs(3)).await;
    assert_eq!(relayed(got), ["[fix-auth] busy, editing"]);

    // A late or unknown request ID is ignored.
    a.send(&format!("AGENTEND {id}")).await;
    a.send("AGENTREPLY zz999 ses_A :stray").await;
    a.sync().await;

    op.send("AGENT INTERRUPT fix-auth|explore1").await;
    let req = a.expect(|m| is_agent_req(m, "INTERRUPT", "ses_B")).await;
    let id = req_id(&req);
    a.send(&format!("AGENTREPLY {id} ses_B :interrupted")).await;
    a.send(&format!("AGENTEND {id}")).await;
    let got = notices_until(&mut op, "end of AGENT INTERRUPT", Duration::from_secs(3)).await;
    assert_eq!(relayed(got), ["[fix-auth|explore1] interrupted"]);

    op.send("AGENT STATUS alice").await;
    let got = notices_until(&mut op, "end of AGENT STATUS", Duration::from_secs(3)).await;
    assert!(got.iter().any(|t| t == "[alice] not an agent"), "{got:?}");
}

// 28
#[tokio::test]
async fn agent_status_channel_and_dormant() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let (mut a, _) = linked(srv.local_addr, LINK_A, &[INTRO_A]).await;
    let b = link_b(srv.local_addr).await;
    let mut op = operator(srv.local_addr).await;
    join_names(&mut op, "#webapp").await;

    drop(b);
    op.expect(|m| {
        m.command_upper() == "AWAY"
            && m.source_nick() == Some("docs-bot")
            && m.param(0) == Some("dormant")
    })
    .await;

    op.send("AGENT STATUS #webapp").await;
    let req = a.expect(|m| is_agent_req(m, "STATUS", "ses_A")).await;
    let id = req_id(&req);
    a.send(&format!("AGENTREPLY {id} ses_A :idle")).await;
    a.send(&format!("AGENTEND {id}")).await;

    let got = notices_until(&mut op, "end of AGENT STATUS", Duration::from_secs(4)).await;
    assert!(got.iter().any(|t| t == "[fix-auth] idle"), "{got:?}");
    assert!(
        got.iter().any(|t| t == "[docs-bot] dormant (link offline)"),
        "{got:?}"
    );
    assert!(
        a.try_expect(Duration::from_millis(300), |m| is_cmd(m, "AGENT"))
            .await
            .is_none(),
        "more than one request for one account"
    );
}

// 29
#[tokio::test]
async fn agent_timeout() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut a = link_a(srv.local_addr).await;
    let mut op = operator(srv.local_addr).await;

    let t0 = Instant::now();
    op.send("AGENT STATUS fix-auth").await;
    a.expect(|m| is_agent_req(m, "STATUS", "ses_A")).await;
    let got = notices_until(&mut op, "end of AGENT STATUS", Duration::from_secs(6)).await;
    assert_eq!(relayed(got), ["[fix-auth] no reply"]);
    assert!(
        t0.elapsed() >= Duration::from_millis(1500),
        "timed out too early: {:?}",
        t0.elapsed()
    );
}

// 30
#[tokio::test]
async fn agent_permissions() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut a = link_a(srv.local_addr).await;

    let mut g = guest(srv.local_addr, "guest").await;
    g.send("AGENT STATUS fix-auth").await;
    g.expect_numeric("481").await;

    let mut op = operator(srv.local_addr).await;
    op.send("AGENT INTERRUPT unknown").await;
    op.expect_numeric("401").await;
    op.send("AGENT STATUS #nochannel").await;
    op.expect_numeric("403").await;
    op.send("AGENT STATUS").await;
    op.expect_numeric("461").await;

    assert!(
        a.try_expect(Duration::from_millis(300), |m| is_cmd(m, "AGENT"))
            .await
            .is_none(),
        "a refused request reached the link"
    );
}
