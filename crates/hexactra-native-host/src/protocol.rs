//! Native Messaging protocol implementation
//!
//! Chrome's Native Messaging protocol uses 32-bit length-prefixed JSON messages.
//! This module provides encoding and decoding functions for the protocol.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fmt::Display;
use std::io::{Read, Write};

/// Maximum message size in bytes (1 MB as per Chrome limits)
pub const MAX_MESSAGE_SIZE: usize = 1024 * 1024;

/// Protocol version for extension-worker communication
pub const PROTOCOL_VERSION: &str = "1.0.0";

/// Unique identifier for a host instance
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct HostId(pub uuid::Uuid);

impl HostId {
    pub fn new() -> Self {
        HostId(uuid::Uuid::new_v4())
    }

    pub fn from_uuid(uuid: uuid::Uuid) -> Self {
        HostId(uuid)
    }

    pub fn as_uuid(&self) -> uuid::Uuid {
        self.0
    }
}

impl Default for HostId {
    fn default() -> Self {
        Self::new()
    }
}

/// Unique identifier for a session
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionId(pub uuid::Uuid);

impl SessionId {
    pub fn new() -> Self {
        SessionId(uuid::Uuid::new_v4())
    }

    pub fn from_uuid(uuid: uuid::Uuid) -> Self {
        SessionId(uuid)
    }

    pub fn as_uuid(&self) -> uuid::Uuid {
        self.0
    }
}

impl Default for SessionId {
    fn default() -> Self {
        Self::new()
    }
}

/// Unique identifier for a tab
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TabId(pub i32);

impl TabId {
    pub fn new(id: i32) -> Self {
        TabId(id)
    }

    pub fn as_i32(&self) -> i32 {
        self.0
    }
}

/// Unique identifier for a correlation/operation
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CorrelationId(pub uuid::Uuid);

impl CorrelationId {
    pub fn new() -> Self {
        CorrelationId(uuid::Uuid::new_v4())
    }

    pub fn from_uuid(uuid: uuid::Uuid) -> Self {
        CorrelationId(uuid)
    }

    pub fn as_uuid(&self) -> uuid::Uuid {
        self.0
    }
}

impl Default for CorrelationId {
    fn default() -> Self {
        Self::new()
    }
}

/// Message types for extension-worker communication
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageType {
    /// Handshake messages
    Hello,
    Ready,
    Goodbye,
    /// Action messages
    Navigate { url: String },
    Click { selector: String },
    Type { selector: String, text: String },
    Screenshot,
    /// Secret transport messages
    StoreSecret { value: String, ttl_minutes: i64 },
    RetrieveSecret { secret_id: String },
    VerifySecret { secret_id: String },
    /// Response messages
    Success { data: Option<serde_json::Value> },
    Error { message: String },
    /// Protocol control messages
    Heartbeat,
    Reconnect { session_id: SessionId },
    /// Capability negotiation
    GetCapabilities,
    Capabilities { capabilities: Vec<String> },
}

impl Display for MessageType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MessageType::Hello => write!(f, "hello"),
            MessageType::Ready => write!(f, "ready"),
            MessageType::Goodbye => write!(f, "goodbye"),
            MessageType::Navigate { .. } => write!(f, "navigate"),
            MessageType::Click { .. } => write!(f, "click"),
            MessageType::Type { .. } => write!(f, "type"),
            MessageType::Screenshot => write!(f, "screenshot"),
            MessageType::StoreSecret { .. } => write!(f, "store_secret"),
            MessageType::RetrieveSecret { .. } => write!(f, "retrieve_secret"),
            MessageType::VerifySecret { .. } => write!(f, "verify_secret"),
            MessageType::Success { .. } => write!(f, "success"),
            MessageType::Error { .. } => write!(f, "error"),
            MessageType::Heartbeat => write!(f, "heartbeat"),
            MessageType::Reconnect { .. } => write!(f, "reconnect"),
            MessageType::GetCapabilities => write!(f, "get_capabilities"),
            MessageType::Capabilities { .. } => write!(f, "capabilities"),
        }
    }
}

/// Extension identity for authentication
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtensionIdentity {
    pub extension_id: String,
    pub version: String,
    pub origin: String,
}

/// Worker identity for authentication
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkerIdentity {
    pub worker_id: String,
    pub protocol_version: String,
}

/// Authenticated message envelope
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope {
    /// Protocol version
    pub version: String,
    /// Message type
    #[serde(rename = "type")]
    pub message_type: String,
    /// Host instance ID
    pub host_id: HostId,
    /// Session ID (if applicable)
    pub session_id: Option<SessionId>,
    /// Tab ID (if applicable)
    pub tab_id: Option<TabId>,
    /// Correlation/operation ID for request/response matching
    pub correlation_id: CorrelationId,
    /// Sequence number for ordering
    pub sequence_number: u64,
    /// Timestamp for heartbeats and timeouts
    pub timestamp: u64,
    /// Sender identity (extension or worker)
    #[serde(rename = "sender")]
    pub sender_identity: SenderIdentity,
    /// Message payload
    pub payload: Option<serde_json::Value>,
}

/// Sender identity (extension or worker)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum SenderIdentity {
    Extension(ExtensionIdentity),
    Worker(WorkerIdentity),
}

/// Capability flags for negotiation
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    pub supports_screenshots: bool,
    pub supports_click: bool,
    pub supports_type: bool,
    pub supports_navigate: bool,
    pub supports_tabs: bool,
    pub supports_javascript: bool,
    /// Supports secure secret transport for passwords/OTPs
    pub supports_secret_transport: bool,
}

/// Read a single native message from stdin
///
/// The message format is:
/// - 4 bytes (little-endian u32): message length
/// - N bytes: JSON message
pub fn read_message<R: Read>(reader: &mut R) -> Result<String> {
    // Read the 4-byte length prefix
    let mut len_bytes = [0u8; 4];
    reader
        .read_exact(&mut len_bytes)
        .context("Failed to read message length")?;

    let msg_len = u32::from_le_bytes(len_bytes) as usize;

    // Validate message size
    if msg_len > MAX_MESSAGE_SIZE {
        return Err(anyhow::anyhow!(
            "Message too large: {} bytes (max: {})",
            msg_len,
            MAX_MESSAGE_SIZE
        ));
    }

    // Read the message body
    let mut buffer = vec![0u8; msg_len];
    reader
        .read_exact(&mut buffer)
        .context("Failed to read message body")?;

    String::from_utf8(buffer).context("Message is not valid UTF-8")
}

/// Write a single native message to stdout
///
/// The message format is:
/// - 4 bytes (little-endian u32): message length
/// - N bytes: JSON message
pub fn write_message<W: Write>(writer: &mut W, message: &str) -> Result<()> {
    let msg_bytes = message.as_bytes();

    if msg_bytes.len() > MAX_MESSAGE_SIZE {
        return Err(anyhow::anyhow!(
            "Message too large: {} bytes (max: {})",
            msg_bytes.len(),
            MAX_MESSAGE_SIZE
        ));
    }

    // Write the 4-byte length prefix
    let len_bytes = (msg_bytes.len() as u32).to_le_bytes();
    writer.write_all(&len_bytes)?;

    // Write the message body
    writer.write_all(msg_bytes)?;

    Ok(())
}

/// Write an error response to stderr
///
/// Error messages go to stderr, not stdout (which is reserved for the protocol)
pub fn write_error(message: &str) {
    eprintln!("ERROR: {}", message);
}

/// Create a hello message for extension -> worker communication
pub fn create_hello_message(extension_id: &str, version: &str) -> Envelope {
    Envelope {
        version: PROTOCOL_VERSION.to_string(),
        message_type: MessageType::Hello.to_string(),
        host_id: HostId::new(),
        session_id: None,
        tab_id: None,
        correlation_id: CorrelationId::new(),
        sequence_number: 0,
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        sender_identity: SenderIdentity::Extension(ExtensionIdentity {
            extension_id: extension_id.to_string(),
            version: version.to_string(),
            origin: "chrome-extension".to_string(),
        }),
        payload: None,
    }
}

/// Create a ready message for worker -> extension communication
pub fn create_ready_message(worker_id: &str, protocol_version: &str) -> Envelope {
    Envelope {
        version: PROTOCOL_VERSION.to_string(),
        message_type: MessageType::Ready.to_string(),
        host_id: HostId::new(),
        session_id: None,
        tab_id: None,
        correlation_id: CorrelationId::new(),
        sequence_number: 0,
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        sender_identity: SenderIdentity::Worker(WorkerIdentity {
            worker_id: worker_id.to_string(),
            protocol_version: protocol_version.to_string(),
        }),
        payload: None,
    }
}

/// Create a heartbeat message
pub fn create_heartbeat_message(host_id: HostId) -> Envelope {
    Envelope {
        version: PROTOCOL_VERSION.to_string(),
        message_type: MessageType::Heartbeat.to_string(),
        host_id,
        session_id: None,
        tab_id: None,
        correlation_id: CorrelationId::new(),
        sequence_number: 0,
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        sender_identity: SenderIdentity::Extension(ExtensionIdentity {
            extension_id: "unknown".to_string(),
            version: "0.0.0".to_string(),
            origin: "chrome-extension".to_string(),
        }),
        payload: None,
    }
}

/// Create an error response
pub fn create_error_message(message: &str, correlation_id: CorrelationId) -> Envelope {
    Envelope {
        version: PROTOCOL_VERSION.to_string(),
        message_type: "error".to_string(),
        host_id: HostId::new(),
        session_id: None,
        tab_id: None,
        correlation_id,
        sequence_number: 0,
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        sender_identity: SenderIdentity::Worker(WorkerIdentity {
            worker_id: "unknown".to_string(),
            protocol_version: PROTOCOL_VERSION.to_string(),
        }),
        payload: Some(serde_json::json!({"message": message})),
    }
}

/// Create a success response
pub fn create_success_message(
    data: Option<serde_json::Value>,
    correlation_id: CorrelationId,
) -> Envelope {
    Envelope {
        version: PROTOCOL_VERSION.to_string(),
        message_type: "success".to_string(),
        host_id: HostId::new(),
        session_id: None,
        tab_id: None,
        correlation_id,
        sequence_number: 0,
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        sender_identity: SenderIdentity::Worker(WorkerIdentity {
            worker_id: "unknown".to_string(),
            protocol_version: PROTOCOL_VERSION.to_string(),
        }),
        payload: data,
    }
}

/// Validate an incoming envelope
pub fn validate_envelope(envelope: &Envelope) -> Result<()> {
    // Check protocol version
    if envelope.version != PROTOCOL_VERSION {
        return Err(anyhow::anyhow!(
            "Protocol version mismatch: expected {}, got {}",
            PROTOCOL_VERSION,
            envelope.version
        ));
    }

    // Validate sender identity (extension must have valid origin)
    match &envelope.sender_identity {
        SenderIdentity::Extension(ext) => {
            if !ext.origin.starts_with("chrome-extension") {
                return Err(anyhow::anyhow!("Invalid extension origin: {}", ext.origin));
            }
        }
        SenderIdentity::Worker(worker) => {
            if worker.protocol_version != PROTOCOL_VERSION {
                return Err(anyhow::anyhow!(
                    "Worker protocol version mismatch: expected {}, got {}",
                    PROTOCOL_VERSION,
                    worker.protocol_version
                ));
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hello_message() {
        let envelope = create_hello_message("test-extension-id", "1.0.0");
        assert_eq!(envelope.version, PROTOCOL_VERSION);
        assert_eq!(envelope.message_type, "hello");
        // Verify the UUID is valid (non-zero)
        let uuid = envelope.host_id.as_uuid();
        assert_ne!(uuid, uuid::Uuid::nil());
    }

    #[test]
    fn test_ready_message() {
        let envelope = create_ready_message("test-worker-id", PROTOCOL_VERSION);
        assert_eq!(envelope.version, PROTOCOL_VERSION);
        assert_eq!(envelope.message_type, "ready");
        // Verify the UUID is valid (non-zero)
        let uuid = envelope.host_id.as_uuid();
        assert_ne!(uuid, uuid::Uuid::nil());
    }

    #[test]
    fn test_heartbeat_message() {
        let host_id = HostId::new();
        let envelope = create_heartbeat_message(host_id);
        assert_eq!(envelope.version, PROTOCOL_VERSION);
        assert_eq!(envelope.message_type, "heartbeat");
        assert_eq!(envelope.host_id, host_id);
    }

    #[test]
    fn test_error_message() {
        let correlation_id = CorrelationId::new();
        let envelope = create_error_message("test error", correlation_id);
        assert_eq!(envelope.version, PROTOCOL_VERSION);
        assert_eq!(envelope.message_type, "error");
        assert_eq!(envelope.correlation_id, correlation_id);
        assert_eq!(
            envelope.payload,
            Some(serde_json::json!({"message": "test error"}))
        );
    }

    #[test]
    fn test_success_message() {
        let correlation_id = CorrelationId::new();
        let data = serde_json::json!({"result": "success"});
        let envelope = create_success_message(Some(data.clone()), correlation_id);
        assert_eq!(envelope.version, PROTOCOL_VERSION);
        assert_eq!(envelope.message_type, "success");
        assert_eq!(envelope.correlation_id, correlation_id);
        assert_eq!(envelope.payload, Some(data));
    }

    #[test]
    fn test_validate_envelope() {
        let mut envelope = create_hello_message("test-extension-id", "1.0.0");

        // Valid envelope should pass
        assert!(validate_envelope(&envelope).is_ok());

        // Invalid version should fail
        envelope.version = "0.9.0".to_string();
        assert!(validate_envelope(&envelope).is_err());
    }
}
