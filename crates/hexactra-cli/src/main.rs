//! Hexactra CLI

use anyhow::Result;
use clap::Parser;
use tracing::info;

#[derive(Parser, Debug)]
#[command(name = "hexactra")]
#[command(about = "Hexactra CLI for browser automation runtime")]
struct Args {
    /// Path to config file
    #[arg(short, long)]
    config: Option<String>,

    /// Verbose output
    #[arg(short, long)]
    verbose: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let _args = Args::parse();
    
    if cfg!(debug_assertions) {
        tracing_subscriber::fmt::init();
    } else {
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::INFO)
            .init();
    }

    info!("Hexactra CLI started");

    Ok(())
}
