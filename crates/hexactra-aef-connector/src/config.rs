//! Configuration for the AEF connector

use crate::{BackoffConfig, CircuitBreakerConfig};
use serde::{Deserialize, Serialize};

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
    fn test_config_serialization() {
        let config = ConnectorConfig::default();
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: ConnectorConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(config, deserialized);
    }
}
