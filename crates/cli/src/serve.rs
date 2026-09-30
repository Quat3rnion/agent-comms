//! `agent-comms serve`.

use crate::cli::LogFormat;
use crate::{paths, secrets_file};
use agent_comms_server::config::Secrets;
use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};
use tokio::signal::unix::{signal, Signal, SignalKind};
use tracing_subscriber::EnvFilter;

pub async fn run(config_dir: &Path, config_file: Option<&Path>, format: LogFormat) -> Result<()> {
    let config = paths::load_config(config_dir, config_file)?;
    let secrets = secrets_file::load_checked(&config.secrets_path)?;
    config.validate().map_err(|e| anyhow!(e))?;
    init_tracing(format);

    // Install the handlers before the pid file exists, so that a signal
    // from another command never uses the default action.
    let term = signal(SignalKind::terminate()).context("install SIGTERM handler")?;
    let mut hup = signal(SignalKind::hangup()).context("install SIGHUP handler")?;

    secrets_file::create_private_dir(&config.data_dir)?;
    let _pid_file = PidFile::create(paths::pid_file(&config.data_dir))?;

    let (reload_tx, reload_rx) = tokio::sync::mpsc::channel::<Secrets>(1);
    let secrets_path = config.secrets_path.clone();
    let reload_task = tokio::spawn(async move {
        while hup.recv().await.is_some() {
            tracing::info!("SIGHUP received: reloading secrets");
            match reload_secrets(&secrets_path) {
                Ok(s) => {
                    if reload_tx.send(s).await.is_err() {
                        break;
                    }
                }
                Err(e) => tracing::warn!("secrets reload failed, keeping current secrets: {e}"),
            }
        }
    });

    tracing::info!(bind = %config.bind, tls = config.tls.is_some(), "starting agent-comms");
    let result = agent_comms_server::server::run_with_reload(
        config,
        secrets,
        shutdown_signal(term),
        reload_rx,
    )
    .await;
    reload_task.abort();
    result
}

/// Read the secrets file again with the startup checks. The error text
/// never contains file contents.
fn reload_secrets(path: &Path) -> Result<Secrets> {
    secrets_file::check_mode(path)?;
    let text =
        std::fs::read_to_string(path).with_context(|| format!("cannot read {}", path.display()))?;
    Secrets::from_toml(&text).map_err(|_| anyhow!("cannot parse {}", path.display()))
}

/// Pid file of the running server. Removed on drop.
struct PidFile {
    path: PathBuf,
    pid: String,
}

impl PidFile {
    fn create(path: PathBuf) -> Result<PidFile> {
        let pid = std::process::id().to_string();
        secrets_file::write_private_file(&path, format!("{pid}\n").as_bytes())?;
        Ok(PidFile { path, pid })
    }
}

impl Drop for PidFile {
    fn drop(&mut self) {
        // Remove the file only when it still names this process.
        if let Ok(text) = std::fs::read_to_string(&self.path) {
            if text.trim() == self.pid {
                let _ = std::fs::remove_file(&self.path);
            }
        }
    }
}

fn init_tracing(format: LogFormat) {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let builder = tracing_subscriber::fmt().with_env_filter(filter);
    match format {
        LogFormat::Json => builder.json().init(),
        LogFormat::Text => builder.init(),
    }
}

async fn shutdown_signal(mut term: Signal) {
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
    tracing::info!("shutdown signal received");
}
