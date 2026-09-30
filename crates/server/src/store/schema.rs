//! Schema migrations, based on `PRAGMA user_version`.

use rusqlite::Connection;

use super::StoreError;

/// Ordered migrations. Migration `i` moves `user_version` from `i` to `i + 1`.
/// Never edit an applied migration. Add a new one at the end.
pub(super) const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE accounts (
    account       TEXT PRIMARY KEY,
    nick          TEXT NOT NULL,
    nick_fold     TEXT NOT NULL UNIQUE,
    parent        TEXT NULL,
    owner         TEXT NOT NULL,
    role          TEXT NOT NULL,
    link          TEXT NULL,
    project       TEXT NULL,
    realname      TEXT NOT NULL DEFAULT '',
    created       INTEGER NOT NULL DEFAULT 0,
    last_activity INTEGER NOT NULL DEFAULT 0,
    retired       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE aliases (
    nick_fold TEXT PRIMARY KEY,
    nick      TEXT NOT NULL,
    account   TEXT NOT NULL REFERENCES accounts(account) ON DELETE CASCADE
);
CREATE INDEX aliases_account ON aliases(account);

CREATE TABLE channels (
    channel_fold  TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    topic         TEXT NULL,
    topic_set_by  TEXT NULL,
    topic_set_at  INTEGER NULL,
    created       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE memberships (
    account      TEXT NOT NULL,
    channel_fold TEXT NOT NULL,
    channel      TEXT NOT NULL,
    PRIMARY KEY (account, channel_fold)
);
CREATE INDEX memberships_channel ON memberships(channel_fold);

CREATE TABLE messages (
    seq            INTEGER PRIMARY KEY AUTOINCREMENT,
    msgid          TEXT NOT NULL UNIQUE,
    time_ms        INTEGER NOT NULL,
    sender_account TEXT NULL,
    sender_nick    TEXT NOT NULL DEFAULT '',
    sender_source  TEXT NOT NULL DEFAULT '',
    target         TEXT NOT NULL,
    target_fold    TEXT NOT NULL,
    is_channel     INTEGER NOT NULL DEFAULT 0,
    command        TEXT NOT NULL,
    tags           TEXT NOT NULL DEFAULT '',
    lines          TEXT NOT NULL DEFAULT '',
    multiline      INTEGER NOT NULL DEFAULT 0,
    dm_account     TEXT NULL
);
CREATE INDEX messages_target_time  ON messages(target_fold, time_ms);
CREATE INDEX messages_dm_time      ON messages(dm_account, time_ms);
CREATE INDEX messages_sender_time  ON messages(sender_account, time_ms);
CREATE INDEX messages_time         ON messages(time_ms);

CREATE TABLE recipients (
    seq     INTEGER NOT NULL REFERENCES messages(seq) ON DELETE CASCADE,
    account TEXT NOT NULL,
    PRIMARY KEY (account, seq)
);
CREATE INDEX recipients_seq ON recipients(seq);

CREATE TABLE cursors (
    account TEXT PRIMARY KEY,
    seq     INTEGER NOT NULL
);

CREATE TABLE read_markers (
    account     TEXT NOT NULL,
    target_fold TEXT NOT NULL,
    target      TEXT NOT NULL,
    time_ms     INTEGER NOT NULL,
    PRIMARY KEY (account, target_fold)
);

CREATE TABLE claims (
    path           TEXT PRIMARY KEY,
    holder_account TEXT NOT NULL,
    holder_nick    TEXT NOT NULL,
    since          INTEGER NOT NULL,
    deadline       INTEGER NOT NULL
);
CREATE INDEX claims_holder ON claims(holder_account);
"#];

/// Apply all pending migrations. Each one runs in its own transaction.
pub(super) fn migrate(conn: &mut Connection) -> Result<(), StoreError> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let total = MIGRATIONS.len() as i64;
    if current > total {
        return Err(StoreError::Migration(format!(
            "database schema version {current} is newer than supported version {total}"
        )));
    }
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)
            .map_err(|e| StoreError::Migration(format!("migration {}: {e}", i + 1)))?;
        // PRAGMA cannot take bound parameters. The value is an integer.
        tx.execute_batch(&format!("PRAGMA user_version = {}", i + 1))?;
        tx.commit()?;
    }
    Ok(())
}
