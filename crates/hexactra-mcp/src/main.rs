//! Hexactra MCP server

use anyhow::Result;
use clap::Parser;
use tracing::info;

#[derive(Parser, Debug)]
#[command(name = "hexactra-mcp")]
#[command(about = "Hexactra Model Context Protocol server")]
struct Args {
    /// Path to config file
    #[arg(short, long)]
    config: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let _args = Args::parse();
    
    tracing_subscriber::fmt::init();

    info!("Hexactra MCP server starting");

    Ok(())
}
