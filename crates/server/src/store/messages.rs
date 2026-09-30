//! Messages, recipients, delivery cursors and CHATHISTORY queries.
//!
//! History order is `(time_ms, seq)`. `seq` is strictly increasing and breaks
//! ties. All bounds are exclusive. All results are in ascending order.

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};

use super::accounts::account_by_nick_conn;
use super::{fold, Store, StoreResult};

/// Largest number of rows one history or replay call returns.
pub const MAX_HISTORY_LIMIT: usize = 1000;

/// A message to store.
///
/// `lines` never contain `\n`. For a DM, `dm_account` is the recipient
/// account and `sender_account` is the sender, so both parties can query it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NewMessage {
    pub msgid: String,
    pub time_ms: i64,
    pub sender_account: Option<String>,
    pub sender_nick: String,
    pub sender_source: String,
    /// Channel name, or recipient nick for a DM.
    pub target: String,
    pub is_channel: bool,
    /// `PRIVMSG`, `NOTICE` or `TAGMSG`.
    pub command: String,
    /// Serialized tag section without the leading `@`. May be empty.
    pub tags: String,
    pub lines: Vec<String>,
    pub dm_account: Option<String>,
}

/// A stored message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredMessage {
    pub seq: i64,
    pub msgid: String,
    pub time_ms: i64,
    pub sender_account: Option<String>,
    pub sender_nick: String,
    pub sender_source: String,
    pub target: String,
    pub is_channel: bool,
    pub command: String,
    pub tags: String,
    pub lines: Vec<String>,
}

/// A CHATHISTORY reference point.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Bound {
    MsgId(String),
    /// Unix milliseconds.
    Time(i64),
}

const MSG_COLS: &str = "seq, msgid, time_ms, sender_account, sender_nick, sender_source, \
                        target, is_channel, command, tags, lines";

fn message_from_row(r: &Row<'_>) -> rusqlite::Result<StoredMessage> {
    let lines_text: String = r.get(10)?;
    let lines = if lines_text.is_empty() {
        Vec::new()
    } else {
        lines_text.split('\n').map(str::to_owned).collect()
    };
    Ok(StoredMessage {
        seq: r.get(0)?,
        msgid: r.get(1)?,
        time_ms: r.get(2)?,
        sender_account: r.get(3)?,
        sender_nick: r.get(4)?,
        sender_source: r.get(5)?,
        target: r.get(6)?,
        is_channel: r.get::<_, i64>(7)? != 0,
        command: r.get(8)?,
        tags: r.get(9)?,
        lines,
    })
}

fn clamp_limit(limit: usize) -> i64 {
    limit.min(MAX_HISTORY_LIMIT) as i64
}

fn looks_like_channel(fold: &str) -> bool {
    fold.starts_with('#') || fold.starts_with('&')
}

/// Sort key `(time_ms, seq)` of a bound. `lower` selects the sentinel for a
/// time bound so that the comparison is exclusive on time alone. `None`
/// means the message id is unknown.
fn resolve_bound(
    conn: &Connection,
    bound: &Bound,
    lower: bool,
) -> rusqlite::Result<Option<(i64, i64)>> {
    match bound {
        Bound::Time(t) => Ok(Some((*t, if lower { i64::MAX } else { i64::MIN }))),
        Bound::MsgId(id) => conn
            .query_row(
                "SELECT time_ms, seq FROM messages WHERE msgid = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional(),
    }
}

impl Store {
    /// Store a message and the accounts that receive it. Returns the stored
    /// form with its new `seq`. A duplicate `msgid` is an error.
    pub fn insert_message(
        &self,
        msg: &NewMessage,
        recipients: &[String],
    ) -> StoreResult<StoredMessage> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let lines_text = msg.lines.join("\n");
        tx.execute(
            "INSERT INTO messages (msgid, time_ms, sender_account, sender_nick, sender_source, \
             target, target_fold, is_channel, command, tags, lines, multiline, dm_account) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                msg.msgid,
                msg.time_ms,
                msg.sender_account,
                msg.sender_nick,
                msg.sender_source,
                msg.target,
                fold(&msg.target),
                msg.is_channel as i64,
                msg.command,
                msg.tags,
                lines_text,
                (msg.lines.len() > 1) as i64,
                msg.dm_account,
            ],
        )?;
        let seq = tx.last_insert_rowid();
        {
            let mut stmt =
                tx.prepare("INSERT OR IGNORE INTO recipients (seq, account) VALUES (?1, ?2)")?;
            for account in recipients {
                stmt.execute(params![seq, account])?;
            }
        }
        tx.commit()?;
        Ok(StoredMessage {
            seq,
            msgid: msg.msgid.clone(),
            time_ms: msg.time_ms,
            sender_account: msg.sender_account.clone(),
            sender_nick: msg.sender_nick.clone(),
            sender_source: msg.sender_source.clone(),
            target: msg.target.clone(),
            is_channel: msg.is_channel,
            command: msg.command.clone(),
            tags: msg.tags.clone(),
            lines: msg.lines.clone(),
        })
    }

    pub fn message_by_msgid(&self, msgid: &str) -> StoreResult<Option<StoredMessage>> {
        let conn = self.conn.lock();
        let sql = format!("SELECT {MSG_COLS} FROM messages WHERE msgid = ?1");
        Ok(conn
            .query_row(&sql, params![msgid], message_from_row)
            .optional()?)
    }

    /// Messages that `account` received with `seq > after_seq`, ascending by
    /// `seq`. Use [`Store::get_cursor`] for `after_seq`.
    pub fn replay_for(
        &self,
        account: &str,
        after_seq: i64,
        limit: usize,
    ) -> StoreResult<Vec<StoredMessage>> {
        let conn = self.conn.lock();
        let sql = "SELECT m.seq, m.msgid, m.time_ms, m.sender_account, m.sender_nick, \
                   m.sender_source, m.target, m.is_channel, m.command, m.tags, m.lines \
                   FROM recipients r JOIN messages m ON m.seq = r.seq \
                   WHERE r.account = ?1 AND r.seq > ?2 ORDER BY r.seq ASC LIMIT ?3";
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(
            params![account, after_seq, limit.min(MAX_HISTORY_LIMIT) as i64],
            message_from_row,
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Delivery cursor of an account. 0 when there is none.
    pub fn get_cursor(&self, account: &str) -> StoreResult<i64> {
        let conn = self.conn.lock();
        Ok(conn
            .query_row(
                "SELECT seq FROM cursors WHERE account = ?1",
                params![account],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0))
    }

    /// Move the delivery cursor forward. A lower value is ignored.
    pub fn set_cursor(&self, account: &str, seq: i64) -> StoreResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO cursors (account, seq) VALUES (?1, ?2) \
             ON CONFLICT(account) DO UPDATE SET seq = MAX(cursors.seq, excluded.seq)",
            params![account, seq],
        )?;
        Ok(())
    }

    // ---- CHATHISTORY ----

    /// Core history query. `lo` and `hi` are exclusive `(time_ms, seq)` keys.
    /// `newest` picks the newest `limit` rows of the window. Output is ascending.
    fn history_query(
        conn: &Connection,
        account: &str,
        target_fold: &str,
        lo: Option<(i64, i64)>,
        hi: Option<(i64, i64)>,
        limit: usize,
        newest: bool,
    ) -> StoreResult<Vec<StoredMessage>> {
        let limit = clamp_limit(limit);
        if limit == 0 {
            return Ok(Vec::new());
        }
        // ?1 account, ?2 target fold, ?3 other account.
        let mut other: Option<String> = None;
        let vis = if looks_like_channel(target_fold) {
            "is_channel = 1 AND target_fold = ?2"
        } else if let Some(o) = account_by_nick_conn(conn, target_fold)? {
            other = Some(o.account);
            "is_channel = 0 AND ((sender_account = ?1 AND dm_account = ?3) \
             OR (sender_account = ?3 AND dm_account = ?1))"
        } else {
            "is_channel = 0 AND target_fold = ?2 AND (sender_account = ?1 OR dm_account = ?1)"
        };
        let order = if newest { "DESC" } else { "ASC" };
        let sql = format!(
            "SELECT {MSG_COLS} FROM messages WHERE {vis} \
             AND (?4 IS NULL OR (time_ms, seq) > (?4, ?5)) \
             AND (?6 IS NULL OR (time_ms, seq) < (?6, ?7)) \
             ORDER BY time_ms {order}, seq {order} LIMIT ?8"
        );
        let null = Value::Null;
        let vals: Vec<Value> = vec![
            Value::Text(account.to_owned()),
            Value::Text(target_fold.to_owned()),
            other.map(Value::Text).unwrap_or_else(|| null.clone()),
            lo.map(|k| Value::Integer(k.0))
                .unwrap_or_else(|| null.clone()),
            lo.map(|k| Value::Integer(k.1))
                .unwrap_or_else(|| null.clone()),
            hi.map(|k| Value::Integer(k.0))
                .unwrap_or_else(|| null.clone()),
            hi.map(|k| Value::Integer(k.1)).unwrap_or(null),
            Value::Integer(limit),
        ];
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(vals.iter()), message_from_row)?;
        let mut out = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        if newest {
            out.reverse();
        }
        Ok(out)
    }

    /// The newest `limit` messages, or the newest `limit` after `bound`.
    pub fn history_latest(
        &self,
        account: &str,
        target_fold: &str,
        bound: Option<Bound>,
        limit: usize,
    ) -> StoreResult<Vec<StoredMessage>> {
        let conn = self.conn.lock();
        let lo = match &bound {
            None => None,
            Some(b) => match resolve_bound(&conn, b, true)? {
                Some(k) => Some(k),
                None => return Ok(Vec::new()),
            },
        };
        Self::history_query(&conn, account, target_fold, lo, None, limit, true)
    }

    /// The newest `limit` messages before `bound`.
    pub fn history_before(
        &self,
        account: &str,
        target_fold: &str,
        bound: Bound,
        limit: usize,
    ) -> StoreResult<Vec<StoredMessage>> {
        let conn = self.conn.lock();
        let Some(hi) = resolve_bound(&conn, &bound, false)? else {
            return Ok(Vec::new());
        };
        Self::history_query(&conn, account, target_fold, None, Some(hi), limit, true)
    }

    /// The oldest `limit` messages after `bound`.
    pub fn history_after(
        &self,
        account: &str,
        target_fold: &str,
        bound: Bound,
        limit: usize,
    ) -> StoreResult<Vec<StoredMessage>> {
        let conn = self.conn.lock();
        let Some(lo) = resolve_bound(&conn, &bound, true)? else {
            return Ok(Vec::new());
        };
        Self::history_query(&conn, account, target_fold, Some(lo), None, limit, false)
    }

    /// Messages strictly between `a` and `b`, ascending. If `a` is the older
    /// bound, the oldest `limit` are returned. If `a` is the newer bound, the
    /// newest `limit` (nearest to `a`) are returned.
    pub fn history_between(
        &self,
        account: &str,
        target_fold: &str,
        a: Bound,
        b: Bound,
        limit: usize,
    ) -> StoreResult<Vec<StoredMessage>> {
        let conn = self.conn.lock();
        let (Some(ka), Some(kb)) = (
            resolve_bound(&conn, &a, true)?,
            resolve_bound(&conn, &b, true)?,
        ) else {
            return Ok(Vec::new());
        };
        // Recompute with the right sentinel for each side.
        let (lo_bound, hi_bound, newest) = if ka <= kb {
            (&a, &b, false)
        } else {
            (&b, &a, true)
        };
        let (Some(lo), Some(hi)) = (
            resolve_bound(&conn, lo_bound, true)?,
            resolve_bound(&conn, hi_bound, false)?,
        ) else {
            return Ok(Vec::new());
        };
        Self::history_query(
            &conn,
            account,
            target_fold,
            Some(lo),
            Some(hi),
            limit,
            newest,
        )
    }

    /// Conversations of `account` with activity strictly between `from_ms`
    /// and `to_ms` (either order). Items are `(target, latest_ms)` in
    /// ascending order of `latest_ms`. Channels come from the memberships of
    /// the account. DM targets are the current nick of the other party.
    pub fn history_targets(
        &self,
        account: &str,
        from_ms: i64,
        to_ms: i64,
        limit: usize,
    ) -> StoreResult<Vec<(String, i64)>> {
        let limit = clamp_limit(limit) as usize;
        let (from_ms, to_ms) = if from_ms <= to_ms {
            (from_ms, to_ms)
        } else {
            (to_ms, from_ms)
        };
        let conn = self.conn.lock();
        let mut out: Vec<(String, i64)> = Vec::new();

        let mut stmt = conn.prepare(
            "SELECT target, MAX(time_ms) FROM messages \
             WHERE is_channel = 1 \
             AND target_fold IN (SELECT channel_fold FROM memberships WHERE account = ?1) \
             AND time_ms > ?2 AND time_ms < ?3 GROUP BY target_fold",
        )?;
        let rows = stmt.query_map(params![account, from_ms, to_ms], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        for row in rows {
            out.push(row?);
        }

        let mut stmt = conn.prepare(
            "SELECT peer, MAX(time_ms) FROM ( \
               SELECT CASE WHEN sender_account = ?1 THEN dm_account ELSE sender_account END AS peer, \
                      time_ms \
               FROM messages \
               WHERE is_channel = 0 AND (sender_account = ?1 OR dm_account = ?1) \
               AND time_ms > ?2 AND time_ms < ?3) \
             WHERE peer IS NOT NULL GROUP BY peer",
        )?;
        let rows = stmt.query_map(params![account, from_ms, to_ms], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        let peers = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        for (peer, latest) in peers {
            let nick: Option<String> = conn
                .query_row(
                    "SELECT nick FROM accounts WHERE account = ?1 AND retired = 0",
                    params![peer],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(nick) = nick {
                out.push((nick, latest));
            }
        }

        out.sort_by(|x, y| x.1.cmp(&y.1).then_with(|| x.0.cmp(&y.0)));
        if out.len() > limit {
            out.drain(..out.len() - limit);
        }
        Ok(out)
    }

    /// Delete messages older than `cutoff_ms` (exclusive). Recipient rows go
    /// with them. Returns the number of messages deleted.
    pub fn purge_older_than(&self, cutoff_ms: i64) -> StoreResult<usize> {
        let conn = self.conn.lock();
        Ok(conn.execute(
            "DELETE FROM messages WHERE time_ms < ?1",
            params![cutoff_ms],
        )?)
    }

    /// Unread messages per target for `account`, from its recipient rows
    /// against its read markers. Items are `(target, count, last_msgid)`.
    /// For a DM, the target is the nick of the sender. Only PRIVMSG and
    /// NOTICE count. Messages the account sent itself do not count.
    pub fn unread_counts(&self, account: &str) -> StoreResult<Vec<(String, i64, Option<String>)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT CASE WHEN m.is_channel = 1 THEN m.target ELSE m.sender_nick END AS tgt, \
                    COUNT(*), m.msgid, MAX(m.seq) \
             FROM recipients r \
             JOIN messages m ON m.seq = r.seq \
             LEFT JOIN read_markers rm ON rm.account = r.account AND rm.target_fold = \
                  (CASE WHEN m.is_channel = 1 THEN m.target_fold ELSE lower(m.sender_nick) END) \
             WHERE r.account = ?1 \
               AND m.command IN ('PRIVMSG', 'NOTICE') \
               AND (m.sender_account IS NULL OR m.sender_account <> ?1) \
               AND m.time_ms > COALESCE(rm.time_ms, -1) \
             GROUP BY (CASE WHEN m.is_channel = 1 THEN m.target_fold ELSE lower(m.sender_nick) END) \
             ORDER BY tgt",
        )?;
        let rows = stmt.query_map(params![account], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}
