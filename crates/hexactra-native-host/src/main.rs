//! Native messaging host for Chrome extension
//!
//! This process is launched by Chrome to bridge messages between the extension
//! and the session worker. It implements Chrome's Native Messaging protocol
//! (32-bit length-prefixed JSON) on stdout/stdin and communicates with the
//! worker via a Unix socket.

use anyhow::{Context, Result};
use clap::Parser;
use std::io::{self, Write};
use tracing::{info, error, warn, debug};

mod protocol;
mod bridge;

use protocol::{
    read_message, write_message, write_error, validate_envelope, create_error_message,
    create_ready_message, HostId, CorrelationId,
};
use bridge::worker_ready;

#[derive(Parser, Debug)]
#[command(name = "hexactra-native-host")]
#[command(about = "Native messaging host for Chrome extension")]
struct Args {
    /// Path to the control socket (Unix domain socket to worker)
    #[arg(short, long, default_value = "/tmp/hexactra-control.sock")]
    control_socket: String,

    /// Maximum message size in bytes
    #[arg(long, default_value_t = protocol::MAX_MESSAGE_SIZE)]
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

    // Host ID for this instance
    let host_id = HostId::new();

    loop {
        match read_message(&mut stdin.lock()) {
            Ok(message) => {
                debug!("Received message: {}", message);

                // Parse and validate the envelope
                match serde_json::from_str::<protocol::Envelope>(&message) {
                    Ok(envelope) => {
                        // Validate the envelope
                        if let Err(e) = validate_envelope(&envelope) {
                            error!("Invalid envelope: {}", e);
                            let error_msg = create_error_message(
                                &format!("Validation failed: {}", e),
                                envelope.correlation_id,
                            );
                            if let Err(e) = write_message(&mut stdout, &serde_json::to_string(&error_msg)?) {
                                error!("Failed to write error response: {}", e);
                            }
                            continue;
                        }

                        // Handle the message based on type
                        match handle_message(&envelope, &args.control_socket, host_id).await {
                            Ok(response) => {
                                if let Err(e) = write_message(&mut stdout, &response) {
                                    error!("Failed to write response: {}", e);
                                }
                            }
                            Err(e) => {
                                error!("Message handling failed: {}", e);
                                let error_msg = create_error_message(
                                    &e.to_string(),
                                    envelope.correlation_id,
                                );
                                if let Err(e) = write_message(&mut stdout, &serde_json::to_string(&error_msg)?) {
                                    error!("Failed to write error response: {}", e);
                                }
                            }
                        }
                    }
                    Err(e) => {
                        error!("Failed to parse message as envelope: {}", e);
                        // Try to extract correlation ID if possible
                        let error_msg = create_error_message(
                            &format!("Parse failed: {}", e),
                            CorrelationId::new(),
                        );
                        if let Err(e) = write_message(&mut stdout, &serde_json::to_string(&error_msg)?) {
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
async fn handle_message(
    envelope: &protocol::Envelope,
    socket_path: &str,
    host_id: HostId,
) -> Result<String> {
    debug!("Handling message type: {}", envelope.message_type);

    match envelope.message_type.as_str() {
        "hello" => {
            // Return ready message with worker identity
            let ready = create_ready_message("native-host", protocol::PROTOCOL_VERSION);
            serde_json::to_string(&ready).context("Failed to serialize ready message")
        }
        "heartbeat" => {
            // Return heartbeat response
            let response = protocol::Envelope {
                version: envelope.version.clone(),
                message_type: "heartbeat_response".to_string(),
                host_id,
                session_id: envelope.session_id,
                tab_id: envelope.tab_id,
                correlation_id: envelope.correlation_id,
                sequence_number: envelope.sequence_number + 1,
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
                sender_identity: protocol::SenderIdentity::Worker(protocol::WorkerIdentity {
                    worker_id: "native-host".to_string(),
                    protocol_version: protocol::PROTOCOL_VERSION.to_string(),
                }),
                payload: Some(serde_json::json!({"status": "ok"})),
            };
            serde_json::to_string(&response).context("Failed to serialize heartbeat response")
        }
        "get_capabilities" => {
            // Return capability information
            let capabilities = protocol::Capabilities {
                supports_screenshots: true,
                supports_click: true,
                supports_type: true,
                supports_navigate: true,
                supports_tabs: true,
                supports_javascript: true,
                supports_secret_transport: true,
            };
            let response = protocol::Envelope {
                version: envelope.version.clone(),
                message_type: "capabilities".to_string(),
                host_id,
                session_id: envelope.session_id,
                tab_id: envelope.tab_id,
                correlation_id: envelope.correlation_id,
                sequence_number: envelope.sequence_number + 1,
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
                sender_identity: protocol::SenderIdentity::Worker(protocol::WorkerIdentity {
                    worker_id: "native-host".to_string(),
                    protocol_version: protocol::PROTOCOL_VERSION.to_string(),
                }),
                payload: Some(serde_json::to_value(capabilities)?),
            };
            serde_json::to_string(&response).context("Failed to serialize capabilities response")
        }
        "store_secret" => {
            // Handle secret storage request
            handle_store_secret(envelope).await
        }
        "retrieve_secret" => {
            // Handle secret retrieval request
            handle_retrieve_secret(envelope).await
        }
        "verify_secret" => {
            // Handle secret verification request
            handle_verify_secret(envelope).await
        }
        _ => {
            // Forward unknown messages to worker
            forward_to_worker(envelope, socket_path).await
        }
    }
}

/// Forward a message to the session worker via Unix socket
async fn forward_to_worker(
    envelope: &protocol::Envelope,
    socket_path: &str,
) -> Result<String> {
    // TODO: Implement actual worker connection and message forwarding
    // For now, return a mock response

    debug!("Forwarding to worker at {}", socket_path);

    // Create a mock response
    let response = protocol::Envelope {
        version: envelope.version.clone(),
        message_type: "success".to_string(),
        host_id: HostId::new(),
        session_id: envelope.session_id,
        tab_id: envelope.tab_id,
        correlation_id: envelope.correlation_id,
        sequence_number: envelope.sequence_number + 1,
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        sender_identity: protocol::SenderIdentity::Worker(protocol::WorkerIdentity {
            worker_id: "native-host".to_string(),
            protocol_version: protocol::PROTOCOL_VERSION.to_string(),
        }),
        payload: Some(serde_json::json!({
            "status": "mock",
            "message": "Worker connection not yet implemented"
        })),
    };

    serde_json::to_string(&response).context("Failed to serialize response")
}

/// Handle secret storage request from Chrome extension
async fn handle_store_secret(envelope: &protocol::Envelope) -> Result<String> {
    let payload = envelope.payload.as_ref()
        .ok_or_else(|| anyhow::anyhow!("Missing payload for store_secret"))?;
    
    let value = payload.get("value")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing 'value' in payload"))?;
    
    let ttl_minutes = payload.get("ttl_minutes")
        .and_then(|v| v.as_i64())
        .unwrap_or(15); // Default 15 minutes

    // Store the secret in memory (never persisted)
    // In production, this would use a secure in-memory store
    debug!("Storing secret with TTL {} minutes", ttl_minutes);
    
    // For now, we just acknowledge the storage request
    // The actual secret handling would be done by the worker via IPC
    let response = protocol::Envelope {
        version: envelope.version.clone(),
        message_type: "success".to_string(),
        host_id: envelope.host_id,
        session_id: envelope.session_id,
        tab_id: envelope.tab_id,
        correlation_id: envelope.correlation_id,
        sequence_number: envelope.sequence_number + 1,
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        sender_identity: protocol::SenderIdentity::Worker(protocol::WorkerIdentity {
            worker_id: "native-host".to_string(),
            protocol_version: protocol::PROTOCOL_VERSION.to_string(),
        }),
        payload: Some(serde_json::json!({
            "status": "stored",
            "ttl_minutes": ttl_minutes
        })),
    };
    
    serde_json::to_string(&response).context("Failed to serialize store_secret response")
}

/// Handle secret retrieval request from Chrome extension
async fn handle_retrieve_secret(envelope: &protocol::Envelope) -> Result<String> {
    let payload = envelope.payload.as_ref()
        .ok_or_else(|| anyhow::anyhow!("Missing payload for retrieve_secret"))?;
    
    let secret_id = payload.get("secret_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing 'secret_id' in payload"))?;

    // Retrieve the secret (consumes it)
    debug!("Retrieving secret: {}", secret_id);
    
    // In production, this would retrieve from the worker's secret store
    let response = protocol::Envelope {
        version: envelope.version.clone(),
        message_type: "success".to_string(),
        host_id: envelope.host_id,
        session_id: envelope.session_id,
        tab_id: envelope.tab_id,
        correlation_id: envelope.correlation_id,
        sequence_number: envelope.sequence_number + 1,
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        sender_identity: protocol::SenderIdentity::Worker(protocol::WorkerIdentity {
            worker_id: "native-host".to_string(),
            protocol_version: protocol::PROTOCOL_VERSION.to_string(),
        }),
        payload: Some(serde_json::json!({
            "status": "retrieved",
            "secret_id": secret_id
        })),
    };
    
    serde_json::to_string(&response).context("Failed to serialize retrieve_secret response")
}

/// Handle secret verification request from Chrome extension
async fn handle_verify_secret(envelope: &protocol::Envelope) -> Result<String> {
    let payload = envelope.payload.as_ref()
        .ok_or_else(|| anyhow::anyhow!("Missing payload for verify_secret"))?;
    
    let secret_id = payload.get("secret_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing 'secret_id' in payload"))?;

    // Verify the secret is still valid
    debug!("Verifying secret: {}", secret_id);
    
    let response = protocol::Envelope {
        version: envelope.version.clone(),
        message_type: "success".to_string(),
        host_id: envelope.host_id,
        session_id: envelope.session_id,
        tab_id: envelope.tab_id,
        correlation_id: envelope.correlation_id,
        sequence_number: envelope.sequence_number + 1,
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        sender_identity: protocol::SenderIdentity::Worker(protocol::WorkerIdentity {
            worker_id: "native-host".to_string(),
            protocol_version: protocol::PROTOCOL_VERSION.to_string(),
        }),
        payload: Some(serde_json::json!({
            "status": "valid",
            "secret_id": secret_id
        })),
    };
    
    serde_json::to_string(&response).context("Failed to serialize verify_secret response")
}
