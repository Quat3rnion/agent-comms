//! `agent-comms install`.

use crate::cli::InstallArgs;
use crate::{paths, secrets_file, service, token};
use agent_comms_server::config::Config;
use anyhow::{anyhow, Result};
use std::path::{Path, PathBuf};

const CONFIG_HEADER: &str = "\
# agent-comms server configuration.
# Every setting is shown with its default value.
# Edit a value and restart the service to apply it.
# A missing setting uses the default.

";

const CONFIG_TLS_HINT: &str = "
# TLS is required when `bind` is not a loopback address.
# [tls]
# cert = \"/path/to/fullchain.pem\"
# key = \"/path/to/privkey.pem\"
";

fn default_config_text(config: &Config) -> Result<String> {
    let body = toml::to_string_pretty(config)?;
    Ok(format!("{CONFIG_HEADER}{body}{CONFIG_TLS_HINT}"))
}

fn absolute(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

pub fn run(config_dir: &Path, args: &InstallArgs) -> Result<()> {
    secrets_file::create_private_dir(config_dir)?;

    // Config file.
    let cfg_path = paths::config_file(config_dir);
    let config = if cfg_path.exists() {
        if args.port.is_some() {
            eprintln!(
                "warning: {} exists. --port is ignored. Edit `bind` in the file.",
                cfg_path.display()
            );
        }
        println!("Kept config {}", cfg_path.display());
        paths::load_config(config_dir, None)?
    } else {
        let mut c = Config {
            secrets_path: paths::default_secrets_file(config_dir),
            ..Config::default()
        };
        if let Some(port) = args.port {
            c.bind.set_port(port);
        }
        secrets_file::write_private_file(&cfg_path, default_config_text(&c)?.as_bytes())?;
        println!("Wrote config {}", cfg_path.display());
        c
    };
    config.validate().map_err(|e| anyhow!(e))?;
    secrets_file::create_private_dir(&config.data_dir)?;

    // Secrets.
    let mut secrets = if args.force {
        agent_comms_server::config::Secrets::default()
    } else {
        secrets_file::load_or_default(&config.secrets_path)?
    };

    let mut generated_password = None;
    let given_password = token::read_password(args.password_stdin, args.prompt)?;
    if args.force || given_password.is_some() || secrets.operator.is_none() {
        let (password, generated) = match given_password {
            Some(p) => (p, false),
            None => (token::generate_password(), true),
        };
        token::set_operator_password(&mut secrets, &password)?;
        if generated {
            generated_password = Some(password);
        }
    }

    let host = token::host_name();
    let token_path = paths::link_token_file(config_dir);
    let have_link =
        token_path.exists() && secrets.links.iter().any(|l| l.name == host && !l.revoked);
    let mut new_token = false;
    if !have_link {
        let t = token::generate_token();
        token::upsert_link(&mut secrets, &host, &t)?;
        // Write the hash first. If the token file write fails, a second
        // install run generates a new pair.
        secrets_file::write_secrets(&config.secrets_path, &secrets)?;
        secrets_file::write_private_file(&token_path, t.as_bytes())?;
        new_token = true;
    } else {
        // Credentials from before the server key existed: add the key when
        // the token file still matches the credential.
        if let Ok(t) = std::fs::read_to_string(&token_path) {
            token::backfill_server_key(&mut secrets, &host, t.trim());
        }
        secrets_file::write_secrets(&config.secrets_path, &secrets)?;
    }
    println!("Secrets file {}", config.secrets_path.display());
    if new_token {
        println!("Wrote link token {}", token_path.display());
    } else {
        println!("Kept link token {}", token_path.display());
    }

    // Service.
    if cfg!(any(target_os = "macos", target_os = "linux")) && !args.no_launchd {
        let exe = std::env::current_exe()?;
        service::install(&exe, &absolute(config_dir))?;
    }

    print_summary(&config, generated_password.as_deref());
    Ok(())
}

fn print_summary(config: &Config, password: Option<&str>) {
    println!();
    match password {
        Some(p) => {
            println!("Operator account: operator");
            println!("Operator password (shown once, store it now): {p}");
        }
        None => println!("Operator password: unchanged."),
    }
    let ip = config.bind.ip();
    let port = config.bind.port();
    let tls_flag = if config.tls.is_some() {
        "-tls"
    } else {
        "-notls"
    };
    println!();
    println!("WeeChat setup:");
    println!("  /server add agent-comms {ip}/{port} {tls_flag}");
    println!("  /set irc.server.agent-comms.sasl_mechanism plain");
    println!("  /set irc.server.agent-comms.sasl_username operator");
    println!(
        "  /set irc.server.agent-comms.sasl_password {}",
        password.unwrap_or("<operator password>")
    );
    println!(
        "  /set irc.server.agent-comms.capabilities message-tags,server-time,account-tag,away-notify,batch,labeled-response,draft/chathistory,draft/read-marker,draft/multiline,echo-message"
    );
    println!("  /connect agent-comms");
}
