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

/// The SQLite store. One connection behind a mutex.
pub struct Store {
    conn: Mutex<Connection>,
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
        Ok(Store {
            conn: Mutex::new(conn),
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
