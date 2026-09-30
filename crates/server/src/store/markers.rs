//! Read markers (Unix milliseconds).

use rusqlite::{params, OptionalExtension};

use super::{Store, StoreResult};

impl Store {
    pub fn get_marker(&self, account: &str, target_fold: &str) -> StoreResult<Option<i64>> {
        let conn = self.conn.lock();
        Ok(conn
            .query_row(
                "SELECT time_ms FROM read_markers WHERE account = ?1 AND target_fold = ?2",
                params![account, target_fold],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Set a read marker. It only moves forward. Returns the stored value,
    /// which is the greater of the old and the new time.
    pub fn set_marker(
        &self,
        account: &str,
        target_fold: &str,
        target: &str,
        time_ms: i64,
    ) -> StoreResult<i64> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO read_markers (account, target_fold, target, time_ms) \
             VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(account, target_fold) DO UPDATE SET \
               target = CASE WHEN excluded.time_ms > read_markers.time_ms \
                             THEN excluded.target ELSE read_markers.target END, \
               time_ms = MAX(read_markers.time_ms, excluded.time_ms)",
            params![account, target_fold, target, time_ms],
        )?;
        let stored = tx.query_row(
            "SELECT time_ms FROM read_markers WHERE account = ?1 AND target_fold = ?2",
            params![account, target_fold],
            |r| r.get(0),
        )?;
        tx.commit()?;
        Ok(stored)
    }

    /// All markers of an account as `(target_fold, target, time_ms)`.
    pub fn markers(&self, account: &str) -> StoreResult<Vec<(String, String, i64)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT target_fold, target, time_ms FROM read_markers WHERE account = ?1 \
             ORDER BY target_fold",
        )?;
        let rows = stmt.query_map(params![account], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}
