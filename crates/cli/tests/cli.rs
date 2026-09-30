use agent_comms_server::config::Secrets;
use argon2::password_hash::{PasswordHash, PasswordVerifier};
use argon2::Argon2;
use assert_cmd::Command;
use predicates::prelude::*;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

fn cmd(tmp: &TempDir) -> Command {
    let mut c = Command::cargo_bin("agent-comms").unwrap();
    c.env("HOME", tmp.path())
        .env("XDG_DATA_HOME", tmp.path().join("data"))
        .env("XDG_CONFIG_HOME", tmp.path().join("xdg-config"))
        .env_remove("AGENT_COMMS_CONFIG_DIR")
        .env_remove("RUST_LOG")
        .arg("--config-dir")
        .arg(config_dir(tmp));
    c
}

fn config_dir(tmp: &TempDir) -> PathBuf {
    tmp.path().join("cfg")
}

fn mode(path: &Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn install(tmp: &TempDir) {
    cmd(tmp)
        .args(["install", "--no-launchd"])
        .assert()
        .success();
}

fn read_secrets(tmp: &TempDir) -> Secrets {
    let text = fs::read_to_string(config_dir(tmp).join("secrets.toml")).unwrap();
    Secrets::from_toml(&text).unwrap()
}

fn verify(hash: &str, secret: &str) -> bool {
    let parsed = PasswordHash::new(hash).unwrap();
    Argon2::default()
        .verify_password(secret.as_bytes(), &parsed)
        .is_ok()
}

#[test]
fn install_creates_files_with_private_modes() {
    let tmp = TempDir::new().unwrap();
    cmd(&tmp)
        .args(["install", "--no-launchd"])
        .assert()
        .success()
        .stdout(predicate::str::contains("/server add agent-comms"))
        .stdout(predicate::str::contains("Operator password"));
    let dir = config_dir(&tmp);
    assert!(dir.join("config.toml").is_file());
    assert_eq!(mode(&dir), 0o700);
    assert_eq!(mode(&dir.join("secrets.toml")), 0o600);
    assert_eq!(mode(&dir.join("link-token")), 0o600);
    let token = fs::read_to_string(dir.join("link-token")).unwrap();
    assert_eq!(token.trim().len(), 43);
    let secrets = read_secrets(&tmp);
    assert_eq!(secrets.operator.as_ref().unwrap().account, "operator");
    assert_eq!(secrets.links.len(), 1);
    assert_eq!(secrets.links[0].owner, "operator");
    assert!(verify(&secrets.links[0].token_hash, token.trim()));
    // The plaintext token is never in the secrets file.
    let raw = fs::read_to_string(dir.join("secrets.toml")).unwrap();
    assert!(!raw.contains(token.trim()));
}

#[test]
fn install_uses_given_operator_password() {
    let tmp = TempDir::new().unwrap();
    cmd(&tmp)
        .args([
            "install",
            "--no-launchd",
            "--operator-password",
            "hunter2hunter2",
        ])
        .assert()
        .success();
    let secrets = read_secrets(&tmp);
    assert!(verify(
        &secrets.operator.unwrap().password_hash,
        "hunter2hunter2"
    ));
}

#[test]
fn second_install_keeps_token() {
    let tmp = TempDir::new().unwrap();
    install(&tmp);
    let path = config_dir(&tmp).join("link-token");
    let first = fs::read_to_string(&path).unwrap();
    let secrets1 = read_secrets(&tmp);
    install(&tmp);
    assert_eq!(fs::read_to_string(&path).unwrap(), first);
    assert_eq!(read_secrets(&tmp), secrets1);

    cmd(&tmp)
        .args(["install", "--no-launchd", "--force"])
        .assert()
        .success();
    assert_ne!(fs::read_to_string(&path).unwrap(), first);
}

#[test]
fn token_rotate_changes_token() {
    let tmp = TempDir::new().unwrap();
    install(&tmp);
    let path = config_dir(&tmp).join("link-token");
    let old = fs::read_to_string(&path).unwrap();
    cmd(&tmp)
        .args(["token", "rotate"])
        .assert()
        .success()
        .stdout(predicate::str::contains("reload").or(predicate::str::contains("Restart")));
    let new = fs::read_to_string(&path).unwrap();
    assert_ne!(old, new);
    assert_eq!(new.trim().len(), 43);
    assert_eq!(mode(&path), 0o600);
    let secrets = read_secrets(&tmp);
    assert_eq!(secrets.links.len(), 1);
    assert!(verify(&secrets.links[0].token_hash, new.trim()));
    assert!(!verify(&secrets.links[0].token_hash, old.trim()));
    assert_eq!(mode(&config_dir(&tmp).join("secrets.toml")), 0o600);
}

#[test]
fn token_revoke_marks_revoked() {
    let tmp = TempDir::new().unwrap();
    install(&tmp);
    let name = read_secrets(&tmp).links[0].name.clone();
    cmd(&tmp)
        .args(["token", "revoke", &name])
        .assert()
        .success();
    assert!(read_secrets(&tmp).links[0].revoked);
    cmd(&tmp)
        .args(["token", "list"])
        .assert()
        .success()
        .stdout(predicate::str::contains(&name));
    cmd(&tmp)
        .args(["token", "revoke", "no-such-name"])
        .assert()
        .failure();
}

#[test]
fn token_show_path() {
    let tmp = TempDir::new().unwrap();
    cmd(&tmp)
        .args(["token", "show-path"])
        .assert()
        .success()
        .stdout(predicate::str::contains("link-token"));
}

#[test]
fn config_check_defaults_ok() {
    let tmp = TempDir::new().unwrap();
    cmd(&tmp)
        .args(["config", "check"])
        .assert()
        .success()
        .stdout(predicate::str::contains("server_name"));
}

#[test]
fn config_check_rejects_public_bind_without_tls() {
    let tmp = TempDir::new().unwrap();
    fs::create_dir_all(config_dir(&tmp)).unwrap();
    fs::write(
        config_dir(&tmp).join("config.toml"),
        "bind = \"0.0.0.0:6667\"\n",
    )
    .unwrap();
    cmd(&tmp)
        .args(["config", "check"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("TLS"));
}

#[test]
fn config_check_rejects_parse_error() {
    let tmp = TempDir::new().unwrap();
    fs::create_dir_all(config_dir(&tmp)).unwrap();
    fs::write(config_dir(&tmp).join("config.toml"), "bind = [\n").unwrap();
    cmd(&tmp).args(["config", "check"]).assert().failure();
}

#[test]
fn serve_refuses_loose_secrets_mode() {
    let tmp = TempDir::new().unwrap();
    fs::create_dir_all(config_dir(&tmp)).unwrap();
    let secrets = config_dir(&tmp).join("secrets.toml");
    fs::write(&secrets, "").unwrap();
    fs::set_permissions(&secrets, fs::Permissions::from_mode(0o644)).unwrap();
    cmd(&tmp)
        .arg("serve")
        .timeout(std::time::Duration::from_secs(20))
        .assert()
        .failure()
        .stderr(predicate::str::contains("group or others"));
}

#[test]
fn operator_password_updates_hash() {
    let tmp = TempDir::new().unwrap();
    install(&tmp);
    cmd(&tmp)
        .args(["operator-password", "--password", "new-password-123"])
        .assert()
        .success();
    let secrets = read_secrets(&tmp);
    assert!(verify(
        &secrets.operator.unwrap().password_hash,
        "new-password-123"
    ));
}
