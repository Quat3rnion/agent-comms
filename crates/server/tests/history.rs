use agent_comms_proto::Message;
use agent_comms_server::config::{Config, OperatorSecret, Secrets};
use agent_comms_server::modules::history::HistoryModule;
use agent_comms_server::store::Store;
use agent_comms_server::Module;
use argon2::password_hash::{PasswordHasher, SaltString};
use base64::Engine;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;

const OP_ACCOUNT: &str = "operator";
const OP_PASSWORD: &str = "history test password";
const TIMEOUT: Duration = Duration::from_secs(5);
const CAPS: &str = "message-tags server-time account-tag batch draft/chathistory draft/read-marker";

struct Client {
    reader: BufReader<OwnedReadHalf>,
    writer: OwnedWriteHalf,
    ping: u32,
}

impl Client {
    async fn connect(addr: SocketAddr) -> Client {
        let stream = TcpStream::connect(addr).await.expect("connect");
        let (r, w) = stream.into_split();
        Client {
            reader: BufReader::new(r),
            writer: w,
            ping: 0,
        }
    }

    async fn send(&mut self, line: &str) {
        self.writer
            .write_all(format!("{line}\r\n").as_bytes())
            .await
            .expect("write");
    }

    async fn recv(&mut self) -> Message {
        let mut line = String::new();
        let n = tokio::time::timeout(TIMEOUT, self.reader.read_line(&mut line))
            .await
            .expect("timed out waiting for a line")
            .expect("read");
        assert!(n > 0, "connection closed");
        Message::parse_with(&line, agent_comms_proto::Limits::LINK).expect("parse")
    }

    /// Read lines until one matches; return it.
    async fn expect(&mut self, pred: impl Fn(&Message) -> bool) -> Message {
        loop {
            let m = self.recv().await;
            if pred(&m) {
                return m;
            }
        }
    }

    /// Read lines until one matches; return all lines read, the match last.
    async fn until(&mut self, pred: impl Fn(&Message) -> bool) -> Vec<Message> {
        let mut out = Vec::new();
        loop {
            let m = self.recv().await;
            let done = pred(&m);
            out.push(m);
            if done {
                return out;
            }
        }
    }

    /// Send PING and drop every line up to the PONG.
    async fn sync(&mut self) {
        self.ping += 1;
        let token = format!("sync{}", self.ping);
        self.send(&format!("PING {token}")).await;
        self.expect(|m| m.command == "PONG" && m.params.last() == Some(&token))
            .await;
    }

    async fn register(addr: SocketAddr, nick: &str, sasl: bool) -> Client {
        let mut c = Client::connect(addr).await;
        c.send("CAP LS 302").await;
        let req = if sasl {
            format!("CAP REQ :sasl {CAPS}")
        } else {
            format!("CAP REQ :{CAPS}")
        };
        c.send(&req).await;
        c.expect(|m| m.command == "CAP" && m.param(1) == Some("ACK"))
            .await;
        if sasl {
            c.send("AUTHENTICATE PLAIN").await;
            c.expect(|m| m.command == "AUTHENTICATE").await;
            let payload = base64::engine::general_purpose::STANDARD
                .encode(format!("{OP_ACCOUNT}\0{OP_ACCOUNT}\0{OP_PASSWORD}"));
            c.send(&format!("AUTHENTICATE {payload}")).await;
            c.expect(|m| m.command == "903").await;
        }
        c.send(&format!("NICK {nick}")).await;
        c.send(&format!("USER {nick} 0 * :{nick}")).await;
        c.send("CAP END").await;
        c.expect(|m| m.command == "001").await;
        c.sync().await;
        c
    }

    async fn join(&mut self, chan: &str) {
        self.send(&format!("JOIN {chan}")).await;
        self.expect(|m| m.command == "366").await;
    }

    /// Run one CHATHISTORY command and return the messages of its batch.
    async fn history(&mut self, args: &str) -> Vec<Message> {
        self.send(&format!("CHATHISTORY {args}")).await;
        let open = self
            .expect(|m| m.command == "BATCH" && m.param(0).is_some_and(|p| p.starts_with('+')))
            .await;
        assert_eq!(open.param(1), Some("chathistory"), "{open:?}");
        let id = open.param(0).expect("id")[1..].to_string();
        let close = format!("-{id}");
        let lines = self
            .until(|m| m.command == "BATCH" && m.param(0) == Some(close.as_str()))
            .await;
        let inner: Vec<Message> = lines[..lines.len() - 1].to_vec();
        for m in &inner {
            assert_eq!(m.tag("batch"), Some(id.as_str()), "{m:?}");
        }
        inner
    }

    async fn fail(&mut self, line: &str) -> Message {
        self.send(line).await;
        self.expect(|m| m.command == "FAIL").await
    }
}

fn texts(msgs: &[Message]) -> Vec<String> {
    msgs.iter()
        .filter(|m| m.command == "PRIVMSG")
        .map(|m| m.param(1).unwrap_or("").to_string())
        .collect()
}

fn config(dir: &Path) -> Config {
    Config {
        bind: "127.0.0.1:0".parse().expect("addr"),
        data_dir: dir.to_path_buf(),
        secrets_path: dir.join("secrets.toml"),
        require_sasl: false,
        ..Config::default()
    }
}

fn secrets() -> Secrets {
    let salt = SaltString::encode_b64(b"history-test-salt").expect("salt");
    let hash = argon2::Argon2::default()
        .hash_password(OP_PASSWORD.as_bytes(), &salt)
        .expect("hash")
        .to_string();
    Secrets {
        operator: Some(OperatorSecret {
            account: OP_ACCOUNT.into(),
            password_hash: hash,
        }),
        links: vec![],
    }
}

async fn start(cfg: &Config) -> (Arc<Store>, agent_comms_server::Running) {
    let store = Arc::new(Store::open(&cfg.db_path()).expect("store"));
    let module: Arc<dyn Module> = Arc::new(HistoryModule::new(store.clone(), cfg));
    let running = agent_comms_server::start_with(cfg.clone(), secrets(), vec![module])
        .await
        .expect("start");
    (store, running)
}

/// A message that the operator saw live: (text, msgid, time).
struct Seen {
    text: String,
    msgid: String,
    time: String,
}

#[tokio::test]
async fn chathistory_markread_and_restart() {
    let dir = tempfile::tempdir().expect("tempdir");
    let cfg = config(dir.path());
    let (store, srv) = start(&cfg).await;
    let addr = srv.local_addr;

    let mut op = Client::register(addr, "boss", true).await;
    let mut guest = Client::register(addr, "guest", false).await;

    op.send("JOIN #room").await;
    let mr = op.expect(|m| m.command == "MARKREAD").await;
    assert_eq!(mr.params, vec!["#room".to_string(), "*".to_string()]);
    op.expect(|m| m.command == "366").await;
    guest.join("#room").await;
    op.sync().await;

    let mut seen: Vec<Seen> = Vec::new();
    for i in 1..=5 {
        let text = format!("m{i}");
        if i == 1 {
            guest.send("@+example/tag=v1 PRIVMSG #room :m1").await;
        } else {
            guest.send(&format!("PRIVMSG #room :{text}")).await;
        }
        let m = op
            .expect(|m| m.command == "PRIVMSG" && m.param(1) == Some(text.as_str()))
            .await;
        seen.push(Seen {
            text,
            msgid: m.tag("msgid").expect("msgid").to_string(),
            time: m.tag("time").expect("time").to_string(),
        });
    }
    op.send("PRIVMSG #room :m6").await;
    let m = guest
        .expect(|m| m.command == "PRIVMSG" && m.param(1) == Some("m6"))
        .await;
    seen.push(Seen {
        text: "m6".into(),
        msgid: m.tag("msgid").expect("msgid").to_string(),
        time: m.tag("time").expect("time").to_string(),
    });
    op.sync().await;

    // LATEST with `*`: everything, oldest first, with the original tags.
    let all = op.history("LATEST #room * 10").await;
    assert_eq!(texts(&all), vec!["m1", "m2", "m3", "m4", "m5", "m6"]);
    for (m, s) in all.iter().zip(&seen) {
        assert_eq!(m.param(1), Some(s.text.as_str()));
        assert_eq!(m.param(0), Some("#room"));
        assert_eq!(m.tag("msgid"), Some(s.msgid.as_str()));
        assert_eq!(m.tag("time"), Some(s.time.as_str()));
    }
    assert_eq!(all[0].tag("+example/tag"), Some("v1"));
    assert_eq!(all[0].source_nick(), Some("guest"));
    assert_eq!(all[0].tag("account"), None);
    assert_eq!(all[5].source_nick(), Some("boss"));
    assert_eq!(all[5].tag("account"), Some(OP_ACCOUNT));

    let latest = op.history("LATEST #room * 2").await;
    assert_eq!(texts(&latest), vec!["m5", "m6"]);

    let latest = op
        .history(&format!("LATEST #room msgid={} 10", seen[3].msgid))
        .await;
    assert_eq!(texts(&latest), vec!["m5", "m6"]);

    let before = op
        .history(&format!("BEFORE #room msgid={} 2", seen[3].msgid))
        .await;
    assert_eq!(texts(&before), vec!["m2", "m3"]);

    let before = op
        .history(&format!("BEFORE #room timestamp={} 10", seen[2].time))
        .await;
    assert_eq!(texts(&before), vec!["m1", "m2"]);

    let after = op
        .history(&format!("AFTER #room msgid={} 2", seen[1].msgid))
        .await;
    assert_eq!(texts(&after), vec!["m3", "m4"]);

    let after = op
        .history(&format!("AFTER #room timestamp={} 10", seen[0].time))
        .await;
    assert_eq!(texts(&after), vec!["m2", "m3", "m4", "m5", "m6"]);

    let between = op
        .history(&format!(
            "BETWEEN #room msgid={} msgid={} 10",
            seen[0].msgid, seen[4].msgid
        ))
        .await;
    assert_eq!(texts(&between), vec!["m2", "m3", "m4"]);

    let between = op
        .history(&format!(
            "BETWEEN #room timestamp={} timestamp={} 1",
            seen[4].time, seen[0].time
        ))
        .await;
    assert_eq!(texts(&between), vec!["m4"]);

    let unknown = op.history("AFTER #room msgid=nope 10").await;
    assert!(unknown.is_empty());

    // Errors.
    let f = guest.fail("CHATHISTORY LATEST #room * 10").await;
    assert_eq!(f.param(0), Some("CHATHISTORY"));
    assert_eq!(f.param(1), Some("ACCOUNT_REQUIRED"));
    // A guest has read markers in memory only.
    guest.send("MARKREAD #room").await;
    let m = guest.expect(|m| m.command == "MARKREAD").await;
    assert_eq!(m.params, vec!["#room".to_string(), "*".to_string()]);
    guest
        .send(&format!("MARKREAD #room timestamp={}", seen[1].time))
        .await;
    let m = guest.expect(|m| m.command == "MARKREAD").await;
    assert_eq!(
        m.params,
        vec!["#room".to_string(), format!("timestamp={}", seen[1].time)]
    );
    let f = guest.fail("MARKREAD").await;
    assert_eq!(f.param(1), Some("NEED_MORE_PARAMS"));
    let f = guest.fail("MARKREAD #room *").await;
    assert_eq!(f.param(1), Some("INVALID_PARAMS"));
    let f = op.fail("CHATHISTORY LATEST #elsewhere * 10").await;
    assert_eq!(f.param(1), Some("INVALID_TARGET"));
    assert_eq!(f.param(2), Some("LATEST"));
    assert_eq!(f.param(3), Some("#elsewhere"));
    let f = op.fail("CHATHISTORY BEFORE #room * 10").await;
    assert_eq!(f.param(1), Some("INVALID_PARAMS"));
    let f = op.fail("CHATHISTORY LATEST #room * zero").await;
    assert_eq!(f.param(1), Some("INVALID_PARAMS"));
    let f = op.fail("CHATHISTORY LATEST #room timestamp=bogus 5").await;
    assert_eq!(f.param(1), Some("INVALID_PARAMS"));
    let f = op.fail("CHATHISTORY SIDEWAYS #room * 5").await;
    assert_eq!(f.param(1), Some("INVALID_PARAMS"));

    // MARKREAD: get, set, forward only, fan-out to the same account.
    let mut op2 = Client::register(addr, "boss2", true).await;
    op.send("MARKREAD #room").await;
    let m = op.expect(|m| m.command == "MARKREAD").await;
    assert_eq!(m.params, vec!["#room".to_string(), "*".to_string()]);

    let set = format!("timestamp={}", seen[2].time);
    op.send(&format!("MARKREAD #room {set}")).await;
    let m = op.expect(|m| m.command == "MARKREAD").await;
    assert_eq!(m.params, vec!["#room".to_string(), set.clone()]);
    let m = op2.expect(|m| m.command == "MARKREAD").await;
    assert_eq!(m.params, vec!["#room".to_string(), set.clone()]);

    op.send(&format!("MARKREAD #room timestamp={}", seen[0].time))
        .await;
    let m = op.expect(|m| m.command == "MARKREAD").await;
    assert_eq!(m.params, vec!["#room".to_string(), set.clone()]);

    op.send("MARKREAD #room").await;
    let m = op.expect(|m| m.command == "MARKREAD").await;
    assert_eq!(m.params, vec!["#room".to_string(), set.clone()]);

    let f = op.fail("MARKREAD #room timestamp=yesterday").await;
    assert_eq!(f.param(1), Some("INVALID_PARAMS"));
    assert_eq!(f.param(2), Some("#room"));

    // Restart: the history and the marker survive.
    drop(op);
    drop(op2);
    drop(guest);
    srv.shutdown().await.expect("shutdown");
    drop(store);

    let (_store, srv) = start(&cfg).await;
    let mut op = Client::register(srv.local_addr, "boss", true).await;
    op.send("JOIN #room").await;
    let mr = op.expect(|m| m.command == "MARKREAD").await;
    assert_eq!(mr.params, vec!["#room".to_string(), set.clone()]);
    op.expect(|m| m.command == "366").await;

    let all = op.history("LATEST #room * 10").await;
    assert_eq!(texts(&all), vec!["m1", "m2", "m3", "m4", "m5", "m6"]);
    for (m, s) in all.iter().zip(&seen) {
        assert_eq!(m.tag("msgid"), Some(s.msgid.as_str()));
    }
    let after = op
        .history(&format!("AFTER #room msgid={} 10", seen[4].msgid))
        .await;
    assert_eq!(texts(&after), vec!["m6"]);

    srv.shutdown().await.expect("shutdown");
}
