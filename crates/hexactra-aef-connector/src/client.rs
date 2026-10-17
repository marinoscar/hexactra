//! HTTP client for AEF API

use crate::{ConnectorConfig, CircuitState, ConnectorError, Hint, HintResult, SubmissionResult};
use chrono::{DateTime, Utc};
use hexactra_core::experience::{ExperienceEventBatch};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{instrument, warn};
use uuid::Uuid;

/// AEF API client
pub struct AefClient {
    config: Arc<ConnectorConfig>,
    http_client: reqwest::Client,
    circuit_state: Mutex<CircuitState>,
    failure_count: Mutex<u32>,
}

impl AefClient {
    /// Create a new AEF client
    pub fn new(config: ConnectorConfig) -> Self {
        let config = Arc::new(config);
        Self {
            config,
            http_client: reqwest::Client::new(),
            circuit_state: Mutex::new(CircuitState::Closed),
            failure_count: Mutex::new(0),
        }
    }

    /// Check if the circuit breaker is open
    async fn is_circuit_open(&self) -> bool {
        *self.circuit_state.lock().await == CircuitState::Open
    }

    /// Record a successful request
    async fn record_success(&self) {
        let mut state = self.circuit_state.lock().await;
        let mut failures = self.failure_count.lock().await;

        if *state == CircuitState::HalfOpen {
            *state = CircuitState::Closed;
        }
        *failures = 0;
    }

    /// Record a failed request
    async fn record_failure(&self) {
        let mut state = self.circuit_state.lock().await;
        let mut failures = self.failure_count.lock().await;

        *failures += 1;

        if *failures >= self.config.circuit_breaker.failure_threshold {
            *state = CircuitState::Open;
            warn!(
                "Circuit breaker opened after {} failures",
                *failures
            );
        }
    }



    /// Submit a batch of experience events to AEF
    #[instrument(skip(self, batch))]
    pub async fn submit_events(
        &self,
        batch: &ExperienceEventBatch,
    ) -> Result<SubmissionResult, ConnectorError> {
        if self.is_circuit_open().await {
            warn!("Circuit breaker open, dropping events");
            return Err(ConnectorError::CircuitBreakerOpen);
        }

        let response = self
            .http_client
            .post(format!("{}/events", self.config.api_url))
            .json(batch)
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await?;

        if response.status().is_success() {
            let result: SubmissionResponse = response.json().await?;
            self.record_success().await;
            Ok(SubmissionResult {
                batch_id: result.batch_id,
                submitted_count: result.submitted_count,
                accepted_count: result.accepted_count,
                timestamp: Utc::now(),
            })
        } else {
            let status = response.status();
            let message = response.text().await.unwrap_or_default();
            self.record_failure().await;
            Err(ConnectorError::Http {
                status: status.as_u16(),
                message,
            })
        }
    }

    /// Retrieve hints for a site and task type
    #[instrument(skip(self))]
    pub async fn retrieve_hints(
        &self,
        site_url: &str,
        task_type: &str,
        limit: usize,
        min_confidence: f64,
    ) -> Result<HintResult, ConnectorError> {
        if self.is_circuit_open().await {
            warn!("Circuit breaker open, returning empty hints");
            return Ok(HintResult {
                hints: Vec::new(),
                total: 0,
            });
        }

        let response = self
            .http_client
            .get(format!("{}/hints", self.config.api_url))
            .query(&[
                ("site_url", site_url),
                ("task_type", task_type),
                ("limit", &limit.to_string()),
                ("min_confidence", &min_confidence.to_string()),
            ])
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await?;

        if response.status().is_success() {
            let result: HintsResponse = response.json().await?;
            self.record_success().await;
            Ok(HintResult {
                hints: result.hints,
                total: result.total,
            })
        } else {
            let status = response.status();
            let message = response.text().await.unwrap_or_default();
            self.record_failure().await;
            Err(ConnectorError::Http {
                status: status.as_u16(),
                message,
            })
        }
    }

    /// Get health status
    #[instrument(skip(self))]
    pub async fn get_health(&self) -> Result<HealthResponse, ConnectorError> {
        let response = self
            .http_client
            .get(format!("{}/health", self.config.api_url))
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await?;

        if response.status().is_success() {
            let health: HealthResponse = response.json().await?;
            Ok(health)
        } else {
            let status = response.status();
            let message = response.text().await.unwrap_or_default();
            Err(ConnectorError::Http {
                status: status.as_u16(),
                message,
            })
        }
    }

    /// Get current circuit state
    pub async fn circuit_state(&self) -> CircuitState {
        let state = self.circuit_state.lock().await;
        state.clone()
    }

    /// Store hints locally for offline access
    pub fn store_hints(&self, _hints: Vec<Hint>) {
        // Hint storage is handled by the caller (e.g., in-memory or persistent store)
        // This is a placeholder for future implementation
    }
}

/// Response from events submission
#[derive(Debug, Deserialize)]
struct SubmissionResponse {
    batch_id: Uuid,
    submitted_count: usize,
    accepted_count: usize,
}

/// Response from hints retrieval
#[derive(Debug, Deserialize)]
struct HintsResponse {
    hints: Vec<Hint>,
    total: usize,
}

/// Health response from AEF
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    #[serde(deserialize_with = "from_str")]
    pub timestamp: DateTime<Utc>,
    pub circuit_breaker: Option<CircuitBreakerState>,
}

fn from_str<'de, D>(deserializer: D) -> Result<DateTime<Utc>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let s = String::deserialize(deserializer)?;
    DateTime::parse_from_rfc3339(&s)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(serde::de::Error::custom)
}

/// Circuit breaker state in health response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CircuitBreakerState {
    pub state: String,
    pub failure_count: u32,
    #[serde(default)]
    pub last_failure: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_circuit_breaker_state() {
        let config = ConnectorConfig::default();
        let client = AefClient::new(config);

        // Initial state should be Closed
        assert_eq!(client.circuit_state().await, CircuitState::Closed);
    }
}
