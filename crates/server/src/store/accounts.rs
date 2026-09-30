//! Accounts, aliases, memberships and channels.

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::{fold, now_ms, Store, StoreError, StoreResult};

/// One account. `created` and `last_activity` are Unix seconds.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AccountRow {
    pub account: String,
    pub nick: String,
    pub parent: Option<String>,
    pub owner: String,
    pub role: String,
    pub link: Option<String>,
    pub project: Option<String>,
    pub realname: String,
    pub created: i64,
    pub last_activity: i64,
}

/// One channel. `topic_set_at` and `created` are Unix seconds.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ChannelRow {
    pub fold: String,
    pub name: String,
    pub topic: Option<String>,
    pub topic_set_by: Option<String>,
    pub topic_set_at: Option<i64>,
    pub created: i64,
}

const ACCOUNT_COLS: &str =
    "account, nick, parent, owner, role, link, project, realname, created, last_activity";

fn account_from_row(r: &Row<'_>) -> rusqlite::Result<AccountRow> {
    Ok(AccountRow {
        account: r.get(0)?,
        nick: r.get(1)?,
        parent: r.get(2)?,
        owner: r.get(3)?,
        role: r.get(4)?,
        link: r.get(5)?,
        project: r.get(6)?,
        realname: r.get(7)?,
        created: r.get(8)?,
        last_activity: r.get(9)?,
    })
}

fn channel_from_row(r: &Row<'_>) -> rusqlite::Result<ChannelRow> {
    Ok(ChannelRow {
        fold: r.get(0)?,
        name: r.get(1)?,
        topic: r.get(2)?,
        topic_set_by: r.get(3)?,
        topic_set_at: r.get(4)?,
        created: r.get(5)?,
    })
}

/// True if `nick_fold` is the nick or an alias of an account other than `account`.
fn taken_by_other(conn: &Connection, nick_fold: &str, account: &str) -> rusqlite::Result<bool> {
    let by_nick = conn
        .query_row(
            "SELECT 1 FROM accounts WHERE nick_fold = ?1 AND account <> ?2",
            params![nick_fold, account],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if by_nick {
        return Ok(true);
    }
    Ok(conn
        .query_row(
            "SELECT 1 FROM aliases WHERE nick_fold = ?1 AND account <> ?2",
            params![nick_fold, account],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

pub(super) fn account_by_nick_conn(
    conn: &Connection,
    nick_fold: &str,
) -> rusqlite::Result<Option<AccountRow>> {
    let sql = format!("SELECT {ACCOUNT_COLS} FROM accounts WHERE nick_fold = ?1 AND retired = 0");
    if let Some(row) = conn
        .query_row(&sql, params![nick_fold], account_from_row)
        .optional()?
    {
        return Ok(Some(row));
    }
    let sql = format!(
        "SELECT {ACCOUNT_COLS} FROM accounts WHERE retired = 0 AND account = \
         (SELECT account FROM aliases WHERE nick_fold = ?1)"
    );
    conn.query_row(&sql, params![nick_fold], account_from_row)
        .optional()
}

impl Store {
    /// Insert an account, or update an existing one.
    ///
    /// On insert every field is stored. On update `nick` and `created` are NOT
    /// changed (use [`Store::set_nick`] to rename). Fails with
    /// `StoreError::Conflict` if the nick of a new account is taken.
    pub fn upsert_account(&self, row: &AccountRow) -> StoreResult<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let exists = tx
            .query_row(
                "SELECT 1 FROM accounts WHERE account = ?1",
                params![row.account],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if exists {
            tx.execute(
                "UPDATE accounts SET parent = ?2, owner = ?3, role = ?4, link = ?5, \
                 project = ?6, realname = ?7, last_activity = ?8 WHERE account = ?1",
                params![
                    row.account,
                    row.parent,
                    row.owner,
                    row.role,
                    row.link,
                    row.project,
                    row.realname,
                    row.last_activity
                ],
            )?;
        } else {
            let nick_fold = fold(&row.nick);
            if taken_by_other(&tx, &nick_fold, &row.account)? {
                return Err(StoreError::Conflict(format!(
                    "nick {} is already taken",
                    row.nick
                )));
            }
            tx.execute(
                "INSERT INTO accounts (account, nick, nick_fold, parent, owner, role, link, \
                 project, realname, created, last_activity) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    row.account,
                    row.nick,
                    nick_fold,
                    row.parent,
                    row.owner,
                    row.role,
                    row.link,
                    row.project,
                    row.realname,
                    row.created,
                    row.last_activity
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_account(&self, account: &str) -> StoreResult<Option<AccountRow>> {
        let conn = self.conn.lock();
        let sql = format!("SELECT {ACCOUNT_COLS} FROM accounts WHERE account = ?1 AND retired = 0");
        Ok(conn
            .query_row(&sql, params![account], account_from_row)
            .optional()?)
    }

    /// Find an account by folded nick. Checks current nicks, then aliases.
    pub fn account_by_nick(&self, nick_fold: &str) -> StoreResult<Option<AccountRow>> {
        let conn = self.conn.lock();
        Ok(account_by_nick_conn(&conn, nick_fold)?)
    }

    /// Rename an account. The old nick becomes an alias. If the new nick is an
    /// alias of the same account, that alias is removed. Returns `false` if the
    /// account does not exist. Fails with `Conflict` if another account owns
    /// the new nick or an alias of it.
    pub fn set_nick(&self, account: &str, nick: &str, nick_fold: &str) -> StoreResult<bool> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let old: Option<(String, String)> = tx
            .query_row(
                "SELECT nick, nick_fold FROM accounts WHERE account = ?1",
                params![account],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((old_nick, old_fold)) = old else {
            return Ok(false);
        };
        if taken_by_other(&tx, nick_fold, account)? {
            return Err(StoreError::Conflict(format!(
                "nick {nick} is already taken"
            )));
        }
        if old_fold != nick_fold {
            tx.execute(
                "DELETE FROM aliases WHERE nick_fold = ?1 AND account = ?2",
                params![nick_fold, account],
            )?;
            tx.execute(
                "INSERT OR REPLACE INTO aliases (nick_fold, nick, account) VALUES (?1, ?2, ?3)",
                params![old_fold, old_nick, account],
            )?;
        }
        tx.execute(
            "UPDATE accounts SET nick = ?2, nick_fold = ?3 WHERE account = ?1",
            params![account, nick, nick_fold],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Reserve `nick` as an alias of `account`. No-op if it is the current
    /// nick of the account. Fails with `Conflict` if another account owns it.
    pub fn add_alias(&self, account: &str, nick: &str, nick_fold: &str) -> StoreResult<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        if taken_by_other(&tx, nick_fold, account)? {
            return Err(StoreError::Conflict(format!(
                "nick {nick} is already taken"
            )));
        }
        let own = tx
            .query_row(
                "SELECT 1 FROM accounts WHERE account = ?1 AND nick_fold = ?2",
                params![account, nick_fold],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !own {
            tx.execute(
                "INSERT OR REPLACE INTO aliases (nick_fold, nick, account) VALUES (?1, ?2, ?3)",
                params![nick_fold, nick, account],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Aliases of an account (original case), oldest reservation order not guaranteed.
    pub fn aliases(&self, account: &str) -> StoreResult<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt =
            conn.prepare("SELECT nick FROM aliases WHERE account = ?1 ORDER BY nick_fold")?;
        let rows = stmt.query_map(params![account], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn set_link(&self, account: &str, link: Option<&str>) -> StoreResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE accounts SET link = ?2 WHERE account = ?1",
            params![account, link],
        )?;
        Ok(())
    }

    /// Record activity (Unix seconds).
    pub fn touch(&self, account: &str, now: i64) -> StoreResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE accounts SET last_activity = ?2 WHERE account = ?1",
            params![account, now],
        )?;
        Ok(())
    }

    /// Delete an account and everything that belongs to it: aliases,
    /// memberships, recipient rows, delivery cursor, read markers, held
    /// claims, and the DMs the account received. Returns `false` if the
    /// account did not exist.
    pub fn retire(&self, account: &str) -> StoreResult<bool> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM aliases WHERE account = ?1", params![account])?;
        tx.execute(
            "DELETE FROM memberships WHERE account = ?1",
            params![account],
        )?;
        tx.execute(
            "DELETE FROM recipients WHERE account = ?1",
            params![account],
        )?;
        tx.execute(
            "DELETE FROM messages WHERE is_channel = 0 AND dm_account = ?1",
            params![account],
        )?;
        tx.execute("DELETE FROM cursors WHERE account = ?1", params![account])?;
        tx.execute(
            "DELETE FROM read_markers WHERE account = ?1",
            params![account],
        )?;
        tx.execute(
            "DELETE FROM claims WHERE holder_account = ?1",
            params![account],
        )?;
        let n = tx.execute("DELETE FROM accounts WHERE account = ?1", params![account])?;
        tx.commit()?;
        Ok(n > 0)
    }

    /// All non-retired accounts, ordered by account id.
    pub fn list_accounts(&self) -> StoreResult<Vec<AccountRow>> {
        let conn = self.conn.lock();
        let sql = format!("SELECT {ACCOUNT_COLS} FROM accounts WHERE retired = 0 ORDER BY account");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], account_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Accounts whose last activity is strictly before `cutoff_unix` (seconds).
    pub fn inactive_since(&self, cutoff_unix: i64) -> StoreResult<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT account FROM accounts WHERE retired = 0 AND last_activity < ?1 \
             ORDER BY account",
        )?;
        let rows = stmt.query_map(params![cutoff_unix], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Replace all memberships of an account. Items are `(channel_fold, channel_name)`.
    pub fn set_memberships(&self, account: &str, channels: &[(String, String)]) -> StoreResult<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM memberships WHERE account = ?1",
            params![account],
        )?;
        for (channel_fold, channel) in channels {
            tx.execute(
                "INSERT OR REPLACE INTO memberships (account, channel_fold, channel) \
                 VALUES (?1, ?2, ?3)",
                params![account, channel_fold, channel],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn add_membership(
        &self,
        account: &str,
        channel_fold: &str,
        channel: &str,
    ) -> StoreResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO memberships (account, channel_fold, channel) \
             VALUES (?1, ?2, ?3)",
            params![account, channel_fold, channel],
        )?;
        Ok(())
    }

    pub fn remove_membership(&self, account: &str, channel_fold: &str) -> StoreResult<bool> {
        let conn = self.conn.lock();
        let n = conn.execute(
            "DELETE FROM memberships WHERE account = ?1 AND channel_fold = ?2",
            params![account, channel_fold],
        )?;
        Ok(n > 0)
    }

    /// Memberships of an account as `(channel_fold, channel_name)`.
    pub fn memberships(&self, account: &str) -> StoreResult<Vec<(String, String)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT channel_fold, channel FROM memberships WHERE account = ?1 \
             ORDER BY channel_fold",
        )?;
        let rows = stmt.query_map(params![account], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Accounts that are members of a channel.
    pub fn channel_members(&self, channel_fold: &str) -> StoreResult<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT account FROM memberships WHERE channel_fold = ?1 ORDER BY account")?;
        let rows = stmt.query_map(params![channel_fold], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // ---- channels ----

    /// Create a channel, or update its display name.
    pub fn upsert_channel(&self, fold: &str, name: &str) -> StoreResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO channels (channel_fold, name, created) VALUES (?1, ?2, ?3) \
             ON CONFLICT(channel_fold) DO UPDATE SET name = excluded.name",
            params![fold, name, now_ms() / 1000],
        )?;
        Ok(())
    }

    /// Set the topic of a channel. An empty topic clears it. `at` is Unix seconds.
    pub fn set_topic(&self, fold: &str, topic: &str, by: &str, at: i64) -> StoreResult<()> {
        let conn = self.conn.lock();
        let topic = if topic.is_empty() { None } else { Some(topic) };
        conn.execute(
            "UPDATE channels SET topic = ?2, topic_set_by = ?3, topic_set_at = ?4 \
             WHERE channel_fold = ?1",
            params![fold, topic, by, at],
        )?;
        Ok(())
    }

    pub fn get_channel(&self, fold: &str) -> StoreResult<Option<ChannelRow>> {
        let conn = self.conn.lock();
        Ok(conn
            .query_row(
                "SELECT channel_fold, name, topic, topic_set_by, topic_set_at, created \
                 FROM channels WHERE channel_fold = ?1",
                params![fold],
                channel_from_row,
            )
            .optional()?)
    }

    pub fn list_channels(&self) -> StoreResult<Vec<ChannelRow>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT channel_fold, name, topic, topic_set_by, topic_set_at, created \
             FROM channels ORDER BY channel_fold",
        )?;
        let rows = stmt.query_map([], channel_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}
