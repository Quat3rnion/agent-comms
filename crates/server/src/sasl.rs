//! SASL authentication (`AUTHENTICATE`) with the PLAIN mechanism.
//!
//! The command handler runs under the world lock. It only collects and
//! decodes the payload, and records the credentials as pending. The
//! connection task then calls [`run_pending`], which verifies the password
//! with argon2 on a blocking thread, without the world lock, and applies the
//! result under a short lock.
//!
//! Admission control for each server:
//! - At most [`MAX_CONCURRENT`] verifications run at the same time.
//! - An IP address with [`MAX_FAILURES`] failed attempts in [`FAILURE_WINDOW`]
//!   gets `904` without a hash check for the remainder of the window. This
//!   also applies to an attempt with the correct password.

use crate::handlers::registration;
use crate::module::Cx;
use crate::ops;
use crate::state::{ServerState, SharedState};
use crate::user::{Role, SaslState, UserId};
use agent_comms_proto::{numeric, Message};
use argon2::{Argon2, PasswordHash, PasswordVerifier};
use base64::Engine;
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;

/// Size of a full chunk. A chunk of this size means that more data follows.
const CHUNK: usize = 400;
/// Maximum size of the complete base64 payload.
const MAX_PAYLOAD: usize = 8192;

/// Maximum number of password verifications that run at the same time.
pub const MAX_CONCURRENT: usize = 4;
/// Maximum number of failed attempts from one IP address in one window.
pub const MAX_FAILURES: u32 = 10;
/// Length of the failure window.
pub const FAILURE_WINDOW: Duration = Duration::from_secs(60);
/// Maximum number of IP addresses in the failure map.
const MAX_TRACKED_IPS: usize = 10_000;
/// Maximum time to wait for a verification slot.
const PERMIT_WAIT: Duration = Duration::from_secs(10);

/// Decoded PLAIN credentials that wait for verification. The password bytes
/// are overwritten with zeros on drop.
#[derive(Clone)]
pub struct PendingPlain {
    pub authcid: String,
    password: Vec<u8>,
}

impl std::fmt::Debug for PendingPlain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PendingPlain")
            .field("authcid", &self.authcid)
            .field("password", &"<redacted>")
            .finish()
    }
}

impl Drop for PendingPlain {
    fn drop(&mut self) {
        wipe(&mut self.password);
    }
}

fn wipe(buf: &mut [u8]) {
    buf.fill(0);
    let _ = std::hint::black_box(buf);
}

/// Handle one `AUTHENTICATE` command.
pub fn handle(cx: &mut Cx<'_>, uid: UserId, msg: &Message) {
    let Some(arg) = msg.param(0).map(str::to_string) else {
        cx.numeric(
            uid,
            numeric::ERR_NEEDMOREPARAMS,
            vec!["AUTHENTICATE".into(), "Not enough parameters".into()],
        );
        return;
    };
    let Some(u) = cx.world.user(uid) else {
        return;
    };
    let in_progress = u.reg.sasl.is_some();
    let verifying = u.reg.sasl.as_ref().is_some_and(|s| s.verifying);
    let logged_in = u.account.is_some();

    if verifying {
        // The connection task applies the result; keep the state.
        cx.numeric(
            uid,
            numeric::ERR_SASLFAIL,
            vec!["SASL authentication is in progress".into()],
        );
        return;
    }
    if arg == "*" {
        clear(cx, uid);
        cx.numeric(
            uid,
            numeric::ERR_SASLABORTED,
            vec!["SASL authentication aborted".into()],
        );
        return;
    }
    if logged_in {
        clear(cx, uid);
        cx.numeric(
            uid,
            numeric::ERR_SASLALREADY,
            vec!["You have already authenticated using SASL".into()],
        );
        return;
    }

    if !in_progress {
        let mech = arg.to_ascii_uppercase();
        if mech != "PLAIN" {
            cx.numeric(
                uid,
                numeric::RPL_SASLMECHS,
                vec!["PLAIN".into(), "are available SASL mechanisms".into()],
            );
            fail(cx, uid);
            return;
        }
        if let Some(u) = cx.world.user_mut(uid) {
            u.reg.sasl = Some(SaslState {
                mechanism: mech,
                ..SaslState::default()
            });
        }
        cx.send(uid, Message::new("AUTHENTICATE", vec!["+".into()]));
        return;
    }

    if arg.len() > CHUNK {
        too_long(cx, uid);
        return;
    }
    let done = arg.len() < CHUNK;
    let buffer = {
        let Some(state) = cx.world.user_mut(uid).and_then(|u| u.reg.sasl.as_mut()) else {
            return;
        };
        if arg != "+" {
            state.buffer.push_str(&arg);
        }
        if state.buffer.len() > MAX_PAYLOAD {
            None
        } else if done {
            Some(Some(std::mem::take(&mut state.buffer)))
        } else {
            Some(None)
        }
    };
    let payload = match buffer {
        None => {
            too_long(cx, uid);
            return;
        }
        Some(None) => return,
        Some(Some(p)) => p,
    };
    let mut payload = payload.into_bytes();
    let creds = parse_plain(&payload);
    wipe(&mut payload);

    let Some(creds) = creds else {
        fail(cx, uid);
        return;
    };
    // The connection task verifies the password outside the world lock.
    if let Some(state) = cx.world.user_mut(uid).and_then(|u| u.reg.sasl.as_mut()) {
        state.pending = Some(creds);
        state.verifying = true;
    }
}

/// Decode a PLAIN payload. Returns `None` when the format is not valid.
fn parse_plain(payload: &[u8]) -> Option<PendingPlain> {
    let mut raw = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .ok()?;
    let parsed = split_plain(&raw);
    wipe(&mut raw);
    parsed
}

fn split_plain(raw: &[u8]) -> Option<PendingPlain> {
    let mut parts = raw.split(|b| *b == 0);
    let authzid = std::str::from_utf8(parts.next()?).ok()?;
    let authcid = std::str::from_utf8(parts.next()?).ok()?;
    let password = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    if !authzid.is_empty() && authzid != authcid {
        return None;
    }
    Some(PendingPlain {
        authcid: authcid.to_string(),
        password: password.to_vec(),
    })
}

enum Outcome {
    Success(String),
    Failure,
    /// Refused by the failure limiter without a hash check.
    Limited,
}

/// Verify the pending credentials of `uid`, if any, and apply the result.
/// Call this from the connection task, without the world lock.
pub async fn run_pending(state: &SharedState, uid: UserId, ip: IpAddr) {
    let creds = {
        let mut world = state.world.lock();
        let Some(sasl) = world.user_mut(uid).and_then(|u| u.reg.sasl.as_mut()) else {
            return;
        };
        let Some(creds) = sasl.pending.take() else {
            return;
        };
        creds
    };

    let gate = gate_for(state);
    let outcome = if gate.limited(ip) {
        Outcome::Limited
    } else {
        let outcome = verify(state, &gate, ip, creds).await;
        if matches!(outcome, Outcome::Failure) {
            gate.record_failure(ip);
        }
        outcome
    };

    state.with_world(|cx| apply(cx, uid, outcome));
}

/// Check the credentials against the operator secret on a blocking thread.
async fn verify(state: &SharedState, gate: &Gate, ip: IpAddr, creds: PendingPlain) -> Outcome {
    let (account, hash) = {
        let secrets = state.secrets.read();
        let Some(op) = secrets.operator.as_ref() else {
            return Outcome::Failure;
        };
        (op.account.clone(), op.password_hash.clone())
    };
    if creds.authcid != account {
        return Outcome::Failure;
    }
    let permit = match tokio::time::timeout(PERMIT_WAIT, gate.permits.clone().acquire_owned()).await
    {
        Ok(Ok(p)) => p,
        _ => return Outcome::Failure,
    };
    // Other attempts from the same address can fail while this one waits.
    if gate.limited(ip) {
        return Outcome::Limited;
    }
    let ok = tokio::task::spawn_blocking(move || {
        // Keep the slot until the hash check ends, also when the caller is
        // cancelled.
        let _permit = permit;
        PasswordHash::new(&hash).is_ok_and(|parsed| {
            Argon2::default()
                .verify_password(&creds.password, &parsed)
                .is_ok()
        })
    })
    .await
    .unwrap_or(false);
    if ok {
        Outcome::Success(account)
    } else {
        Outcome::Failure
    }
}

/// Apply a verification result, if the user still exists and still waits.
fn apply(cx: &mut Cx<'_>, uid: UserId, outcome: Outcome) {
    let waiting = cx
        .world
        .user(uid)
        .and_then(|u| u.reg.sasl.as_ref())
        .is_some_and(|s| s.verifying);
    if !waiting {
        return;
    }
    clear(cx, uid);
    match outcome {
        Outcome::Success(account) => succeed(cx, uid, account),
        Outcome::Failure => fail(cx, uid),
        Outcome::Limited => {
            fail(cx, uid);
            if cx.config().require_sasl {
                let reason = "Too many failed SASL attempts";
                cx.world
                    .send_to(uid, &Message::new("ERROR", vec![reason.to_string()]));
                ops::quit(cx, uid, reason);
                return;
            }
        }
    }
    // Registration waits while a verification runs.
    registration::try_complete(cx, uid);
}

fn succeed(cx: &mut Cx<'_>, uid: UserId, account: String) {
    let Some(u) = cx.world.user_mut(uid) else {
        return;
    };
    u.account = Some(account.clone());
    u.role = Role::Operator;
    let source = u.source();
    cx.numeric(
        uid,
        numeric::RPL_LOGGEDIN,
        vec![
            source,
            account.clone(),
            format!("You are now logged in as {account}"),
        ],
    );
    cx.numeric(
        uid,
        numeric::RPL_SASLSUCCESS,
        vec!["SASL authentication successful".into()],
    );
}

fn fail(cx: &mut Cx<'_>, uid: UserId) {
    clear(cx, uid);
    cx.numeric(
        uid,
        numeric::ERR_SASLFAIL,
        vec!["SASL authentication failed".into()],
    );
}

fn too_long(cx: &mut Cx<'_>, uid: UserId) {
    clear(cx, uid);
    cx.numeric(
        uid,
        numeric::ERR_SASLTOOLONG,
        vec!["SASL message too long".into()],
    );
}

fn clear(cx: &mut Cx<'_>, uid: UserId) {
    if let Some(u) = cx.world.user_mut(uid) {
        u.reg.sasl = None;
    }
}

// ---------------------------------------------------------------- admission

/// Failed attempts of one IP address in the current window.
struct Window {
    start: Instant,
    count: u32,
}

/// Admission control of one server.
struct Gate {
    owner: Weak<ServerState>,
    permits: Arc<Semaphore>,
    failures: parking_lot::Mutex<HashMap<IpAddr, Window>>,
}

impl Gate {
    /// True when `ip` has too many failed attempts in the current window.
    fn limited(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        self.failures.lock().get(&ip).is_some_and(|w| {
            now.duration_since(w.start) < FAILURE_WINDOW && w.count >= MAX_FAILURES
        })
    }

    fn record_failure(&self, ip: IpAddr) {
        let now = Instant::now();
        let mut map = self.failures.lock();
        if let Some(w) = map.get_mut(&ip) {
            if now.duration_since(w.start) < FAILURE_WINDOW {
                w.count = w.count.saturating_add(1);
            } else {
                *w = Window {
                    start: now,
                    count: 1,
                };
            }
            return;
        }
        if map.len() >= MAX_TRACKED_IPS {
            map.retain(|_, w| now.duration_since(w.start) < FAILURE_WINDOW);
        }
        // When the map is still full, do not track the address. The
        // concurrency limit still bounds the hash work.
        if map.len() < MAX_TRACKED_IPS {
            map.insert(
                ip,
                Window {
                    start: now,
                    count: 1,
                },
            );
        }
    }
}

/// Gates of the running servers. A gate is removed when its server is gone,
/// so a new server never gets the failures of an old one.
static GATES: OnceLock<parking_lot::Mutex<Vec<Arc<Gate>>>> = OnceLock::new();

fn gate_for(state: &SharedState) -> Arc<Gate> {
    let mut gates = GATES.get_or_init(Default::default).lock();
    gates.retain(|g| g.owner.strong_count() > 0);
    let ptr = Arc::as_ptr(state);
    if let Some(g) = gates.iter().find(|g| std::ptr::eq(g.owner.as_ptr(), ptr)) {
        return g.clone();
    }
    let gate = Arc::new(Gate {
        owner: Arc::downgrade(state),
        permits: Arc::new(Semaphore::new(MAX_CONCURRENT)),
        failures: parking_lot::Mutex::new(HashMap::new()),
    });
    gates.push(gate.clone());
    gate
}
