#![allow(dead_code)]

use crate::common::{test_config, TestClient};
use agent_comms_proto::{Limits, Message};
use agent_comms_server::config::{Config, LinkCredential, OperatorSecret, Secrets};
use agent_comms_server::{default_modules, start_with, Running};
use argon2::password_hash::{PasswordHasher, SaltString};
use std::net::SocketAddr;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;
use tokio::time::{timeout, Instant};

pub const OP_ACCOUNT: &str = "operator";
pub const OP_PW: &str = "link test operator password";
pub const OP_NICK: &str = "alice";
pub const TOKEN: &str = "linktoken_0123456789abcdefghijklmnopqrstuv";
pub const LINK_A: &str = "svc-local.prj-webapp";
pub const LINK_B: &str = "svc-local.prj-docs";
pub const OP_CAPS: &[&str] = &["message-tags", "server-time", "account-tag", "away-notify"];

/// Parent account on link A: `ses_A` / `fix-auth`, project `webapp`.
pub const INTRO_A: &str = "INTRODUCE ses_A fix-auth * operator agent webapp :Fix auth";
/// Child of `ses_A` on link A: `ses_B` / `fix-auth|explore1`.
pub const INTRO_B: &str = "INTRODUCE ses_B fix-auth|explore1 ses_A operator agent webapp :Explore";
/// Unrelated account on link B: `ses_C` / `docs-bot`, project `webapp`.
pub const INTRO_C: &str = "INTRODUCE ses_C docs-bot * operator agent webapp :Docs";

const RECV_TIMEOUT: Duration = Duration::from_secs(3);

fn hash(secret: &str) -> String {
    let salt = SaltString::generate(&mut rand::rngs::OsRng);
    argon2::Argon2::default()
        .hash_password(secret.as_bytes(), &salt)
        .expect("argon2 hash")
        .to_string()
}

/// Operator account `operator` with `op_pw`, and one link credential `test`
/// (owner `operator`) with `token`.
pub fn secrets_with_link(op_pw: &str, token: &str) -> Secrets {
    Secrets {
        operator: Some(OperatorSecret {
            account: OP_ACCOUNT.to_string(),
            password_hash: hash(op_pw),
        }),
        links: vec![LinkCredential {
            name: "test".to_string(),
            owner: "operator".to_string(),
            token_hash: hash(token),
            created: 0,
            revoked: false,
            server_key: Some(server_key(token)),
        }],
    }
}

fn hmac_hex(key: &[u8], parts: &[&[u8]]) -> String {
    use hmac::Mac;
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(key).expect("hmac key");
    for p in parts {
        mac.update(p);
    }
    hex::encode(mac.finalize().into_bytes())
}

/// Server key of `token`: hex of HMAC-SHA256(token, "agent-comms server key v1").
pub fn server_key(token: &str) -> String {
    hmac_hex(token.as_bytes(), &[b"agent-comms server key v1"])
}

/// Expected `PROOF` value for `token`, `nonce`, and `server_name`.
pub fn expected_proof(token: &str, nonce: &str, server_name: &str) -> String {
    let key = hex::decode(server_key(token)).expect("hex server key");
    hmac_hex(
        &key,
        &[
            b"agent-comms link proof v1|",
            nonce.as_bytes(),
            b"|",
            server_name.as_bytes(),
        ],
    )
}

fn cached_secrets() -> Secrets {
    static S: OnceLock<Secrets> = OnceLock::new();
    S.get_or_init(|| secrets_with_link(OP_PW, TOKEN)).clone()
}

/// Test configuration for link tests: data_dir inside `dir`, no SASL
/// requirement, short claim and agent timeouts.
pub fn link_config(dir: &Path) -> Config {
    let mut cfg = test_config(dir);
    cfg.require_sasl = false;
    cfg.limits.claim_idle_secs = 3;
    cfg.limits.agent_request_timeout_secs = 2;
    cfg.limits.link_auth_failures_per_min = 5;
    cfg
}

pub async fn start(dir: &Path) -> Running {
    start_cfg(link_config(dir)).await
}

pub async fn start_cfg(cfg: Config) -> Running {
    std::fs::create_dir_all(&cfg.data_dir).expect("create data dir");
    let modules = default_modules(&cfg).expect("default modules");
    start_with(cfg, cached_secrets(), modules)
        .await
        .expect("server start")
}

/// Parse the inner line (last parameter) of a DELIVER line.
pub fn inner(msg: &Message) -> Message {
    let line = msg
        .params
        .last()
        .unwrap_or_else(|| panic!("DELIVER without inner line: {}", msg.to_line()));
    Message::parse_with(line, Limits::LINK)
        .unwrap_or_else(|e| panic!("unparsable inner line {line:?}: {e}"))
}

pub fn is_cmd(m: &Message, cmd: &str) -> bool {
    m.command.eq_ignore_ascii_case(cmd)
}

pub fn is_deliver_for(m: &Message, account: &str) -> bool {
    is_cmd(m, "DELIVER") && m.param(0) == Some(account) && m.params.len() >= 2
}

/// DELIVER for `account` whose inner line is `cmd` with the last parameter `text`.
pub fn is_deliver_msg(m: &Message, account: &str, cmd: &str, text: &str) -> bool {
    if !is_deliver_for(m, account) {
        return false;
    }
    let i = inner(m);
    is_cmd(&i, cmd) && i.params.last().map(String::as_str) == Some(text)
}

pub fn find(msgs: &[Message], pred: impl Fn(&Message) -> bool) -> Option<&Message> {
    msgs.iter().find(|m| pred(m))
}

pub fn dump(msgs: &[Message]) -> String {
    msgs.iter()
        .map(|m| m.to_line())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Assigned nick in an `INTRODUCED <account> <nick>` line of `msgs`.
pub fn introduced_nick(msgs: &[Message], account: &str) -> String {
    find(msgs, |m| {
        is_cmd(m, "INTRODUCED") && m.param(0) == Some(account)
    })
    .and_then(|m| m.param(1))
    .unwrap_or_else(|| panic!("no INTRODUCED for {account}; got:\n{}", dump(msgs)))
    .to_string()
}

pub struct FakeLink {
    reader: BufReader<OwnedReadHalf>,
    writer: OwnedWriteHalf,
    pub name: String,
    /// Lines that were read but did not match an `expect` predicate.
    pub backlog: Vec<Message>,
    ping_seq: u32,
}

impl FakeLink {
    pub async fn connect(addr: SocketAddr) -> FakeLink {
        let stream = TcpStream::connect(addr).await.expect("link connect");
        let _ = stream.set_nodelay(true);
        let (r, w) = stream.into_split();
        FakeLink {
            reader: BufReader::new(r),
            writer: w,
            name: String::from("(unlinked)"),
            backlog: Vec::new(),
            ping_seq: 0,
        }
    }

    pub async fn send(&mut self, line: &str) {
        let mut data = line.as_bytes().to_vec();
        data.extend_from_slice(b"\r\n");
        self.writer
            .write_all(&data)
            .await
            .unwrap_or_else(|e| panic!("[link {}] send {line:?} failed: {e}", self.name));
    }

    /// Send without panicking. Returns false when the write fails.
    pub async fn send_quiet(&mut self, line: &str) -> bool {
        let mut data = line.as_bytes().to_vec();
        data.extend_from_slice(b"\r\n");
        self.writer.write_all(&data).await.is_ok()
    }

    /// `Ok(None)` means EOF or a read error; `Err(())` means timeout.
    async fn read_line(&mut self, dur: Duration) -> Result<Option<String>, ()> {
        let mut buf = String::new();
        match timeout(dur, self.reader.read_line(&mut buf)).await {
            Err(_) => Err(()),
            Ok(Err(_)) | Ok(Ok(0)) => Ok(None),
            Ok(Ok(_)) => Ok(Some(buf.trim_end_matches(['\r', '\n']).to_string())),
        }
    }

    fn parse(&self, line: &str) -> Message {
        Message::parse_with(line, Limits::LINK)
            .unwrap_or_else(|e| panic!("[link {}] unparsable line {line:?}: {e}", self.name))
    }

    fn backlog_dump(&self) -> String {
        dump(&self.backlog)
    }

    /// Next line: the oldest backlog line first, then the socket.
    pub async fn recv(&mut self) -> Message {
        if !self.backlog.is_empty() {
            return self.backlog.remove(0);
        }
        match self.read_line(RECV_TIMEOUT).await {
            Err(()) => panic!(
                "[link {}] recv: timed out after {RECV_TIMEOUT:?}",
                self.name
            ),
            Ok(None) => panic!("[link {}] recv: connection closed (EOF)", self.name),
            Ok(Some(line)) => self.parse(&line),
        }
    }

    pub async fn try_recv(&mut self, dur: Duration) -> Option<Message> {
        if !self.backlog.is_empty() {
            return Some(self.backlog.remove(0));
        }
        match self.read_line(dur).await {
            Ok(Some(line)) => Some(self.parse(&line)),
            _ => None,
        }
    }

    pub async fn expect(&mut self, pred: impl Fn(&Message) -> bool) -> Message {
        self.expect_within(RECV_TIMEOUT, pred).await
    }

    pub async fn expect_within(
        &mut self,
        total: Duration,
        pred: impl Fn(&Message) -> bool,
    ) -> Message {
        match self.search(total, &pred).await {
            Ok(m) => m,
            Err(why) => panic!(
                "[link {}] expect: {why} within {total:?}; skipped:\n{}",
                self.name,
                self.backlog_dump()
            ),
        }
    }

    /// Like `expect_within`, but returns `None` when nothing matches.
    pub async fn try_expect(
        &mut self,
        total: Duration,
        pred: impl Fn(&Message) -> bool,
    ) -> Option<Message> {
        self.search(total, &pred).await.ok()
    }

    async fn search(
        &mut self,
        total: Duration,
        pred: &impl Fn(&Message) -> bool,
    ) -> Result<Message, &'static str> {
        if let Some(i) = self.backlog.iter().position(pred) {
            return Ok(self.backlog.remove(i));
        }
        let deadline = Instant::now() + total;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err("no matching line");
            }
            match self.read_line(left).await {
                Err(()) => return Err("timed out"),
                Ok(None) => return Err("connection closed (EOF)"),
                Ok(Some(line)) => {
                    let m = self.parse(&line);
                    if pred(&m) {
                        return Ok(m);
                    }
                    self.backlog.push(m);
                }
            }
        }
    }

    pub async fn expect_cmd(&mut self, cmd: &str) -> Message {
        let cmd = cmd.to_string();
        self.expect(move |m| is_cmd(m, &cmd)).await
    }

    /// True when the server closes the connection within `dur`. Lines read
    /// before the close go to the backlog.
    pub async fn closed(&mut self, dur: Duration) -> bool {
        let deadline = Instant::now() + dur;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            match self.read_line(left).await {
                Err(()) => return false,
                Ok(None) => return true,
                Ok(Some(line)) => {
                    let m = self.parse(&line);
                    self.backlog.push(m);
                }
            }
        }
    }

    /// Send `CHALLENGE <nonce>` and wait for `PROOF` (or `ERROR`).
    pub async fn challenge(&mut self, nonce: &str) -> Message {
        self.send(&format!("CHALLENGE {nonce}")).await;
        self.expect(|m| is_cmd(m, "PROOF") || is_cmd(m, "ERROR"))
            .await
    }

    /// Send `LINK 1 <name> <token>` and wait for `LINKED`.
    pub async fn handshake(&mut self, link_name: &str, token: &str) -> Message {
        self.name = link_name.to_string();
        self.send(&format!("LINK 1 {link_name} {token}")).await;
        let m = self
            .expect(|m| is_cmd(m, "LINKED") || is_cmd(m, "ERROR"))
            .await;
        assert!(
            is_cmd(&m, "LINKED"),
            "[link {link_name}] handshake refused: {}",
            m.to_line()
        );
        m
    }

    /// Send `BURST`, `lines`, `ENDBURST`. Return every server line up to and
    /// including the server `ENDBURST`.
    pub async fn burst(&mut self, lines: &[&str]) -> Vec<Message> {
        self.send("BURST").await;
        for l in lines {
            self.send(l).await;
        }
        self.send("ENDBURST").await;
        let mut out = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let m = if !self.backlog.is_empty() {
                self.backlog.remove(0)
            } else {
                let left = deadline.saturating_duration_since(Instant::now());
                match self.read_line(left).await {
                    Ok(Some(line)) => self.parse(&line),
                    Ok(None) => panic!(
                        "[link {}] burst: connection closed; got:\n{}",
                        self.name,
                        dump(&out)
                    ),
                    Err(()) => panic!(
                        "[link {}] burst: no server ENDBURST; got:\n{}",
                        self.name,
                        dump(&out)
                    ),
                }
            };
            let end = is_cmd(&m, "ENDBURST");
            out.push(m);
            if end {
                return out;
            }
        }
    }

    /// PING the server and wait for the PONG, so that the server has
    /// processed every earlier line.
    pub async fn sync(&mut self) {
        self.ping_seq += 1;
        let token = format!("sync{}", self.ping_seq);
        self.send(&format!("PING {token}")).await;
        self.expect(|m| is_cmd(m, "PONG") && m.params.last() == Some(&token))
            .await;
    }
}

/// Connect, handshake as `name`, and burst `lines`. Returns the link and the
/// server lines of the burst.
pub async fn linked(addr: SocketAddr, name: &str, lines: &[&str]) -> (FakeLink, Vec<Message>) {
    let mut l = FakeLink::connect(addr).await;
    l.handshake(name, TOKEN).await;
    let b = l.burst(lines).await;
    (l, b)
}

/// Link A with `ses_A` (`fix-auth`) and its child `ses_B` (`fix-auth|explore1`).
pub async fn link_a(addr: SocketAddr) -> FakeLink {
    let (l, b) = linked(addr, LINK_A, &[INTRO_A, INTRO_B]).await;
    assert_eq!(introduced_nick(&b, "ses_A"), "fix-auth");
    assert_eq!(introduced_nick(&b, "ses_B"), "fix-auth|explore1");
    l
}

/// Link B with `ses_C` (`docs-bot`).
pub async fn link_b(addr: SocketAddr) -> FakeLink {
    let (l, b) = linked(addr, LINK_B, &[INTRO_C]).await;
    assert_eq!(introduced_nick(&b, "ses_C"), "docs-bot");
    l
}

/// Operator client `alice`, logged in with SASL as `operator`.
pub async fn operator(addr: SocketAddr) -> TestClient {
    let mut c = TestClient::connect(addr).await;
    c.register_sasl(OP_NICK, OP_ACCOUNT, OP_PW, OP_CAPS)
        .await
        .unwrap_or_else(|m| panic!("operator SASL failed: {m:?}"));
    c
}

/// Ordinary client without an account.
pub async fn guest(addr: SocketAddr, nick: &str) -> TestClient {
    let mut c = TestClient::connect(addr).await;
    c.register(nick).await;
    c
}

/// Read 353 lines for `chan` up to its 366. Returns nicks without prefixes.
pub async fn collect_names(c: &mut TestClient, chan: &str) -> Vec<String> {
    let mut out = Vec::new();
    loop {
        let m = c
            .expect(|m| {
                (m.command == "353" && m.param(2).is_some_and(|p| p.eq_ignore_ascii_case(chan)))
                    || (m.command == "366"
                        && m.param(1).is_some_and(|p| p.eq_ignore_ascii_case(chan)))
            })
            .await;
        if m.command == "366" {
            return out;
        }
        if let Some(list) = m.params.last() {
            for n in list.split_whitespace() {
                out.push(n.trim_start_matches(['@', '+', '%', '~', '&']).to_string());
            }
        }
    }
}

pub async fn join_names(c: &mut TestClient, chan: &str) -> Vec<String> {
    c.send(&format!("JOIN {chan}")).await;
    collect_names(c, chan).await
}

pub async fn names(c: &mut TestClient, chan: &str) -> Vec<String> {
    c.send(&format!("NAMES {chan}")).await;
    collect_names(c, chan).await
}

pub fn has_nick(names: &[String], nick: &str) -> bool {
    names.iter().any(|n| n.eq_ignore_ascii_case(nick))
}

/// PING the server from a client and wait for the PONG.
pub async fn client_sync(c: &mut TestClient, token: &str) {
    c.send(&format!("PING {token}")).await;
    let token = token.to_string();
    c.expect(move |m| m.command_upper() == "PONG" && m.params.last() == Some(&token))
        .await;
}

/// Read NOTICE lines for the operator until the one with the text `end`.
/// Returns the texts before it.
pub async fn notices_until(c: &mut TestClient, end: &str, total: Duration) -> Vec<String> {
    let mut out = Vec::new();
    loop {
        let m = c
            .expect_within(total, |m| m.command_upper() == "NOTICE")
            .await;
        let text = m.params.last().cloned().unwrap_or_default();
        if text == end {
            return out;
        }
        out.push(text);
    }
}
