//! Command-line definition (clap derive).

use clap::{Args, Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(
    name = "agent-comms",
    version,
    about = "Local IRC server for agent communication"
)]
pub struct Cli {
    /// Directory of config.toml, secrets.toml and link-token.
    #[arg(
        long,
        global = true,
        env = "AGENT_COMMS_CONFIG_DIR",
        value_name = "DIR"
    )]
    pub config_dir: Option<PathBuf>,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Run the server.
    Serve(ServeArgs),
    /// Create config, secrets, link token and the launchd service.
    Install(InstallArgs),
    /// Stop and remove the launchd service. Data stays.
    Uninstall,
    /// Manage link tokens.
    #[command(subcommand)]
    Token(TokenCmd),
    /// Set or regenerate the operator password.
    OperatorPassword(OperatorPasswordArgs),
    /// Check the configuration.
    #[command(subcommand)]
    Config(ConfigCmd),
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum LogFormat {
    Text,
    Json,
}

#[derive(Debug, Args)]
pub struct ServeArgs {
    /// Config file. Default: <config-dir>/config.toml.
    #[arg(long, value_name = "FILE")]
    pub config: Option<PathBuf>,
    /// Log format.
    #[arg(long, value_enum, default_value_t = LogFormat::Text)]
    pub log_format: LogFormat,
}

#[derive(Debug, Args)]
pub struct InstallArgs {
    /// Replace existing secrets (operator password and all link tokens).
    #[arg(long)]
    pub force: bool,
    /// Do not write or load the launchd service.
    #[arg(long)]
    pub no_launchd: bool,
    /// Use this operator password instead of a random one.
    #[arg(long, value_name = "PW")]
    pub operator_password: Option<String>,
    /// Listen port for a new config file.
    #[arg(long, value_name = "PORT")]
    pub port: Option<u16>,
}

#[derive(Debug, Subcommand)]
pub enum TokenCmd {
    /// List link credentials.
    List,
    /// Generate a new token for a name (default: host name).
    Rotate {
        #[arg(long, value_name = "N")]
        name: Option<String>,
    },
    /// Revoke the credential with this name.
    Revoke { name: String },
    /// Print the path of the link-token file.
    ShowPath,
}

#[derive(Debug, Args)]
pub struct OperatorPasswordArgs {
    /// New password. Default: a random password.
    #[arg(long, value_name = "PW", conflicts_with = "prompt")]
    pub password: Option<String>,
    /// Read the new password from the terminal.
    #[arg(long)]
    pub prompt: bool,
}

#[derive(Debug, Subcommand)]
pub enum ConfigCmd {
    /// Parse and validate the config. Print the effective config.
    Check,
}
