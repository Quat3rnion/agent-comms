//! Reading and writing of private files. Secrets are never logged.

use agent_comms_server::config::Secrets;
use anyhow::{anyhow, bail, Context, Result};
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;

/// Create a directory with mode 0700. Missing parents use the default mode.
pub fn create_private_dir(dir: &Path) -> Result<()> {
    if let Some(parent) = dir.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .with_context(|| format!("cannot create {}", parent.display()))?;
        }
    }
    if !dir.exists() {
        DirBuilder::new()
            .mode(0o700)
            .create(dir)
            .with_context(|| format!("cannot create {}", dir.display()))?;
    }
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
        .with_context(|| format!("cannot set mode 0700 on {}", dir.display()))?;
    Ok(())
}

/// Write a file atomically with mode 0600: temp file in the same
/// directory, fsync, rename.
pub fn write_private_file(path: &Path, contents: &[u8]) -> Result<()> {
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .ok_or_else(|| anyhow!("invalid file path {}", path.display()))?
        .to_string_lossy();
    let tmp = dir.join(format!(".{name}.tmp-{}", std::process::id()));
    let _ = fs::remove_file(&tmp);
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)
            .with_context(|| format!("cannot create {}", tmp.display()))?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path).with_context(|| format!("cannot write {}", path.display()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
        return result;
    }
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

/// Refuse a secrets file that group or others can access.
pub fn check_mode(path: &Path) -> Result<()> {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => bail!(
            "secrets file {} not found: run `agent-comms install`",
            path.display()
        ),
        Err(e) => return Err(e).with_context(|| format!("cannot read {}", path.display())),
    };
    let mode = meta.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        bail!(
            "secrets file {} is accessible by group or others (mode {:04o}): run `chmod 600 {}`",
            path.display(),
            mode,
            path.display()
        );
    }
    Ok(())
}

/// Load secrets. A missing file gives empty secrets.
pub fn load_or_default(path: &Path) -> Result<Secrets> {
    match fs::read_to_string(path) {
        Ok(text) => Secrets::from_toml(&text)
            .map_err(|e| anyhow!("cannot parse secrets file {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Secrets::default()),
        Err(e) => Err(e).with_context(|| format!("cannot read {}", path.display())),
    }
}

/// Check the mode, then load. A missing file is an error.
pub fn load_checked(path: &Path) -> Result<Secrets> {
    check_mode(path)?;
    load_or_default(path)
}

pub fn write_secrets(path: &Path, secrets: &Secrets) -> Result<()> {
    write_private_file(path, secrets.to_toml().as_bytes())
}
