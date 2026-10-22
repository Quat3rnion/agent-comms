mod cli;
mod install;
#[cfg(not(target_os = "linux"))]
mod launchd;
mod notify;
mod paths;
mod secrets_file;
mod serve;
#[cfg(target_os = "linux")]
mod systemd;
mod token;

#[cfg(not(target_os = "linux"))]
use launchd as service;
#[cfg(target_os = "linux")]
use systemd as service;

use anyhow::{anyhow, Result};
use clap::Parser;

use cli::{Cli, Command, ConfigCmd};

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let config_dir = cli
        .config_dir
        .unwrap_or_else(agent_comms_server::config::default_config_dir);

    match cli.command {
        Command::Serve(args) => {
            serve::run(&config_dir, args.config.as_deref(), args.log_format).await
        }
        Command::Install(args) => install::run(&config_dir, &args),
        Command::Uninstall => service::uninstall(),
        Command::Token(cmd) => token::run(&config_dir, cmd),
        Command::OperatorPassword(args) => token::operator_password(&config_dir, &args),
        Command::Config(ConfigCmd::Check) => {
            let config = paths::load_config(&config_dir, None)?;
            config.validate().map_err(|e| anyhow!(e))?;
            println!("{}", toml::to_string_pretty(&config)?);
            Ok(())
        }
    }
}
