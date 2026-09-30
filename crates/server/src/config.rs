//! Server configuration (`config.toml`) and secrets (`secrets.toml`).
//!
//! This file is a shared contract between the server and the CLI.

use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::path::PathBuf;

/// Top-level server configuration. Every field has a default.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// Server name used as the source of numerics.
    pub server_name: String,
    /// Listen address. Non-loopback addresses require `tls`.
    pub bind: SocketAddr,
    /// TLS settings. When set, the listener accepts TLS only.
    pub tls: Option<TlsConfig>,
    /// Directory for the SQLite database (`agent-comms.db`).
    pub data_dir: PathBuf,
    /// Path of `secrets.toml`.
    pub secrets_path: PathBuf,
    /// Optional message of the day.
    pub motd: Option<String>,
    /// Require SASL for ordinary client connections. Only tests set this to false.
    pub require_sasl: bool,
    pub limits: LimitsConfig,
    pub modules: ModulesConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TlsConfig {
    pub cert: PathBuf,
    pub key: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct LimitsConfig {
    /// Maximum logical size of one message (multiline included), in bytes.
    pub max_message_bytes: usize,
    pub history_retention_days: u32,
    pub account_retirement_days: u32,
    pub claim_idle_secs: u64,
    /// Flood control: token bucket size (lines) for each connection or account.
    pub flood_burst: u32,
    /// Flood control: tokens added each second.
    pub flood_rate_per_sec: u32,
    pub link_ping_secs: u64,
    pub link_timeout_secs: u64,
    pub client_ping_secs: u64,
    pub client_timeout_secs: u64,
    pub agent_request_timeout_secs: u64,
    pub nick_max_len: usize,
    /// Bounded outbound queue length (lines) for each connection.
    pub outbound_queue: usize,
    /// Failed link handshakes allowed for each source address in one minute.
    pub link_auth_failures_per_min: u32,
    /// Flood control for SEND on one link: token bucket size (inner lines).
    pub link_flood_burst: u32,
    /// Flood control for SEND on one link: tokens added each second.
    pub link_flood_rate_per_sec: u32,
    /// Flood control for SEND by one account: token bucket size (messages).
    pub account_flood_burst: u32,
    /// Flood control for SEND by one account: tokens added each second.
    pub account_flood_rate_per_sec: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct ModulesConfig {
    pub history: bool,
    pub link: bool,
    pub authority: bool,
    pub claims: bool,
    pub agent: bool,
    pub broadcast: bool,
}

impl Default for Config {
    fn default() -> Self {
        let base = default_config_dir();
        Self {
            server_name: "irc.agent-comms.local".into(),
            bind: "127.0.0.1:6667".parse().expect("valid default bind"),
            tls: None,
            data_dir: default_data_dir(),
            secrets_path: base.join("secrets.toml"),
            motd: None,
            require_sasl: true,
            limits: LimitsConfig::default(),
            modules: ModulesConfig::default(),
        }
    }
}

impl Default for LimitsConfig {
    fn default() -> Self {
        Self {
            max_message_bytes: 16 * 1024,
            history_retention_days: 7,
            account_retirement_days: 30,
            claim_idle_secs: 600,
            flood_burst: 20,
            flood_rate_per_sec: 5,
            link_ping_secs: 60,
            link_timeout_secs: 120,
            client_ping_secs: 120,
            client_timeout_secs: 240,
            agent_request_timeout_secs: 10,
            nick_max_len: 96,
            outbound_queue: 4096,
            link_auth_failures_per_min: 5,
            link_flood_burst: 5000,
            link_flood_rate_per_sec: 1000,
            account_flood_burst: 100,
            account_flood_rate_per_sec: 20,
        }
    }
}

impl Default for ModulesConfig {
    fn default() -> Self {
        Self {
            history: true,
            link: true,
            authority: true,
            claims: true,
            agent: true,
            broadcast: true,
        }
    }
}

impl Config {
    /// Parse a TOML document. Missing fields take defaults.
    pub fn from_toml(text: &str) -> Result<Self, toml::de::Error> {
        toml::from_str(text)
    }

    /// Path of the SQLite database file.
    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("agent-comms.db")
    }

    /// Check rules that serde cannot express.
    pub fn validate(&self) -> Result<(), String> {
        if !self.bind.ip().is_loopback() && self.tls.is_none() {
            return Err(format!(
                "bind address {} is not loopback: TLS is required ([tls] cert and key)",
                self.bind
            ));
        }
        if self.limits.max_message_bytes == 0 {
            return Err("limits.max_message_bytes must be greater than 0".into());
        }
        Ok(())
    }
}

/// `~/.config/agent-comms` (or `$XDG_CONFIG_HOME/agent-comms`).
pub fn default_config_dir() -> PathBuf {
    if let Some(x) = std::env::var_os("XDG_CONFIG_HOME") {
        return PathBuf::from(x).join("agent-comms");
    }
    home_dir().join(".config").join("agent-comms")
}

/// `~/.local/share/agent-comms` (or `$XDG_DATA_HOME/agent-comms`).
pub fn default_data_dir() -> PathBuf {
    if let Some(x) = std::env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(x).join("agent-comms");
    }
    home_dir().join(".local").join("share").join("agent-comms")
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Contents of `secrets.toml` (file mode 0600). Only hashes are stored.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct Secrets {
    pub operator: Option<OperatorSecret>,
    pub links: Vec<LinkCredential>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OperatorSecret {
    /// SASL account name of the operator (default `operator`).
    pub account: String,
    /// Argon2id PHC string of the operator password.
    pub password_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LinkCredential {
    /// Human name of the credential, for example the machine host name.
    pub name: String,
    /// Owner of all accounts on links that use this credential.
    pub owner: String,
    /// Argon2id PHC string of the link token.
    pub token_hash: String,
    /// Unix time of creation.
    pub created: i64,
    #[serde(default)]
    pub revoked: bool,
    /// Key that proves the server identity to a link (link protocol CHALLENGE):
    /// hex of HMAC-SHA256(token, "agent-comms server key v1"). It cannot be
    /// used to authenticate as a link.
    #[serde(default)]
    pub server_key: Option<String>,
}

impl Secrets {
    pub fn from_toml(text: &str) -> Result<Self, toml::de::Error> {
        toml::from_str(text)
    }

    pub fn to_toml(&self) -> String {
        toml::to_string_pretty(self).expect("secrets serialize")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_validate() {
        let c = Config::default();
        assert!(c.validate().is_ok());
        assert_eq!(c.limits.max_message_bytes, 16384);
    }

    #[test]
    fn non_loopback_requires_tls() {
        let c = Config {
            bind: "0.0.0.0:6667".parse().unwrap(),
            ..Config::default()
        };
        assert!(c.validate().is_err());
    }

    #[test]
    fn partial_toml() {
        let c = Config::from_toml("bind = \"127.0.0.1:7000\"\n[limits]\nclaim_idle_secs = 5\n")
            .unwrap();
        assert_eq!(c.bind.port(), 7000);
        assert_eq!(c.limits.claim_idle_secs, 5);
        assert_eq!(c.limits.flood_burst, 20);
    }
}
