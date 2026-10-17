//! Hexactra CLI - A command-line interface for the Hexactra browser automation runtime
//!
//! The CLI provides remote session management, browser actions, AI goal execution,
//! and HITL (Human in the Loop) interaction through a secure, typed interface.

use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use tracing::{info, warn};

// Re-export types from hexactra-control for convenience
use hexactra_control::config::Config;

/// Hexactra CLI configuration
#[derive(Parser, Debug)]
#[command(name = "hexactra")]
#[command(about = "Hexactra CLI for browser automation runtime", long_about = None)]
struct Cli {
    /// Path to config file (optional)
    #[arg(short, long)]
    config: Option<PathBuf>,

    /// Verbose output (multiple -v increases verbosity)
    #[arg(short, long, action = clap::ArgAction::Count)]
    verbose: u8,

    /// Output format (json or text)
    #[arg(short, long, default_value = "text")]
    output: String,

    /// Subcommand to execute
    #[command(subcommand)]
    command: Commands,
}

/// Available CLI commands
#[derive(Subcommand, Debug)]
enum Commands {
    /// Session management commands
    #[command(subcommand)]
    Session(SessionCommands),
    /// Profile management commands
    #[command(subcommand)]
    Profile(ProfileCommands),
    /// Host management commands
    #[command(subcommand)]
    Host(HostCommands),
    /// Browser action commands
    #[command(subcommand)]
    Action(ActionCommands),
    /// Agent run commands
    #[command(subcommand)]
    Agent(AgentCommands),
    /// HITL (Human in the Loop) commands
    #[command(subcommand)]
    Hitl(HitlCommands),
    /// Show version information
    Version,
}

/// Session management commands
#[derive(Subcommand, Debug)]
enum SessionCommands {
    /// List all sessions
    List,
    /// Show session details
    Status { session_id: String },
    /// Create a new session
    Create { profile_id: String },
    /// Stop a session
    Stop { session_id: String },
}

/// Profile management commands
#[derive(Subcommand, Debug)]
enum ProfileCommands {
    /// List all profiles
    List,
    /// Show profile details
    Status { profile_id: String },
    /// Create a new profile
    Create { name: String, chrome_profile_path: Option<String> },
    /// Delete a profile
    Delete { profile_id: String },
}

/// Host management commands
#[derive(Subcommand, Debug)]
enum HostCommands {
    /// List all hosts
    List,
    /// Show host details
    Status { host_id: String },
}

/// Browser action commands
#[derive(Subcommand, Debug)]
enum ActionCommands {
    /// Execute a click action
    Click { session_id: String, selector: String },
    /// Execute a type action
    Type { session_id: String, selector: String, text: String },
    /// Execute a navigate action
    Navigate { session_id: String, url: String },
    /// Take a screenshot
    Screenshot { session_id: String },
}

/// Agent run commands
#[derive(Subcommand, Debug)]
enum AgentCommands {
    /// Start an agent run
    Start { session_id: String, goal: String },
    /// Show agent run status
    Status { session_id: String },
    /// Stop an agent run
    Stop { session_id: String },
}

/// HITL (Human in the Loop) commands
#[derive(Subcommand, Debug)]
enum HitlCommands {
    /// List pending HITL requests
    List { session_id: String },
    /// Show HITL request details
    Status { request_id: String },
    /// Approve a HITL request
    Approve { request_id: String, owner_id: String },
    /// Reject a HITL request
    Reject { request_id: String, owner_id: String },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    // Set up logging based on verbosity
    let log_level = match cli.verbose {
        0 => "warn",
        1 => "info",
        2 => "debug",
        _ => "trace",
    };

    tracing_subscriber::fmt()
        .with_max_level(match log_level {
            "trace" => tracing::Level::TRACE,
            "debug" => tracing::Level::DEBUG,
            "info" => tracing::Level::INFO,
            "warn" => tracing::Level::WARN,
            _ => tracing::Level::INFO,
        })
        .init();

    info!("Hexactra CLI starting");
    info!("Log level: {}", log_level);

    // Load configuration
    let config = Config::load()?;

    match cli.command {
        Commands::Session(cmd) => handle_session_command(cmd, &config).await,
        Commands::Profile(cmd) => handle_profile_command(cmd, &config).await,
        Commands::Host(cmd) => handle_host_command(cmd, &config).await,
        Commands::Action(cmd) => handle_action_command(cmd, &config).await,
        Commands::Agent(cmd) => handle_agent_command(cmd, &config).await,
        Commands::Hitl(cmd) => handle_hitl_command(cmd, &config).await,
        Commands::Version => {
            println!("hexactra-cli {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
    }
}

async fn handle_session_command(cmd: SessionCommands, config: &Config) -> Result<()> {
    match cmd {
        SessionCommands::List => {
            info!("Listing sessions (config: {:?})", config.redacted());
            // TODO: Implement session listing
            warn!("Session list not yet implemented");
            Ok(())
        }
        SessionCommands::Status { session_id } => {
            info!("Getting session status: {}", session_id);
            // TODO: Implement session status
            warn!("Session status not yet implemented");
            Ok(())
        }
        SessionCommands::Create { profile_id } => {
            info!("Creating session with profile: {}", profile_id);
            // TODO: Implement session creation
            warn!("Session creation not yet implemented");
            Ok(())
        }
        SessionCommands::Stop { session_id } => {
            info!("Stopping session: {}", session_id);
            // TODO: Implement session stop
            warn!("Session stop not yet implemented");
            Ok(())
        }
    }
}

async fn handle_profile_command(cmd: ProfileCommands, config: &Config) -> Result<()> {
    match cmd {
        ProfileCommands::List => {
            info!("Listing profiles (config: {:?})", config.redacted());
            // TODO: Implement profile listing
            warn!("Profile list not yet implemented");
            Ok(())
        }
        ProfileCommands::Status { profile_id } => {
            info!("Getting profile status: {}", profile_id);
            // TODO: Implement profile status
            warn!("Profile status not yet implemented");
            Ok(())
        }
        ProfileCommands::Create { name, chrome_profile_path } => {
            info!("Creating profile: {} with path: {:?}", name, chrome_profile_path);
            // TODO: Implement profile creation
            warn!("Profile creation not yet implemented");
            Ok(())
        }
        ProfileCommands::Delete { profile_id } => {
            info!("Deleting profile: {}", profile_id);
            // TODO: Implement profile deletion
            warn!("Profile deletion not yet implemented");
            Ok(())
        }
    }
}

async fn handle_host_command(cmd: HostCommands, config: &Config) -> Result<()> {
    match cmd {
        HostCommands::List => {
            info!("Listing hosts (config: {:?})", config.redacted());
            // TODO: Implement host listing
            warn!("Host list not yet implemented");
            Ok(())
        }
        HostCommands::Status { host_id } => {
            info!("Getting host status: {}", host_id);
            // TODO: Implement host status
            warn!("Host status not yet implemented");
            Ok(())
        }
    }
}

async fn handle_action_command(cmd: ActionCommands, _config: &Config) -> Result<()> {
    match cmd {
        ActionCommands::Click { session_id, selector } => {
            info!("Executing click action on {} in session {}", selector, session_id);
            // TODO: Implement click action
            warn!("Click action not yet implemented");
            Ok(())
        }
        ActionCommands::Type { session_id, selector, text } => {
            info!(
                "Executing type action on {} with text '{}' in session {}",
                selector, text, session_id
            );
            // TODO: Implement type action
            warn!("Type action not yet implemented");
            Ok(())
        }
        ActionCommands::Navigate { session_id, url } => {
            info!("Executing navigate action to {} in session {}", url, session_id);
            // TODO: Implement navigate action
            warn!("Navigate action not yet implemented");
            Ok(())
        }
        ActionCommands::Screenshot { session_id } => {
            info!("Taking screenshot for session {}", session_id);
            // TODO: Implement screenshot action
            warn!("Screenshot action not yet implemented");
            Ok(())
        }
    }
}

async fn handle_agent_command(cmd: AgentCommands, _config: &Config) -> Result<()> {
    match cmd {
        AgentCommands::Start { session_id, goal } => {
            info!("Starting agent run with goal: '{}' in session {}", goal, session_id);
            // TODO: Implement agent start
            warn!("Agent start not yet implemented");
            Ok(())
        }
        AgentCommands::Status { session_id } => {
            info!("Getting agent status for session {}", session_id);
            // TODO: Implement agent status
            warn!("Agent status not yet implemented");
            Ok(())
        }
        AgentCommands::Stop { session_id } => {
            info!("Stopping agent run for session {}", session_id);
            // TODO: Implement agent stop
            warn!("Agent stop not yet implemented");
            Ok(())
        }
    }
}

async fn handle_hitl_command(cmd: HitlCommands, _config: &Config) -> Result<()> {
    match cmd {
        HitlCommands::List { session_id } => {
            info!("Listing HITL requests for session {}", session_id);
            // TODO: Implement HITL list
            warn!("HITL list not yet implemented");
            Ok(())
        }
        HitlCommands::Status { request_id } => {
            info!("Getting HITL request status: {}", request_id);
            // TODO: Implement HITL status
            warn!("HITL status not yet implemented");
            Ok(())
        }
        HitlCommands::Approve { request_id, owner_id } => {
            info!("Approving HITL request {} by owner {}", request_id, owner_id);
            // TODO: Implement HITL approve
            warn!("HITL approve not yet implemented");
            Ok(())
        }
        HitlCommands::Reject { request_id, owner_id } => {
            info!("Rejecting HITL request {} by owner {}", request_id, owner_id);
            // TODO: Implement HITL reject
            warn!("HITL reject not yet implemented");
            Ok(())
        }
    }
}
