//! Telemetry and tracing utilities for Hexactra

pub mod audit;
pub mod artifact;
pub mod metrics;

pub use audit::{AuditEvent, AuditEventType, AuditSeverity, AuditStore, AuditDb};
pub use metrics::{Metrics, Timer, track_session_created, track_session_terminated, 
                  track_action_executed, track_action_failed, track_model_call};
pub use artifact::{Artifact, ArtifactType, ArtifactPermission, ArtifactStore};

use tracing::{span, Level};
use uuid::Uuid;

/// Start a new span with the given name and attributes
pub fn start_span(name: &str, session_id: &str) -> span::EnteredSpan {
    let span = span!(Level::INFO, "hexactra.span", name = name, session_id = session_id);
    span.entered()
}

/// Generate a correlation ID for request tracing
pub fn generate_correlation_id() -> Uuid {
    Uuid::new_v4()
}

/// Redact sensitive data from a value
pub fn redact_sensitive(value: &serde_json::Value) -> serde_json::Value {
    const SENSITIVE_KEYS: &[&str] = &["password", "token", "secret", "key", "otp", "credential"];
    
    match value {
        serde_json::Value::Object(map) => {
            let mut new_map = serde_json::Map::new();
            for (k, v) in map {
                if SENSITIVE_KEYS.iter().any(|sk| k.to_lowercase().contains(sk)) {
                    new_map.insert(k.clone(), serde_json::Value::String("[REDACTED]".to_string()));
                } else {
                    new_map.insert(k.clone(), redact_sensitive(v));
                }
            }
            serde_json::Value::Object(new_map)
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(redact_sensitive).collect())
        }
        _ => value.clone(),
    }
}
