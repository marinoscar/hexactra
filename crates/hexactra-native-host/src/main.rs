//! Native messaging host for Chrome extension

use anyhow::Result;
use clap::Parser;
use tokio::net::UnixListener;
use tracing::{info, error};

#[derive(Parser, Debug)]
#[command(name = "hexactra-native-host")]
#[command(about = "Native messaging host for Chrome extension")]
struct Args {
    /// Path to the control socket
    #[arg(short, long, default_value = "/tmp/hexactra-control.sock")]
    control_socket: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    
    tracing_subscriber::fmt::init();

    info!("Starting native messaging host");
    info!("Control socket: {}", args.control_socket);

    // Create control socket
    let _listener = UnixListener::bind(&args.control_socket)?;

    info!("Native messaging host started");

    // Keep running
    tokio::signal::ctrl_c().await?;
    
    Ok(())
}
