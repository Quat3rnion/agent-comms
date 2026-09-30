//! Load test (plan Phase 12): 200 always-on accounts on 10 links, 20 awake
//! senders, one operator client, then dormancy and replay for 5 links.
//!
//! Run with:
//! `cargo test -p agent-comms-server --release --test load -- --ignored --nocapture`

mod common;
mod linkutil;

use agent_comms_proto::{Limits, Message};
use common::TestClient;
use linkutil::{
    collect_names, dump, is_cmd, link_config, start_cfg, OP_ACCOUNT, OP_NICK, OP_PW, TOKEN,
};
use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;
use tokio::task::JoinHandle;

const LINKS: usize = 10;
const TOPS_PER_LINK: usize = 2;
const CHILDREN: usize = 9;
const ACCOUNTS: usize = LINKS * TOPS_PER_LINK * (1 + CHILDREN);
const AWAKE: usize = LINKS * 2;
const MSGS_PER_SENDER: usize = 50;
const PACE: Duration = Duration::from_millis(100);
const DORMANT_LINKS: usize = 5;
const PHASE2_MSGS: usize = 200;
const PHASE2_BASE: u64 = 100_000;
const PHASE2_PACE: Duration = Duration::from_millis(20);
const WAIT: Duration = Duration::from_secs(120);
const P99_LIMIT: Duration = Duration::from_millis(250);
const PROJECT: &str = "load";
const LOAD_CHAN: &str = "#load";
const OP_CAPS: &[&str] = &["message-tags", "server-time", "batch", "away-notify"];

// ---------------------------------------------------------------------------
// Accounts and message plans

struct Acct {
    link: usize,
    id: String,
    nick: String,
    parent: Option<usize>,
    /// Family channel: `#<own nick>` for a top-level account, `#<parent nick>` for a child.
    family: String,
    awake: bool,
}

/// Per link: `p{l}-0` (awake) with children `p{l}-0|c0..c8`, and `p{l}-1`
/// with children `p{l}-1|c0..c8` (`p{l}-1|c0` is awake).
fn build_accounts() -> Vec<Acct> {
    let mut v = Vec::new();
    for l in 0..LINKS {
        for i in 0..TOPS_PER_LINK {
            let nick = format!("p{l}-{i}");
            let top = v.len();
            v.push(Acct {
                link: l,
                id: format!("ses_l{l}_p{i}"),
                nick: nick.clone(),
                parent: None,
                family: format!("#{nick}"),
                awake: i == 0,
            });
            for j in 0..CHILDREN {
                v.push(Acct {
                    link: l,
                    id: format!("ses_l{l}_p{i}_c{j}"),
                    nick: format!("{nick}|c{j}"),
                    parent: Some(top),
                    family: format!("#{nick}"),
                    awake: i == 1 && j == 0,
                });
            }
        }
    }
    assert_eq!(v.len(), ACCOUNTS);
    assert_eq!(v.iter().filter(|a| a.awake).count(), AWAKE);
    v
}

fn link_name(l: usize) -> String {
    format!("svc-load.prj-{l}")
}

fn burst_lines(accts: &[Acct], l: usize) -> Vec<String> {
    let mine: Vec<&Acct> = accts.iter().filter(|a| a.link == l).collect();
    let mut out = vec!["BURST".to_string()];
    for a in &mine {
        let parent = a.parent.map_or("*", |p| accts[p].id.as_str());
        out.push(format!(
            "INTRODUCE {} {} {parent} {OP_ACCOUNT} agent {PROJECT} :Load {}",
            a.id, a.nick, a.nick
        ));
    }
    for a in &mine {
        let state = if a.awake { "busy" } else { "idle" };
        out.push(format!("STATE {} {state}", a.id));
    }
    out.push("ENDBURST".to_string());
    out
}

#[derive(Clone)]
enum Target {
    Chan(String),
    Dm(usize),
}

struct Plan {
    k: u64,
    sender: usize,
    target: Target,
}

impl Plan {
    fn target_name(&self, accts: &[Acct]) -> String {
        match &self.target {
            Target::Chan(c) => c.clone(),
            Target::Dm(t) => accts[*t].nick.clone(),
        }
    }

    fn is_load(&self) -> bool {
        matches!(&self.target, Target::Chan(c) if c == LOAD_CHAN)
    }

    /// Link accounts that must get a live DELIVER. `connected` tells if a link is up.
    fn expected_live(&self, accts: &[Acct], connected: impl Fn(usize) -> bool) -> Vec<String> {
        let mut v: Vec<String> = match &self.target {
            Target::Dm(t) => vec![accts[*t].id.clone()],
            Target::Chan(c) => accts
                .iter()
                .enumerate()
                .filter(|(i, a)| *i != self.sender && (c == LOAD_CHAN || &a.family == c))
                .map(|(_, a)| a.id.clone())
                .collect(),
        };
        v.retain(|id| {
            let a = accts.iter().find(|a| &a.id == id).expect("known account");
            connected(a.link)
        });
        v.sort();
        v
    }
}

struct Lcg(u64);

impl Lcg {
    fn next(&mut self, n: usize) -> usize {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((self.0 >> 33) as usize) % n
    }
}

/// Phase 1: every awake account sends 50 messages round-robin to `#load`,
/// a random DM target, and its family channel.
fn phase1_plans(accts: &[Acct]) -> Vec<Plan> {
    let awake: Vec<usize> = (0..accts.len()).filter(|&i| accts[i].awake).collect();
    let mut out = Vec::new();
    for (s, &a) in awake.iter().enumerate() {
        let mut rng = Lcg(0x9E37_79B9_7F4A_7C15 ^ a as u64);
        for n in 0..MSGS_PER_SENDER {
            let target = match n % 3 {
                0 => Target::Chan(LOAD_CHAN.to_string()),
                1 => loop {
                    let t = rng.next(accts.len());
                    if t != a {
                        break Target::Dm(t);
                    }
                },
                _ => Target::Chan(accts[a].family.clone()),
            };
            out.push(Plan {
                k: (s * MSGS_PER_SENDER + n) as u64,
                sender: a,
                target,
            });
        }
    }
    out
}

/// Phase 2: the awake accounts of the connected links send 200 messages to `#load`.
fn phase2_plans(accts: &[Acct]) -> Vec<Plan> {
    let senders: Vec<usize> = (0..accts.len())
        .filter(|&i| accts[i].awake && accts[i].link >= DORMANT_LINKS)
        .collect();
    let per = PHASE2_MSGS / senders.len();
    assert_eq!(per * senders.len(), PHASE2_MSGS);
    let mut out = Vec::new();
    for (s, &a) in senders.iter().enumerate() {
        for n in 0..per {
            out.push(Plan {
                k: PHASE2_BASE + (s * per + n) as u64,
                sender: a,
                target: Target::Chan(LOAD_CHAN.to_string()),
            });
        }
    }
    out
}

fn parse_text(text: &str) -> Option<(u64, i64)> {
    let rest = text.strip_prefix("load k=")?;
    let (k, t) = rest.split_once(" t=")?;
    Some((k.parse().ok()?, t.parse().ok()?))
}

// ---------------------------------------------------------------------------
// Shared measurement state

struct Deliver {
    k: u64,
    account: String,
    lat_ns: i64,
    replay: bool,
}

struct Shared {
    t0: Instant,
    delivers: Mutex<Vec<Deliver>>,
    deliver_count: AtomicUsize,
    other_delivers: AtomicUsize,
    sends: Mutex<HashMap<u64, Instant>>,
    sent: Mutex<Vec<(u64, Instant)>>,
    sent_count: AtomicUsize,
    problems: Mutex<Vec<String>>,
}

impl Shared {
    fn nanos(&self, at: Instant) -> i64 {
        at.duration_since(self.t0).as_nanos() as i64
    }

    fn problem(&self, p: String) {
        self.problems.lock().unwrap().push(p);
    }

    fn on_deliver(&self, name: &str, m: &Message, now: Instant) {
        let (Some(account), true) = (m.param(0), m.params.len() >= 2) else {
            self.problem(format!("[{name}] malformed DELIVER: {}", m.to_line()));
            return;
        };
        let raw = m.params.last().expect("inner line");
        let inner = match Message::parse_with(raw, Limits::LINK) {
            Ok(i) => i,
            Err(e) => {
                self.problem(format!("[{name}] unparsable inner line {raw:?}: {e}"));
                return;
            }
        };
        let load = if is_cmd(&inner, "PRIVMSG") {
            inner.params.last().and_then(|t| parse_text(t))
        } else {
            None
        };
        match load {
            Some((k, t)) => {
                self.delivers.lock().unwrap().push(Deliver {
                    k,
                    account: account.to_string(),
                    lat_ns: self.nanos(now) - t,
                    replay: m.tag("batch").is_some(),
                });
                self.deliver_count.fetch_add(1, Ordering::SeqCst);
            }
            None => {
                self.other_delivers.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Link driver with a dedicated reader task

struct LoadLink {
    name: String,
    writer: Arc<tokio::sync::Mutex<OwnedWriteHalf>>,
    /// Every server line that is not a DELIVER.
    ctrl: Arc<Mutex<Vec<Message>>>,
    closed: Arc<AtomicBool>,
    reader: JoinHandle<()>,
}

impl LoadLink {
    async fn send_raw(&self, data: &str) {
        self.writer
            .lock()
            .await
            .write_all(data.as_bytes())
            .await
            .unwrap_or_else(|e| panic!("[link {}] write failed: {e}", self.name));
    }

    /// Index (from `from`) of the first control line that matches `pred`.
    async fn wait_ctrl(&self, from: usize, what: &str, pred: impl Fn(&Message) -> bool) -> usize {
        let deadline = Instant::now() + WAIT;
        loop {
            let closed = self.closed.load(Ordering::SeqCst);
            {
                let c = self.ctrl.lock().unwrap();
                if let Some(i) = c.iter().skip(from).position(&pred) {
                    return from + i;
                }
                if closed || Instant::now() > deadline {
                    panic!(
                        "[link {}] no {what} ({}); control lines:\n{}",
                        self.name,
                        if closed {
                            "connection closed"
                        } else {
                            "timed out"
                        },
                        dump(&c[from.min(c.len())..])
                    );
                }
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }

    async fn disconnect(self) {
        let _ = self.writer.lock().await.shutdown().await;
        self.reader.abort();
    }
}

async fn read_link(
    name: String,
    r: OwnedReadHalf,
    writer: Arc<tokio::sync::Mutex<OwnedWriteHalf>>,
    ctrl: Arc<Mutex<Vec<Message>>>,
    closed: Arc<AtomicBool>,
    shared: Arc<Shared>,
) {
    let mut r = BufReader::new(r);
    let mut buf = String::new();
    loop {
        buf.clear();
        match r.read_line(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let now = Instant::now();
        let line = buf.trim_end_matches(['\r', '\n']);
        let m = match Message::parse_with(line, Limits::LINK) {
            Ok(m) => m,
            Err(e) => {
                shared.problem(format!("[{name}] unparsable line {line:?}: {e}"));
                continue;
            }
        };
        if is_cmd(&m, "DELIVER") {
            shared.on_deliver(&name, &m, now);
            continue;
        }
        if is_cmd(&m, "PING") {
            let tok = m.params.last().cloned().unwrap_or_default();
            let _ = writer
                .lock()
                .await
                .write_all(format!("PONG :{tok}\r\n").as_bytes())
                .await;
            continue;
        }
        if is_cmd(&m, "SENT") {
            match m
                .tag("label")
                .and_then(|s| s.strip_prefix('s'))
                .and_then(|s| s.parse::<u64>().ok())
            {
                Some(k) => {
                    shared.sent.lock().unwrap().push((k, now));
                    shared.sent_count.fetch_add(1, Ordering::SeqCst);
                }
                None => shared.problem(format!("[{name}] SENT without a load label: {line}")),
            }
        } else if is_cmd(&m, "SENDFAIL") || is_cmd(&m, "FAIL") || is_cmd(&m, "ERROR") {
            shared.problem(format!("[{name}] {line}"));
        }
        ctrl.lock().unwrap().push(m);
    }
    closed.store(true, Ordering::SeqCst);
}

/// Connect, handshake, burst, and wait for the server ENDBURST.
async fn connect_link(
    addr: SocketAddr,
    l: usize,
    accts: Arc<Vec<Acct>>,
    shared: Arc<Shared>,
) -> LoadLink {
    let stream = TcpStream::connect(addr).await.expect("link connect");
    let _ = stream.set_nodelay(true);
    let (r, w) = stream.into_split();
    let name = link_name(l);
    let writer = Arc::new(tokio::sync::Mutex::new(w));
    let ctrl = Arc::new(Mutex::new(Vec::new()));
    let closed = Arc::new(AtomicBool::new(false));
    let reader = tokio::spawn(read_link(
        name.clone(),
        r,
        writer.clone(),
        ctrl.clone(),
        closed.clone(),
        shared,
    ));
    let link = LoadLink {
        name: name.clone(),
        writer,
        ctrl,
        closed,
        reader,
    };

    link.send_raw(&format!("LINK 1 {name} {TOKEN}\r\n")).await;
    let i = link
        .wait_ctrl(0, "LINKED", |m| is_cmd(m, "LINKED") || is_cmd(m, "ERROR"))
        .await;
    {
        let c = link.ctrl.lock().unwrap();
        assert!(
            is_cmd(&c[i], "LINKED"),
            "[link {name}] refused: {}",
            c[i].to_line()
        );
    }

    let mut data = String::new();
    for line in burst_lines(&accts, l) {
        data.push_str(&line);
        data.push_str("\r\n");
    }
    link.send_raw(&data).await;
    let end = link
        .wait_ctrl(i + 1, "server ENDBURST", |m| is_cmd(m, "ENDBURST"))
        .await;

    let c = link.ctrl.lock().unwrap();
    for a in accts.iter().filter(|a| a.link == l) {
        let got = c[i..end]
            .iter()
            .rev()
            .find(|m| is_cmd(m, "INTRODUCED") && m.param(0) == Some(a.id.as_str()))
            .and_then(|m| m.param(1));
        assert_eq!(
            got,
            Some(a.nick.as_str()),
            "[link {name}] wrong INTRODUCED for {}; control lines:\n{}",
            a.id,
            dump(&c[i..=end])
        );
    }
    drop(c);
    link
}

/// Connect the links `ls` concurrently. Returns the links and the time until
/// the last server ENDBURST.
async fn connect_links(
    addr: SocketAddr,
    ls: std::ops::Range<usize>,
    accts: &Arc<Vec<Acct>>,
    shared: &Arc<Shared>,
) -> (Vec<(usize, LoadLink)>, Duration) {
    let start = Instant::now();
    let handles: Vec<(usize, JoinHandle<LoadLink>)> = ls
        .map(|l| {
            (
                l,
                tokio::spawn(connect_link(addr, l, accts.clone(), shared.clone())),
            )
        })
        .collect();
    let mut out = Vec::new();
    for (l, h) in handles {
        out.push((l, h.await.expect("link connect task")));
    }
    (out, start.elapsed())
}

// ---------------------------------------------------------------------------
// Senders and operator

async fn run_sender(
    writer: Arc<tokio::sync::Mutex<OwnedWriteHalf>>,
    shared: Arc<Shared>,
    account: String,
    lines: Vec<(u64, String)>,
    pace: Duration,
    offset: Duration,
) {
    tokio::time::sleep(offset).await;
    let mut next = tokio::time::Instant::now();
    for (k, target) in lines {
        let at = Instant::now();
        let t = shared.nanos(at);
        let line = format!("@label=s{k} SEND {account} :PRIVMSG {target} :load k={k} t={t}\r\n");
        shared.sends.lock().unwrap().insert(k, at);
        if let Err(e) = writer.lock().await.write_all(line.as_bytes()).await {
            shared.problem(format!("SEND for {account} failed: {e}"));
            return;
        }
        next += pace;
        tokio::time::sleep_until(next).await;
    }
}

/// Start one sender task for each sender of `plans`.
fn spawn_senders(
    plans: &[Plan],
    accts: &[Acct],
    links: &[Option<LoadLink>],
    shared: &Arc<Shared>,
    pace: Duration,
) -> Vec<JoinHandle<()>> {
    let mut by_sender: Vec<(usize, Vec<(u64, String)>)> = Vec::new();
    for p in plans {
        let item = (p.k, p.target_name(accts));
        match by_sender.iter_mut().find(|(s, _)| *s == p.sender) {
            Some((_, v)) => v.push(item),
            None => by_sender.push((p.sender, vec![item])),
        }
    }
    let n = by_sender.len() as u32;
    by_sender
        .into_iter()
        .enumerate()
        .map(|(i, (s, lines))| {
            let a = &accts[s];
            let writer = links[a.link]
                .as_ref()
                .expect("sender link is connected")
                .writer
                .clone();
            tokio::spawn(run_sender(
                writer,
                shared.clone(),
                a.id.clone(),
                lines,
                pace,
                pace * i as u32 / n,
            ))
        })
        .collect()
}

#[derive(Default)]
struct OpStats {
    recv: Mutex<Vec<(u64, i64)>>,
    count: AtomicUsize,
    dormant: Mutex<HashSet<String>>,
    stop: AtomicBool,
    closed: AtomicBool,
}

async fn op_reader(mut op: TestClient, shared: Arc<Shared>, st: Arc<OpStats>) {
    loop {
        if st.stop.load(Ordering::SeqCst) {
            break;
        }
        let started = Instant::now();
        let Some(m) = op.try_recv(Duration::from_millis(500)).await else {
            // An immediate `None` is EOF; a late one is an idle timeout.
            if started.elapsed() < Duration::from_millis(400) {
                st.closed.store(true, Ordering::SeqCst);
                break;
            }
            continue;
        };
        let now = Instant::now();
        match m.command_upper().as_str() {
            "PING" => {
                let tok = m.params.last().cloned().unwrap_or_default();
                op.send(&format!("PONG :{tok}")).await;
            }
            "PRIVMSG"
                if m.param(0)
                    .is_some_and(|c| c.eq_ignore_ascii_case(LOAD_CHAN)) =>
            {
                if let Some((k, t)) = m.params.last().and_then(|x| parse_text(x)) {
                    st.recv.lock().unwrap().push((k, shared.nanos(now) - t));
                    st.count.fetch_add(1, Ordering::SeqCst);
                }
            }
            "AWAY" if m.param(0) == Some("dormant") => {
                if let Some(n) = m.source_nick() {
                    st.dormant.lock().unwrap().insert(n.to_ascii_lowercase());
                }
            }
            "ERROR" => shared.problem(format!("[operator] {}", m.to_line())),
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Reporting helpers

async fn wait_until(mut cond: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        if cond() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    cond()
}

fn pct(sorted: &[i64], p: f64) -> i64 {
    if sorted.is_empty() {
        return 0;
    }
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

fn ms(ns: i64) -> f64 {
    ns as f64 / 1e6
}

/// Returns (p99 in ns, table row).
fn lat_row(name: &str, mut v: Vec<i64>) -> (i64, String) {
    v.sort_unstable();
    let p99 = pct(&v, 0.99);
    let row = format!(
        "  {name:<26} {:>8} {:>9.2} {:>9.2} {:>9.2} {:>9.2}",
        v.len(),
        ms(pct(&v, 0.50)),
        ms(pct(&v, 0.95)),
        ms(p99),
        ms(v.last().copied().unwrap_or(0)),
    );
    (p99, row)
}

/// Compare the live DELIVER recipients of each plan with the exact expected set.
fn check_live(
    plans: &[Plan],
    accts: &[Acct],
    delivers: &[Deliver],
    connected: impl Fn(usize) -> bool + Copy,
    errs: &mut Vec<String>,
) -> Vec<i64> {
    let ks: HashSet<u64> = plans.iter().map(|p| p.k).collect();
    let mut got: HashMap<u64, Vec<String>> = HashMap::new();
    let mut lats = Vec::new();
    for d in delivers.iter().filter(|d| !d.replay && ks.contains(&d.k)) {
        got.entry(d.k).or_default().push(d.account.clone());
        lats.push(d.lat_ns);
    }
    for p in plans {
        let exp = p.expected_live(accts, connected);
        let mut g = got.remove(&p.k).unwrap_or_default();
        g.sort();
        if g != exp {
            let e: HashSet<&String> = exp.iter().collect();
            let gs: HashSet<&String> = g.iter().collect();
            let missing: Vec<_> = e.difference(&gs).take(5).collect();
            let extra: Vec<_> = gs.difference(&e).take(5).collect();
            errs.push(format!(
                "k={} {} -> {}: expected {} deliveries, got {} (missing e.g. {missing:?}, extra e.g. {extra:?}, duplicates {})",
                p.k,
                accts[p.sender].nick,
                p.target_name(accts),
                exp.len(),
                g.len(),
                g.len() - gs.len(),
            ));
        }
    }
    lats
}

// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn load_200_accounts_20_awake() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut cfg = link_config(dir.path());
    cfg.require_sasl = false;
    cfg.limits.flood_burst = 100_000;
    cfg.limits.flood_rate_per_sec = 100_000;
    let srv = start_cfg(cfg).await;
    let addr = srv.local_addr;

    let accts = Arc::new(build_accounts());
    let shared = Arc::new(Shared {
        t0: Instant::now(),
        delivers: Mutex::new(Vec::new()),
        deliver_count: AtomicUsize::new(0),
        other_delivers: AtomicUsize::new(0),
        sends: Mutex::new(HashMap::new()),
        sent: Mutex::new(Vec::new()),
        sent_count: AtomicUsize::new(0),
        problems: Mutex::new(Vec::new()),
    });
    let mut errs: Vec<String> = Vec::new();

    // Bursts: 10 links x 20 accounts, all at the same time.
    let (connected, burst_time) = connect_links(addr, 0..LINKS, &accts, &shared).await;
    let mut links: Vec<Option<LoadLink>> = (0..LINKS).map(|_| None).collect();
    for (l, link) in connected {
        links[l] = Some(link);
    }

    // Operator in #load.
    let mut op = TestClient::connect(addr).await;
    op.register_sasl(OP_NICK, OP_ACCOUNT, OP_PW, OP_CAPS)
        .await
        .unwrap_or_else(|m| panic!("operator SASL failed: {m:?}"));
    op.send(&format!("JOIN {LOAD_CHAN}")).await;
    let names = collect_names(&mut op, LOAD_CHAN).await;
    assert_eq!(
        names.len(),
        ACCOUNTS + 1,
        "{LOAD_CHAN} must have {ACCOUNTS} accounts and the operator: {names:?}"
    );
    let ops = Arc::new(OpStats::default());
    let op_task = tokio::spawn(op_reader(op, shared.clone(), ops.clone()));

    // Phase 1: live traffic from the 20 awake accounts.
    let p1 = phase1_plans(&accts);
    let p1_link_total: usize = p1
        .iter()
        .map(|p| p.expected_live(&accts, |_| true).len())
        .sum();
    let p1_op_total = p1.iter().filter(|p| p.is_load()).count();
    let base_delivers = shared.deliver_count.load(Ordering::SeqCst);
    let traffic_start = Instant::now();
    for h in spawn_senders(&p1, &accts, &links, &shared, PACE) {
        h.await.expect("sender task");
    }
    let send_time = traffic_start.elapsed();
    let p1_done = wait_until(|| {
        shared.sent_count.load(Ordering::SeqCst) >= p1.len()
            && shared.deliver_count.load(Ordering::SeqCst) >= base_delivers + p1_link_total
            && ops.count.load(Ordering::SeqCst) >= p1_op_total
    })
    .await;
    let traffic_time = traffic_start.elapsed();
    if !p1_done {
        errs.push(format!(
            "phase 1 incomplete after {WAIT:?}: SENT {}/{}, DELIVER {}/{}, operator {}/{}",
            shared.sent_count.load(Ordering::SeqCst),
            p1.len(),
            shared.deliver_count.load(Ordering::SeqCst) - base_delivers,
            p1_link_total,
            ops.count.load(Ordering::SeqCst),
            p1_op_total
        ));
    }
    tokio::time::sleep(Duration::from_millis(300)).await;

    {
        let p = shared.problems.lock().unwrap();
        for x in p.iter().filter(|x| !x.starts_with("SEND for")).take(15) {
            println!("PROBLEM {x}");
        }
    }
    // A link that the server closed before phase 2 makes the phase 2 checks
    // meaningless: its accounts went dormant before the operator watched.
    let closed_early: Vec<String> = links
        .iter()
        .flatten()
        .filter(|l| l.closed.load(Ordering::SeqCst))
        .map(|l| l.name.clone())
        .collect();
    assert!(
        closed_early.is_empty() && !ops.closed.load(Ordering::SeqCst),
        "the server closed connections in phase 1: links {closed_early:?}, operator closed {}; problems:\n{}",
        ops.closed.load(Ordering::SeqCst),
        shared.problems.lock().unwrap().join("\n")
    );

    // Phase 2: 5 links go away; their 100 accounts become dormant.
    let dormant_nicks: HashSet<String> = accts
        .iter()
        .filter(|a| a.link < DORMANT_LINKS)
        .map(|a| a.nick.to_ascii_lowercase())
        .collect();
    for slot in links.iter_mut().take(DORMANT_LINKS) {
        slot.take().expect("link").disconnect().await;
    }
    let all_dormant = wait_until(|| ops.dormant.lock().unwrap().is_superset(&dormant_nicks)).await;
    assert!(
        all_dormant,
        "operator saw AWAY dormant for only {} of {} accounts",
        ops.dormant
            .lock()
            .unwrap()
            .intersection(&dormant_nicks)
            .count(),
        dormant_nicks.len()
    );

    let p2 = phase2_plans(&accts);
    let live = |l: usize| l >= DORMANT_LINKS;
    let p2_live_total: usize = p2.iter().map(|p| p.expected_live(&accts, live).len()).sum();
    let before_sent = shared.sent_count.load(Ordering::SeqCst);
    let before_del = shared.deliver_count.load(Ordering::SeqCst);
    let before_op = ops.count.load(Ordering::SeqCst);
    for h in spawn_senders(&p2, &accts, &links, &shared, PHASE2_PACE) {
        h.await.expect("sender task");
    }
    let p2_done = wait_until(|| {
        shared.sent_count.load(Ordering::SeqCst) >= before_sent + p2.len()
            && shared.deliver_count.load(Ordering::SeqCst) >= before_del + p2_live_total
            && ops.count.load(Ordering::SeqCst) >= before_op + p2.len()
    })
    .await;
    if !p2_done {
        errs.push(format!(
            "phase 2 incomplete after {WAIT:?}: SENT {}/{}, DELIVER {}/{}, operator {}/{}",
            shared.sent_count.load(Ordering::SeqCst) - before_sent,
            p2.len(),
            shared.deliver_count.load(Ordering::SeqCst) - before_del,
            p2_live_total,
            ops.count.load(Ordering::SeqCst) - before_op,
            p2.len()
        ));
    }
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Reconnect the 5 links with the same bursts; each dormant account gets a replay.
    let (reconnected, replay_time) = connect_links(addr, 0..DORMANT_LINKS, &accts, &shared).await;
    for (l, link) in reconnected {
        let has_batch = link.ctrl.lock().unwrap().iter().any(|m| {
            is_cmd(m, "BATCH")
                && m.param(0).is_some_and(|p| p.starts_with('+'))
                && m.param(1) == Some("agent-comms.local/replay")
        });
        if !has_batch {
            errs.push(format!("[link {}] no replay batch", link_name(l)));
        }
        links[l] = Some(link);
    }
    tokio::time::sleep(Duration::from_millis(500)).await;

    // -----------------------------------------------------------------------
    // Analysis

    let delivers = std::mem::take(&mut *shared.delivers.lock().unwrap());
    let sent = std::mem::take(&mut *shared.sent.lock().unwrap());
    let sends = std::mem::take(&mut *shared.sends.lock().unwrap());

    // SENT: exactly one per message.
    let mut sent_lat = Vec::new();
    let mut sent_seen: HashMap<u64, usize> = HashMap::new();
    for (k, at) in &sent {
        *sent_seen.entry(*k).or_default() += 1;
        match sends.get(k) {
            Some(s) => sent_lat.push(at.duration_since(*s).as_nanos() as i64),
            None => errs.push(format!("SENT for unknown label s{k}")),
        }
    }
    for p in p1.iter().chain(p2.iter()) {
        match sent_seen.get(&p.k).copied().unwrap_or(0) {
            1 => {}
            n => errs.push(format!("k={}: {n} SENT acks (expected 1)", p.k)),
        }
    }

    // Live DELIVER: exact recipient sets.
    let mut deliver_lat = check_live(&p1, &accts, &delivers, |_| true, &mut errs);
    deliver_lat.extend(check_live(&p2, &accts, &delivers, live, &mut errs));

    // Operator: every #load message exactly once.
    let op_recv = std::mem::take(&mut *ops.recv.lock().unwrap());
    let mut op_seen: HashMap<u64, usize> = HashMap::new();
    for (k, _) in &op_recv {
        *op_seen.entry(*k).or_default() += 1;
    }
    for p in p1.iter().chain(p2.iter()).filter(|p| p.is_load()) {
        match op_seen.get(&p.k).copied().unwrap_or(0) {
            1 => {}
            n => errs.push(format!("operator got k={} {n} times (expected 1)", p.k)),
        }
    }
    let op_lat: Vec<i64> = op_recv.iter().map(|(_, l)| *l).collect();

    // Replay: every dormant account gets exactly the 200 phase 2 messages.
    let p2_ks: HashSet<u64> = p2.iter().map(|p| p.k).collect();
    let mut replay_by_acct: HashMap<&str, Vec<u64>> = HashMap::new();
    let mut replay_total = 0usize;
    for d in delivers.iter().filter(|d| d.replay) {
        replay_total += 1;
        replay_by_acct
            .entry(d.account.as_str())
            .or_default()
            .push(d.k);
    }
    for a in accts.iter() {
        let got = replay_by_acct.remove(a.id.as_str()).unwrap_or_default();
        if a.link < DORMANT_LINKS {
            let set: HashSet<u64> = got.iter().copied().collect();
            if got.len() != PHASE2_MSGS || set != p2_ks {
                errs.push(format!(
                    "replay for {} ({}): {} messages, {} distinct phase 2 messages (expected {PHASE2_MSGS})",
                    a.id,
                    a.nick,
                    got.len(),
                    set.intersection(&p2_ks).count()
                ));
            }
        } else if !got.is_empty() {
            errs.push(format!(
                "replay for always-connected account {}: {} messages",
                a.id,
                got.len()
            ));
        }
    }
    let dormant_ids: HashSet<&str> = accts
        .iter()
        .filter(|a| a.link < DORMANT_LINKS)
        .map(|a| a.id.as_str())
        .collect();
    let late_live = delivers
        .iter()
        .filter(|d| !d.replay && d.k >= PHASE2_BASE && dormant_ids.contains(d.account.as_str()))
        .count();
    if late_live > 0 {
        errs.push(format!(
            "{late_live} phase 2 messages reached dormant accounts outside the replay"
        ));
    }

    // Link health.
    for (l, link) in links.iter().enumerate() {
        let link = link.as_ref().expect("all links are connected at the end");
        if link.closed.load(Ordering::SeqCst) {
            errs.push(format!("[link {}] closed by the server", link_name(l)));
        }
    }
    if ops.closed.load(Ordering::SeqCst) {
        errs.push("operator connection closed by the server".to_string());
    }
    let problems = std::mem::take(&mut *shared.problems.lock().unwrap());

    // -----------------------------------------------------------------------
    // Summary

    let live_delivers = delivers.iter().filter(|d| !d.replay).count();
    let (_, sent_row) = lat_row("SENT (send -> SENT)", sent_lat);
    let (deliver_p99, deliver_row) = lat_row("DELIVER (send -> link)", deliver_lat);
    let (_, op_row) = lat_row("operator #load (send -> op)", op_lat);
    println!();
    println!("=== agent-comms load test ===");
    println!("  links                      {LINKS}");
    println!(
        "  accounts                   {ACCOUNTS} ({AWAKE} busy, {} idle)",
        ACCOUNTS - AWAKE
    );
    println!(
        "  burst time (all links)     {:.1} ms",
        burst_time.as_secs_f64() * 1e3
    );
    println!(
        "  phase 1                    {} messages from {AWAKE} senders, send {:.2} s, done {:.2} s",
        p1.len(),
        send_time.as_secs_f64(),
        traffic_time.as_secs_f64()
    );
    println!(
        "  phase 1 throughput         {:.0} deliveries/s",
        p1_link_total as f64 / traffic_time.as_secs_f64()
    );
    println!(
        "  phase 2                    {} messages to {LOAD_CHAN} with {DORMANT_LINKS} links down",
        p2.len()
    );
    println!("  SENT acks                  {}", sent.len());
    println!(
        "  live DELIVERs (load)       {live_delivers} (expected {})",
        p1_link_total + p2_live_total
    );
    println!(
        "  replay DELIVERs            {replay_total} (expected {})",
        dormant_ids.len() * PHASE2_MSGS
    );
    println!(
        "  other DELIVERs             {}",
        shared.other_delivers.load(Ordering::Relaxed)
    );
    println!("  operator #load messages    {}", op_recv.len());
    println!(
        "  reconnect + replay time    {:.1} ms",
        replay_time.as_secs_f64() * 1e3
    );
    println!("  problems (FAIL/ERROR/...)  {}", problems.len());
    println!();
    println!(
        "  {:<26} {:>8} {:>9} {:>9} {:>9} {:>9}",
        "latency (ms)", "n", "p50", "p95", "p99", "max"
    );
    println!("{sent_row}");
    println!("{deliver_row}");
    println!("{op_row}");
    println!();

    ops.stop.store(true, Ordering::SeqCst);
    let _ = op_task.await;
    for link in links.into_iter().flatten() {
        link.disconnect().await;
    }
    let _ = srv.shutdown().await;

    assert!(
        problems.is_empty(),
        "{} problem lines (SENDFAIL/FAIL/ERROR), first 20:\n{}",
        problems.len(),
        problems
            .iter()
            .take(20)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
    assert!(
        errs.is_empty(),
        "{} check failures, first 20:\n{}",
        errs.len(),
        errs.iter().take(20).cloned().collect::<Vec<_>>().join("\n")
    );
    assert!(
        deliver_p99 < P99_LIMIT.as_nanos() as i64,
        "p99 DELIVER latency {:.2} ms is not below {P99_LIMIT:?}",
        ms(deliver_p99)
    );
}
