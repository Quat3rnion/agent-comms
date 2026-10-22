//! Linux systemd user service.

use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const LABEL: &str = "agent-comms.service";

pub fn unit_path() -> PathBuf {
    let config_home = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".config")
        });
    config_home.join("systemd/user").join(LABEL)
}

/// Build the unit for the same command used by the launchd service.
pub fn unit_text(exe: &Path, config_dir: &Path) -> String {
    format!(
        "[Unit]\nDescription=agent-comms IRC server\n\n\
         [Service]\nType=simple\n\
         ExecStart=\"{}\" serve --config-dir \"{}\"\n\
         Restart=on-failure\nRestartSec=5s\nUMask=0077\n\
         StandardOutput=journal\nStandardError=journal\n\n\
         [Install]\nWantedBy=default.target\n",
        escape_path(exe),
        // systemd expands environment variables in arguments, not the executable.
        escape_path(config_dir).replace('$', "$$")
    )
}

// ExecStart is not a shell command: escape systemd specifiers,
// as well as quoted-string delimiters and control characters.
fn escape_path(path: &Path) -> String {
    let mut escaped = String::new();
    for c in path.to_string_lossy().chars() {
        match c {
            '%' => escaped.push_str("%%"),
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            c => escaped.push(c),
        }
    }
    escaped
}

fn systemctl(args: &[&str]) -> Result<bool> {
    let status = Command::new("systemctl")
        .arg("--user")
        .args(args)
        .status()
        .context("cannot run systemctl --user")?;
    Ok(status.success())
}

/// Write the unit and start the service. A failure to start is a warning.
pub fn install(exe: &Path, config_dir: &Path) -> Result<()> {
    let unit = unit_path();
    if let Some(dir) = unit.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("cannot create {}", dir.display()))?;
    }
    std::fs::write(&unit, unit_text(exe, config_dir))
        .with_context(|| format!("cannot write {}", unit.display()))?;
    println!("Wrote {}", unit.display());
    if !systemctl(&["daemon-reload"])? {
        eprintln!("warning: `systemctl --user daemon-reload` failed. Start the service by hand.");
    } else if systemctl(&["enable", "--now", LABEL])? {
        println!("Service {LABEL} started. Log: journalctl --user -u {LABEL}");
    } else {
        eprintln!(
            "warning: `systemctl --user enable --now {LABEL}` failed. Start the service by hand."
        );
    }
    Ok(())
}

/// Stop and disable the service, then remove its unit. Data stays.
pub fn uninstall() -> Result<()> {
    let unit = unit_path();
    if unit.exists() {
        if !systemctl(&["disable", "--now", LABEL])? {
            bail!("cannot stop and disable {LABEL}; kept {}", unit.display());
        }
        std::fs::remove_file(&unit).with_context(|| format!("cannot remove {}", unit.display()))?;
        println!("Removed {}", unit.display());
        if !systemctl(&["daemon-reload"])? {
            bail!("`systemctl --user daemon-reload` failed");
        }
    } else {
        println!("No service file at {}", unit.display());
    }
    println!("Config, secrets and data are kept.");
    Ok(())
}

/// Send SIGHUP only when this user installed the service and it is active.
pub fn signal_reload() -> Result<bool> {
    if !unit_path().exists() {
        return Ok(false);
    }
    let active = Command::new("systemctl")
        .args(["--user", "is-active", "--quiet", LABEL])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if !active {
        return Ok(false);
    }
    systemctl(&["kill", "--kill-who=main", "--signal=SIGHUP", LABEL])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_quotes_paths_without_systemd_expansion() {
        let unit = unit_text(
            Path::new("/opt/a b/$agent%comms"),
            Path::new("/home/u/%h/$HOME/\"quoted\"/back\\slash\nnext\r\t"),
        );
        assert!(unit.contains(
            "ExecStart=\"/opt/a b/$agent%%comms\" serve --config-dir \"/home/u/%%h/$$HOME/\\\"quoted\\\"/back\\\\slash\\nnext\\r\\t\"\n"
        ));
        assert!(unit.contains("Restart=on-failure\n"));
        assert!(unit.contains("StandardOutput=journal\nStandardError=journal\n"));
        assert!(unit.ends_with("[Install]\nWantedBy=default.target\n"));
    }
}
