//! File claims. All times are Unix seconds.

use rusqlite::{params, OptionalExtension, Row};

use super::{Store, StoreResult};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ClaimRow {
    pub path: String,
    pub holder_account: String,
    pub holder_nick: String,
    pub since: i64,
    pub deadline: i64,
}

const CLAIM_COLS: &str = "path, holder_account, holder_nick, since, deadline";

fn claim_from_row(r: &Row<'_>) -> rusqlite::Result<ClaimRow> {
    Ok(ClaimRow {
        path: r.get(0)?,
        holder_account: r.get(1)?,
        holder_nick: r.get(2)?,
        since: r.get(3)?,
        deadline: r.get(4)?,
    })
}

impl Store {
    pub fn get_claim(&self, path: &str) -> StoreResult<Option<ClaimRow>> {
        let conn = self.conn.lock();
        let sql = format!("SELECT {CLAIM_COLS} FROM claims WHERE path = ?1");
        Ok(conn
            .query_row(&sql, params![path], claim_from_row)
            .optional()?)
    }

    /// Insert a claim, or replace the claim on the same path.
    pub fn put_claim(&self, claim: &ClaimRow) -> StoreResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO claims (path, holder_account, holder_nick, since, deadline) \
             VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(path) DO UPDATE SET holder_account = excluded.holder_account, \
               holder_nick = excluded.holder_nick, since = excluded.since, \
               deadline = excluded.deadline",
            params![
                claim.path,
                claim.holder_account,
                claim.holder_nick,
                claim.since,
                claim.deadline
            ],
        )?;
        Ok(())
    }

    /// Delete a claim. Returns `true` if it existed.
    pub fn delete_claim(&self, path: &str) -> StoreResult<bool> {
        let conn = self.conn.lock();
        let n = conn.execute("DELETE FROM claims WHERE path = ?1", params![path])?;
        Ok(n > 0)
    }

    /// All claims, ordered by path.
    pub fn claims(&self) -> StoreResult<Vec<ClaimRow>> {
        let conn = self.conn.lock();
        let sql = format!("SELECT {CLAIM_COLS} FROM claims ORDER BY path");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], claim_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn claims_of(&self, account: &str) -> StoreResult<Vec<ClaimRow>> {
        let conn = self.conn.lock();
        let sql =
            format!("SELECT {CLAIM_COLS} FROM claims WHERE holder_account = ?1 ORDER BY path");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![account], claim_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Claims with `deadline <= now`. This does not delete them.
    pub fn expired_claims(&self, now: i64) -> StoreResult<Vec<ClaimRow>> {
        let conn = self.conn.lock();
        let sql = format!("SELECT {CLAIM_COLS} FROM claims WHERE deadline <= ?1 ORDER BY path");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![now], claim_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Set the deadline of every claim of `account`. Returns the updated claims.
    pub fn refresh_claims_of(&self, account: &str, deadline: i64) -> StoreResult<Vec<ClaimRow>> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE claims SET deadline = ?2 WHERE holder_account = ?1",
            params![account, deadline],
        )?;
        let rows = {
            let sql =
                format!("SELECT {CLAIM_COLS} FROM claims WHERE holder_account = ?1 ORDER BY path");
            let mut stmt = tx.prepare(&sql)?;
            let it = stmt.query_map(params![account], claim_from_row)?;
            it.collect::<rusqlite::Result<Vec<_>>>()?
        };
        tx.commit()?;
        Ok(rows)
    }

    /// Update the holder nick on all claims of `account`.
    pub fn rename_holder(&self, account: &str, nick: &str) -> StoreResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE claims SET holder_nick = ?2 WHERE holder_account = ?1",
            params![account, nick],
        )?;
        Ok(())
    }
}
