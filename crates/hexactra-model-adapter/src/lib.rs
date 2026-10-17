//! OpenAI-compatible model adapter for Hexactra
//!
//! This crate provides an adapter for any OpenAI-compatible API endpoint,
//! supporting chat completions with tool calling, structured output, and
//! optional streaming/vision capabilities.

pub mod client;
pub mod error;
pub mod types;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tracing::info;
use hexactra_telemetry::start_span;

/// Configuration for the OpenAI-compatible model adapter
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfig {
    /// Base URL of the OpenAI-compatible endpoint
    pub base_url: String,
    /// Model ID to use
    pub model_id: String,
    /// API key for authentication (optional, for some providers)
    pub api_key: Option<String>,
    /// Timeout for model requests
    pub request_timeout: Duration,
    /// Maximum tokens to generate
    pub max_tokens: Option<u32>,
    /// Temperature for generation
    pub temperature: Option<f32>,
    /// Enable streaming responses
    pub stream: bool,
    /// Supported capabilities
    pub capabilities: ModelCapabilities,
}

impl Default for ModelConfig {
    fn default() -> Self {
        Self {
            base_url: "http://localhost:11434/v1".to_string(),
            model_id: "llama3".to_string(),
            api_key: None,
            request_timeout: Duration::from_secs(30),
            max_tokens: Some(4096),
            temperature: Some(0.7),
            stream: false,
            capabilities: ModelCapabilities::default(),
        }
    }
}

/// Model capabilities
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelCapabilities {
    /// Supports tool calling
    pub tool_calling: bool,
    /// Supports structured JSON output
    pub structured_output: bool,
    /// Supports vision (images)
    pub vision: bool,
    /// Supports streaming
    pub streaming: bool,
}

/// Model adapter trait for Hexactra
#[async_trait]
pub trait ModelAdapter {
    /// Get the model configuration
    fn config(&self) -> &ModelConfig;

    /// Send a chat completion request
    async fn chat_completion(
        &self,
        messages: Vec<ChatMessage>,
        tools: Option<Vec<Tool>>,
    ) -> Result<ChatCompletionResponse>;

    /// Send a streaming chat completion request
    async fn chat_completion_stream(
        &self,
        messages: Vec<ChatMessage>,
        tools: Option<Vec<Tool>>,
    ) -> Result<Vec<ChatCompletionResponse>>;

    /// Validate the model configuration
    fn validate(&self) -> Result<()>;
}

/// Chat message for model conversation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: MessageRole,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Message role
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    System,
    User,
    Assistant,
    Tool,
}

/// Tool definition for model
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tool {
    pub r#type: ToolType,
    pub function: FunctionDefinition,
}

/// Tool type
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolType {
    Function,
}

/// Function definition for a tool
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionDefinition {
    pub name: String,
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<serde_json::Value>,
}

/// Chat completion response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatCompletionResponse {
    pub id: String,
    pub object: String,
    pub created: u64,
    pub model: String,
    pub choices: Vec<Choice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
}

/// Choice in a completion response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Choice {
    pub index: u32,
    pub message: ChatMessage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
}

/// Usage statistics for a completion
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Usage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

/// Error types for model adapter
#[derive(Debug, thiserror::Error)]
pub enum ModelAdapterError {
    #[error("Invalid configuration: {0}")]
    InvalidConfig(String),
    #[error("Network error: {0}")]
    Network(String),
    #[error("HTTP error: {status} - {body}")]
    HttpError {
        status: u32,
        body: String,
    },
    #[error("Timeout error")]
    Timeout,
    #[error("Invalid response format: {0}")]
    InvalidResponse(String),
    #[error("Tool calling not supported by model")]
    ToolCallingNotSupported,
    #[error("Rate limit exceeded")]
    RateLimitExceeded,
}

impl From<reqwest::Error> for ModelAdapterError {
    fn from(err: reqwest::Error) -> Self {
        ModelAdapterError::Network(err.to_string())
    }
}

/// Result type for model adapter operations
pub type Result<T> = std::result::Result<T, ModelAdapterError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_model_config_default() {
        let config = ModelConfig::default();
        assert_eq!(config.base_url, "http://localhost:11434/v1");
        assert_eq!(config.model_id, "llama3");
        assert!(config.api_key.is_none());
    }

    #[test]
    fn test_model_capabilities_default() {
        let capabilities = ModelCapabilities::default();
        assert!(!capabilities.tool_calling);
        assert!(!capabilities.structured_output);
        assert!(!capabilities.vision);
        assert!(!capabilities.streaming);
    }
}
