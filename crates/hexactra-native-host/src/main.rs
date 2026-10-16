//! Native messaging host for Chrome extension
//!
//! This process is launched by Chrome to bridge messages between the extension
//! and the session worker. It implements Chrome's Native Messaging protocol
//! (32-bit length-prefixed JSON) on stdout/stdin and communicates with the
//! worker via a Unix socket.

use anyhow::Result;
use clap::Parser;
use std::io::{self, Write};
use tracing::{info, error, warn, debug};

mod protocol;
mod bridge;

use protocol::{read_message, write_message, write_error, MAX_MESSAGE_SIZE};
use bridge::worker_ready;

#[derive(Parser, Debug)]
#[command(name = "hexactra-native-host")]
#[command(about = "Native messaging host for Chrome extension")]
struct Args {
    /// Path to the control socket (Unix domain socket to worker)
    #[arg(short, long, default_value = "/tmp/hexactra-control.sock")]
    control_socket: String,

    /// Maximum message size in bytes
    #[arg(long, default_value_t = MAX_MESSAGE_SIZE)]
    max_message_size: usize,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    
    tracing_subscriber::fmt::init();

    info!("Starting native messaging host");
    info!("Control socket: {}", args.control_socket);
    info!("Max message size: {} bytes", args.max_message_size);

    // Check if worker is available
    if !worker_ready(&args.control_socket) {
        warn!("Worker not ready at {}", args.control_socket);
    }

    info!("Native messaging host started, waiting for Chrome messages");

    // Main message loop
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    
    loop {
        match read_message(&mut stdin.lock()) {
            Ok(message) => {
                debug!("Received message: {}", message);
                
                // Forward to worker
                match handle_message(&message, &args.control_socket) {
                    Ok(response) => {
                        if let Err(e) = write_message(&mut stdout, &response) {
                            error!("Failed to write response: {}", e);
                            write_error(&format!("Response write failed: {}", e));
                        }
                    }
                    Err(e) => {
                        error!("Message handling failed: {}", e);
                        let error_msg = serde_json::json!({
                            "error": e.to_string(),
                            "timestamp": chrono::Utc::now().to_rfc3339()
                        });
                        if let Err(e) = write_message(&mut stdout, &error_msg.to_string()) {
                            error!("Failed to write error response: {}", e);
                        }
                    }
                }
            }
            Err(e) => {
                // Handle protocol errors
                match e.downcast_ref::<std::io::Error>() {
                    Some(io_err) if io_err.kind() == std::io::ErrorKind::UnexpectedEof => {
                        // Chrome closed the connection
                        info!("Chrome closed the native messaging connection");
                        break;
                    }
                    _ => {
                        error!("Failed to read message: {}", e);
                        write_error(&format!("Read failed: {}", e));
                    }
                }
            }
        }
        
        // Flush stdout after each message
        if let Err(e) = stdout.flush() {
            error!("Failed to flush stdout: {}", e);
        }
    }

    info!("Native messaging host shutting down");
    Ok(())
}

/// Handle a single message from Chrome
fn handle_message(_message: &str, _socket_path: &str) -> Result<String> {
    // For now, we just echo back a response
    // In a full implementation, this would forward to the worker
    
    // Create a simple response
    let response = serde_json::json!({
        "status": "ok",
        "host": "native-messaging",
        "timestamp": chrono::Utc::now().to_rfc3339()
    });

    Ok(response.to_string())
}
