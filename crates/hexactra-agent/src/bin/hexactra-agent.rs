//! Hexactra Host Agent CLI
//!
//! This binary provides the command-line interface for managing the Hexactra host agent service.

use anyhow::Result;
use clap::{Parser, Subcommand};
use hexactra_agent::{AgentConfig, AgentService};
use std::path::PathBuf;
use tokio::signal;
use tracing::{error, info, warn};

/// Hexactra Host Agent
#[derive(Parser)]
#[command(name = "hexactra-agent")]
#[command(about = "Hexactra Host Agent Service", long_about = None)]
struct Cli {
    /// Path to the configuration file
    #[arg(short, long)]
    config: Option<PathBuf>,

    /// Enable verbose output (debug level)
    #[arg(short, long)]
    verbose: bool,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Run the agent daemon
    Daemon,
    /// Show health status
    Health,
    /// Stop the agent service
    Stop,
    /// Show version information
    Version,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    // Initialize logging
    let log_level = if cli.verbose { "debug" } else { "info" };
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new(format!("hexactra_agent={}", log_level)))
        .init();

    match cli.command {
        Commands::Daemon => run_daemon().await,
        Commands::Health => show_health().await,
        Commands::Stop => stop_service().await,
        Commands::Version => show_version(),
    }
}

async fn run_daemon() -> Result<()> {
    info!("Starting Hexactra Host Agent daemon");

    // Load configuration
    let config = load_config()?;

    let mut service = AgentService::new(config);

    // Set up signal handlers for graceful shutdown
    let mut shutdown = signal::unix::signal(signal::unix::SignalKind::terminate())?;
    
    tokio::select! {
        result = service.start() => {
            if let Err(e) = result {
                error!("Agent service failed: {}", e);
                return Err(e);
            }
        }
        _ = shutdown.recv() => {
            info!("Received shutdown signal");
            service.stop().await?;
        }
    }

    Ok(())
}

async fn show_health() -> Result<()> {
    // For now, just log that health check would be implemented
    info!("Health check endpoint would be available at /health");
    Ok(())
}

async fn stop_service() -> Result<()> {
    warn!("Stop command would send signal to running daemon");
    Ok(())
}

fn show_version() -> Result<()> {
    println!("hexactra-agent {}", env!("CARGO_PKG_VERSION"));
    Ok(())
}

fn load_config() -> Result<AgentConfig> {
    // Load from environment variables with fallback to defaults
    let config = AgentConfig {
        control_socket_path: std::env::var("HEXACTRA_CONTROL_SOCKET")
            .unwrap_or_else(|_| "/run/hexactra/agent.sock".to_string()),
        chrome_profile_path: std::env::var("HEXACTRA_CHROME_PROFILE_PATH").ok(),
        service_uid: std::env::var("HEXACTRA_SERVICE_UID")
            .ok()
            .and_then(|s| s.parse::<u32>().ok()),
        service_gid: std::env::var("HEXACTRA_SERVICE_GID")
            .ok()
            .and_then(|s| s.parse::<u32>().ok()),
        health_endpoint_path: "/health".to_string(),
    };

    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cli_parsing() {
        let cli = Cli::parse_from(["hexactra-agent", "daemon"]);
        match cli.command {
            Commands::Daemon => (),
            _ => panic!("Expected Daemon command"),
        }
    }

    #[test]
    fn test_load_config() {
        // Test with default values (no env vars set)
        std::env::set_var("HEXACTRA_CONTROL_SOCKET", "/tmp/test.sock");
        
        let config = load_config().unwrap();
        assert_eq!(config.control_socket_path, "/tmp/test.sock");
    }
}
