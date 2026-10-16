//! Native Messaging protocol implementation
//!
//! Chrome's Native Messaging protocol uses 32-bit length-prefixed JSON messages.
//! This module provides encoding and decoding functions for the protocol.

use anyhow::{Context, Result};
use std::io::{Read, Write};

/// Maximum message size in bytes (1 MB as per Chrome limits)
pub const MAX_MESSAGE_SIZE: usize = 1024 * 1024;

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
