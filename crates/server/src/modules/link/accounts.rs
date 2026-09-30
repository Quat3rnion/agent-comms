//! INTRODUCE, RENAME, RETIRE, STATE (docs/link-protocol.md section 6), family
//! channels, restore after a server restart, dormant presence, membership
//! persistence, and inactivity retirement.

use super::{LinkCtx, LinkPhase, LinkShared};
use crate::module::Cx;
use crate::ops;
use crate::state::{SharedState, World};
use crate::store::{AccountRow, Store};
use crate::user::{LinkHandle, Role, Sink, UserId};
use crate::util::{fold, unix_now, valid_channel, valid_nick};
use agent_comms_proto::Message;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const INACTIVITY_CHECK_EVERY: Duration = Duration::from_secs(3600);

/// Link verbs of this file: INTRODUCE, RENAME, RETIRE, STATE.
pub fn handle(shared: &Arc<LinkShared>, state: &SharedState, ctx: &mut LinkCtx, msg: &Message) {
    match msg.command_upper().as_str() {
        "INTRODUCE" => introduce(shared, state, ctx, msg),
        "RENAME" => rename(shared, state, ctx, msg),
        "RETIRE" => retire(shared, state, ctx, msg),
        "STATE" => set_state(shared, state, ctx, msg),
        _ => ctx.fail(msg, "UNKNOWN_COMMAND", &[], "Unknown command"),
    }
}

/// Record activity of an account (INTRODUCE, STATE, SEND, CLAIM).
pub fn touch(shared: &LinkShared, account: &str) {
    if let Some(store) = shared.hub.store() {
        if let Err(e) = store.touch(account, unix_now()) {
            tracing::warn!("store touch failed for {account}: {e}");
        }
    }
}

// ---------------------------------------------------------------------------
// Validation helpers

fn valid_account(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn valid_project(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn is_operator_account(state: &SharedState, account: &str) -> bool {
    let f = fold(account);
    if f == "operator" {
        return true;
    }
    state
        .secrets
        .read()
        .operator
        .as_ref()
        .is_some_and(|o| fold(&o.account) == f)
}

// ---------------------------------------------------------------------------
// World helpers

/// True when `nick` is free for `me` (not used as nick or alias by another user).
fn nick_free(world: &World, nick: &str, me: Option<UserId>) -> bool {
    let f = fold(nick);
    let by_nick = world.nicks.get(&f).copied();
    let by_alias = world.aliases.get(&f).copied();
    by_nick.is_none_or(|u| Some(u) == me) && by_alias.is_none_or(|u| Some(u) == me)
}

/// The wanted nick, or the nick with a `-2`, `-3`, ... suffix (section 6.1).
fn assign_nick(world: &World, wanted: &str, max: usize, me: Option<UserId>) -> String {
    if nick_free(world, wanted, me) {
        return wanted.to_string();
    }
    let mut i: u64 = 2;
    loop {
        let suffix = format!("-{i}");
        let keep = max.saturating_sub(suffix.len()).max(1);
        let base: String = wanted.chars().take(keep).collect();
        let candidate = format!("{base}{suffix}");
        if nick_free(world, &candidate, me) {
            return candidate;
        }
        i += 1;
    }
}

fn set_sink_link(world: &mut World, uid: UserId, handle: Option<LinkHandle>) {
    if let Some(u) = world.user_mut(uid) {
        if let Sink::Virtual { link, .. } = &mut u.sink {
            *link = handle;
        }
    }
}

fn virtual_account(world: &World, uid: UserId) -> Option<String> {
    match &world.user(uid)?.sink {
        Sink::Virtual { account, .. } => Some(account.clone()),
        Sink::Socket(_) => None,
    }
}

fn account_of(world: &World, uid: UserId) -> Option<String> {
    world.user(uid).and_then(|u| u.account.clone())
}

/// Project of each account when no store is configured (key: shared pointer
/// and folded account).
fn project_memo() -> &'static parking_lot::Mutex<HashMap<(usize, String), String>> {
    static MEMO: OnceLock<parking_lot::Mutex<HashMap<(usize, String), String>>> = OnceLock::new();
    MEMO.get_or_init(|| parking_lot::Mutex::new(HashMap::new()))
}

fn memo_key(shared: &LinkShared, account: &str) -> (usize, String) {
    (shared as *const LinkShared as usize, fold(account))
}

/// Rename `uid` to `wanted` (or a free variant), keep the old nick as an alias,
/// persist, and move the family channel. Returns the assigned nick.
fn apply_rename(
    cx: &mut Cx<'_>,
    store: Option<&Arc<Store>>,
    uid: UserId,
    account: &str,
    wanted: &str,
) -> String {
    let Some(old) = cx.world.user(uid).map(|u| u.nick.clone()) else {
        return wanted.to_string();
    };
    if old == wanted {
        return old;
    }
    let max = cx.state.config.limits.nick_max_len;
    let new = if fold(&old) == fold(wanted) {
        wanted.to_string()
    } else {
        assign_nick(cx.world, wanted, max, Some(uid))
    };
    if let Err(e) = ops::rename(cx, uid, &new) {
        tracing::warn!("rename of {account} to {new} failed: {e}");
        return old;
    }
    let old_fold = fold(&old);
    let new_fold = fold(&new);
    if old_fold != new_fold {
        cx.world.add_alias(uid, &old);
    }
    if cx.world.aliases.get(&new_fold) == Some(&uid) {
        cx.world.aliases.remove(&new_fold);
    }
    if let Some(store) = store {
        // set_nick also moves the old nick into the aliases.
        if let Err(e) = store.set_nick(account, &new, &new_fold) {
            tracing::warn!("store set_nick failed for {account}: {e}");
        }
    }
    if old_fold != new_fold {
        move_family_channel(cx, uid, &old, &new);
    }
    new
}

/// Section 6.5: move the family channel `#<old>` to `#<new>`.
fn move_family_channel(cx: &mut Cx<'_>, uid: UserId, old: &str, new: &str) {
    let children: Vec<UserId> = cx
        .world
        .users
        .values()
        .filter(|u| u.parent == Some(uid))
        .map(|u| u.id)
        .collect();
    if children.is_empty() {
        return;
    }
    let old_chan = format!("#{old}");
    let new_chan = format!("#{new}");
    if !valid_channel(&new_chan) {
        return;
    }
    let mut members = cx.world.channel_members(&fold(&old_chan));
    if members.is_empty() {
        members.push(uid);
        members.extend(children);
    }
    // The parent joins first, so it becomes the channel operator.
    members.sort_by_key(|m| (*m != uid, *m));
    for m in &members {
        ops::join(cx, *m, &new_chan, true);
    }
    for m in &members {
        ops::part(cx, *m, &old_chan, Some("renamed"));
    }
}

fn call_nick_extensions(shared: &LinkShared, state: &SharedState, account: &str, nick: &str) {
    for ext in shared.hub.extensions() {
        ext.on_account_nick(state, account, nick);
    }
}

// ---------------------------------------------------------------------------
// INTRODUCE

enum Introduced {
    Ok {
        /// Account ID in the case of the first introduction.
        canonical: String,
        nick: String,
    },
    Fail(&'static str, &'static str),
}

fn introduce(shared: &Arc<LinkShared>, state: &SharedState, ctx: &mut LinkCtx, msg: &Message) {
    if msg.params.len() < 6 {
        let ctxp: Vec<&str> = msg.param(0).into_iter().collect();
        ctx.fail(msg, "INVALID_PARAMS", &ctxp, "Not enough parameters");
        return;
    }
    let account = msg.params[0].as_str();
    let wanted = msg.params[1].as_str();
    let parent = msg.params[2].as_str();
    let owner = msg.params[3].as_str();
    let role = msg.params[4].as_str();
    let project = msg.params[5].as_str();
    let realname = msg.param(6).unwrap_or("");
    let max = state.config.limits.nick_max_len;

    if !valid_account(account) {
        ctx.fail(msg, "INVALID_ACCOUNT", &[account], "Invalid account ID");
        return;
    }
    if is_operator_account(state, account) {
        ctx.fail(
            msg,
            "ACCOUNT_OWNED_BY_OPERATOR",
            &[account],
            "Account belongs to the operator",
        );
        return;
    }
    if role != "agent" {
        ctx.fail(msg, "INVALID_ROLE", &[account], "Role must be agent");
        return;
    }
    if owner != ctx.entry.owner {
        ctx.fail(
            msg,
            "OWNER_MISMATCH",
            &[account],
            "Owner is not the owner of the link credential",
        );
        return;
    }
    if !valid_project(project) {
        ctx.fail(msg, "INVALID_PROJECT", &[account], "Invalid project slug");
        return;
    }
    if !valid_nick(wanted, max) {
        ctx.fail(msg, "ERRONEUS_NICK", &[account], "Erroneous nickname");
        return;
    }

    restore(shared, state);

    let key = fold(account);
    let link_name = ctx.entry.name.clone();
    let handle = ctx.entry.handle.clone();
    let established = ctx.phase == LinkPhase::Established;
    let store = shared.hub.store().cloned();
    let prev_owner = shared.owners.lock().get(&key).cloned();
    let memo = project_memo()
        .lock()
        .get(&memo_key(shared, account))
        .cloned();

    let outcome = state.with_world(|cx| match cx.world.find_account(account) {
        None => introduce_new(
            cx,
            store.as_ref(),
            account,
            wanted,
            parent,
            owner,
            project,
            realname,
            &link_name,
            established.then(|| handle.clone()),
        ),
        Some(uid) => introduce_existing(
            cx,
            store.as_ref(),
            uid,
            account,
            wanted,
            parent,
            owner,
            project,
            realname,
            &link_name,
            memo.clone(),
            established.then(|| handle.clone()),
        ),
    });

    let (canonical, nick) = match outcome {
        Introduced::Ok { canonical, nick } => (canonical, nick),
        Introduced::Fail(code, text) => {
            ctx.fail(msg, code, &[account], text);
            return;
        }
    };

    shared.owners.lock().insert(key.clone(), link_name.clone());
    project_memo()
        .lock()
        .insert(memo_key(shared, account), project.to_string());
    if let Some(old) = prev_owner.filter(|o| *o != link_name) {
        shared
            .hub
            .send(&old, &Message::new("DISOWN", vec![canonical.clone()]));
    }
    touch(shared, &canonical);

    ctx.reply(
        msg,
        Message::new("INTRODUCED", vec![account.to_string(), nick.clone()]),
    );
    if !ctx.accounts.iter().any(|a| fold(a) == key) {
        ctx.accounts.push(account.to_string());
    }
    call_nick_extensions(shared, state, &canonical, &nick);
}

#[expect(clippy::too_many_arguments, reason = "INTRODUCE has many parameters")]
fn introduce_new(
    cx: &mut Cx<'_>,
    store: Option<&Arc<Store>>,
    account: &str,
    wanted: &str,
    parent: &str,
    owner: &str,
    project: &str,
    realname: &str,
    link_name: &str,
    handle: Option<LinkHandle>,
) -> Introduced {
    let parent_uid = if parent == "*" {
        None
    } else {
        match cx.world.find_account(parent) {
            Some(p) => Some(p),
            None => return Introduced::Fail("INVALID_PARENT", "Parent account does not exist"),
        }
    };
    let max = cx.state.config.limits.nick_max_len;
    let nick = assign_nick(cx.world, wanted, max, None);
    let uid = cx.world.create_virtual_user(
        account,
        &nick,
        realname,
        Role::Agent,
        parent_uid,
        Some(owner.to_string()),
        handle,
    );
    ops::set_away(cx, uid, Some("idle".to_string()));

    if let Some(store) = store {
        let now = unix_now();
        let row = AccountRow {
            account: account.to_string(),
            nick: nick.clone(),
            parent: parent_uid.and_then(|p| account_of(cx.world, p)),
            owner: owner.to_string(),
            role: Role::Agent.as_str().to_string(),
            link: Some(link_name.to_string()),
            project: Some(project.to_string()),
            realname: realname.to_string(),
            created: now,
            last_activity: now,
        };
        if let Err(e) = store.upsert_account(&row) {
            tracing::warn!("store upsert_account failed for {account}: {e}");
        }
    }

    ops::join(cx, uid, "#lobby", false);
    let project_chan = format!("#{project}");
    ops::join(cx, uid, &project_chan, false);
    if let Some(p) = parent_uid {
        if let Some(pnick) = cx.world.user(p).map(|u| u.nick.clone()) {
            let family = format!("#{pnick}");
            if valid_channel(&family) {
                ops::join(cx, p, &family, false);
                ops::join(cx, uid, &family, false);
            }
        }
    }
    Introduced::Ok {
        canonical: account.to_string(),
        nick,
    }
}

#[expect(clippy::too_many_arguments, reason = "INTRODUCE has many parameters")]
fn introduce_existing(
    cx: &mut Cx<'_>,
    store: Option<&Arc<Store>>,
    uid: UserId,
    account: &str,
    wanted: &str,
    parent: &str,
    owner: &str,
    project: &str,
    realname: &str,
    link_name: &str,
    memo_project: Option<String>,
    handle: Option<LinkHandle>,
) -> Introduced {
    let Some(u) = cx.world.user(uid) else {
        return Introduced::Fail("UNKNOWN_ACCOUNT", "No such account");
    };
    if u.owner.as_deref().is_some_and(|o| o != owner) {
        return Introduced::Fail("OWNER_MISMATCH", "Account belongs to another owner");
    }
    let canonical = account_of(cx.world, uid).unwrap_or_else(|| account.to_string());
    let cur_parent = u.parent;
    let cur_parent_account = cur_parent.and_then(|p| account_of(cx.world, p));
    let parent_ok = match (parent, cur_parent) {
        ("*", None) => true,
        ("*", Some(_)) => false,
        (_, None) => false,
        // A retired parent no longer resolves; accept the stored relation.
        (p, Some(_)) => cur_parent_account
            .as_deref()
            .is_none_or(|c| fold(c) == fold(p)),
    };
    if !parent_ok {
        return Introduced::Fail("PARENT_MISMATCH", "Account exists with another parent");
    }

    let row = store.and_then(|s| match s.get_account(&canonical) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("store get_account failed for {canonical}: {e}");
            None
        }
    });

    // Detach until the server burst of this link attaches the handle, or
    // attach now when the link is already established.
    set_sink_link(cx.world, uid, handle);

    let nick = apply_rename(cx, store, uid, &canonical, wanted);
    if let Some(u) = cx.world.user_mut(uid) {
        u.realname = realname.to_string();
    }
    if cx
        .world
        .user(uid)
        .is_some_and(|u| u.away.as_deref() == Some("dormant"))
    {
        ops::set_away(cx, uid, Some("idle".to_string()));
    }

    let old_project = row
        .as_ref()
        .and_then(|r| r.project.clone())
        .or(memo_project);
    let new_chan = format!("#{project}");
    match old_project {
        Some(old) if old == project => {}
        Some(old) => {
            ops::part(cx, uid, &format!("#{old}"), Some("moved"));
            ops::join(cx, uid, &new_chan, false);
        }
        None => {
            ops::join(cx, uid, &new_chan, false);
        }
    }

    if let Some(store) = store {
        let now = unix_now();
        let new_row = AccountRow {
            account: canonical.clone(),
            nick: nick.clone(),
            parent: row
                .as_ref()
                .and_then(|r| r.parent.clone())
                .or(cur_parent_account),
            owner: owner.to_string(),
            role: Role::Agent.as_str().to_string(),
            link: Some(link_name.to_string()),
            project: Some(project.to_string()),
            realname: realname.to_string(),
            created: row.as_ref().map(|r| r.created).unwrap_or(now),
            last_activity: now,
        };
        if let Err(e) = store.upsert_account(&new_row) {
            tracing::warn!("store upsert_account failed for {canonical}: {e}");
        }
    }
    Introduced::Ok { canonical, nick }
}

// ---------------------------------------------------------------------------
// RENAME

fn rename(shared: &Arc<LinkShared>, state: &SharedState, ctx: &mut LinkCtx, msg: &Message) {
    let (Some(account), Some(wanted)) = (msg.param(0), msg.param(1)) else {
        let ctxp: Vec<&str> = msg.param(0).into_iter().collect();
        ctx.fail(msg, "INVALID_PARAMS", &ctxp, "Not enough parameters");
        return;
    };
    if !ctx.owns(shared, account) {
        ctx.fail(
            msg,
            "UNKNOWN_ACCOUNT",
            &[account],
            "No such account on this link",
        );
        return;
    }
    if !valid_nick(wanted, state.config.limits.nick_max_len) {
        ctx.fail(msg, "ERRONEUS_NICK", &[account], "Erroneous nickname");
        return;
    }
    let store = shared.hub.store().cloned();
    let done = state.with_world(|cx| {
        let uid = cx.world.find_account(account)?;
        let canonical = account_of(cx.world, uid).unwrap_or_else(|| account.to_string());
        let nick = apply_rename(cx, store.as_ref(), uid, &canonical, wanted);
        Some((canonical, nick))
    });
    let Some((canonical, nick)) = done else {
        ctx.fail(
            msg,
            "UNKNOWN_ACCOUNT",
            &[account],
            "No such account on this link",
        );
        return;
    };
    ctx.reply(
        msg,
        Message::new("RENAMED", vec![account.to_string(), nick.clone()]),
    );
    call_nick_extensions(shared, state, &canonical, &nick);
}

// ---------------------------------------------------------------------------
// RETIRE

fn retire(shared: &Arc<LinkShared>, state: &SharedState, ctx: &mut LinkCtx, msg: &Message) {
    let Some(account) = msg.param(0) else {
        ctx.fail(msg, "INVALID_PARAMS", &[], "Not enough parameters");
        return;
    };
    if !ctx.owns(shared, account) {
        ctx.fail(
            msg,
            "UNKNOWN_ACCOUNT",
            &[account],
            "No such account on this link",
        );
        return;
    }
    let reason = msg.param(1).filter(|r| !r.is_empty()).unwrap_or("retired");
    retire_account(shared, state, account, reason);
    let key = fold(account);
    ctx.accounts.retain(|a| fold(a) != key);
    ctx.reply(msg, Message::new("RETIRED", vec![account.to_string()]));
}

/// Retire an account (section 6.6). Children are not retired. Returns false
/// when the account was not known.
pub fn retire_account(
    shared: &Arc<LinkShared>,
    state: &SharedState,
    account: &str,
    reason: &str,
) -> bool {
    let key = fold(account);
    let in_world = state.with_world(|cx| {
        let uid = cx.world.find_account(account)?;
        let canonical = account_of(cx.world, uid).unwrap_or_else(|| account.to_string());
        ops::quit(cx, uid, reason);
        cx.world.remove_aliases(uid);
        cx.world.accounts.remove(&key);
        Some(canonical)
    });
    let canonical = in_world.clone().unwrap_or_else(|| account.to_string());
    let owned = shared.owners.lock().remove(&key).is_some();
    project_memo().lock().remove(&memo_key(shared, account));
    // Extensions first: the claims module must see (and announce) the claims
    // before the store deletes them with the account.
    if in_world.is_some() || owned {
        for ext in shared.hub.extensions() {
            ext.on_account_retired(state, &canonical);
        }
    }
    let stored = match shared.hub.store() {
        Some(store) => match store.retire(&canonical) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!("store retire failed for {canonical}: {e}");
                false
            }
        },
        None => false,
    };
    in_world.is_some() || owned || stored
}

// ---------------------------------------------------------------------------
// STATE

fn set_state(shared: &Arc<LinkShared>, state: &SharedState, ctx: &mut LinkCtx, msg: &Message) {
    let (Some(account), Some(value)) = (msg.param(0), msg.param(1)) else {
        let ctxp: Vec<&str> = msg.param(0).into_iter().collect();
        ctx.fail(msg, "INVALID_PARAMS", &ctxp, "Not enough parameters");
        return;
    };
    if !ctx.owns(shared, account) {
        ctx.fail(
            msg,
            "UNKNOWN_ACCOUNT",
            &[account],
            "No such account on this link",
        );
        return;
    }
    let busy = match value {
        "busy" => true,
        "idle" => false,
        _ => {
            ctx.fail(
                msg,
                "INVALID_STATE",
                &[account],
                "State must be busy or idle",
            );
            return;
        }
    };
    let canonical = state.with_world(|cx| {
        let uid = cx.world.find_account(account)?;
        let away = (!busy).then(|| "idle".to_string());
        if cx.world.user(uid).is_some_and(|u| u.away != away) {
            ops::set_away(cx, uid, away);
        }
        Some(account_of(cx.world, uid).unwrap_or_else(|| account.to_string()))
    });
    let Some(canonical) = canonical else {
        ctx.fail(
            msg,
            "UNKNOWN_ACCOUNT",
            &[account],
            "No such account on this link",
        );
        return;
    };
    touch(shared, &canonical);
    for ext in shared.hub.extensions() {
        ext.on_account_state(state, &canonical, busy);
    }
}

// ---------------------------------------------------------------------------
// Link down, restore, tick, membership persistence

/// The link closed: its accounts stay in their channels as dormant users
/// (section 6.8). Ownership persists.
pub fn link_down(shared: &Arc<LinkShared>, state: &SharedState, ctx: &LinkCtx) {
    // A newer connection with the same name replaced this one: keep its state.
    if let Some(cur) = shared.hub.get(&ctx.entry.name) {
        if !cur.handle.tx.same_channel(&ctx.entry.handle.tx) {
            return;
        }
    }
    let mine: Vec<String> = shared
        .owners
        .lock()
        .iter()
        .filter(|(_, l)| **l == ctx.entry.name)
        .map(|(k, _)| k.clone())
        .collect();
    state.with_world(|cx| {
        for key in mine {
            let Some(uid) = cx.world.accounts.get(&key).copied() else {
                continue;
            };
            let attached_elsewhere = match cx.world.user(uid).map(|u| &u.sink) {
                Some(Sink::Virtual { link: Some(h), .. }) => {
                    !h.tx.same_channel(&ctx.entry.handle.tx)
                }
                _ => false,
            };
            if attached_elsewhere {
                continue;
            }
            set_sink_link(cx.world, uid, None);
            if cx
                .world
                .user(uid)
                .is_some_and(|u| u.away.as_deref() != Some("dormant"))
            {
                ops::set_away(cx, uid, Some("dormant".to_string()));
            }
        }
    });
}

struct RestoreItem {
    row: AccountRow,
    aliases: Vec<String>,
    memberships: Vec<(String, String)>,
}

/// Create the stored accounts as dormant users. Runs once; safe when some
/// users already exist.
pub fn restore(shared: &Arc<LinkShared>, state: &SharedState) {
    if shared.restored.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(store) = shared.hub.store().cloned() else {
        return;
    };
    let rows = match store.list_accounts() {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("store list_accounts failed: {e}");
            return;
        }
    };
    let mut pending: Vec<RestoreItem> = rows
        .into_iter()
        .map(|row| RestoreItem {
            aliases: store.aliases(&row.account).unwrap_or_default(),
            memberships: store.memberships(&row.account).unwrap_or_default(),
            row,
        })
        .collect();

    let mut owners: Vec<(String, String)> = Vec::new();
    state.with_world(|cx| {
        // Parents before children; a parent that never resolves (a cycle or a
        // retired parent) is dropped on the last pass.
        let mut force = false;
        while !pending.is_empty() {
            let waiting: HashSet<String> = pending.iter().map(|i| fold(&i.row.account)).collect();
            let mut rest = Vec::new();
            let mut progress = false;
            for item in pending {
                let parent_waits = item.row.parent.as_ref().is_some_and(|p| {
                    cx.world.find_account(p).is_none() && waiting.contains(&fold(p))
                });
                if parent_waits && !force {
                    rest.push(item);
                    continue;
                }
                progress = true;
                if let Some(link) = item.row.link.clone() {
                    owners.push((fold(&item.row.account), link));
                }
                restore_one(cx, &store, item);
            }
            pending = rest;
            force = !progress;
        }
    });

    let mut map = shared.owners.lock();
    for (k, link) in owners {
        map.entry(k).or_insert(link);
    }
}

fn restore_one(cx: &mut Cx<'_>, store: &Arc<Store>, item: RestoreItem) {
    let row = item.row;
    if cx.world.find_account(&row.account).is_some() {
        return;
    }
    let max = cx.state.config.limits.nick_max_len;
    let nick = assign_nick(cx.world, &row.nick, max, None);
    if nick != row.nick {
        if let Err(e) = store.set_nick(&row.account, &nick, &fold(&nick)) {
            tracing::warn!("store set_nick failed for {}: {e}", row.account);
        }
    }
    let parent_uid = row.parent.as_ref().and_then(|p| cx.world.find_account(p));
    let uid = cx.world.create_virtual_user(
        &row.account,
        &nick,
        &row.realname,
        Role::Agent,
        parent_uid,
        Some(row.owner.clone()),
        None,
    );
    for alias in &item.aliases {
        if nick_free(cx.world, alias, Some(uid)) && fold(alias) != fold(&nick) {
            cx.world.add_alias(uid, alias);
        }
    }
    ops::set_away(cx, uid, Some("dormant".to_string()));
    for (_, channel) in &item.memberships {
        if valid_channel(channel) {
            ops::join(cx, uid, channel, false);
        }
    }
}

/// Restore once, then retire inactive accounts at most once per hour.
pub fn on_tick(shared: &Arc<LinkShared>, state: &SharedState, now: SystemTime) {
    restore(shared, state);
    let days = state.config.limits.account_retirement_days;
    if days == 0 {
        return;
    }
    {
        let mut last = shared.last_inactivity_check.lock();
        if last.is_some_and(|t| t.elapsed() < INACTIVITY_CHECK_EVERY) {
            return;
        }
        *last = Some(Instant::now());
    }
    let Some(store) = shared.hub.store().cloned() else {
        return;
    };
    let now_unix = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let cutoff = now_unix - i64::from(days) * 86_400;
    let inactive = match store.inactive_since(cutoff) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("store inactive_since failed: {e}");
            return;
        }
    };
    for account in inactive {
        let owner = shared.owners.lock().get(&fold(&account)).cloned();
        if retire_account(shared, state, &account, "inactive") {
            if let Some(link) = owner {
                shared.hub.send(
                    &link,
                    &Message::new("RETIRED", vec![account.clone(), "inactive".to_string()]),
                );
            }
        }
    }
}

/// Persist the channel membership of a virtual user.
pub fn on_join(shared: &Arc<LinkShared>, cx: &mut Cx<'_>, uid: UserId, channel: &str) {
    let Some(store) = shared.hub.store() else {
        return;
    };
    let Some(account) = virtual_account(cx.world, uid) else {
        return;
    };
    if let Err(e) = store.add_membership(&account, &fold(channel), channel) {
        tracing::warn!("store add_membership failed for {account}: {e}");
    }
}

/// Forget the channel membership of a virtual user.
pub fn on_part(shared: &Arc<LinkShared>, cx: &mut Cx<'_>, uid: UserId, channel: &str) {
    let Some(store) = shared.hub.store() else {
        return;
    };
    let Some(account) = virtual_account(cx.world, uid) else {
        return;
    };
    if let Err(e) = store.remove_membership(&account, &fold(channel)) {
        tracing::warn!("store remove_membership failed for {account}: {e}");
    }
}
