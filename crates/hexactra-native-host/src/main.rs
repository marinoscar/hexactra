//! `hexactra-native-host`: Chrome native messaging host for the Hexactra
//! extension (#176).
//!
//! Chrome starts this process when the extension calls
//! `chrome.runtime.connectNative("com.hexactra.nativehost")` and talks to it
//! over stdin/stdout with 4-byte native-endian length-prefixed JSON. This
//! process relays those messages to the host agent's Unix socket
//! (see `hexactra_core::bridge`) and back.
//!
//! - The extension stays connected while the agent restarts: this process
//!   reconnects to the socket every second and tells the extension
//!   `{"type":"agent_connected"}` / `{"type":"agent_disconnected"}`.
//! - The extension's latest `hello` frame is replayed to every new agent
//!   connection.
//! - Logs go to stderr only; stdout is the protocol channel.
//! - The process exits when Chrome closes stdin.

mod relay;

use std::time::Duration;

use anyhow::Result;
use hexactra_core::bridge::bridge_socket_path;

#[tokio::main]
async fn main() -> Result<()> {
    // Chrome passes the caller origin (and on some platforms
    // --parent-window=...) as arguments; they are informational only.
    if std::env::args().any(|a| a == "--version") {
        println!("hexactra-native-host {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("HEXACTRA_LOG")
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let socket = bridge_socket_path();
    tracing::info!(socket = %socket.display(), "native host started");
    relay::run(
        tokio::io::stdin(),
        tokio::io::stdout(),
        socket,
        Duration::from_secs(1),
    )
    .await
}
