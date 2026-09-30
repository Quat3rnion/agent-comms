//! Link connection task: handshake, authentication, rate limit, replacement,
//! state machine (section 2.6), keepalive, verb dispatch, and disconnect.

use super::{LinkCtx, LinkPhase, LinkShared};
use crate::config::LinkCredential;
use crate::conn::{spawn_writer, BoxReader, LineConn, LineError};
use crate::modules::hub::LinkEntry;
use crate::state::SharedState;
use crate::user::{LinkHandle, Outbound};
use agent_comms_proto::{Limits, Message, ParseError};
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncBufReadExt;
use tokio::time::Instant;

/// Maximum size of one link line: body, tags, and a small margin.
const LINK_LINE_MAX: usize = Limits::LINK.body + Limits::LINK.tags + 16;
/// Window of the handshake failure rate limit.
const AUTH_WINDOW: Duration = Duration::from_secs(60);
/// Time that a link has between its `BURST` and its `ENDBURST`.
const BURST_TIMEOUT: Duration = Duration::from_secs(60);
const PROTOCOL_VERSION: &str = "1";

/// Start the task for a link connection whose first line is `first` (`LINK`).
pub fn spawn(shared: Arc<LinkShared>, state: SharedState, conn: LineConn, first: Message) {
    tokio::spawn(run(shared, state, conn, first));
}

async fn run(shared: Arc<LinkShared>, state: SharedState, mut conn: LineConn, first: Message) {
    let peer = conn.peer;

    let credential = match handshake(&shared, &state, peer, conn.is_tls, &first).await {
        Ok(c) => c,
        Err(reason) => {
            let _ = conn.write_line(&format!("ERROR :{reason}")).await;
            return;
        }
    };
    let name = first.params[1].clone();

    let (outbound, rx) = Outbound::new(state.config.limits.outbound_queue);
    let (reader, writer, _, _) = conn.into_parts();
    let writer_task = spawn_writer(writer, rx, outbound.clone());

    let entry = LinkEntry {
        name: name.clone(),
        owner: credential.owner.clone(),
        handle: LinkHandle {
            name: name.clone(),
            tx: outbound.clone(),
        },
        established: false,
    };
    if let Some(old) = shared.hub.insert(entry.clone()) {
        old.handle.tx.send_line("ERROR replaced");
        old.handle.tx.close_with("replaced");
        tracing::info!(link = %name, peer = %peer, "link replaced");
    }
    tracing::info!(link = %name, peer = %peer, owner = %credential.owner, "link up");

    let mut ctx = LinkCtx {
        entry,
        phase: LinkPhase::Linked,
        accounts: Vec::new(),
    };
    ctx.send(&Message::new(
        "LINKED",
        vec![
            PROTOCOL_VERSION.to_string(),
            state.config.server_name.clone(),
        ],
    ));

    let mut reader = LinkReader {
        reader,
        buf: Vec::new(),
        too_long: false,
    };
    let reason = session(&shared, &state, &mut ctx, &mut reader).await;

    if shared
        .hub
        .remove_if_current(&ctx.entry.name, &ctx.entry.handle)
    {
        super::accounts::link_down(&shared, &state, &ctx);
        for ext in shared.hub.extensions() {
            ext.on_link_down(&state, &ctx.entry.name);
        }
    }
    outbound.close_with("link closed");
    let _ = tokio::time::timeout(Duration::from_secs(5), writer_task).await;
    tracing::info!(link = %name, peer = %peer, reason = %reason, "link down");
}

/// Check the `LINK` line. Returns the matching credential, or the reason for
/// the `ERROR` line.
async fn handshake(
    shared: &Arc<LinkShared>,
    state: &SharedState,
    peer: SocketAddr,
    is_tls: bool,
    first: &Message,
) -> Result<LinkCredential, &'static str> {
    let ip = peer.ip().to_canonical();
    if first.params.len() != 3 {
        return Err("malformed LINK");
    }
    let limit = state.config.limits.link_auth_failures_per_min as usize;
    if recent_failures(shared, ip) >= limit {
        tracing::warn!(peer = %peer, "link handshake rate limited");
        return Err("rate limited");
    }
    let (version, name, token) = (&first.params[0], &first.params[1], &first.params[2]);
    if version != PROTOCOL_VERSION {
        return Err("unsupported version");
    }
    if !valid_link_name(name) {
        return Err("invalid link name");
    }
    if !is_tls && !ip.is_loopback() {
        tracing::warn!(peer = %peer, link = %name, "link refused: TLS required");
        return Err("TLS required");
    }

    let candidates: Vec<LinkCredential> = state
        .secrets
        .read()
        .links
        .iter()
        .filter(|c| !c.revoked)
        .cloned()
        .collect();
    let token = token.clone();
    let matched = tokio::task::spawn_blocking(move || verify(&candidates, &token))
        .await
        .ok()
        .flatten();
    match matched {
        Some(c) => Ok(c),
        None => {
            record_failure(shared, ip);
            tracing::warn!(peer = %peer, link = %name, "link handshake: bad credential");
            Err("bad credential")
        }
    }
}

fn verify(candidates: &[LinkCredential], token: &str) -> Option<LinkCredential> {
    use argon2::{Argon2, PasswordHash, PasswordVerifier};
    candidates
        .iter()
        .find(|c| {
            PasswordHash::new(&c.token_hash).is_ok_and(|hash| {
                Argon2::default()
                    .verify_password(token.as_bytes(), &hash)
                    .is_ok()
            })
        })
        .cloned()
}

fn valid_link_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Number of failed handshakes from `ip` in the last minute (old entries are
/// removed).
fn recent_failures(shared: &LinkShared, ip: IpAddr) -> usize {
    let now = std::time::Instant::now();
    let mut map = shared.auth_failures.lock();
    let Some(list) = map.get_mut(&ip) else {
        return 0;
    };
    list.retain(|t| now.duration_since(*t) < AUTH_WINDOW);
    let n = list.len();
    if n == 0 {
        map.remove(&ip);
    }
    n
}

fn record_failure(shared: &LinkShared, ip: IpAddr) {
    shared
        .auth_failures
        .lock()
        .entry(ip)
        .or_default()
        .push(std::time::Instant::now());
}

/// Read and dispatch lines until the link closes. Returns the close reason.
async fn session(
    shared: &Arc<LinkShared>,
    state: &SharedState,
    ctx: &mut LinkCtx,
    reader: &mut LinkReader,
) -> String {
    let limits = &state.config.limits;
    let ping_after = Duration::from_secs(limits.link_ping_secs.max(1));
    let timeout_after = Duration::from_secs(limits.link_timeout_secs.max(1));
    let out = ctx.entry.handle.tx.clone();
    let mut last_rx = Instant::now();
    let mut pinged = false;
    let mut burst_started: Option<Instant> = None;

    loop {
        let idle_deadline = if pinged {
            last_rx + timeout_after
        } else {
            last_rx + ping_after
        };
        let deadline = match (ctx.phase, burst_started) {
            (LinkPhase::Bursting, Some(t)) => idle_deadline.min(t + BURST_TIMEOUT),
            _ => idle_deadline,
        };

        let read = tokio::select! {
            r = reader.read_line(LINK_LINE_MAX) => r,
            _ = out.closed_notified() => {
                return out.close_reason().unwrap_or_else(|| "link closed".into());
            }
            _ = tokio::time::sleep_until(deadline) => {
                let now = Instant::now();
                let burst_expired = ctx.phase == LinkPhase::Bursting
                    && burst_started.is_some_and(|t| now >= t + BURST_TIMEOUT);
                if burst_expired || now >= last_rx + timeout_after {
                    return violation(ctx, "timeout");
                }
                if !pinged && now >= last_rx + ping_after {
                    ctx.send(&Message::new("PING", vec![state.config.server_name.clone()]));
                    pinged = true;
                }
                continue;
            }
        };

        let line = match read {
            Err(e) => return format!("read error: {e}"),
            Ok(None) => return "connection closed".into(),
            Ok(Some(Err(LineError::TooLong))) => return violation(ctx, "line too long"),
            Ok(Some(Err(LineError::InvalidUtf8))) => return violation(ctx, "invalid UTF-8"),
            Ok(Some(Ok(line))) => line,
        };
        last_rx = Instant::now();
        pinged = false;

        let msg = match Message::parse_with(&line, Limits::LINK) {
            Ok(m) => m,
            Err(ParseError::Empty) => continue,
            Err(ParseError::BodyTooLong | ParseError::TagsTooLong) => {
                return violation(ctx, "line too long");
            }
            Err(e) => return violation(ctx, &e.to_string()),
        };

        if let Err(reason) = dispatch(shared, state, ctx, &msg, &mut burst_started) {
            return violation(ctx, reason);
        }
    }
}

/// Queue `ERROR :<reason>` (the caller closes the link). Returns the reason.
fn violation(ctx: &LinkCtx, reason: &str) -> String {
    ctx.entry.handle.tx.send_line(&format!("ERROR :{reason}"));
    reason.to_string()
}

/// Handle one link line. `Err(reason)` is a protocol violation.
fn dispatch(
    shared: &Arc<LinkShared>,
    state: &SharedState,
    ctx: &mut LinkCtx,
    msg: &Message,
    burst_started: &mut Option<Instant>,
) -> Result<(), &'static str> {
    let verb = msg.command_upper();
    match verb.as_str() {
        "PING" => {
            match msg.params.first() {
                Some(token) => ctx.reply(msg, Message::new("PONG", vec![token.clone()])),
                None => ctx.fail(msg, "INVALID_PARAMS", &[], "Missing token"),
            }
            return Ok(());
        }
        "PONG" => return Ok(()),
        "LINK" => return Err("not allowed in this state"),
        "BURST" => {
            if ctx.phase != LinkPhase::Linked {
                return Err("duplicate burst");
            }
            ctx.phase = LinkPhase::Bursting;
            *burst_started = Some(Instant::now());
            return Ok(());
        }
        _ => {}
    }

    match ctx.phase {
        LinkPhase::Linked => return Err("not allowed in this state"),
        LinkPhase::Bursting => {
            if !matches!(verb.as_str(), "INTRODUCE" | "STATE" | "CLAIM" | "ENDBURST") {
                return Err("not allowed in this state");
            }
        }
        LinkPhase::Syncing | LinkPhase::Established => {}
    }

    match verb.as_str() {
        "ENDBURST" => {
            if ctx.phase != LinkPhase::Bursting {
                return Err("not allowed in this state");
            }
            ctx.phase = LinkPhase::Syncing;
            *burst_started = None;
            super::replay::server_burst(shared, state, ctx);
            ctx.phase = LinkPhase::Established;
            ctx.entry.established = true;
            for ext in shared.hub.extensions() {
                ext.on_link_up(state, &ctx.entry);
            }
        }
        "INTRODUCE" | "RENAME" | "RETIRE" | "STATE" => {
            super::accounts::handle(shared, state, ctx, msg);
        }
        "SEND" => super::send::handle(shared, state, ctx, msg),
        _ => {
            let handled = shared
                .hub
                .extensions()
                .iter()
                .any(|ext| ext.on_link_verb(state, &ctx.entry, msg));
            if !handled {
                ctx.fail(msg, "UNKNOWN_COMMAND", &[], "Unknown command");
            }
        }
    }
    Ok(())
}

/// Cancel-safe line reader over the reader half of the link connection.
struct LinkReader {
    reader: BoxReader,
    buf: Vec<u8>,
    too_long: bool,
}

impl LinkReader {
    /// Read one line (LF-terminated, CR stripped). `None` at EOF.
    async fn read_line(&mut self, max: usize) -> io::Result<Option<Result<String, LineError>>> {
        loop {
            let avail = self.reader.fill_buf().await?;
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
            self.reader
                .consume(if done { chunk_len + 1 } else { chunk_len });
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
