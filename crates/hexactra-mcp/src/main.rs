//! `hexactra-mcp`: MCP server (stdio) that lets AI agents operate the
//! operator's browser through the Hexactra control plane (#178).
//!
//! Configure it in an MCP client as a stdio server:
//!
//! ```json
//! { "command": "hexactra-mcp", "env": { "HEXACTRA_URL": "http://127.0.0.1:8787" } }
//! ```
//!
//! The API token comes from `HEXACTRA_API_TOKEN` or
//! `$XDG_CONFIG_HOME/hexactra/api-token`.

mod server;

use std::path::PathBuf;

use anyhow::{Context, Result};
use hexactra_client::ControlClient;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

fn config_dir() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("hexactra")
}

fn read_token() -> Result<String> {
    if let Ok(t) = std::env::var("HEXACTRA_API_TOKEN") {
        if !t.trim().is_empty() {
            return Ok(t.trim().to_string());
        }
    }
    let f = std::env::var_os("HEXACTRA_TOKEN_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| config_dir().join("api-token"));
    Ok(std::fs::read_to_string(&f)
        .with_context(|| format!("reading API token from {}", f.display()))?
        .trim()
        .to_string())
}

#[tokio::main]
async fn main() -> Result<()> {
    if std::env::args().any(|a| a == "--version") {
        println!("hexactra-mcp {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    // stdout carries JSON-RPC; logs go to stderr.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("HEXACTRA_LOG")
                .unwrap_or_else(|_| "warn".into()),
        )
        .init();

    let url = std::env::var("HEXACTRA_URL").unwrap_or_else(|_| "http://127.0.0.1:8787".into());
    let client = ControlClient::new(&url, &read_token()?)?;
    let server = server::Server::new(client);

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        if let Some(resp) = server.handle_line(&line).await {
            stdout.write_all(resp.to_string().as_bytes()).await?;
            stdout.write_all(b"\n").await?;
            stdout.flush().await?;
        }
    }
    Ok(())
}
