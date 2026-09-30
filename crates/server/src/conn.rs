//! Line-based connections and the client session loop.

use crate::flood::TokenBucket;
use crate::ops;
use crate::sasl;
use crate::state::SharedState;
use crate::user::{Outbound, Role, User, UserId};
use crate::util::unix_now;
use agent_comms_proto::{numeric, Limits, Message, ParseError};
use std::collections::VecDeque;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::Instant;

pub type BoxReader = BufReader<Box<dyn AsyncRead + Send + Unpin>>;
pub type BoxWriter = Box<dyn AsyncWrite + Send + Unpin>;

/// Maximum size of one client line: body plus tags.
pub const CLIENT_LINE_MAX: usize = Limits::CLIENT.body + Limits::CLIENT.tags;

/// Maximum size of the tag data that a client can send, without the leading
/// `@` and the trailing space (IRCv3 message-tags).
const CLIENT_TAG_DATA_MAX: usize = 4094;

const REGISTRATION_TIMEOUT: Duration = Duration::from_secs(60);
const FLOOD_WINDOW: Duration = Duration::from_secs(60);
const FLOOD_MAX_WAIT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum LineError {
    #[error("line too long")]
    TooLong,
    #[error("invalid UTF-8")]
    InvalidUtf8,
}

/// Cancel-safe line reader state.
#[derive(Default)]
struct LineBuf {
    buf: Vec<u8>,
    too_long: bool,
}

impl LineBuf {
    async fn read_line(
        &mut self,
        reader: &mut BoxReader,
        max: usize,
    ) -> io::Result<Option<Result<String, LineError>>> {
        loop {
            let avail = reader.fill_buf().await?;
            if avail.is_empty() {
                return Ok(None);
            }
            let (chunk_len, done) = match avail.iter().position(|b| *b == b'\n') {
                Some(pos) => (pos, true),
                None => (avail.len(), false),
            };
            if !self.too_long {
                if self.buf.len() + chunk_len > max + 1 {
                    self.too_long = true;
                    self.buf.clear();
                } else {
                    self.buf.extend_from_slice(&avail[..chunk_len]);
                }
            }
            reader.consume(if done { chunk_len + 1 } else { chunk_len });
            if !done {
                continue;
            }
            let mut line = std::mem::take(&mut self.buf);
            let too_long = std::mem::replace(&mut self.too_long, false);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if too_long || line.len() > max {
                return Ok(Some(Err(LineError::TooLong)));
            }
            return Ok(Some(
                String::from_utf8(line).map_err(|_| LineError::InvalidUtf8),
            ));
        }
    }
}

pub struct LineConn {
    reader: BoxReader,
    writer: BoxWriter,
    pub peer: SocketAddr,
    pub is_tls: bool,
    pending: LineBuf,
}

impl LineConn {
    pub fn new<S>(stream: S, peer: SocketAddr, is_tls: bool) -> LineConn
    where
        S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        let (r, w) = tokio::io::split(stream);
        LineConn {
            reader: BufReader::new(Box::new(r) as Box<dyn AsyncRead + Send + Unpin>),
            writer: Box::new(w),
            peer,
            is_tls,
            pending: LineBuf::default(),
        }
    }

    /// Read one line (LF-terminated, CR stripped). `None` at EOF.
    pub async fn read_line(&mut self, max: usize) -> io::Result<Option<Result<String, LineError>>> {
        self.pending.read_line(&mut self.reader, max).await
    }

    /// Write one line and CRLF, then flush.
    pub async fn write_line(&mut self, line: &str) -> io::Result<()> {
        self.writer.write_all(line.as_bytes()).await?;
        self.writer.write_all(b"\r\n").await?;
        self.writer.flush().await
    }

    pub fn into_parts(self) -> (BoxReader, BoxWriter, SocketAddr, bool) {
        (self.reader, self.writer, self.peer, self.is_tls)
    }
}

/// Write queued lines until the queue closes or the outbound is closed. Lines
/// queued before the close are still written.
pub fn spawn_writer(
    writer: BoxWriter,
    rx: mpsc::Receiver<Arc<str>>,
    closer: Outbound,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut writer = writer;
        let mut rx = rx;
        loop {
            tokio::select! {
                biased;
                line = rx.recv() => match line {
                    Some(line) => {
                        if write_crlf(&mut writer, &line).await.is_err() {
                            closer.close_with("Write error");
                            break;
                        }
                    }
                    None => break,
                },
                _ = closer.closed_notified() => {
                    while let Ok(line) = rx.try_recv() {
                        if write_crlf(&mut writer, &line).await.is_err() {
                            break;
                        }
                    }
                    break;
                }
            }
        }
        let _ = writer.flush().await;
        let _ = writer.shutdown().await;
    })
}

async fn write_crlf(w: &mut BoxWriter, line: &str) -> io::Result<()> {
    w.write_all(line.as_bytes()).await?;
    w.write_all(b"\r\n").await?;
    w.flush().await
}

/// Run one client connection until it closes.
pub async fn run_client(state: SharedState, mut conn: LineConn) {
    // The first line decides between a client and a link.
    let first =
        match tokio::time::timeout(REGISTRATION_TIMEOUT, conn.read_line(CLIENT_LINE_MAX)).await {
            Ok(Ok(Some(line))) => line,
            _ => return,
        };
    if let Ok(line) = &first {
        if let Ok(msg) = Message::parse_with(line, Limits::LINK) {
            if msg.command_upper() == "LINK" {
                let mut conn = conn;
                for module in &state.modules {
                    match module.take_link(state.clone(), conn, msg.clone()) {
                        Some(c) => conn = c,
                        None => return,
                    }
                }
                let _ = conn.write_line("ERROR :links disabled").await;
                return;
            }
        }
    }

    let LineConn {
        mut reader,
        writer,
        peer,
        pending: mut linebuf,
        ..
    } = conn;
    let limits = &state.config.limits;
    let (out, rx) = Outbound::new(limits.outbound_queue);
    let uid = state.with_world(|cx| {
        let id = cx.world.alloc_uid();
        cx.world.add_user(User::new_socket(
            id,
            peer.ip().to_string(),
            out.clone(),
            unix_now(),
        ));
        id
    });
    let writer_task = spawn_writer(writer, rx, out.clone());

    let reason = session(
        &state,
        uid,
        peer.ip(),
        &out,
        &mut reader,
        &mut linebuf,
        Some(first),
    )
    .await;

    state.with_world(|cx| ops::quit(cx, uid, &reason));
    out.close();
    let _ = tokio::time::timeout(Duration::from_secs(5), writer_task).await;
}

async fn session(
    state: &SharedState,
    uid: UserId,
    ip: IpAddr,
    out: &Outbound,
    reader: &mut BoxReader,
    linebuf: &mut LineBuf,
    mut first: Option<Result<String, LineError>>,
) -> String {
    let limits = &state.config.limits;
    let ping_after = Duration::from_secs(limits.client_ping_secs.max(1));
    let timeout_after = Duration::from_secs(limits.client_timeout_secs.max(1));
    let reg_deadline = Instant::now() + REGISTRATION_TIMEOUT;
    let mut last_rx = Instant::now();
    let mut pinged = false;
    let mut bucket = TokenBucket::new(limits.flood_burst, limits.flood_rate_per_sec);
    let mut waits: VecDeque<(Instant, Duration)> = VecDeque::new();

    loop {
        let (registered, role) = {
            let w = state.world.lock();
            match w.user(uid) {
                Some(u) => (u.registered, u.role),
                None => return "Connection closed".into(),
            }
        };

        let read = match first.take() {
            Some(line) => Ok(Some(line)),
            None => {
                let idle_deadline = if pinged {
                    last_rx + timeout_after
                } else {
                    last_rx + ping_after
                };
                let deadline = if registered {
                    idle_deadline
                } else {
                    idle_deadline.min(reg_deadline)
                };
                tokio::select! {
                    r = linebuf.read_line(reader, CLIENT_LINE_MAX) => r,
                    _ = out.closed_notified() => {
                        return out.close_reason().unwrap_or_else(|| "Connection closed".into());
                    }
                    _ = tokio::time::sleep_until(deadline) => {
                        let now = Instant::now();
                        if !registered && now >= reg_deadline {
                            return "Registration timeout".into();
                        }
                        if pinged && now >= last_rx + timeout_after {
                            return format!("Ping timeout: {} seconds", timeout_after.as_secs());
                        }
                        if !pinged && now >= last_rx + ping_after {
                            let ping = Message::new("PING", vec![state.config.server_name.clone()]);
                            out.send_line(&ping.to_line());
                            pinged = true;
                        }
                        continue;
                    }
                }
            }
        };

        let line = match read {
            Err(e) => return format!("Read error: {e}"),
            Ok(None) => return "Connection closed".into(),
            Ok(Some(Err(LineError::TooLong))) => {
                last_rx = Instant::now();
                pinged = false;
                input_too_long(state, uid);
                continue;
            }
            Ok(Some(Err(LineError::InvalidUtf8))) => return "Invalid UTF-8".into(),
            Ok(Some(Ok(line))) => line,
        };
        last_rx = Instant::now();
        pinged = false;

        if client_tags_too_long(&line) {
            input_too_long(state, uid);
            continue;
        }

        let msg = match Message::parse(&line) {
            Ok(m) => m,
            Err(ParseError::BodyTooLong | ParseError::TagsTooLong) => {
                input_too_long(state, uid);
                continue;
            }
            // Parse the rest of the line so that the unknown command gets
            // ERR_UNKNOWNCOMMAND (with its label) from the dispatcher.
            Err(ParseError::InvalidCommand) => match parse_unknown_command(&line) {
                Some(m) => m,
                None => continue,
            },
            Err(_) => continue,
        };

        let cmd = msg.command_upper();
        if cmd != "PING" && cmd != "PONG" {
            if let Some(u) = state.world.lock().user_mut(uid) {
                u.last_activity = std::time::Instant::now();
            }
        }

        if role != Role::Operator {
            if let Some(wait) = bucket.take() {
                let now = Instant::now();
                waits.push_back((now, wait));
                while waits
                    .front()
                    .is_some_and(|(t, _)| now.duration_since(*t) > FLOOD_WINDOW)
                {
                    waits.pop_front();
                }
                let total: Duration = waits.iter().map(|(_, d)| *d).sum();
                if total > FLOOD_MAX_WAIT {
                    return "Excess Flood".into();
                }
                tokio::time::sleep(wait).await;
            }
        }

        ops::dispatch_as(state, uid, msg);

        // The next line is read only after the SASL result is applied, so a
        // pipelined CAP END cannot complete registration before it.
        if cmd == "AUTHENTICATE" {
            sasl::run_pending(state, uid, ip).await;
        }
    }
}

/// True when the tag data of a client line (without the leading `@` and the
/// trailing space) is larger than the IRCv3 client limit.
fn client_tags_too_long(line: &str) -> bool {
    match line.strip_prefix('@') {
        Some(rest) => rest.find(' ').unwrap_or(rest.len()) > CLIENT_TAG_DATA_MAX,
        None => false,
    }
}

/// Parse a line whose command token is not valid. The command token is
/// replaced by a placeholder for the parse and restored after it.
fn parse_unknown_command(line: &str) -> Option<Message> {
    let mut start = 0;
    let mut rest = line;
    for prefix in ['@', ':'] {
        if rest.starts_with(prefix) {
            let end = rest.find(' ')?;
            let after = rest[end..].trim_start_matches(' ');
            start += rest.len() - after.len();
            rest = after;
        }
    }
    let end = rest.find(' ').unwrap_or(rest.len());
    let command = &rest[..end];
    if command.is_empty() {
        return None;
    }
    let patched = format!("{}X{}", &line[..start], &rest[end..]);
    let mut msg = Message::parse(&patched).ok()?;
    msg.command = command.to_string();
    Some(msg)
}

fn input_too_long(state: &SharedState, uid: UserId) {
    state.with_world(|cx| {
        cx.numeric(
            uid,
            numeric::ERR_INPUTTOOLONG,
            vec!["Input line was too long".into()],
        )
    });
}
