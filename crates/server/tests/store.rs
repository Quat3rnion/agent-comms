use agent_comms_server::store::*;

fn acct(id: &str, nick: &str) -> AccountRow {
    AccountRow {
        account: id.into(),
        nick: nick.into(),
        parent: None,
        owner: "owner".into(),
        role: "agent".into(),
        link: Some("link1".into()),
        project: Some("proj".into()),
        realname: "Real Name".into(),
        created: 100,
        last_activity: 100,
    }
}

fn chan_msg(id: &str, t: i64, from: &str, from_nick: &str, chan: &str) -> NewMessage {
    NewMessage {
        msgid: id.into(),
        time_ms: t,
        sender_account: Some(from.into()),
        sender_nick: from_nick.into(),
        sender_source: format!("{from_nick}!{from}@host"),
        target: chan.into(),
        is_channel: true,
        command: "PRIVMSG".into(),
        tags: String::new(),
        lines: vec![format!("hello {id}")],
        dm_account: None,
    }
}

fn dm_msg(id: &str, t: i64, from: &str, from_nick: &str, to: &str, to_nick: &str) -> NewMessage {
    NewMessage {
        msgid: id.into(),
        time_ms: t,
        sender_account: Some(from.into()),
        sender_nick: from_nick.into(),
        sender_source: format!("{from_nick}!{from}@host"),
        target: to_nick.into(),
        is_channel: false,
        command: "PRIVMSG".into(),
        tags: "label=x".into(),
        lines: vec![format!("dm {id}")],
        dm_account: Some(to.into()),
    }
}

fn ids(v: &[StoredMessage]) -> Vec<&str> {
    v.iter().map(|m| m.msgid.as_str()).collect()
}

fn s(x: &str) -> String {
    x.to_string()
}

/// Store with a channel #c holding m1..m5 at times 1000..5000.
fn chan_store() -> Store {
    let st = Store::open_in_memory().unwrap();
    st.upsert_account(&acct("a", "Alice")).unwrap();
    st.upsert_account(&acct("b", "Bob")).unwrap();
    st.add_membership("a", "#c", "#C").unwrap();
    st.add_membership("b", "#c", "#C").unwrap();
    for i in 1..=5 {
        let m = chan_msg(&format!("m{i}"), i * 1000, "a", "Alice", "#C");
        st.insert_message(&m, &[s("b")]).unwrap();
    }
    st
}

#[test]
fn migrations_idempotent_on_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nested").join("db.sqlite");
    let v1;
    {
        let st = Store::open(&path).unwrap();
        v1 = st.schema_version().unwrap();
        assert!(v1 >= 1);
        st.upsert_account(&acct("a", "Alice")).unwrap();
    }
    let st = Store::open(&path).unwrap();
    assert_eq!(st.schema_version().unwrap(), v1);
    assert!(st.get_account("a").unwrap().is_some());
}

#[test]
fn account_upsert_and_rename_creates_alias() {
    let st = Store::open_in_memory().unwrap();
    st.upsert_account(&acct("a", "Alice")).unwrap();
    let got = st.get_account("a").unwrap().unwrap();
    assert_eq!(got, acct("a", "Alice"));
    assert_eq!(st.account_by_nick("alice").unwrap().unwrap().account, "a");

    assert!(st.set_nick("a", "Alicia", "alicia").unwrap());
    assert_eq!(st.get_account("a").unwrap().unwrap().nick, "Alicia");
    assert_eq!(st.aliases("a").unwrap(), vec![s("Alice")]);
    assert_eq!(st.account_by_nick("alicia").unwrap().unwrap().account, "a");
    assert_eq!(st.account_by_nick("alice").unwrap().unwrap().account, "a");
    assert!(st.account_by_nick("nobody").unwrap().is_none());

    // Another account cannot take the alias or the nick.
    st.upsert_account(&acct("b", "Bob")).unwrap();
    assert!(st.upsert_account(&acct("c", "ALICE")).is_err());
    assert!(st.set_nick("b", "alice", "alice").is_err());
    assert!(st.add_alias("b", "Alicia", "alicia").is_err());

    // The account can go back to its own alias.
    assert!(st.set_nick("a", "Alice", "alice").unwrap());
    assert_eq!(st.aliases("a").unwrap(), vec![s("Alicia")]);

    // Upsert updates fields but not the nick.
    let mut row = acct("a", "Other");
    row.realname = "New".into();
    st.upsert_account(&row).unwrap();
    let got = st.get_account("a").unwrap().unwrap();
    assert_eq!(got.nick, "Alice");
    assert_eq!(got.realname, "New");

    assert!(!st.set_nick("missing", "x", "x").unwrap());
}

#[test]
fn link_touch_inactive_list() {
    let st = Store::open_in_memory().unwrap();
    st.upsert_account(&acct("a", "Alice")).unwrap();
    st.upsert_account(&acct("b", "Bob")).unwrap();
    st.set_link("a", None).unwrap();
    assert_eq!(st.get_account("a").unwrap().unwrap().link, None);
    st.set_link("a", Some("l2")).unwrap();
    assert_eq!(
        st.get_account("a").unwrap().unwrap().link.as_deref(),
        Some("l2")
    );
    st.touch("b", 500).unwrap();
    assert_eq!(st.inactive_since(200).unwrap(), vec![s("a")]);
    assert_eq!(st.inactive_since(600).unwrap(), vec![s("a"), s("b")]);
    assert_eq!(st.list_accounts().unwrap().len(), 2);
}

#[test]
fn retire_frees_everything() {
    let st = Store::open_in_memory().unwrap();
    st.upsert_account(&acct("a", "Alice")).unwrap();
    st.upsert_account(&acct("b", "Bob")).unwrap();
    st.set_nick("a", "Alicia", "alicia").unwrap();
    st.add_membership("a", "#c", "#C").unwrap();
    st.set_cursor("a", 5).unwrap();
    st.set_marker("a", "#c", "#C", 10).unwrap();
    st.put_claim(&ClaimRow {
        path: "/x".into(),
        holder_account: "a".into(),
        holder_nick: "Alicia".into(),
        since: 1,
        deadline: 2,
    })
    .unwrap();
    st.insert_message(&chan_msg("m1", 1, "b", "Bob", "#C"), &[s("a")])
        .unwrap();
    st.insert_message(&dm_msg("d1", 2, "b", "Bob", "a", "Alicia"), &[s("a")])
        .unwrap();

    assert!(st.retire("a").unwrap());
    assert!(!st.retire("a").unwrap());
    assert!(st.get_account("a").unwrap().is_none());
    assert!(st.account_by_nick("alice").unwrap().is_none());
    assert!(st.account_by_nick("alicia").unwrap().is_none());
    assert!(st.aliases("a").unwrap().is_empty());
    assert!(st.memberships("a").unwrap().is_empty());
    assert!(st.channel_members("#c").unwrap().is_empty());
    assert_eq!(st.get_cursor("a").unwrap(), 0);
    assert!(st.markers("a").unwrap().is_empty());
    assert!(st.claims_of("a").unwrap().is_empty());
    assert!(st.claims().unwrap().is_empty());
    assert!(st.replay_for("a", 0, 100).unwrap().is_empty());
    assert!(st.message_by_msgid("d1").unwrap().is_none());
    // Channel messages stay for history.
    assert!(st.message_by_msgid("m1").unwrap().is_some());

    // The nick and aliases are free again.
    st.upsert_account(&acct("c", "Alice")).unwrap();
    st.add_alias("c", "Alicia", "alicia").unwrap();
    assert_eq!(st.aliases("c").unwrap(), vec![s("Alicia")]);
}

#[test]
fn memberships_and_channels() {
    let st = Store::open_in_memory().unwrap();
    st.set_memberships("a", &[(s("#x"), s("#X")), (s("#y"), s("#Y"))])
        .unwrap();
    st.add_membership("b", "#x", "#X").unwrap();
    assert_eq!(
        st.memberships("a").unwrap(),
        vec![(s("#x"), s("#X")), (s("#y"), s("#Y"))]
    );
    assert_eq!(st.channel_members("#x").unwrap(), vec![s("a"), s("b")]);
    assert!(st.remove_membership("a", "#x").unwrap());
    assert!(!st.remove_membership("a", "#x").unwrap());
    st.set_memberships("a", &[(s("#z"), s("#Z"))]).unwrap();
    assert_eq!(st.memberships("a").unwrap(), vec![(s("#z"), s("#Z"))]);

    st.upsert_channel("#x", "#X").unwrap();
    st.upsert_channel("#x", "#x").unwrap();
    let ch = st.get_channel("#x").unwrap().unwrap();
    assert_eq!(ch.name, "#x");
    assert_eq!(ch.topic, None);
    st.set_topic("#x", "hi there", "Alice", 1234).unwrap();
    let ch = st.get_channel("#x").unwrap().unwrap();
    assert_eq!(ch.topic.as_deref(), Some("hi there"));
    assert_eq!(ch.topic_set_by.as_deref(), Some("Alice"));
    assert_eq!(ch.topic_set_at, Some(1234));
    st.upsert_channel("#y", "#y").unwrap();
    assert_eq!(st.list_channels().unwrap().len(), 2);
    assert!(st.get_channel("#nope").unwrap().is_none());
}

#[test]
fn insert_replay_cursor_and_seq() {
    let st = Store::open_in_memory().unwrap();
    let mut seqs = Vec::new();
    for i in 1..=4 {
        let mut m = chan_msg(&format!("m{i}"), 1000 + i, "a", "Alice", "#C");
        if i == 2 {
            m.lines = vec![s("l1"), s("l2"), s("l3")];
        }
        let recips = if i == 3 {
            vec![s("c")]
        } else {
            vec![s("b"), s("c")]
        };
        let sm = st.insert_message(&m, &recips).unwrap();
        assert_eq!(sm.msgid, format!("m{i}"));
        seqs.push(sm.seq);
    }
    assert!(seqs.windows(2).all(|w| w[0] < w[1]));

    let all = st.replay_for("b", 0, 100).unwrap();
    assert_eq!(ids(&all), vec!["m1", "m2", "m4"]);
    assert_eq!(all[1].lines, vec![s("l1"), s("l2"), s("l3")]);
    assert_eq!(all[0].tags, "");
    assert!(all[0].is_channel);
    assert_eq!(all[0].command, "PRIVMSG");

    assert_eq!(st.get_cursor("b").unwrap(), 0);
    st.set_cursor("b", seqs[1]).unwrap();
    assert_eq!(st.get_cursor("b").unwrap(), seqs[1]);
    st.set_cursor("b", seqs[0]).unwrap();
    assert_eq!(
        st.get_cursor("b").unwrap(),
        seqs[1],
        "cursor only moves forward"
    );

    let cur = st.get_cursor("b").unwrap();
    let rest = st.replay_for("b", cur, 100).unwrap();
    assert_eq!(ids(&rest), vec!["m4"]);
    assert_eq!(ids(&st.replay_for("c", 0, 2).unwrap()), vec!["m1", "m2"]);

    // Duplicate msgid fails.
    assert!(st
        .insert_message(&chan_msg("m1", 9999, "a", "Alice", "#C"), &[])
        .is_err());

    let by_id = st.message_by_msgid("m2").unwrap().unwrap();
    assert_eq!(by_id.seq, seqs[1]);
    assert!(st.message_by_msgid("nope").unwrap().is_none());
}

#[test]
fn tagmsg_has_no_lines() {
    let st = Store::open_in_memory().unwrap();
    let mut m = chan_msg("t1", 1, "a", "Alice", "#C");
    m.command = "TAGMSG".into();
    m.tags = "+typing=active".into();
    m.lines = vec![];
    st.insert_message(&m, &[s("b")]).unwrap();
    let got = st.message_by_msgid("t1").unwrap().unwrap();
    assert!(got.lines.is_empty());
    assert_eq!(got.tags, "+typing=active");
}

#[test]
fn chathistory_latest() {
    let st = chan_store();
    let r = st.history_latest("b", "#c", None, 3).unwrap();
    assert_eq!(ids(&r), vec!["m3", "m4", "m5"]);
    let r = st
        .history_latest("b", "#c", Some(Bound::MsgId(s("m2"))), 2)
        .unwrap();
    assert_eq!(ids(&r), vec!["m4", "m5"]);
    let r = st
        .history_latest("b", "#c", Some(Bound::Time(3000)), 10)
        .unwrap();
    assert_eq!(ids(&r), vec!["m4", "m5"], "time bound is exclusive");
    let r = st
        .history_latest("b", "#c", Some(Bound::MsgId(s("zzz"))), 10)
        .unwrap();
    assert!(r.is_empty());
    assert!(st.history_latest("b", "#c", None, 0).unwrap().is_empty());
    // Limit is capped.
    assert_eq!(
        st.history_latest("b", "#c", None, 1_000_000).unwrap().len(),
        5
    );
}

#[test]
fn chathistory_before_after() {
    let st = chan_store();
    let r = st
        .history_before("b", "#c", Bound::MsgId(s("m4")), 2)
        .unwrap();
    assert_eq!(ids(&r), vec!["m2", "m3"]);
    let r = st.history_before("b", "#c", Bound::Time(3000), 10).unwrap();
    assert_eq!(ids(&r), vec!["m1", "m2"]);
    let r = st.history_before("b", "#c", Bound::Time(1000), 10).unwrap();
    assert!(r.is_empty());

    let r = st
        .history_after("b", "#c", Bound::MsgId(s("m2")), 2)
        .unwrap();
    assert_eq!(ids(&r), vec!["m3", "m4"]);
    let r = st.history_after("b", "#c", Bound::Time(4000), 10).unwrap();
    assert_eq!(ids(&r), vec!["m5"]);
    let r = st.history_after("b", "#c", Bound::Time(5000), 10).unwrap();
    assert!(r.is_empty());
}

#[test]
fn chathistory_between() {
    let st = chan_store();
    let r = st
        .history_between("b", "#c", Bound::MsgId(s("m1")), Bound::MsgId(s("m5")), 10)
        .unwrap();
    assert_eq!(ids(&r), vec!["m2", "m3", "m4"]);
    let r = st
        .history_between("b", "#c", Bound::Time(1000), Bound::Time(5000), 2)
        .unwrap();
    assert_eq!(ids(&r), vec!["m2", "m3"], "oldest first when a is older");
    let r = st
        .history_between("b", "#c", Bound::MsgId(s("m5")), Bound::MsgId(s("m1")), 2)
        .unwrap();
    assert_eq!(ids(&r), vec!["m3", "m4"], "nearest to a when a is newer");
    let r = st
        .history_between("b", "#c", Bound::Time(1500), Bound::Time(3500), 10)
        .unwrap();
    assert_eq!(ids(&r), vec!["m2", "m3"]);
}

#[test]
fn chathistory_targets() {
    let st = chan_store();
    st.upsert_account(&acct("c", "Carol")).unwrap();
    st.insert_message(&dm_msg("d1", 6000, "b", "Bob", "a", "Alice"), &[s("a")])
        .unwrap();
    st.insert_message(&dm_msg("d2", 7000, "a", "Alice", "c", "Carol"), &[s("c")])
        .unwrap();
    // Alice is in #c (latest 5000), DM with Bob (6000), DM with Carol (7000).
    let t = st.history_targets("a", 0, 10_000, 10).unwrap();
    assert_eq!(
        t,
        vec![(s("#C"), 5000), (s("Bob"), 6000), (s("Carol"), 7000)]
    );
    let t = st.history_targets("a", 5000, 10_000, 10).unwrap();
    assert_eq!(t, vec![(s("Bob"), 6000), (s("Carol"), 7000)]);
    let t = st.history_targets("a", 0, 10_000, 2).unwrap();
    assert_eq!(t, vec![(s("Bob"), 6000), (s("Carol"), 7000)]);
    // Bob: channel and DM with Alice only.
    let t = st.history_targets("b", 0, 10_000, 10).unwrap();
    assert_eq!(t, vec![(s("#C"), 5000), (s("Alice"), 6000)]);
}

#[test]
fn dm_visibility_both_directions() {
    let st = Store::open_in_memory().unwrap();
    st.upsert_account(&acct("a", "Alice")).unwrap();
    st.upsert_account(&acct("b", "Bob")).unwrap();
    st.upsert_account(&acct("c", "Carol")).unwrap();
    st.insert_message(&dm_msg("d1", 1000, "a", "Alice", "b", "Bob"), &[s("b")])
        .unwrap();
    st.insert_message(&dm_msg("d2", 2000, "b", "Bob", "a", "Alice"), &[s("a")])
        .unwrap();
    st.insert_message(&dm_msg("d3", 3000, "c", "Carol", "a", "Alice"), &[s("a")])
        .unwrap();
    st.insert_message(&dm_msg("d4", 4000, "a", "Alice", "b", "Bob"), &[s("b")])
        .unwrap();

    let r = st.history_latest("a", "bob", None, 10).unwrap();
    assert_eq!(ids(&r), vec!["d1", "d2", "d4"]);
    let r = st.history_latest("b", "alice", None, 10).unwrap();
    assert_eq!(ids(&r), vec!["d1", "d2", "d4"]);
    let r = st.history_latest("a", "carol", None, 10).unwrap();
    assert_eq!(ids(&r), vec!["d3"]);
    // Carol cannot see the Alice-Bob conversation.
    let r = st.history_latest("c", "bob", None, 10).unwrap();
    assert!(r.is_empty());
    let r = st.history_latest("c", "alice", None, 10).unwrap();
    assert_eq!(ids(&r), vec!["d3"]);

    // An alias resolves to the same account.
    st.set_nick("b", "Robert", "robert").unwrap();
    let r = st.history_latest("a", "bob", None, 10).unwrap();
    assert_eq!(ids(&r), vec!["d1", "d2", "d4"]);
    let r = st.history_latest("a", "robert", None, 10).unwrap();
    assert_eq!(ids(&r), vec!["d1", "d2", "d4"]);

    // Fallback for an unknown nick: messages the account sent to that target.
    st.insert_message(&dm_msg("d5", 5000, "a", "Alice", "zz", "Ghost"), &[])
        .unwrap();
    let r = st.history_latest("a", "ghost", None, 10).unwrap();
    assert_eq!(ids(&r), vec!["d5"]);
    let r = st.history_latest("b", "ghost", None, 10).unwrap();
    assert!(r.is_empty());
}

#[test]
fn read_markers_only_forward_and_persist() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    {
        let st = Store::open(&path).unwrap();
        assert_eq!(st.get_marker("a", "#c").unwrap(), None);
        assert_eq!(st.set_marker("a", "#c", "#C", 1000).unwrap(), 1000);
        assert_eq!(st.set_marker("a", "#c", "#C", 500).unwrap(), 1000);
        assert_eq!(st.set_marker("a", "#c", "#C", 2000).unwrap(), 2000);
        assert_eq!(st.set_marker("a", "bob", "Bob", 10).unwrap(), 10);
        assert_eq!(st.get_marker("a", "#c").unwrap(), Some(2000));
    }
    let st = Store::open(&path).unwrap();
    assert_eq!(st.get_marker("a", "#c").unwrap(), Some(2000));
    assert_eq!(
        st.markers("a").unwrap(),
        vec![(s("#c"), s("#C"), 2000), (s("bob"), s("Bob"), 10)]
    );
    assert_eq!(st.get_marker("b", "#c").unwrap(), None);
}

#[test]
fn unread_counts_use_markers() {
    let st = Store::open_in_memory().unwrap();
    st.upsert_account(&acct("a", "Alice")).unwrap();
    st.upsert_account(&acct("b", "Bob")).unwrap();
    // Channel #c: b -> a at 1000, 2000, 3000.
    for i in 1..=3 {
        st.insert_message(
            &chan_msg(&format!("c{i}"), i * 1000, "b", "Bob", "#C"),
            &[s("a")],
        )
        .unwrap();
    }
    // a's own message does not count for a.
    st.insert_message(&chan_msg("own", 3500, "a", "Alice", "#C"), &[s("a")])
        .unwrap();
    // Two DMs from Bob.
    st.insert_message(&dm_msg("d1", 4000, "b", "Bob", "a", "Alice"), &[s("a")])
        .unwrap();
    st.insert_message(&dm_msg("d2", 5000, "b", "Bob", "a", "Alice"), &[s("a")])
        .unwrap();
    // A TAGMSG does not count.
    let mut tm = chan_msg("tag", 6000, "b", "Bob", "#C");
    tm.command = "TAGMSG".into();
    tm.lines.clear();
    st.insert_message(&tm, &[s("a")]).unwrap();

    let u = st.unread_counts("a").unwrap();
    assert_eq!(
        u,
        vec![(s("#C"), 3, Some(s("c3"))), (s("Bob"), 2, Some(s("d2"))),]
    );

    st.set_marker("a", "#c", "#C", 2000).unwrap();
    st.set_marker("a", "bob", "Bob", 5000).unwrap();
    let u = st.unread_counts("a").unwrap();
    assert_eq!(u, vec![(s("#C"), 1, Some(s("c3")))]);

    st.set_marker("a", "#c", "#C", 9000).unwrap();
    assert!(st.unread_counts("a").unwrap().is_empty());
    assert!(st.unread_counts("b").unwrap().is_empty());
}

#[test]
fn purge_older_than_removes_recipients() {
    let st = chan_store();
    assert_eq!(st.replay_for("b", 0, 100).unwrap().len(), 5);
    let n = st.purge_older_than(3000).unwrap();
    assert_eq!(n, 2, "cutoff is exclusive");
    assert_eq!(
        ids(&st.replay_for("b", 0, 100).unwrap()),
        vec!["m3", "m4", "m5"]
    );
    assert!(st.message_by_msgid("m1").unwrap().is_none());
    assert_eq!(st.purge_older_than(3000).unwrap(), 0);
    assert_eq!(st.purge_older_than(i64::MAX).unwrap(), 3);
    assert!(st.replay_for("b", 0, 100).unwrap().is_empty());
}

#[test]
fn claims_lifecycle() {
    let st = Store::open_in_memory().unwrap();
    let c = |path: &str, acct: &str, nick: &str, deadline: i64| ClaimRow {
        path: path.into(),
        holder_account: acct.into(),
        holder_nick: nick.into(),
        since: 10,
        deadline,
    };
    assert!(st.get_claim("/a").unwrap().is_none());
    st.put_claim(&c("/a", "x", "X", 100)).unwrap();
    st.put_claim(&c("/b c", "x", "X", 200)).unwrap();
    st.put_claim(&c("/d", "y", "Y", 300)).unwrap();
    assert_eq!(st.get_claim("/b c").unwrap().unwrap().deadline, 200);
    assert_eq!(st.claims().unwrap().len(), 3);
    assert_eq!(st.claims_of("x").unwrap().len(), 2);

    // Replace on the same path (moves to another holder).
    st.put_claim(&c("/a", "y", "Y", 150)).unwrap();
    assert_eq!(st.get_claim("/a").unwrap().unwrap().holder_account, "y");
    assert_eq!(st.claims_of("y").unwrap().len(), 2);

    let exp = st.expired_claims(150).unwrap();
    assert_eq!(
        exp.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(),
        vec!["/a"]
    );
    assert!(st.expired_claims(149).unwrap().is_empty());
    assert_eq!(
        st.claims().unwrap().len(),
        3,
        "expired_claims does not delete"
    );

    let refreshed = st.refresh_claims_of("y", 1000).unwrap();
    assert_eq!(refreshed.len(), 2);
    assert!(refreshed.iter().all(|c| c.deadline == 1000));
    assert_eq!(st.get_claim("/b c").unwrap().unwrap().deadline, 200);
    assert!(st.refresh_claims_of("nobody", 5).unwrap().is_empty());

    st.rename_holder("y", "Yolanda").unwrap();
    assert_eq!(st.get_claim("/d").unwrap().unwrap().holder_nick, "Yolanda");
    assert_eq!(st.get_claim("/b c").unwrap().unwrap().holder_nick, "X");

    assert!(st.delete_claim("/d").unwrap());
    assert!(!st.delete_claim("/d").unwrap());
    assert_eq!(st.claims().unwrap().len(), 2);
}

#[test]
fn time_helpers() {
    assert_eq!(format_time_ms(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(
        format_time_ms(1_700_000_000_123),
        "2023-11-14T22:13:20.123Z"
    );
    assert_eq!(
        parse_time("2023-11-14T22:13:20.123Z"),
        Some(1_700_000_000_123)
    );
    assert_eq!(parse_time("2023-11-14T22:13:20Z"), Some(1_700_000_000_000));
    assert_eq!(parse_time("garbage"), None);
    let now = now_ms();
    assert_eq!(parse_time(&format_time_ms(now)), Some(now));
}

/// A container with a read-only root file system has no temp directory.
/// SQLite then fails each insert that needs a temp file ("disk I/O error"),
/// and messages are lost. The store must keep temp files in memory.
#[test]
fn temp_files_stay_in_memory() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("a.db")).unwrap();
    assert_eq!(store.temp_store().unwrap(), 2);
    let store = Store::open_in_memory().unwrap();
    assert_eq!(store.temp_store().unwrap(), 2);
}
