//! Locations of files and config loading.

use agent_comms_server::config::Config;
use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};

pub fn config_file(config_dir: &Path) -> PathBuf {
    config_dir.join("config.toml")
}

pub fn link_token_file(config_dir: &Path) -> PathBuf {
    config_dir.join("link-token")
}

/// Pid file of a running `serve`, in the data directory.
pub fn pid_file(data_dir: &Path) -> PathBuf {
    data_dir.join("agent-comms.pid")
}

pub fn default_secrets_file(config_dir: &Path) -> PathBuf {
    config_dir.join("secrets.toml")
}

/// Load the config. A missing file gives the defaults.
/// When the file does not set `secrets_path`, the secrets file is
/// `<config-dir>/secrets.toml`.
pub fn load_config(config_dir: &Path, config_file_override: Option<&Path>) -> Result<Config> {
    let path = config_file_override
        .map(Path::to_path_buf)
        .unwrap_or_else(|| config_file(config_dir));
    let mut explicit_secrets = false;
    let mut config = match std::fs::read_to_string(&path) {
        Ok(text) => {
            let table: toml::Table = text
                .parse()
                .map_err(|e| anyhow!("cannot parse {}: {e}", path.display()))?;
            explicit_secrets = table.contains_key("secrets_path");
            Config::from_toml(&text)
                .map_err(|e| anyhow!("invalid config {}: {e}", path.display()))?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Config::default(),
        Err(e) => return Err(e).with_context(|| format!("cannot read {}", path.display())),
    };
    if !explicit_secrets {
        config.secrets_path = default_secrets_file(config_dir);
    }
    Ok(config)
}
