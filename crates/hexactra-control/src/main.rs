//! `hexactra-control`: the control-plane server for remote browser control.

use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use hexactra_control::runtime::webhooks::{WebhookConfig, Webhooks};
use hexactra_control::runtime::{self, ApiState, RuntimeStore};

#[derive(Parser)]
#[command(name = "hexactra-control", version, about = "Hexactra control plane")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the control-plane HTTP API.
    Serve {
        /// Address to listen on. Loopback by default; reach it remotely through
        /// an SSH tunnel or a private network.
        #[arg(long, env = "HEXACTRA_BIND", default_value = "127.0.0.1:8787")]
        bind: SocketAddr,
        /// Allow listening on a non-loopback address.
        #[arg(long, env = "HEXACTRA_ALLOW_REMOTE_BIND")]
        allow_remote_bind: bool,
        /// File holding the bearer token. Defaults to
        /// `$XDG_CONFIG_HOME/hexactra/api-token`, generated on first start.
        #[arg(long, env = "HEXACTRA_TOKEN_FILE")]
        token_file: Option<PathBuf>,
        /// External base URL of this server (e.g. https://hexactra.example.test),
        /// used to put clickable respond links in webhook payloads.
        #[arg(long, env = "HEXACTRA_PUBLIC_URL")]
        public_url: Option<String>,
        /// Webhook registry file. Defaults to `$XDG_CONFIG_HOME/hexactra/webhooks.json`.
        #[arg(long, env = "HEXACTRA_WEBHOOKS_FILE")]
        webhooks_file: Option<PathBuf>,
        /// Allow webhook targets over http or on private, loopback or CGNAT
        /// (Tailscale) addresses. Link-local and metadata addresses stay blocked.
        #[arg(long, env = "HEXACTRA_WEBHOOK_ALLOW_INSECURE")]
        webhook_allow_insecure: bool,
    },
    /// Print the path of the default token file.
    TokenPath,
}

fn default_token_file() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("hexactra")
        .join("api-token")
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    match Cli::parse().command {
        Command::TokenPath => {
            println!("{}", default_token_file().display());
            Ok(())
        }
        Command::Serve {
            bind,
            allow_remote_bind,
            token_file,
            public_url,
            webhooks_file,
            webhook_allow_insecure,
        } => {
            runtime::check_bind(&bind, allow_remote_bind)?;
            let explicit = std::env::var("HEXACTRA_API_TOKEN").ok();
            let (token, created) =
                runtime::resolve_token(explicit, token_file.as_deref(), &default_token_file())?;
            if let Some(path) = created {
                tracing::info!(path = %path.display(), "generated API token");
            }
            let listener = tokio::net::TcpListener::bind(bind)
                .await
                .with_context(|| format!("binding {bind}"))?;
            tracing::info!(addr = %listener.local_addr()?, "hexactra-control listening");
            let webhooks = Webhooks::load(WebhookConfig {
                file: Some(
                    webhooks_file
                        .unwrap_or_else(|| default_token_file().with_file_name("webhooks.json")),
                ),
                public_url: public_url.filter(|u| !u.trim().is_empty()),
                allow_insecure: webhook_allow_insecure,
                ..Default::default()
            })?;
            tracing::info!(count = webhooks.list().len(), "webhooks loaded");
            let state = ApiState::with_webhooks(RuntimeStore::new(), &token, webhooks);
            runtime::serve(listener, state, async {
                let _ = tokio::signal::ctrl_c().await;
            })
            .await
        }
    }
}
