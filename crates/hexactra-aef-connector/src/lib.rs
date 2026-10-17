//! AEF (Agent Experience Framework) connector for Hexactra
//!
//! This crate provides an optional HTTP/SDK adapter to the independent Agent Experience API,
//! with bounded event queue, backoff, permissions/retention and telemetry.
//!
//! The connector is designed to be decoupled from control-plane availability and should not
//! block browser actions on AEF failure.

pub mod client;
pub mod config;
pub mod health;
pub mod queue;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error as ThisError;
use uuid::Uuid;

/// Error types for the AEF connector
#[derive(Debug, ThisError)]
pub enum ConnectorError {
    #[error("Configuration error: {0}")]
    Config(String),

    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("HTTP error: {status} - {message}")]
    Http {
        status: u16,
        message: String,
    },

    #[error("Queue error: {0}")]
    Queue(String),

    #[error("Circuit breaker open")]
    CircuitBreakerOpen,

    #[error("Timeout error")]
    Timeout,
}

/// Result type for AEF operations
pub type Result<T> = std::result::Result<T, ConnectorError>;

/// Configuration for the AEF connector
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorConfig {
    /// AEF API endpoint URL
    pub api_url: String,

    /// Opt-in default (whether opt-in is required by default)
    #[serde(default = "default_opt_in_required")]
    pub opt_in_required: bool,

    /// Maximum events per batch
    #[serde(default = "default_max_events_per_batch")]
    pub max_events_per_batch: usize,

    /// Batch flush interval in milliseconds
    #[serde(default = "default_flush_interval_ms")]
    pub flush_interval_ms: u64,

    /// Circuit breaker configuration
    #[serde(default)]
    pub circuit_breaker: CircuitBreakerConfig,

    /// Backoff configuration
    #[serde(default)]
    pub backoff: BackoffConfig,
}

impl Default for ConnectorConfig {
    fn default() -> Self {
        Self {
            api_url: "http://localhost:8081".to_string(),
            opt_in_required: true,
            max_events_per_batch: 100,
            flush_interval_ms: 30_000,
            circuit_breaker: CircuitBreakerConfig::default(),
            backoff: BackoffConfig::default(),
        }
    }
}

fn default_opt_in_required() -> bool {
    true
}

fn default_max_events_per_batch() -> usize {
    100
}

fn default_flush_interval_ms() -> u64 {
    30_000
}

/// Circuit breaker configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CircuitBreakerConfig {
    /// Number of failures before opening circuit
    #[serde(default = "default_failure_threshold")]
    pub failure_threshold: u32,

    /// Recovery timeout in milliseconds
    #[serde(default = "default_recovery_timeout_ms")]
    pub recovery_timeout_ms: u64,

    /// Number of requests to allow in half-open state
    #[serde(default = "default_half_open_requests")]
    pub half_open_requests: u32,
}

impl Default for CircuitBreakerConfig {
    fn default() -> Self {
        Self {
            failure_threshold: default_failure_threshold(),
            recovery_timeout_ms: default_recovery_timeout_ms(),
            half_open_requests: default_half_open_requests(),
        }
    }
}

fn default_failure_threshold() -> u32 {
    5
}

fn default_recovery_timeout_ms() -> u64 {
    30_000
}

fn default_half_open_requests() -> u32 {
    3
}

/// Backoff configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackoffConfig {
    /// Minimum backoff time in milliseconds
    #[serde(default = "default_backoff_min_ms")]
    pub min_ms: u64,

    /// Maximum backoff time in milliseconds
    #[serde(default = "default_backoff_max_ms")]
    pub max_ms: u64,

    /// Backoff multiplier
    #[serde(default = "default_backoff_multiplier")]
    pub multiplier: f64,
}

fn default_backoff_min_ms() -> u64 {
    1_000
}

fn default_backoff_max_ms() -> u64 {
    30_000
}

fn default_backoff_multiplier() -> f64 {
    2.0
}

impl Default for BackoffConfig {
    fn default() -> Self {
        Self {
            min_ms: default_backoff_min_ms(),
            max_ms: default_backoff_max_ms(),
            multiplier: default_backoff_multiplier(),
        }
    }
}

/// Health status of the AEF connector
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum HealthStatus {
    /// Service is healthy
    Healthy,
    /// Service is degraded (some functionality unavailable)
    Degraded,
    /// Service is unhealthy
    Unhealthy,
}

impl HealthStatus {
    /// Convert to string representation
    pub fn as_str(&self) -> &'static str {
        match self {
            HealthStatus::Healthy => "healthy",
            HealthStatus::Degraded => "degraded",
            HealthStatus::Unhealthy => "unhealthy",
        }
    }
}

/// Circuit breaker state
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CircuitState {
    /// Circuit is closed, requests are flowing
    Closed,
    /// Circuit is open, requests are rejected
    Open,
    /// Circuit is half-open, limited requests allowed
    HalfOpen,
}

impl CircuitState {
    /// Convert to string representation
    pub fn as_str(&self) -> &'static str {
        match self {
            CircuitState::Closed => "closed",
            CircuitState::Open => "open",
            CircuitState::HalfOpen => "half_open",
        }
    }
}

/// Event submission result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmissionResult {
    /// Batch ID
    pub batch_id: Uuid,

    /// Number of events submitted
    pub submitted_count: usize,

    /// Number of events accepted by AEF
    pub accepted_count: usize,

    /// Timestamp of submission
    pub timestamp: DateTime<Utc>,
}

/// Hint retrieval result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HintResult {
    /// List of hints retrieved
    pub hints: Vec<Hint>,

    /// Total count of available hints
    pub total: usize,
}

/// A reusable hint from experience memory
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hint {
    /// Unique hint identifier
    pub hint_id: Uuid,

    /// Site URL the hint applies to
    pub site_url: String,

    /// Task type the hint addresses
    pub task_type: String,

    /// Confidence level (0.0 to 1.0)
    pub confidence: f64,

    /// Hint payload (action sequence, selectors, etc.)
    pub payload: serde_json::Value,

    /// Provenance information
    pub provenance: HintProvenance,

    /// Freshness in days since the hint was created
    pub freshness_days: i32,
}

/// Provenance information for a hint
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HintProvenance {
    /// When the hint was created
    pub created_at: DateTime<Utc>,

    /// Agent ID that generated the hint
    pub agent_id: Uuid,

    /// Confidence in the hint's accuracy
    pub confidence: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = ConnectorConfig::default();
        assert_eq!(config.opt_in_required, true);
        assert_eq!(config.max_events_per_batch, 100);
        assert_eq!(config.flush_interval_ms, 30_000);
    }

    #[test]
    fn test_circuit_breaker_config() {
        let config = CircuitBreakerConfig::default();
        assert_eq!(config.failure_threshold, 5);
        assert_eq!(config.recovery_timeout_ms, 30_000);
        assert_eq!(config.half_open_requests, 3);
    }

    #[test]
    fn test_backoff_config() {
        let config = BackoffConfig::default();
        assert_eq!(config.min_ms, 1_000);
        assert_eq!(config.max_ms, 30_000);
        assert_eq!(config.multiplier, 2.0);
    }

    #[test]
    fn test_health_status_as_str() {
        assert_eq!(HealthStatus::Healthy.as_str(), "healthy");
        assert_eq!(HealthStatus::Degraded.as_str(), "degraded");
        assert_eq!(HealthStatus::Unhealthy.as_str(), "unhealthy");
    }

    #[test]
    fn test_circuit_state_as_str() {
        assert_eq!(CircuitState::Closed.as_str(), "closed");
        assert_eq!(CircuitState::Open.as_str(), "open");
        assert_eq!(CircuitState::HalfOpen.as_str(), "half_open");
    }
}
