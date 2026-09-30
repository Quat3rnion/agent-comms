//! Tell a running server to reload its secrets (SIGHUP).

use crate::{launchd, paths};
use agent_comms_server::config::Config;
use std::process::{Command, Stdio};

/// Send SIGHUP to the running server and print the result.
/// First the pid file in the data directory, then the launchd service.
pub fn reload_running_server(config: &Config) {
    match signal_pid_file(config) {
        Ok(Some(pid)) => {
            println!("Running server (pid {pid}) notified. It uses the new secrets now.");
            return;
        }
        Ok(None) => {}
        Err(e) => eprintln!("warning: {e}"),
    }
    match launchd::signal_reload() {
        Ok(true) => {
            println!(
                "Running service {} notified. It uses the new secrets now.",
                launchd::LABEL
            );
        }
        Ok(false) => {
            println!("No running server found. A server that starts later reads the new secrets.");
        }
        Err(e) => {
            eprintln!("warning: cannot notify the running server: {e}");
            println!("Restart the server to apply the new secrets.");
        }
    }
}

/// Returns the pid that received SIGHUP, or None when no server runs.
fn signal_pid_file(config: &Config) -> Result<Option<u32>, String> {
    let path = paths::pid_file(&config.data_dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    let pid: u32 = match text.trim().parse() {
        Ok(p) if p > 1 => p,
        _ => return Err(format!("invalid pid file {}", path.display())),
    };
    // A stale pid file can name an unrelated process. Signal only
    // an agent-comms process.
    let out = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("cannot run ps: {e}"))?;
    if !out.status.success() || !String::from_utf8_lossy(&out.stdout).contains("agent-comms") {
        return Ok(None);
    }
    let status = Command::new("kill")
        .args(["-HUP", &pid.to_string()])
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("cannot run kill: {e}"))?;
    if status.success() {
        Ok(Some(pid))
    } else {
        Err(format!("cannot send SIGHUP to pid {pid}"))
    }
}
