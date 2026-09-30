mod common;
mod linkutil;

use agent_comms_proto::Message;
use linkutil::*;
use std::collections::HashSet;
use std::time::Duration;

const SHORT: Duration = Duration::from_millis(600);

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

async fn expect_error(link: &mut FakeLink, reason: &str) {
    let m = link.expect_cmd("ERROR").await;
    assert_eq!(
        m.params.last().map(String::as_str),
        Some(reason),
        "wrong ERROR: {}",
        m.to_line()
    );
    assert!(
        link.closed(Duration::from_secs(2)).await,
        "connection not closed after ERROR"
    );
}

// 1
#[tokio::test]
async fn handshake_ok() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut l = FakeLink::connect(srv.local_addr).await;
    let m = l.handshake(LINK_A, TOKEN).await;
    assert_eq!(m.param(0), Some("1"));
    assert_eq!(m.param(1), Some("irc.agent-comms.local"));
    assert!(
        m.source.is_none(),
        "link verb with a source: {}",
        m.to_line()
    );
}

// 2
#[tokio::test]
async fn bad_version() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut l = FakeLink::connect(srv.local_addr).await;
    // The version is checked before the credential.
    l.send("LINK 2 x tok").await;
    expect_error(&mut l, "unsupported version").await;
}

#[tokio::test]
async fn bad_credential() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut l = FakeLink::connect(srv.local_addr).await;
    l.send(&format!("LINK 1 {LINK_A} wrong-token")).await;
    expect_error(&mut l, "bad credential").await;
}

#[tokio::test]
async fn invalid_link_name() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut l = FakeLink::connect(srv.local_addr).await;
    l.send(&format!("LINK 1 bad!name {TOKEN}")).await;
    expect_error(&mut l, "invalid link name").await;

    let long = "a".repeat(65);
    let mut l = FakeLink::connect(srv.local_addr).await;
    l.send(&format!("LINK 1 {long} {TOKEN}")).await;
    expect_error(&mut l, "invalid link name").await;

    // Any name that follows the character and length rules is accepted.
    let mut l = FakeLink::connect(srv.local_addr).await;
    l.handshake(&"Z.9_-".repeat(12), TOKEN).await;
}

#[tokio::test]
async fn malformed_link() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut l = FakeLink::connect(srv.local_addr).await;
    l.send("LINK 1").await;
    expect_error(&mut l, "malformed LINK").await;
}

// 3
#[tokio::test]
async fn rate_limit() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    for i in 0..5 {
        let mut l = FakeLink::connect(srv.local_addr).await;
        l.send(&format!("LINK 1 {LINK_A} wrong-{i}")).await;
        expect_error(&mut l, "bad credential").await;
    }
    let mut l = FakeLink::connect(srv.local_addr).await;
    l.send(&format!("LINK 1 {LINK_A} wrong-6")).await;
    expect_error(&mut l, "rate limited").await;

    // Over the limit the credential is not checked.
    let mut l = FakeLink::connect(srv.local_addr).await;
    l.send(&format!("LINK 1 {LINK_A} {TOKEN}")).await;
    expect_error(&mut l, "rate limited").await;
}

// 4
#[tokio::test]
async fn introduce_and_autojoin() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut l = FakeLink::connect(srv.local_addr).await;
    l.handshake(LINK_A, TOKEN).await;
    let b = l.burst(&[INTRO_A, INTRO_B]).await;
    assert_eq!(introduced_nick(&b, "ses_A"), "fix-auth");
    assert_eq!(introduced_nick(&b, "ses_B"), "fix-auth|explore1");
    let ib = b
        .iter()
        .position(|m| is_cmd(m, "BURST"))
        .expect("server BURST");
    let ia = b
        .iter()
        .position(|m| is_cmd(m, "INTRODUCED") && m.param(0) == Some("ses_B"))
        .unwrap();
    assert!(ia < ib, "INTRODUCED after the server BURST:\n{}", dump(&b));
    assert!(
        !b.iter().any(|m| is_cmd(m, "DELIVER")),
        "no DELIVER for auto-joins to the introduced accounts:\n{}",
        dump(&b)
    );

    let mut op = operator(srv.local_addr).await;
    for chan in ["#lobby", "#webapp", "#fix-auth"] {
        let n = join_names(&mut op, chan).await;
        assert!(has_nick(&n, "fix-auth"), "{chan}: {n:?}");
        assert!(has_nick(&n, "fix-auth|explore1"), "{chan}: {n:?}");
    }
}

#[tokio::test]
async fn introduce_failures() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut l = FakeLink::connect(srv.local_addr).await;
    l.handshake(LINK_A, TOKEN).await;
    let b = l
        .burst(&[
            "INTRODUCE operator opx * operator agent webapp :x",
            "INTRODUCE ses_R1 r1 * operator operator webapp :x",
            "INTRODUCE ses_R2 r2 * mallory agent webapp :x",
            "INTRODUCE ses_R3 r3 ses_missing operator agent webapp :x",
            "INTRODUCE ses_R4 r4 * operator agent Bad_Project :x",
            "INTRODUCE ses_R5 9nick * operator agent webapp :x",
            "INTRODUCE bad!acct r6 * operator agent webapp :x",
        ])
        .await;
    let fail = |code: &str, acct: &str| {
        find(&b, |m| {
            is_cmd(m, "FAIL")
                && m.param(0) == Some("INTRODUCE")
                && m.param(1) == Some(code)
                && m.param(2) == Some(acct)
        })
        .is_some()
    };
    assert!(
        fail("ACCOUNT_OWNED_BY_OPERATOR", "operator"),
        "{}",
        dump(&b)
    );
    assert!(fail("INVALID_ROLE", "ses_R1"), "{}", dump(&b));
    assert!(fail("OWNER_MISMATCH", "ses_R2"), "{}", dump(&b));
    assert!(fail("INVALID_PARENT", "ses_R3"), "{}", dump(&b));
    assert!(fail("INVALID_PROJECT", "ses_R4"), "{}", dump(&b));
    assert!(fail("ERRONEUS_NICK", "ses_R5"), "{}", dump(&b));
    assert!(fail("INVALID_ACCOUNT", "bad!acct"), "{}", dump(&b));
    assert!(!b.iter().any(|m| is_cmd(m, "INTRODUCED")), "{}", dump(&b));
    // The link stays open.
    l.sync().await;
}

// 5
#[tokio::test]
async fn nick_collision_suffix() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut l = FakeLink::connect(srv.local_addr).await;
    l.handshake(LINK_A, TOKEN).await;
    let b = l
        .burst(&[
            "INTRODUCE ses_D1 dup * operator agent webapp :one",
            "INTRODUCE ses_D2 dup * operator agent webapp :two",
            "INTRODUCE ses_D3 DUP * operator agent webapp :three",
        ])
        .await;
    assert_eq!(introduced_nick(&b, "ses_D1"), "dup");
    assert_eq!(introduced_nick(&b, "ses_D2"), "dup-2");
    assert!(
        introduced_nick(&b, "ses_D3").eq_ignore_ascii_case("dup-3"),
        "{}",
        dump(&b)
    );
}

// 6
#[tokio::test]
async fn rename_alias() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut l = link_a(srv.local_addr).await;

    l.send("@label=r1 RENAME ses_A newnick").await;
    let m = l.expect_cmd("RENAMED").await;
    assert_eq!(m.param(0), Some("ses_A"));
    assert_eq!(m.param(1), Some("newnick"));
    assert_eq!(m.tag("label"), Some("r1"));

    // A rename to the current nick changes nothing and still gets RENAMED.
    l.send("RENAME ses_A newnick").await;
    let m = l.expect_cmd("RENAMED").await;
    assert_eq!(m.param(1), Some("newnick"));

    let mut op = operator(srv.local_addr).await;
    op.send("PRIVMSG fix-auth :via alias").await;
    let d = l
        .expect(|m| is_deliver_msg(m, "ses_A", "PRIVMSG", "via alias"))
        .await;
    let i = inner(&d);
    assert_eq!(i.param(0), Some("newnick"), "target is the current nick");
    assert_eq!(i.tag("agent-comms.local/rel"), Some("operator"));
    assert_eq!(i.tag("agent-comms.local/role"), Some("operator"));
    assert_eq!(i.tag("account"), Some("operator"));
    assert!(i.tag("msgid").is_some_and(|v| !v.is_empty()));
    assert!(i.tag("time").is_some_and(|v| v.ends_with('Z')));
    assert_eq!(i.source_nick(), Some(OP_NICK));

    // The alias stays reserved.
    l.send("INTRODUCE ses_X fix-auth * operator agent webapp :x")
        .await;
    let m = l
        .expect(|m| is_cmd(m, "INTRODUCED") && m.param(0) == Some("ses_X"))
        .await;
    assert_eq!(m.param(1), Some("fix-auth-2"));

    // The account can take its own alias back.
    l.send("RENAME ses_A fix-auth").await;
    let m = l.expect_cmd("RENAMED").await;
    assert_eq!(m.param(1), Some("fix-auth"));

    l.send("RENAME ses_A 9bad").await;
    let m = l.expect_cmd("FAIL").await;
    assert_eq!(m.param(0), Some("RENAME"));
    assert_eq!(m.param(1), Some("ERRONEUS_NICK"));
    assert_eq!(m.param(2), Some("ses_A"));

    l.send("RENAME ses_nope x").await;
    let m = l.expect_cmd("FAIL").await;
    assert_eq!(m.param(0), Some("RENAME"));
    assert_eq!(m.param(1), Some("UNKNOWN_ACCOUNT"));
}

// 7
#[tokio::test]
async fn family_channel_rename() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut l = link_a(srv.local_addr).await;
    l.send("RENAME ses_A boss").await;
    let m = l.expect_cmd("RENAMED").await;
    assert_eq!(m.param(1), Some("boss"));

    let mut op = operator(srv.local_addr).await;
    let n = join_names(&mut op, "#boss").await;
    assert!(has_nick(&n, "boss"), "#boss: {n:?}");
    assert!(has_nick(&n, "fix-auth|explore1"), "#boss: {n:?}");
    let n = join_names(&mut op, "#fix-auth").await;
    assert!(!has_nick(&n, "boss"), "#fix-auth: {n:?}");
    assert!(!has_nick(&n, "fix-auth|explore1"), "#fix-auth: {n:?}");
}

// 8
#[tokio::test]
async fn send_sent_and_deliver() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut a = link_a(srv.local_addr).await;
    let mut b = link_b(srv.local_addr).await;
    let mut op = operator(srv.local_addr).await;
    join_names(&mut op, "#webapp").await;

    a.send("@label=l1 SEND ses_A :PRIVMSG #webapp :hello").await;
    let sent = a.expect_cmd("SENT").await;
    assert_eq!(sent.tag("label"), Some("l1"));
    assert_eq!(sent.param(0), Some("ses_A"));
    let msgid = sent.param(1).expect("msgid").to_string();
    assert!(!msgid.is_empty() && msgid.len() <= 64);
    assert!(msgid
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));

    let pm = op
        .expect(|m| {
            m.command_upper() == "PRIVMSG" && m.params.last().map(String::as_str) == Some("hello")
        })
        .await;
    assert_eq!(pm.source_nick(), Some("fix-auth"));
    assert_eq!(pm.param(0), Some("#webapp"));
    assert!(!pm.has_tag("+agent-comms.local/hop"));
    assert_eq!(pm.tag("agent-comms.local/role"), Some("agent"));
    assert_eq!(pm.tag("msgid"), Some(msgid.as_str()));

    let d = b
        .expect(|m| is_deliver_msg(m, "ses_C", "PRIVMSG", "hello"))
        .await;
    let i = inner(&d);
    assert_eq!(i.tag("agent-comms.local/rel"), Some("peer"));
    assert_eq!(i.tag("agent-comms.local/role"), Some("agent"));
    assert_eq!(i.tag("account"), Some("ses_A"));
    assert_eq!(i.tag("msgid"), Some(msgid.as_str()));
    assert!(!i.has_tag("agent-comms.local/parent"));
    assert_eq!(
        i.source.as_deref(),
        Some("fix-auth!ses_A@agent-comms.local")
    );
    assert!(!d.has_tag("label"));

    let d = a
        .expect(|m| is_deliver_msg(m, "ses_B", "PRIVMSG", "hello"))
        .await;
    assert_eq!(inner(&d).tag("agent-comms.local/rel"), Some("ancestor"));

    // echo-message is off for link accounts.
    assert!(
        a.try_expect(SHORT, |m| is_deliver_msg(m, "ses_A", "PRIVMSG", "hello"))
            .await
            .is_none(),
        "sender got its own message"
    );

    a.send("SEND ses_B :PRIVMSG #webapp :report").await;
    let d = a
        .expect(|m| is_deliver_msg(m, "ses_A", "PRIVMSG", "report"))
        .await;
    let i = inner(&d);
    assert_eq!(i.tag("agent-comms.local/rel"), Some("descendant"));
    assert_eq!(i.tag("agent-comms.local/parent"), Some("fix-auth"));
    let d = b
        .expect(|m| is_deliver_msg(m, "ses_C", "PRIVMSG", "report"))
        .await;
    assert_eq!(inner(&d).tag("agent-comms.local/rel"), Some("peer"));
}

// 9
#[tokio::test]
async fn sendfail_and_send_errors() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut a = link_a(srv.local_addr).await;
    let _b = link_b(srv.local_addr).await;

    a.send("@label=n1 SEND ses_A :PRIVMSG nobody :hi").await;
    let m = a.expect_cmd("SENDFAIL").await;
    assert_eq!(m.tag("label"), Some("n1"));
    assert_eq!(m.param(0), Some("ses_A"));
    assert_eq!(m.param(1), Some("NOSUCHNICK"));

    for inner_line in ["NICK x", "AWAY :gone", "QUIT :bye", "OPER a b"] {
        a.send(&format!("SEND ses_A :{inner_line}")).await;
        let m = a.expect_cmd("FAIL").await;
        assert_eq!(m.param(0), Some("SEND"), "{inner_line}");
        assert_eq!(m.param(1), Some("FORBIDDEN_COMMAND"), "{inner_line}");
        assert_eq!(m.param(2), Some("ses_A"), "{inner_line}");
    }

    // Unknown account, and an account of another link, get the same reply.
    for acct in ["ses_Z", "ses_C"] {
        a.send(&format!("SEND {acct} :PRIVMSG #webapp :x")).await;
        let m = a.expect_cmd("FAIL").await;
        assert_eq!(m.param(0), Some("SEND"));
        assert_eq!(m.param(1), Some("UNKNOWN_ACCOUNT"), "{acct}");
        assert_eq!(m.param(2), Some(acct));
    }
}

// 10
#[tokio::test]
async fn hop_passthrough_and_authority_strip() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut a = link_a(srv.local_addr).await;
    let mut b = link_b(srv.local_addr).await;

    a.send("SEND ses_A :@+agent-comms.local/hop=3 PRIVMSG docs-bot :hop test")
        .await;
    a.expect_cmd("SENT").await;
    let d = b
        .expect(|m| is_deliver_msg(m, "ses_C", "PRIVMSG", "hop test"))
        .await;
    let i = inner(&d);
    assert_eq!(i.tag("+agent-comms.local/hop"), Some("3"));
    assert_eq!(i.param(0), Some("docs-bot"));

    a.send(
        "SEND ses_A :@agent-comms.local/role=operator;agent-comms.local/rel=operator;agent-comms.local/broadcast=all;account=operator PRIVMSG docs-bot :fake op",
    )
    .await;
    a.expect_cmd("SENT").await;
    let d = b
        .expect(|m| is_deliver_msg(m, "ses_C", "PRIVMSG", "fake op"))
        .await;
    let i = inner(&d);
    assert_eq!(i.tag("agent-comms.local/role"), Some("agent"));
    assert_eq!(i.tag("agent-comms.local/rel"), Some("peer"));
    assert_eq!(i.tag("account"), Some("ses_A"));
    assert!(!i.has_tag("agent-comms.local/broadcast"));
}

// 11
#[tokio::test]
async fn broadcast() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut a = link_a(srv.local_addr).await;
    let mut b = link_b(srv.local_addr).await;

    a.send("@label=b1 SEND ses_A :PRIVMSG #webapp :@all x")
        .await;
    let m = a.expect_cmd("SENDFAIL").await;
    assert_eq!(m.tag("label"), Some("b1"));
    assert_eq!(m.param(0), Some("ses_A"));
    assert_eq!(m.param(1), Some("BROADCASTDENIED"));

    a.send("SEND ses_A :PRIVMSG #webapp :@here x").await;
    a.expect_cmd("SENT").await;
    let d = b
        .expect(|m| is_deliver_for(m, "ses_C") && is_cmd(&inner(m), "PRIVMSG"))
        .await;
    let i = inner(&d);
    assert_eq!(
        i.params.last().map(String::as_str),
        Some("@here x"),
        "the refused @all message was delivered"
    );
    assert_eq!(i.tag("agent-comms.local/broadcast"), Some("here"));

    // No broadcast tag in a DM.
    a.send("SEND ses_A :PRIVMSG docs-bot :@here dm").await;
    let d = b
        .expect(|m| is_deliver_msg(m, "ses_C", "PRIVMSG", "@here dm"))
        .await;
    assert!(!inner(&d).has_tag("agent-comms.local/broadcast"));
}

// 12
#[tokio::test]
async fn multiline_send() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut a = link_a(srv.local_addr).await;
    let mut b = link_b(srv.local_addr).await;

    a.send("SEND ses_A :BATCH +b1 draft/multiline #webapp")
        .await;
    a.send("SEND ses_A :@batch=b1 PRIVMSG #webapp :line one")
        .await;
    a.send("SEND ses_A :@batch=b1 PRIVMSG #webapp :line two")
        .await;
    a.send("@label=m1 SEND ses_A :BATCH -b1").await;
    let sent = a.expect_cmd("SENT").await;
    assert_eq!(sent.tag("label"), Some("m1"));
    assert_eq!(sent.param(0), Some("ses_A"));
    assert!(
        a.try_expect(SHORT, |m| is_cmd(m, "SENT") || is_cmd(m, "SENDFAIL"))
            .await
            .is_none(),
        "more than one ack for a multiline message"
    );

    let open = b
        .expect(|m| {
            is_deliver_for(m, "ses_C") && {
                let i = inner(m);
                is_cmd(&i, "BATCH")
                    && i.param(0).is_some_and(|p| p.starts_with('+'))
                    && i.param(1) == Some("draft/multiline")
            }
        })
        .await;
    let oi = inner(&open);
    assert_eq!(oi.param(2), Some("#webapp"));
    assert_eq!(oi.tag("msgid"), sent.param(1));
    assert_eq!(oi.tag("account"), Some("ses_A"));
    assert_eq!(oi.tag("agent-comms.local/rel"), Some("peer"));
    let id = oi.param(0).unwrap()[1..].to_string();

    let mut texts = Vec::new();
    loop {
        let m = b.expect(|m| is_deliver_for(m, "ses_C")).await;
        let i = inner(&m);
        if is_cmd(&i, "BATCH") {
            assert_eq!(i.param(0), Some(format!("-{id}").as_str()));
            break;
        }
        assert!(is_cmd(&i, "PRIVMSG"), "{}", i.to_line());
        assert_eq!(i.tag("batch"), Some(id.as_str()));
        texts.push(i.params.last().cloned().unwrap_or_default());
    }
    assert_eq!(texts, ["line one", "line two"]);
}

// 13
#[tokio::test]
async fn dormant_and_replay() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let a = link_a(srv.local_addr).await;
    let mut op = operator(srv.local_addr).await;
    join_names(&mut op, "#webapp").await;

    drop(a);
    let mut away = HashSet::new();
    while away.len() < 2 {
        let m = op
            .expect(|m| m.command_upper() == "AWAY" && m.param(0) == Some("dormant"))
            .await;
        away.insert(m.source_nick().unwrap_or_default().to_string());
    }
    assert!(
        away.contains("fix-auth") && away.contains("fix-auth|explore1"),
        "{away:?}"
    );
    let n = names(&mut op, "#webapp").await;
    assert!(
        has_nick(&n, "fix-auth") && has_nick(&n, "fix-auth|explore1"),
        "{n:?}"
    );

    op.send("PRIVMSG fix-auth :dm while away").await;
    op.send("PRIVMSG #webapp :chan while away").await;
    client_sync(&mut op, "s1").await;

    let (a, b) = linked(srv.local_addr, LINK_A, &[INTRO_A, INTRO_B]).await;
    assert_eq!(introduced_nick(&b, "ses_A"), "fix-auth");
    assert_eq!(introduced_nick(&b, "ses_B"), "fix-auth|explore1");

    let burst_i = b.iter().position(|m| is_cmd(m, "BURST")).expect("BURST");
    let open_i = b
        .iter()
        .position(|m| {
            is_cmd(m, "BATCH")
                && m.param(0).is_some_and(|p| p.starts_with('+'))
                && m.param(1) == Some("agent-comms.local/replay")
        })
        .unwrap_or_else(|| panic!("no replay batch:\n{}", dump(&b)));
    let id = b[open_i].param(0).unwrap()[1..].to_string();
    assert!(!id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric()));
    let close_i = b
        .iter()
        .position(|m| is_cmd(m, "BATCH") && m.param(0) == Some(format!("-{id}").as_str()))
        .unwrap_or_else(|| panic!("replay batch not closed:\n{}", dump(&b)));
    assert!(
        burst_i < open_i && open_i < close_i && close_i == b.len() - 2,
        "{}",
        dump(&b)
    );
    let body = &b[open_i + 1..close_i];
    for m in body {
        assert!(
            is_cmd(m, "DELIVER"),
            "non-DELIVER inside replay: {}",
            m.to_line()
        );
        assert_eq!(m.tag("batch"), Some(id.as_str()));
    }
    let texts = |acct: &str| -> Vec<String> {
        body.iter()
            .filter(|m| is_deliver_for(m, acct))
            .map(inner)
            .filter(|i| is_cmd(i, "PRIVMSG"))
            .map(|i| i.params.last().cloned().unwrap_or_default())
            .collect()
    };
    assert_eq!(texts("ses_A"), ["dm while away", "chan while away"]);
    assert_eq!(texts("ses_B"), ["chan while away"]);
    let dm = body
        .iter()
        .find(|m| is_deliver_msg(m, "ses_A", "PRIVMSG", "dm while away"))
        .unwrap();
    let i = inner(dm);
    assert_eq!(i.tag("agent-comms.local/rel"), Some("operator"));
    assert_eq!(i.param(0), Some("fix-auth"));
    assert_eq!(i.source_nick(), Some(OP_NICK));

    drop(a);
    op.expect(|m| m.command_upper() == "AWAY" && m.param(0) == Some("dormant"))
        .await;
    let (mut a, b) = linked(srv.local_addr, LINK_A, &[INTRO_A, INTRO_B]).await;
    assert!(
        !b.iter().any(|m| is_cmd(m, "BATCH") || is_cmd(m, "DELIVER")),
        "second reconnect replayed again:\n{}",
        dump(&b)
    );
    assert!(a
        .try_expect(SHORT, |m| is_deliver_for(m, "ses_A")
            && is_cmd(&inner(m), "PRIVMSG"))
        .await
        .is_none());
}

// 14
#[tokio::test]
async fn link_replaced() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut first = link_a(srv.local_addr).await;

    // A bad credential does not replace the old link.
    let mut bad = FakeLink::connect(srv.local_addr).await;
    bad.send(&format!("LINK 1 {LINK_A} wrong")).await;
    expect_error(&mut bad, "bad credential").await;
    first.sync().await;

    let mut second = FakeLink::connect(srv.local_addr).await;
    second.handshake(LINK_A, TOKEN).await;
    expect_error(&mut first, "replaced").await;

    let b = second.burst(&[INTRO_A, INTRO_B]).await;
    assert_eq!(introduced_nick(&b, "ses_A"), "fix-auth");
    assert_eq!(introduced_nick(&b, "ses_B"), "fix-auth|explore1");
    let mut op = operator(srv.local_addr).await;
    let n = join_names(&mut op, "#lobby").await;
    assert!(
        has_nick(&n, "fix-auth") && has_nick(&n, "fix-auth|explore1"),
        "{n:?}"
    );
}

// 15: shared accounts (several links attached to one account).
const INTRO_M: &str = "INTRODUCE ses_M mover * operator agent webapp :shared";

fn is_away_of(m: &Message, nick: &str) -> bool {
    m.command_upper() == "AWAY" && m.source_nick() == Some(nick)
}

/// The first client line that matches `pred` within `dur`, or `None`.
async fn client_try_expect(
    c: &mut common::TestClient,
    dur: Duration,
    pred: impl Fn(&Message) -> bool,
) -> Option<Message> {
    let deadline = tokio::time::Instant::now() + dur;
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            return None;
        }
        match c.try_recv(left).await {
            Some(m) if pred(&m) => return Some(m),
            Some(_) => {}
            None => return None,
        }
    }
}

/// Links `link-x` and `link-y`, both attached to `ses_M` (`mover`), and an
/// operator in `#webapp`.
async fn shared_pair(addr: std::net::SocketAddr) -> (FakeLink, FakeLink, common::TestClient) {
    let mut op = operator(addr).await;
    let (x, bx) = linked(addr, "link-x", &[INTRO_M]).await;
    assert_eq!(introduced_nick(&bx, "ses_M"), "mover");
    join_names(&mut op, "#webapp").await;
    // A different nick in the second INTRODUCE does not rename the account.
    let (y, by) = linked(
        addr,
        "link-y",
        &["INTRODUCE ses_M other-nick * operator agent webapp :shared"],
    )
    .await;
    assert_eq!(introduced_nick(&by, "ses_M"), "mover", "{}", dump(&by));
    (x, y, op)
}

async fn dm_to_mover(op: &mut common::TestClient, text: &str) {
    op.send(&format!("PRIVMSG mover :{text}")).await;
    client_sync(op, "dm").await;
}

#[tokio::test]
async fn shared_attach() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let (mut x, mut y, mut op) = shared_pair(srv.local_addr).await;

    // No DISOWN, no QUIT/JOIN/AWAY noise for the second INTRODUCE.
    assert!(
        x.try_expect(SHORT, |m| is_cmd(m, "DISOWN")).await.is_none(),
        "DISOWN sent to the first link"
    );
    assert!(
        client_try_expect(&mut op, SHORT, |m| m.source_nick() == Some("mover")
            && matches!(
                m.command_upper().as_str(),
                "QUIT" | "JOIN" | "AWAY" | "NICK"
            ))
        .await
        .is_none(),
        "the second INTRODUCE changed the account"
    );

    // Both links can act for the account.
    x.send("SEND ses_M :PRIVMSG #webapp :from x").await;
    x.expect_cmd("SENT").await;
    y.send("SEND ses_M :PRIVMSG #webapp :from y").await;
    y.expect_cmd("SENT").await;

    // Deliveries go to the link that reported busy last.
    y.send("STATE ses_M busy").await;
    y.sync().await;
    dm_to_mover(&mut op, "to busy y").await;
    y.expect(|m| is_deliver_msg(m, "ses_M", "PRIVMSG", "to busy y"))
        .await;
    assert!(
        x.try_expect(SHORT, |m| is_deliver_msg(
            m,
            "ses_M",
            "PRIVMSG",
            "to busy y"
        ))
        .await
        .is_none(),
        "the DM went to both links"
    );

    // y goes away: the account stays present, x gets the deliveries.
    drop(y);
    let away = op.expect(|m| is_away_of(m, "mover")).await;
    assert_eq!(away.param(0), Some("idle"), "{away:?}");
    assert!(
        client_try_expect(&mut op, SHORT, |m| is_away_of(m, "mover")
            && m.param(0) == Some("dormant"))
        .await
        .is_none(),
        "account went dormant with a link still attached"
    );
    dm_to_mover(&mut op, "to x").await;
    x.expect(|m| is_deliver_msg(m, "ses_M", "PRIVMSG", "to x"))
        .await;
}

#[tokio::test]
async fn shared_parent_mismatch_attaches() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let (mut x, bx) = linked(
        srv.local_addr,
        "link-x",
        &[
            "INTRODUCE ses_P1 p-one * operator agent webapp :p1",
            "INTRODUCE ses_P2 p-two * operator agent webapp :p2",
            "INTRODUCE ses_K kid ses_P1 operator agent webapp :kid",
        ],
    )
    .await;
    assert_eq!(introduced_nick(&bx, "ses_K"), "kid");
    let (mut y, by) = linked(
        srv.local_addr,
        "link-y",
        &[
            "INTRODUCE ses_P2 p-two * operator agent webapp :p2",
            "INTRODUCE ses_K kid ses_P2 operator agent webapp :kid",
            "INTRODUCE ses_P1 p-one ses_P2 operator agent webapp :p1",
        ],
    )
    .await;
    assert!(!by.iter().any(|m| is_cmd(m, "FAIL")), "{}", dump(&by));
    assert_eq!(introduced_nick(&by, "ses_K"), "kid");
    assert_eq!(introduced_nick(&by, "ses_P1"), "p-one");

    for l in [&mut x, &mut y] {
        l.send("STATE ses_K busy").await;
        l.send("SEND ses_K :PRIVMSG #webapp :kid here").await;
        l.expect_cmd("SENT").await;
        l.sync().await;
        assert!(
            l.try_expect(SHORT, |m| is_cmd(m, "FAIL")).await.is_none(),
            "[{}] {}",
            l.name,
            dump(&l.backlog)
        );
    }

    // The first parent stays: ses_K is still in the family channel of p-one.
    let mut op = operator(srv.local_addr).await;
    let n = join_names(&mut op, "#p-one").await;
    assert!(has_nick(&n, "kid"), "#p-one: {n:?}");
}

#[tokio::test]
async fn shared_state_aggregate() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let (mut x, mut y, mut op) = shared_pair(srv.local_addr).await;

    x.send("STATE ses_M busy").await;
    let m = op.expect(|m| is_away_of(m, "mover")).await;
    assert!(m.params.is_empty(), "busy must clear AWAY: {m:?}");

    // The link that does not run the session reports idle: still busy.
    y.send("STATE ses_M idle").await;
    y.sync().await;
    assert!(
        client_try_expect(&mut op, SHORT, |m| is_away_of(m, "mover"))
            .await
            .is_none(),
        "idle on one link overrode busy on the other"
    );
    op.send("WHOIS mover").await;
    let m = op
        .expect(|m| m.command == "301" || m.command == "318")
        .await;
    assert_eq!(m.command, "318", "mover is AWAY: {m:?}");

    // All links idle: AWAY idle.
    x.send("STATE ses_M idle").await;
    let m = op.expect(|m| is_away_of(m, "mover")).await;
    assert_eq!(m.param(0), Some("idle"));
}

#[tokio::test]
async fn shared_delivery_to_last_busy() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let (mut x, mut y, mut op) = shared_pair(srv.local_addr).await;

    y.send("STATE ses_M busy").await;
    y.sync().await;
    x.send("STATE ses_M idle").await;
    x.sync().await;
    dm_to_mover(&mut op, "for y only").await;
    y.expect(|m| is_deliver_msg(m, "ses_M", "PRIVMSG", "for y only"))
        .await;
    assert!(
        x.try_expect(SHORT, |m| is_deliver_msg(
            m,
            "ses_M",
            "PRIVMSG",
            "for y only"
        ))
        .await
        .is_none(),
        "the DM went to the idle link"
    );

    // x reports busy later: x becomes the primary link.
    x.send("STATE ses_M busy").await;
    x.sync().await;
    dm_to_mover(&mut op, "for x now").await;
    x.expect(|m| is_deliver_msg(m, "ses_M", "PRIVMSG", "for x now"))
        .await;
    assert!(y
        .try_expect(SHORT, |m| is_deliver_msg(
            m,
            "ses_M",
            "PRIVMSG",
            "for x now"
        ))
        .await
        .is_none());
}

#[tokio::test]
async fn shared_detach_keeps_present() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let (x, mut y, mut op) = shared_pair(srv.local_addr).await;

    drop(x);
    assert!(
        client_try_expect(&mut op, SHORT, |m| is_away_of(m, "mover")
            && m.param(0) == Some("dormant"))
        .await
        .is_none(),
        "account went dormant with a link still attached"
    );
    dm_to_mover(&mut op, "after x left").await;
    y.expect(|m| is_deliver_msg(m, "ses_M", "PRIVMSG", "after x left"))
        .await;
    y.send("SEND ses_M :PRIVMSG #webapp :still here").await;
    y.expect_cmd("SENT").await;
}

#[tokio::test]
async fn shared_both_down_replay_once() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let (x, y, mut op) = shared_pair(srv.local_addr).await;

    drop(x);
    drop(y);
    let m = op
        .expect(|m| is_away_of(m, "mover") && m.param(0) == Some("dormant"))
        .await;
    assert_eq!(m.param(0), Some("dormant"));
    dm_to_mover(&mut op, "while dormant").await;

    let (mut x, bx) = linked(srv.local_addr, "link-x", &[INTRO_M]).await;
    assert!(
        bx.iter()
            .any(|m| is_deliver_msg(m, "ses_M", "PRIVMSG", "while dormant")),
        "no replay for the first link:\n{}",
        dump(&bx)
    );
    let (mut y, by) = linked(srv.local_addr, "link-y", &[INTRO_M]).await;
    assert!(
        !by.iter()
            .any(|m| is_cmd(m, "DELIVER") || is_cmd(m, "BATCH")),
        "second link got a replay:\n{}",
        dump(&by)
    );
    // x stays the primary link (earliest attached, nobody busy).
    dm_to_mover(&mut op, "live again").await;
    x.expect(|m| is_deliver_msg(m, "ses_M", "PRIVMSG", "live again"))
        .await;
    assert!(y
        .try_expect(SHORT, |m| is_deliver_for(m, "ses_M"))
        .await
        .is_none());
}

#[tokio::test]
async fn shared_authority_and_retire() {
    let dir = tmp();
    let mut cfg = link_config(dir.path());
    cfg.limits.claim_idle_secs = 60;
    let srv = start_cfg(cfg).await;
    let (mut x, mut y, _op) = shared_pair(srv.local_addr).await;

    // A link that never introduced the account cannot act for it.
    let (mut z, _) = linked(srv.local_addr, "link-z", &[]).await;
    for (line, verb) in [
        ("CLAIM ses_M /tmp/shared.rs", "CLAIM"),
        ("RELEASE ses_M /tmp/shared.rs", "RELEASE"),
        ("STATE ses_M busy", "STATE"),
        ("SEND ses_M :PRIVMSG #webapp :intruder", "SEND"),
        ("RENAME ses_M intruder", "RENAME"),
        ("RETIRE ses_M", "RETIRE"),
    ] {
        z.send(line).await;
        let m = z.expect_cmd("FAIL").await;
        assert_eq!(m.param(0), Some(verb), "{line}");
        assert_eq!(m.param(1), Some("UNKNOWN_ACCOUNT"), "{line}");
    }

    // Both attached links can claim and release.
    x.send("CLAIM ses_M /tmp/shared.rs").await;
    x.expect(|m| is_cmd(m, "CLAIMSET")).await;
    y.send("RELEASE ses_M /tmp/shared.rs").await;
    y.expect(|m| is_cmd(m, "CLAIMDEL")).await;

    // RETIRE from one attached link retires the account for all of them.
    y.send("@label=r RETIRE ses_M").await;
    let m = y.expect_cmd("RETIRED").await;
    assert_eq!(m.tag("label"), Some("r"));
    let m = x.expect_cmd("RETIRED").await;
    assert_eq!(m.param(0), Some("ses_M"));
    x.send("SEND ses_M :PRIVMSG #webapp :gone").await;
    let m = x.expect_cmd("FAIL").await;
    assert_eq!(m.param(1), Some("UNKNOWN_ACCOUNT"));
}

// 16
#[tokio::test]
async fn retire() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let (mut l, _) = linked(srv.local_addr, LINK_A, &[INTRO_A]).await;
    let mut op = operator(srv.local_addr).await;
    join_names(&mut op, "#webapp").await;

    l.send("@label=t1 RETIRE ses_A :done").await;
    let m = l.expect_cmd("RETIRED").await;
    assert_eq!(m.param(0), Some("ses_A"));
    assert_eq!(m.tag("label"), Some("t1"));
    let q = op.expect(|m| m.command_upper() == "QUIT").await;
    assert_eq!(q.source_nick(), Some("fix-auth"));
    assert!(q.params.last().is_some_and(|r| r.contains("done")), "{q:?}");

    l.send("INTRODUCE ses_N fix-auth * operator agent webapp :again")
        .await;
    let m = l
        .expect(|m| is_cmd(m, "INTRODUCED") && m.param(0) == Some("ses_N"))
        .await;
    assert_eq!(m.param(1), Some("fix-auth"));

    l.send("SEND ses_A :PRIVMSG #webapp :ghost").await;
    let m = l.expect_cmd("FAIL").await;
    assert_eq!(m.param(1), Some("UNKNOWN_ACCOUNT"));
}

// 17
#[tokio::test]
async fn state_idle_busy() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut l = link_a(srv.local_addr).await;
    let mut op = operator(srv.local_addr).await;
    join_names(&mut op, "#webapp").await;

    l.send("STATE ses_A busy").await;
    let m = op
        .expect(|m| m.command_upper() == "AWAY" && m.source_nick() == Some("fix-auth"))
        .await;
    assert!(m.params.is_empty(), "busy must clear AWAY: {m:?}");

    l.send("STATE ses_A idle").await;
    let m = op
        .expect(|m| m.command_upper() == "AWAY" && m.source_nick() == Some("fix-auth"))
        .await;
    assert_eq!(m.param(0), Some("idle"));

    l.send("STATE ses_A sleepy").await;
    let m = l.expect_cmd("FAIL").await;
    assert_eq!(m.param(0), Some("STATE"));
    assert_eq!(m.param(1), Some("INVALID_STATE"));
    l.send("STATE ses_Q busy").await;
    let m = l.expect_cmd("FAIL").await;
    assert_eq!(m.param(1), Some("UNKNOWN_ACCOUNT"));
}

// 18
#[tokio::test]
async fn server_restart_presence() {
    let dir = tmp();
    let cfg = link_config(dir.path());
    let srv = start_cfg(cfg.clone()).await;
    let l = link_a(srv.local_addr).await;
    drop(l);
    tokio::time::sleep(Duration::from_millis(300)).await;
    srv.shutdown().await.expect("shutdown");
    tokio::time::sleep(Duration::from_millis(200)).await;

    let srv = start_cfg(cfg).await;
    let mut op = operator(srv.local_addr).await;
    let n = join_names(&mut op, "#lobby").await;
    assert!(
        has_nick(&n, "fix-auth") && has_nick(&n, "fix-auth|explore1"),
        "{n:?}"
    );
    op.send("WHOIS fix-auth").await;
    let m = op
        .expect(|m| m.command == "301" || m.command == "318")
        .await;
    assert_eq!(
        m.command, "301",
        "fix-auth is not AWAY after restart: {m:?}"
    );
    assert_eq!(m.params.last().map(String::as_str), Some("dormant"));
}

// 19
#[tokio::test]
async fn chathistory_via_send() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut a = link_a(srv.local_addr).await;
    a.send("SEND ses_A :PRIVMSG #webapp :first").await;
    a.expect_cmd("SENT").await;
    a.send("SEND ses_A :PRIVMSG #webapp :second").await;
    a.expect_cmd("SENT").await;

    a.send("SEND ses_A :@label=q CHATHISTORY LATEST #webapp * 10")
        .await;
    let open = a
        .expect(|m| {
            is_deliver_for(m, "ses_A") && {
                let i = inner(m);
                is_cmd(&i, "BATCH") && i.tag("label") == Some("q")
            }
        })
        .await;
    assert!(
        !open.has_tag("label"),
        "inner label leaked to the outer line"
    );
    let oi = inner(&open);
    let outer_id = oi.param(0).expect("batch id")[1..].to_string();
    let close = format!("-{outer_id}");
    let mut lines: Vec<Message> = vec![oi];
    loop {
        let m = a.expect(|m| is_deliver_for(m, "ses_A")).await;
        let i = inner(&m);
        let done = is_cmd(&i, "BATCH") && i.param(0) == Some(close.as_str());
        lines.push(i);
        if done {
            break;
        }
    }
    let ch = lines
        .iter()
        .find(|i| {
            is_cmd(i, "BATCH")
                && i.param(0).is_some_and(|p| p.starts_with('+'))
                && i.param(1) == Some("chathistory")
        })
        .unwrap_or_else(|| panic!("no chathistory batch:\n{}", dump(&lines)));
    assert_eq!(ch.param(2), Some("#webapp"));
    let ch_id = ch.param(0).unwrap()[1..].to_string();
    let texts: Vec<String> = lines
        .iter()
        .filter(|i| is_cmd(i, "PRIVMSG") && i.tag("batch") == Some(ch_id.as_str()))
        .map(|i| i.params.last().cloned().unwrap_or_default())
        .collect();
    assert_eq!(texts, ["first", "second"], "{}", dump(&lines));
}

// 20
const NONCE: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

#[tokio::test]
async fn challenge_proof_then_link() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut l = FakeLink::connect(srv.local_addr).await;
    let m = l.challenge(NONCE).await;
    assert!(is_cmd(&m, "PROOF"), "no PROOF: {}", m.to_line());
    assert_eq!(
        m.params,
        [expected_proof(TOKEN, NONCE, "irc.agent-comms.local")],
        "wrong PROOF: {}",
        m.to_line()
    );
    let linked = l.handshake(LINK_A, TOKEN).await;
    assert_eq!(linked.param(1), Some("irc.agent-comms.local"));
}

// 21
#[tokio::test]
async fn challenge_twice_refused() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut l = FakeLink::connect(srv.local_addr).await;
    let m = l.challenge(NONCE).await;
    assert!(is_cmd(&m, "PROOF"), "no PROOF: {}", m.to_line());
    l.send(&format!("CHALLENGE {NONCE}")).await;
    expect_error(&mut l, "not allowed in this state").await;
}

// 22
#[tokio::test]
async fn challenge_after_link_refused() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut l = FakeLink::connect(srv.local_addr).await;
    l.handshake(LINK_A, TOKEN).await;
    l.send(&format!("CHALLENGE {NONCE}")).await;
    expect_error(&mut l, "not allowed in this state").await;
}

// 23
#[tokio::test]
async fn challenge_malformed_nonce() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    for nonce in [
        "abc",
        "00112233445566778899AABBCCDDEEFF00112233445566778899aabbccddeeff",
        "00112233445566778899aabbccddeeff00112233445566778899aabbccddeefg",
    ] {
        let mut l = FakeLink::connect(srv.local_addr).await;
        l.send(&format!("CHALLENGE {nonce}")).await;
        expect_error(&mut l, "malformed CHALLENGE").await;
    }
    let mut l = FakeLink::connect(srv.local_addr).await;
    l.send("CHALLENGE").await;
    expect_error(&mut l, "malformed CHALLENGE").await;
}

// LIST through SEND returns the channels (lobby, project and family).
#[tokio::test]
async fn list_via_send() {
    let dir = tmp();
    let srv = start(dir.path()).await;
    let mut a = link_a(srv.local_addr).await;
    a.send("SEND ses_A :LIST").await;
    let mut seen = Vec::new();
    loop {
        let m = a.expect(|m| is_deliver_for(m, "ses_A")).await;
        let i = inner(&m);
        if i.command == "322" {
            seen.push(i.param(1).unwrap_or_default().to_string());
        }
        if i.command == "323" {
            break;
        }
    }
    for want in ["#lobby", "#webapp", "#fix-auth"] {
        assert!(
            seen.iter().any(|c| c == want),
            "{want} missing from LIST: {seen:?}"
        );
    }
}
