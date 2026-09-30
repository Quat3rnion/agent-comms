#![allow(dead_code)]

use agent_comms_proto::Message;
use agent_comms_server::config::{Config, OperatorSecret, Secrets};
use agent_comms_server::{start, Running};
use argon2::password_hash::{PasswordHasher, SaltString};
use base64::Engine;
use std::net::SocketAddr;
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;
use tokio::time::{timeout, Instant};

pub fn test_config(dir: &Path) -> Config {
    let mut cfg = Config {
        bind: "127.0.0.1:0".parse().unwrap(),
        data_dir: dir.join("data"),
        secrets_path: dir.join("secrets.toml"),
        require_sasl: false,
        ..Config::default()
    };
    cfg.limits.flood_burst = 10_000;
    cfg.limits.flood_rate_per_sec = 10_000;
    cfg
}

pub fn test_secrets(account: &str, password: &str) -> Secrets {
    let salt = SaltString::generate(&mut rand::rngs::OsRng);
    let hash = argon2::Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .expect("hash password")
        .to_string();
    Secrets {
        operator: Some(OperatorSecret {
            account: account.to_string(),
            password_hash: hash,
        }),
        links: vec![],
    }
}

pub async fn start_server(cfg: Config, secrets: Secrets) -> Running {
    std::fs::create_dir_all(&cfg.data_dir).expect("create data dir");
    start(cfg, secrets).await.expect("server start")
}

pub struct TestClient {
    reader: BufReader<OwnedReadHalf>,
    writer: OwnedWriteHalf,
    pub nick: String,
}

impl TestClient {
    pub async fn connect(addr: SocketAddr) -> TestClient {
        let stream = TcpStream::connect(addr).await.expect("connect");
        let _ = stream.set_nodelay(true);
        let (r, w) = stream.into_split();
        TestClient {
            reader: BufReader::new(r),
            writer: w,
            nick: String::new(),
        }
    }

    pub async fn send(&mut self, line: &str) {
        let mut data = line.as_bytes().to_vec();
        data.extend_from_slice(b"\r\n");
        self.writer
            .write_all(&data)
            .await
            .unwrap_or_else(|e| panic!("send {line:?} failed: {e}"));
    }

    /// Send without panicking on failure. Returns false when the write fails.
    pub async fn send_quiet(&mut self, line: &str) -> bool {
        let mut data = line.as_bytes().to_vec();
        data.extend_from_slice(b"\r\n");
        self.writer.write_all(&data).await.is_ok()
    }

    /// Read one raw line. `Ok(None)` means EOF; `Err(())` means timeout.
    async fn read_line(&mut self, dur: Duration) -> Result<Option<String>, ()> {
        let mut buf = String::new();
        match timeout(dur, self.reader.read_line(&mut buf)).await {
            Err(_) => Err(()),
            Ok(Err(_)) => Ok(None),
            Ok(Ok(0)) => Ok(None),
            Ok(Ok(_)) => Ok(Some(buf.trim_end_matches(['\r', '\n']).to_string())),
        }
    }

    fn parse(line: &str) -> Message {
        Message::parse(line).unwrap_or_else(|e| panic!("unparsable line {line:?}: {e}"))
    }

    pub async fn recv(&mut self) -> Message {
        match self.read_line(Duration::from_secs(2)).await {
            Err(()) => panic!("[{}] recv: timed out after 2 s", self.nick),
            Ok(None) => panic!("[{}] recv: connection closed (EOF)", self.nick),
            Ok(Some(line)) => Self::parse(&line),
        }
    }

    pub async fn try_recv(&mut self, dur: Duration) -> Option<Message> {
        match self.read_line(dur).await {
            Ok(Some(line)) => Some(Self::parse(&line)),
            _ => None,
        }
    }

    pub async fn expect(&mut self, pred: impl Fn(&Message) -> bool) -> Message {
        self.expect_within(Duration::from_secs(3), pred).await
    }

    pub async fn expect_within(
        &mut self,
        total: Duration,
        pred: impl Fn(&Message) -> bool,
    ) -> Message {
        let deadline = Instant::now() + total;
        let mut skipped: Vec<String> = Vec::new();
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                panic!(
                    "[{}] expect: no matching line within {:?}; skipped:\n{}",
                    self.nick,
                    total,
                    skipped.join("\n")
                );
            }
            match self.read_line(left).await {
                Err(()) => panic!(
                    "[{}] expect: timed out after {:?}; skipped:\n{}",
                    self.nick,
                    total,
                    skipped.join("\n")
                ),
                Ok(None) => panic!(
                    "[{}] expect: connection closed (EOF); skipped:\n{}",
                    self.nick,
                    skipped.join("\n")
                ),
                Ok(Some(line)) => {
                    let msg = Self::parse(&line);
                    if pred(&msg) {
                        return msg;
                    }
                    skipped.push(line);
                }
            }
        }
    }

    pub async fn expect_numeric(&mut self, code: &str) -> Message {
        let code = code.to_string();
        self.expect(move |m| m.command == code).await
    }

    pub async fn expect_command(&mut self, cmd: &str) -> Message {
        let cmd = cmd.to_ascii_uppercase();
        self.expect(move |m| m.command_upper() == cmd).await
    }

    async fn drain_motd(&mut self) {
        self.expect(|m| m.command == "376" || m.command == "422")
            .await;
    }

    pub async fn register(&mut self, nick: &str) {
        self.nick = nick.to_string();
        self.send(&format!("NICK {nick}")).await;
        self.send(&format!("USER {nick} 0 * :{nick} test")).await;
        self.expect_numeric("001").await;
        self.drain_motd().await;
    }

    pub async fn register_caps(&mut self, nick: &str, caps: &[&str]) {
        self.nick = nick.to_string();
        self.send("CAP LS 302").await;
        if !caps.is_empty() {
            self.send(&format!("CAP REQ :{}", caps.join(" "))).await;
            let m = self
                .expect(|m| {
                    m.command_upper() == "CAP" && matches!(m.param(1), Some("ACK") | Some("NAK"))
                })
                .await;
            assert_eq!(
                m.param(1),
                Some("ACK"),
                "CAP REQ {caps:?} was refused: {m:?}"
            );
        }
        self.send(&format!("NICK {nick}")).await;
        self.send(&format!("USER {nick} 0 * :{nick} test")).await;
        self.send("CAP END").await;
        self.expect_numeric("001").await;
        self.drain_motd().await;
    }

    pub async fn register_sasl(
        &mut self,
        nick: &str,
        account: &str,
        password: &str,
        caps: &[&str],
    ) -> Result<(), Message> {
        self.nick = nick.to_string();
        self.send("CAP LS 302").await;
        let mut req = vec!["sasl"];
        req.extend_from_slice(caps);
        self.send(&format!("CAP REQ :{}", req.join(" "))).await;
        let m = self
            .expect(|m| {
                m.command_upper() == "CAP" && matches!(m.param(1), Some("ACK") | Some("NAK"))
            })
            .await;
        assert_eq!(
            m.param(1),
            Some("ACK"),
            "CAP REQ {req:?} was refused: {m:?}"
        );
        self.send(&format!("NICK {nick}")).await;
        self.send(&format!("USER {nick} 0 * :{nick} test")).await;
        self.send("AUTHENTICATE PLAIN").await;
        self.expect(|m| m.command_upper() == "AUTHENTICATE" && m.param(0) == Some("+"))
            .await;
        let payload =
            base64::engine::general_purpose::STANDARD.encode(format!("\0{account}\0{password}"));
        self.send(&format!("AUTHENTICATE {payload}")).await;
        let res = self
            .expect(|m| m.command == "903" || m.command == "904")
            .await;
        if res.command == "904" {
            return Err(res);
        }
        self.send("CAP END").await;
        self.expect_numeric("001").await;
        self.drain_motd().await;
        Ok(())
    }

    /// Read until EOF. Returns true when the server closes the connection within 2 s.
    pub async fn closed(&mut self) -> bool {
        self.closed_within(Duration::from_secs(2)).await
    }

    pub async fn closed_within(&mut self, total: Duration) -> bool {
        let deadline = Instant::now() + total;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            match self.read_line(left).await {
                Err(()) => return false,
                Ok(None) => return true,
                Ok(Some(_)) => continue,
            }
        }
    }
}
