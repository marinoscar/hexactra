//! Health check utilities

use crate::{CircuitState, HealthStatus};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Structured health response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructuredHealthResponse {
    /// Overall health status
    pub status: HealthStatus,

    /// When the check was performed
    pub timestamp: DateTime<Utc>,

    /// Circuit breaker state
    pub circuit_breaker: CircuitBreakerStateDetails,
}

/// Circuit breaker state details
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CircuitBreakerStateDetails {
    /// Current state
    pub state: CircuitState,

    /// Number of consecutive failures
    pub failure_count: u32,

    /// When the last failure occurred
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_failure: Option<DateTime<Utc>>,
}

impl StructuredHealthResponse {
    /// Create a new health response
    pub fn new(status: HealthStatus, circuit_breaker: CircuitBreakerStateDetails) -> Self {
        Self {
            status,
            timestamp: Utc::now(),
            circuit_breaker,
        }
    }

    /// Check if the service is healthy
    pub fn is_healthy(&self) -> bool {
        self.status == HealthStatus::Healthy
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_health_response() {
        let response = StructuredHealthResponse::new(
            HealthStatus::Healthy,
            CircuitBreakerStateDetails {
                state: CircuitState::Closed,
                failure_count: 0,
                last_failure: None,
            },
        );

        assert!(response.is_healthy());
    }
}
