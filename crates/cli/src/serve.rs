//! `agent-comms serve`.

use crate::cli::LogFormat;
use crate::{paths, secrets_file};
use anyhow::{anyhow, Result};
use std::path::Path;
use tracing_subscriber::EnvFilter;

pub async fn run(config_dir: &Path, config_file: Option<&Path>, format: LogFormat) -> Result<()> {
    let config = paths::load_config(config_dir, config_file)?;
    let secrets = secrets_file::load_checked(&config.secrets_path)?;
    config.validate().map_err(|e| anyhow!(e))?;
    init_tracing(format);
    tracing::info!(bind = %config.bind, tls = config.tls.is_some(), "starting agent-comms");
    agent_comms_server::run(config, secrets, shutdown_signal()).await
}

fn init_tracing(format: LogFormat) {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let builder = tracing_subscriber::fmt().with_env_filter(filter);
    match format {
        LogFormat::Json => builder.json().init(),
        LogFormat::Text => builder.init(),
    }
}

async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("install SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
    tracing::info!("shutdown signal received");
}
