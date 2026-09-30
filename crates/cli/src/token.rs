//! Token and password generation, and the `token` and `operator-password` commands.

use crate::cli::{OperatorPasswordArgs, TokenCmd};
use crate::{notify, paths, secrets_file};
use agent_comms_server::config::{LinkCredential, OperatorSecret, Secrets};
use anyhow::{anyhow, bail, Result};
use argon2::password_hash::{rand_core::OsRng as SaltRng, PasswordHasher, SaltString};
use argon2::Argon2;
use rand::{rngs::OsRng, Rng};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const ALNUM: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const TOKEN_CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

pub const PASSWORD_LEN: usize = 32;
pub const TOKEN_LEN: usize = 43;
pub const OWNER: &str = "operator";

fn random_string(charset: &[u8], len: usize) -> String {
    let mut rng = OsRng;
    (0..len)
        .map(|_| charset[rng.gen_range(0..charset.len())] as char)
        .collect()
}

pub fn generate_password() -> String {
    random_string(ALNUM, PASSWORD_LEN)
}

pub fn generate_token() -> String {
    random_string(TOKEN_CHARS, TOKEN_LEN)
}

/// Hash a secret with argon2id. Returns a PHC string.
pub fn hash_secret(secret: &str) -> Result<String> {
    let salt = SaltString::generate(&mut SaltRng);
    Argon2::default()
        .hash_password(secret.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| anyhow!("cannot hash secret: {e}"))
}

pub fn host_name() -> String {
    hostname::get()
        .ok()
        .map(|h| h.to_string_lossy().trim().to_string())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "localhost".to_string())
}

pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Set the credential with this name to the hash of `token`.
/// An existing credential of that name is replaced and un-revoked.
pub fn upsert_link(secrets: &mut Secrets, name: &str, token: &str) -> Result<()> {
    let token_hash = hash_secret(token)?;
    let created = now_unix();
    if let Some(existing) = secrets.links.iter_mut().find(|l| l.name == name) {
        existing.token_hash = token_hash;
        existing.created = created;
        existing.revoked = false;
    } else {
        secrets.links.push(LinkCredential {
            name: name.to_string(),
            owner: OWNER.to_string(),
            token_hash,
            created,
            revoked: false,
        });
    }
    Ok(())
}

/// Set the operator password hash. Keeps an existing account name.
pub fn set_operator_password(secrets: &mut Secrets, password: &str) -> Result<()> {
    let account = secrets
        .operator
        .as_ref()
        .map(|o| o.account.clone())
        .unwrap_or_else(|| OWNER.to_string());
    secrets.operator = Some(OperatorSecret {
        account,
        password_hash: hash_secret(password)?,
    });
    Ok(())
}

pub fn run(config_dir: &Path, cmd: TokenCmd) -> Result<()> {
    let token_path = paths::link_token_file(config_dir);
    match cmd {
        TokenCmd::ShowPath => {
            println!("{}", token_path.display());
            Ok(())
        }
        TokenCmd::List => {
            let config = paths::load_config(config_dir, None)?;
            let secrets = secrets_file::load_or_default(&config.secrets_path)?;
            println!("{:<24} {:<12} {:<12} REVOKED", "NAME", "OWNER", "CREATED");
            for l in &secrets.links {
                println!(
                    "{:<24} {:<12} {:<12} {}",
                    l.name,
                    l.owner,
                    l.created,
                    if l.revoked { "yes" } else { "no" }
                );
            }
            Ok(())
        }
        TokenCmd::Rotate { name } => {
            let config = paths::load_config(config_dir, None)?;
            let mut secrets = secrets_file::load_or_default(&config.secrets_path)?;
            let name = name.unwrap_or_else(host_name);
            let token = generate_token();
            upsert_link(&mut secrets, &name, &token)?;
            secrets_file::create_private_dir(config_dir)?;
            secrets_file::write_secrets(&config.secrets_path, &secrets)?;
            secrets_file::write_private_file(&token_path, token.as_bytes())?;
            println!("Rotated link token for \"{name}\".");
            println!("New token file: {}", token_path.display());
            notify::reload_running_server(&config);
            println!("The old token does not work after the server reloads its secrets.");
            println!("A plugin reads the token file on each connection and reconnects with the new token.");
            Ok(())
        }
        TokenCmd::Revoke { name } => {
            let config = paths::load_config(config_dir, None)?;
            let mut secrets = secrets_file::load_or_default(&config.secrets_path)?;
            match secrets.links.iter_mut().find(|l| l.name == name) {
                Some(l) => l.revoked = true,
                None => bail!("no link credential named \"{name}\""),
            }
            secrets_file::write_secrets(&config.secrets_path, &secrets)?;
            println!("Revoked link credential \"{name}\".");
            notify::reload_running_server(&config);
            Ok(())
        }
    }
}

/// Get a password from stdin (`--password-stdin`) or the terminal
/// (`--prompt`). Returns None when neither is set.
pub fn read_password(from_stdin: bool, prompt: bool) -> Result<Option<String>> {
    let password = if from_stdin {
        let mut line = String::new();
        std::io::stdin()
            .read_line(&mut line)
            .map_err(|e| anyhow!("cannot read password from stdin: {e}"))?;
        let trimmed = line.strip_suffix('\n').unwrap_or(&line);
        let trimmed = trimmed.strip_suffix('\r').unwrap_or(trimmed);
        trimmed.to_string()
    } else if prompt {
        let first = rpassword::prompt_password("New operator password: ")?;
        let second = rpassword::prompt_password("Repeat password: ")?;
        if first != second {
            bail!("passwords do not match");
        }
        first
    } else {
        return Ok(None);
    };
    if password.is_empty() {
        bail!("password must not be empty");
    }
    Ok(Some(password))
}

pub fn operator_password(config_dir: &Path, args: &OperatorPasswordArgs) -> Result<()> {
    let config = paths::load_config(config_dir, None)?;
    let mut secrets = secrets_file::load_or_default(&config.secrets_path)?;
    let (password, generated) = match read_password(args.password_stdin, args.prompt)? {
        Some(p) => (p, false),
        None => (generate_password(), true),
    };
    set_operator_password(&mut secrets, &password)?;
    secrets_file::create_private_dir(config_dir)?;
    secrets_file::write_secrets(&config.secrets_path, &secrets)?;
    println!("Operator password updated.");
    if generated {
        println!("New operator password (shown once): {password}");
    }
    notify::reload_running_server(&config);
    Ok(())
}
