//! `hexactra-agent`: host agent that lets the control plane drive the
//! operator's own Chrome (#177).

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use hexactra_agent::remote_daemon::{self, DaemonConfig};
use hexactra_core::bridge::bridge_socket_path;

#[derive(Parser)]
#[command(name = "hexactra-agent", version, about = "Hexactra host agent")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Connect to the control plane and serve browser operations (attach mode).
    Daemon {
        /// Control plane URL.
        #[arg(long, env = "HEXACTRA_URL", default_value = "http://127.0.0.1:8787")]
        url: String,
        /// File with the API token (default: $XDG_CONFIG_HOME/hexactra/api-token).
        /// `HEXACTRA_API_TOKEN` overrides it.
        #[arg(long, env = "HEXACTRA_TOKEN_FILE")]
        token_file: Option<PathBuf>,
        /// Display name for this host (default: the machine's hostname).
        #[arg(long, env = "HEXACTRA_HOST_NAME")]
        name: Option<String>,
        /// Unix socket the native messaging host connects to.
        #[arg(long, env = "HEXACTRA_BRIDGE_SOCKET")]
        bridge_socket: Option<PathBuf>,
    },
    /// Print the bridge socket path the native host will use.
    SocketPath,
    /// Print version.
    Version,
}

fn config_dir() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("hexactra")
}

fn hostname() -> String {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "hexactra-host".to_string())
}

fn read_token(token_file: Option<PathBuf>) -> Result<String> {
    if let Ok(t) = std::env::var("HEXACTRA_API_TOKEN") {
        if !t.trim().is_empty() {
            return Ok(t.trim().to_string());
        }
    }
    let file = token_file.unwrap_or_else(|| config_dir().join("api-token"));
    let t = std::fs::read_to_string(&file).with_context(|| {
        format!(
            "reading API token from {} (set HEXACTRA_API_TOKEN or --token-file)",
            file.display()
        )
    })?;
    Ok(t.trim().to_string())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    match Cli::parse().command {
        Commands::Version => {
            println!("hexactra-agent {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Commands::SocketPath => {
            println!("{}", bridge_socket_path().display());
            Ok(())
        }
        Commands::Daemon {
            url,
            token_file,
            name,
            bridge_socket,
        } => {
            let cfg = DaemonConfig {
                control_url: url,
                token: read_token(token_file)?,
                host_name: name.unwrap_or_else(hostname),
                host_id_file: Some(config_dir().join("host-id")),
                bridge_socket: bridge_socket.unwrap_or_else(bridge_socket_path),
                poll_wait: Duration::from_secs(25),
            };
            tokio::select! {
                r = remote_daemon::run(cfg) => r,
                _ = tokio::signal::ctrl_c() => {
                    tracing::info!("shutting down");
                    Ok(())
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_parses_daemon() {
        let cli = Cli::parse_from(["hexactra-agent", "daemon", "--url", "http://h:1"]);
        assert!(matches!(cli.command, Commands::Daemon { .. }));
    }
}
