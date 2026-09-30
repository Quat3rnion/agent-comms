//! macOS launchd user agent.

use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const LABEL: &str = "local.agent-comms";

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn plist_path() -> PathBuf {
    home()
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{LABEL}.plist"))
}

pub fn log_path() -> PathBuf {
    home().join("Library").join("Logs").join("agent-comms.log")
}

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

/// Build the launchd property list for the service.
pub fn plist_xml(exe: &Path, config_dir: &Path, log: &Path) -> String {
    let exe = xml_escape(&exe.to_string_lossy());
    let dir = xml_escape(&config_dir.to_string_lossy());
    let log = xml_escape(&log.to_string_lossy());
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{exe}</string>
        <string>serve</string>
        <string>--config-dir</string>
        <string>{dir}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>{log}</string>
    <key>StandardErrorPath</key>
    <string>{log}</string>
</dict>
</plist>
"#
    )
}

fn uid() -> Result<String> {
    let out = Command::new("id")
        .arg("-u")
        .output()
        .context("cannot run `id -u`")?;
    if !out.status.success() {
        bail!("`id -u` failed");
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn launchctl(args: &[&str]) -> Result<bool> {
    let status = Command::new("launchctl")
        .args(args)
        .status()
        .context("cannot run launchctl")?;
    Ok(status.success())
}

/// Send SIGHUP to the service when this user installed and loaded it.
/// Returns true when launchctl sent the signal.
pub fn signal_reload() -> Result<bool> {
    if !cfg!(target_os = "macos") || !plist_path().exists() {
        return Ok(false);
    }
    let target = format!("gui/{}/{LABEL}", uid()?);
    let loaded = Command::new("launchctl")
        .args(["print", &target])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !loaded {
        return Ok(false);
    }
    let status = Command::new("launchctl")
        .args(["kill", "SIGHUP", &target])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .context("cannot run launchctl")?;
    Ok(status.success())
}

/// Write the plist and load the service. A failure to load is a warning.
pub fn install(exe: &Path, config_dir: &Path) -> Result<()> {
    let plist = plist_path();
    let log = log_path();
    if let Some(dir) = plist.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("cannot create {}", dir.display()))?;
    }
    if let Some(dir) = log.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("cannot create {}", dir.display()))?;
    }
    std::fs::write(&plist, plist_xml(exe, config_dir, &log))
        .with_context(|| format!("cannot write {}", plist.display()))?;
    println!("Wrote {}", plist.display());

    let uid = uid()?;
    let domain = format!("gui/{uid}");
    let target = format!("{domain}/{LABEL}");
    // Unload a running copy first. A failure means it was not loaded.
    let _ = launchctl(&["bootout", &target]);
    let plist_str = plist.to_string_lossy().to_string();
    if launchctl(&["bootstrap", &domain, &plist_str])? {
        println!("Service {LABEL} loaded. Log: {}", log.display());
    } else {
        eprintln!(
            "warning: `launchctl bootstrap {domain} {plist_str}` failed. Load the service by hand."
        );
    }
    Ok(())
}

/// Unload the service and remove the plist. Data stays.
pub fn uninstall() -> Result<()> {
    let plist = plist_path();
    if cfg!(target_os = "macos") {
        let target = format!("gui/{}/{LABEL}", uid()?);
        let _ = launchctl(&["bootout", &target]);
    }
    match std::fs::remove_file(&plist) {
        Ok(()) => println!("Removed {}", plist.display()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            println!("No service file at {}", plist.display())
        }
        Err(e) => return Err(e).with_context(|| format!("cannot remove {}", plist.display())),
    }
    println!("Config, secrets and data are kept.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plist_has_required_keys() {
        let xml = plist_xml(
            Path::new("/opt/bin/agent-comms"),
            Path::new("/home/u/.config/agent-comms"),
            Path::new("/home/u/Library/Logs/agent-comms.log"),
        );
        assert!(xml.contains("RunAtLoad"));
        assert!(xml.contains("KeepAlive"));
        assert!(xml.contains("<string>/opt/bin/agent-comms</string>"));
        assert!(xml.contains("<string>local.agent-comms</string>"));
        assert!(xml.contains("<string>--config-dir</string>"));
        assert!(xml.contains("StandardErrorPath"));
    }

    #[test]
    fn plist_escapes_xml() {
        let xml = plist_xml(Path::new("/a&b/x"), Path::new("/c"), Path::new("/l"));
        assert!(xml.contains("/a&amp;b/x"));
    }
}
