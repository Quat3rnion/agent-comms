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

#[cfg(target_os = "linux")]
fn mock_systemctl(tmp: &TempDir) -> PathBuf {
    let bin = tmp.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let script = bin.join("systemctl");
    fs::write(
        &script,
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HOME/systemctl.log\"\nexit 0\n",
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    bin
}

#[cfg(target_os = "linux")]
#[test]
fn install_and_uninstall_systemd_service_keep_data() {
    let tmp = TempDir::new().unwrap();
    let bin = mock_systemctl(&tmp);
    cmd(&tmp)
        .env("PATH", &bin)
        .arg("install")
        .assert()
        .success();
    let unit = tmp
        .path()
        .join("xdg-config/systemd/user/agent-comms.service");
    let text = fs::read_to_string(&unit).unwrap();
    assert!(text.contains(&format!(
        "ExecStart=\"{}\" serve --config-dir \"{}\"",
        env!("CARGO_BIN_EXE_agent-comms"),
        config_dir(&tmp).display()
    )));
    assert!(text.contains("Restart=on-failure\n"));
    assert!(text.contains("StandardOutput=journal\n"));
    assert!(text.contains("StandardError=journal\n"));
    assert!(text.contains("WantedBy=default.target\n"));
    let secrets = fs::read(config_dir(&tmp).join("secrets.toml")).unwrap();
    let data = tmp.path().join("data/agent-comms/agent-comms.db");
    fs::write(&data, "retained data").unwrap();
    cmd(&tmp)
        .env("PATH", &bin)
        .arg("uninstall")
        .assert()
        .success();
    assert!(!unit.exists());
    assert_eq!(
        fs::read(config_dir(&tmp).join("secrets.toml")).unwrap(),
        secrets
    );
    assert!(config_dir(&tmp).join("config.toml").exists());
    assert!(config_dir(&tmp).join("link-token").exists());
    assert_eq!(fs::read_to_string(data).unwrap(), "retained data");
    assert_eq!(
        fs::read_to_string(tmp.path().join("systemctl.log")).unwrap(),
        "--user daemon-reload\n--user enable --now agent-comms.service\n--user disable --now agent-comms.service\n--user daemon-reload\n"
    );
}

#[test]
fn install_service_opt_out_flags_skip_service() {
    let tmp = TempDir::new().unwrap();
    #[cfg(target_os = "linux")]
    let bin = mock_systemctl(&tmp);
    for flag in ["--no-service", "--no-launchd"] {
        let mut command = cmd(&tmp);
        #[cfg(target_os = "linux")]
        command.env("PATH", &bin);
        command.args(["install", flag]).assert().success();
    }
    assert!(!tmp.path().join("systemctl.log").exists());
    assert!(!tmp
        .path()
        .join("xdg-config/systemd/user/agent-comms.service")
        .exists());
    assert!(!tmp
        .path()
        .join("Library/LaunchAgents/local.agent-comms.plist")
        .exists());
}

#[cfg(target_os = "linux")]
#[test]
fn systemd_uses_home_when_xdg_config_home_is_unset() {
    let tmp = TempDir::new().unwrap();
    let bin = mock_systemctl(&tmp);
    cmd(&tmp)
        .env("PATH", &bin)
        .env_remove("XDG_CONFIG_HOME")
        .arg("install")
        .assert()
        .success();
    assert!(tmp
        .path()
        .join(".config/systemd/user/agent-comms.service")
        .exists());
}

#[cfg(target_os = "linux")]
#[test]
fn token_rotate_signals_active_systemd_service_without_pid_file() {
    let tmp = TempDir::new().unwrap();
    let bin = mock_systemctl(&tmp);
    cmd(&tmp)
        .env("PATH", &bin)
        .arg("install")
        .assert()
        .success();
    fs::write(tmp.path().join("systemctl.log"), "").unwrap();
    cmd(&tmp)
        .env("PATH", &bin)
        .args(["token", "rotate"])
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "Running service agent-comms.service notified",
        ));
    assert_eq!(
        fs::read_to_string(tmp.path().join("systemctl.log")).unwrap(),
        "--user is-active --quiet agent-comms.service\n--user kill --kill-who=main --signal=SIGHUP agent-comms.service\n"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn systemd_failures_warn_on_install_and_keep_unit_on_uninstall() {
    let tmp = TempDir::new().unwrap();
    let bin = mock_systemctl(&tmp);
    fs::write(bin.join("systemctl"), "#!/bin/sh\nexit 1\n").unwrap();
    cmd(&tmp)
        .env("PATH", &bin)
        .arg("install")
        .assert()
        .success()
        .stderr(predicate::str::contains("daemon-reload` failed"));
    cmd(&tmp)
        .env("PATH", &bin)
        .arg("uninstall")
        .assert()
        .failure()
        .stderr(predicate::str::contains("cannot stop and disable"));
    assert!(tmp
        .path()
        .join("xdg-config/systemd/user/agent-comms.service")
        .exists());
    assert!(config_dir(&tmp).join("secrets.toml").exists());
    cmd(&tmp)
        .env("PATH", &bin)
        .args(["token", "rotate"])
        .assert()
        .success()
        .stdout(predicate::str::contains("No running server found"));
    fs::write(
        bin.join("systemctl"),
        "#!/bin/sh\n[ \"$2\" = daemon-reload ]\n",
    )
    .unwrap();
    cmd(&tmp)
        .env("PATH", &bin)
        .arg("install")
        .assert()
        .success()
        .stderr(predicate::str::contains(
            "enable --now agent-comms.service` failed",
        ));
}

#[test]
fn install_uses_given_operator_password() {
    let tmp = TempDir::new().unwrap();
    cmd(&tmp)
        .args(["install", "--no-launchd", "--password-stdin"])
        .write_stdin("hunter2hunter2\n")
        .assert()
        .success()
        .stdout(predicate::str::contains("hunter2hunter2").not());
    let secrets = read_secrets(&tmp);
    assert!(verify(
        &secrets.operator.unwrap().password_hash,
        "hunter2hunter2"
    ));
}

#[test]
fn install_rejects_value_bearing_password_flag() {
    let tmp = TempDir::new().unwrap();
    cmd(&tmp)
        .args([
            "install",
            "--no-launchd",
            "--operator-password",
            "hunter2hunter2",
        ])
        .assert()
        .failure();
}

#[test]
fn install_rejects_empty_stdin_password() {
    let tmp = TempDir::new().unwrap();
    cmd(&tmp)
        .args(["install", "--no-launchd", "--password-stdin"])
        .write_stdin("\n")
        .assert()
        .failure();
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
        .args(["operator-password", "--password-stdin"])
        .write_stdin("new-password-123\r\n")
        .assert()
        .success()
        .stdout(predicate::str::contains("new-password-123").not());
    let secrets = read_secrets(&tmp);
    assert!(verify(
        &secrets.operator.unwrap().password_hash,
        "new-password-123"
    ));
}

#[test]
fn operator_password_default_generates_and_prints() {
    let tmp = TempDir::new().unwrap();
    install(&tmp);
    let out = cmd(&tmp)
        .arg("operator-password")
        .assert()
        .success()
        .stdout(predicate::str::contains("shown once"))
        .get_output()
        .stdout
        .clone();
    let out = String::from_utf8(out).unwrap();
    let line = out.lines().find(|l| l.contains("shown once")).unwrap();
    let password = line.rsplit(' ').next().unwrap();
    let secrets = read_secrets(&tmp);
    assert!(verify(&secrets.operator.unwrap().password_hash, password));
}

#[test]
fn operator_password_rejects_value_flag() {
    let tmp = TempDir::new().unwrap();
    install(&tmp);
    cmd(&tmp)
        .args(["operator-password", "--password", "new-password-123"])
        .assert()
        .failure();
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn send_signal(pid: u32, sig: &str) {
    let status = std::process::Command::new("kill")
        .args([sig, &pid.to_string()])
        .status()
        .unwrap();
    assert!(status.success());
}

fn wait_exit(
    child: &mut std::process::Child,
    timeout: std::time::Duration,
) -> Option<std::process::ExitStatus> {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if let Some(status) = child.try_wait().unwrap() {
            return Some(status);
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    None
}

#[test]
fn serve_writes_pid_file_and_reloads_on_sighup() {
    let tmp = TempDir::new().unwrap();
    let dir = config_dir(&tmp);
    let data = tmp.path().join("serve-data");
    let port = free_port();
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("config.toml"),
        format!(
            "bind = \"127.0.0.1:{port}\"\ndata_dir = \"{}\"\n",
            data.display()
        ),
    )
    .unwrap();
    install(&tmp);

    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_agent-comms"))
        .env("HOME", tmp.path())
        .env("XDG_DATA_HOME", tmp.path().join("data"))
        .env("XDG_CONFIG_HOME", tmp.path().join("xdg-config"))
        .env_remove("AGENT_COMMS_CONFIG_DIR")
        .env_remove("RUST_LOG")
        .arg("--config-dir")
        .arg(&dir)
        .arg("serve")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let pid = child.id();

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            break;
        }
        if let Some(status) = child.try_wait().unwrap() {
            panic!("serve exited early: {status}");
        }
        assert!(std::time::Instant::now() < deadline, "serve did not listen");
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    let pid_path = data.join("agent-comms.pid");
    assert_eq!(
        fs::read_to_string(&pid_path).unwrap().trim(),
        pid.to_string()
    );
    assert_eq!(mode(&pid_path), 0o600);

    // Change the secrets. The command signals the server through the pid file.
    cmd(&tmp)
        .args(["token", "rotate"])
        .assert()
        .success()
        .stdout(predicate::str::contains(format!("pid {pid}")));
    send_signal(pid, "-HUP");
    std::thread::sleep(std::time::Duration::from_millis(500));
    assert!(
        child.try_wait().unwrap().is_none(),
        "serve exited after SIGHUP"
    );
    assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_ok());

    send_signal(pid, "-TERM");
    let status = wait_exit(&mut child, std::time::Duration::from_secs(20));
    let status = match status {
        Some(s) => s,
        None => {
            let _ = child.kill();
            panic!("serve did not exit after SIGTERM");
        }
    };
    assert!(status.success(), "serve exit status {status}");
    assert!(!pid_path.exists(), "pid file not removed");
}
