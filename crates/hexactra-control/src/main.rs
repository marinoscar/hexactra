//! `hexactra-control`: the control-plane server for remote browser control.

use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use hexactra_control::runtime::credentials::Credentials;
use hexactra_control::runtime::persist::StateDb;
use hexactra_control::runtime::webhooks::{WebhookConfig, Webhooks};
use hexactra_control::runtime::{self, ApiState, RuntimeStore};
use std::time::Duration;

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
        /// State database (hosts, sessions, handoffs, credentials). Defaults
        /// to `$XDG_DATA_HOME/hexactra/control.db`.
        #[arg(long, env = "HEXACTRA_STATE_DB")]
        state_db: Option<PathBuf>,
    },
    /// Print the path of the default token file.
    TokenPath,
}

/// Resolves on SIGTERM (docker stop, systemd) or Ctrl-C.
async fn stop_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = term.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

fn default_token_file() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("hexactra")
        .join("api-token")
}

#[tokio::main]
async fn main() -> Result<()> {
    hexactra_otel::init("hexactra-control");

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
            state_db,
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
            let store = RuntimeStore::new();
            let credentials = Credentials::new(&token);
            let db_path = state_db.unwrap_or_else(|| {
                dirs::data_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join("hexactra")
                    .join("control.db")
            });
            let db = StateDb::open(&db_path)?;
            db.restore(&store, &credentials)?;
            db.spawn_saver(store.clone(), credentials.clone(), Duration::from_secs(1));
            let state = ApiState::with_parts(store.clone(), webhooks, credentials.clone());
            let result = runtime::serve(listener, state, stop_signal()).await;
            db.flush(&store, &credentials);
            tracing::info!(path = %db.path().display(), "state saved; stopped");
            hexactra_otel::shutdown();
            result
        }
    }
}
