//! SQLite persistence layer.
//!
//! The API is synchronous. Each call takes a short lock on one connection.
//! Callers run inside a sync lock or inside `spawn_blocking`.
//!
//! Units:
//! - `AccountRow::created`, `AccountRow::last_activity`, `ChannelRow::created`,
//!   `ChannelRow::topic_set_at` and all claim times are Unix seconds.
//! - All message times and read-marker times are Unix milliseconds.

mod accounts;
mod claims;
mod markers;
mod messages;
mod schema;

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use rusqlite::Connection;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

pub use accounts::{AccountRow, ChannelRow};
pub use claims::ClaimRow;
pub use messages::{Bound, NewMessage, StoredMessage, MAX_HISTORY_LIMIT};

/// Result type of the store. (Not named `Result` so a glob import is safe.)
pub type StoreResult<T> = Result<T, StoreError>;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("migration error: {0}")]
    Migration(String),
    /// A nick or alias is already reserved by another account.
    #[error("conflict: {0}")]
    Conflict(String),
}

/// Time between two group commits.
const COMMIT_INTERVAL: Duration = Duration::from_millis(10);

/// The SQLite store. One connection behind a mutex.
///
/// Store calls run under the world lock, so the hot path must not wait for
/// disk I/O:
/// - Deferred writes: the writes of each message (`insert_message_deferred`,
///   `set_cursors`, `touch`) go into a queue. A background thread applies the
///   queue every `COMMIT_INTERVAL`. Every other store call applies the queue
///   first, so each call sees all earlier writes.
/// - Group commit: store calls run inside one open transaction, and the
///   background thread commits it every `COMMIT_INTERVAL` (and on drop).
///   Other connections see the writes after the next commit.
pub struct Store {
    conn: Db,
    /// Next message `seq` (allocated at insert time, before the write).
    next_seq: Mutex<i64>,
    /// `(msgid, seq)` of the last inserted message.
    last_insert: Mutex<Option<(String, i64)>>,
}

/// A write that waits in the queue.
type Op = Box<dyn FnOnce(&mut Connection) -> StoreResult<()> + Send>;

struct DbInner {
    conn: Mutex<Connection>,
    queue: Mutex<Vec<(&'static str, Op)>>,
}

/// The connection and the write queue, shared with the commit thread.
struct Db(Arc<DbInner>);

impl Db {
    fn new(conn: Connection) -> Db {
        let db = Arc::new(DbInner {
            conn: Mutex::new(conn),
            queue: Mutex::new(Vec::new()),
        });
        let weak = Arc::downgrade(&db);
        let spawned = std::thread::Builder::new()
            .name("store-commit".into())
            .spawn(move || loop {
                std::thread::sleep(COMMIT_INTERVAL);
                let Some(db) = weak.upgrade() else {
                    return;
                };
                let queued = !db.queue.lock().is_empty();
                let open = !db.conn.lock().is_autocommit();
                if queued || open {
                    commit(&mut Db::lock_inner(&db));
                }
            });
        if let Err(e) = spawned {
            tracing::warn!("store: cannot start the commit thread: {e}");
        }
        Db(db)
    }

    /// Queue a write. It does not wait for the connection.
    fn defer(&self, what: &'static str, op: Op) {
        self.0.queue.lock().push((what, op));
    }

    /// Lock the connection, start the shared transaction if none is open,
    /// and apply the queued writes.
    fn lock(&self) -> DbGuard<'_> {
        Db::lock_inner(&self.0)
    }

    fn lock_inner(db: &DbInner) -> DbGuard<'_> {
        let mut guard = db.conn.lock();
        let ops = std::mem::take(&mut *db.queue.lock());
        if guard.is_autocommit() {
            if let Err(e) = guard.execute_batch("BEGIN") {
                tracing::warn!("store: BEGIN failed: {e}");
            }
        }
        for (what, op) in ops {
            if let Err(e) = op(&mut guard) {
                tracing::warn!("store: deferred {what} failed: {e}");
            }
        }
        DbGuard(guard)
    }
}

impl Drop for Db {
    fn drop(&mut self) {
        commit(&mut self.lock());
    }
}

fn commit(conn: &mut Connection) {
    if !conn.is_autocommit() {
        if let Err(e) = conn.execute_batch("COMMIT") {
            tracing::warn!("store: group commit failed: {e}");
        }
    }
}

struct DbGuard<'a>(parking_lot::MutexGuard<'a, Connection>);

impl std::ops::Deref for DbGuard<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        &self.0
    }
}

impl std::ops::DerefMut for DbGuard<'_> {
    fn deref_mut(&mut self) -> &mut Connection {
        &mut self.0
    }
}

impl Store {
    /// Open (or create) the database file. Creates the parent directory.
    pub fn open(path: &Path) -> Result<Store, StoreError> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let conn = Connection::open(path)?;
        conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get::<_, String>(0))?;
        // Store calls run under the world lock. In WAL mode, NORMAL does not
        // sync at each commit (only at checkpoints) and the database stays
        // consistent; a power loss can lose the last commits.
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Self::init(conn)
    }

    /// Open a private in-memory database (for tests).
    pub fn open_in_memory() -> Result<Store, StoreError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Store, StoreError> {
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(Duration::from_secs(5))?;
        schema::migrate(&mut conn)?;
        // AUTOINCREMENT never reuses a `seq`: start after the highest one.
        let last_seq: i64 = conn.query_row(
            "SELECT MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'messages'), 0), \
             COALESCE((SELECT MAX(seq) FROM messages), 0))",
            [],
            |r| r.get(0),
        )?;
        Ok(Store {
            conn: Db::new(conn),
            next_seq: Mutex::new(last_seq + 1),
            last_insert: Mutex::new(None),
        })
    }

    /// The schema version of the open database (`PRAGMA user_version`).
    pub fn schema_version(&self) -> StoreResult<i64> {
        let conn = self.conn.lock();
        Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
    }
}

/// Fold a nick or channel name for comparison (ASCII case only).
pub fn fold(s: &str) -> String {
    s.to_ascii_lowercase()
}

/// Current Unix time in milliseconds.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Format Unix milliseconds as `YYYY-MM-DDThh:mm:ss.sssZ`.
pub fn format_time_ms(ms: i64) -> String {
    let dt = OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        dt.year(),
        u8::from(dt.month()),
        dt.day(),
        dt.hour(),
        dt.minute(),
        dt.second(),
        dt.millisecond()
    )
}

/// Parse an RFC 3339 time (the `format_time_ms` form and close variants)
/// into Unix milliseconds.
pub fn parse_time(s: &str) -> Option<i64> {
    let dt = OffsetDateTime::parse(s, &Rfc3339).ok()?;
    let ms = dt.unix_timestamp_nanos().div_euclid(1_000_000);
    i64::try_from(ms).ok()
}
