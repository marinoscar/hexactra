//! Experience event types for Agent Experience Framework (AEF) integration
//!
//! This module provides sanitized event types that can be shared with the optional
//! AEF service for learning and guidance, respecting strict privacy requirements.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// Re-export types from hexactra_core
pub use crate::{GoalId, SessionId};

/// Current schema version for experience events
pub const EXPERIENCE_SCHEMA_VERSION: &str = "1.0.0";

/// Unique identifier for an experience event
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ExperienceEventId(Uuid);

impl ExperienceEventId {
    pub fn new() -> Self {
        ExperienceEventId(Uuid::new_v4())
    }

    pub fn from_uuid(uuid: Uuid) -> Self {
        ExperienceEventId(uuid)
    }

    pub fn as_uuid(&self) -> Uuid {
        self.0
    }
}

impl Default for ExperienceEventId {
    fn default() -> Self {
        Self::new()
    }
}

impl From<ExperienceEventId> for Uuid {
    fn from(id: ExperienceEventId) -> Self {
        id.0
    }
}

impl From<Uuid> for ExperienceEventId {
    fn from(uuid: Uuid) -> Self {
        ExperienceEventId::from_uuid(uuid)
    }
}

/// Origin of an experience event (site and session context)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExperienceOrigin {
    /// URL of the website where the action occurred
    pub site_url: String,
    /// Hexactra session ID
    pub session_id: String,
    /// Chrome profile ID (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
}

/// Type of task performed
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskType {
    Navigation,
    FormSubmission,
    DataExtraction,
    Authentication,
    ClickAction,
    TextInput,
    ElementInteraction,
}

/// Type of browser action
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionType {
    Navigate,
    Click,
    Type,
    GetValue,
    Screenshot,
    ExecuteScript,
    WaitForElement,
    Back,
    Forward,
    Refresh,
}

/// An allowed action that was executed
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AllowedAction {
    /// Type of action performed
    pub action_type: ActionType,
    /// CSS selector or equivalent locator for the target element
    pub selector: String,
    /// Value for type actions (redacted in sanitized events)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

/// Outcome of a task execution
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskOutcome {
    /// Whether the overall task succeeded
    pub success: bool,
    /// Final status
    #[serde(rename = "status")]
    pub status: TaskStatus,
    /// Error message (sanitized, no secrets)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    /// Non-sensitive output data that can be shared for learning
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redacted_output: Option<serde_json::Value>,
}

/// Status of task completion
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Completed,
    PartialSuccess,
    Failed,
    Cancelled,
    Timeout,
}

/// Provenance information about the event
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventProvenance {
    /// Agent instance identifier
    pub agent_id: Uuid,
    /// AI model provider (e.g., 'openai', 'anthropic')
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_provider: Option<String>,
    /// Model identifier (e.g., 'gpt-4o', 'claude-3.5-sonnet')
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    /// Total tokens consumed (input + output)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    /// Estimated cost in USD (redacted in sanitized events)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_cost_usd: Option<f64>,
}

/// UI capabilities available during the event
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UiCapabilities {
    /// Whether screenshots were available
    #[serde(default)]
    pub has_screenshots: bool,
    /// Whether DOM snapshot was available
    #[serde(default)]
    pub has_dom_snapshot: bool,
    /// Browser viewport size
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_viewport: Option<Viewport>,
}

/// Browser viewport dimensions
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
}

/// Consent information for the event
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventConsent {
    /// Whether the user explicitly opted in to share this event
    pub opt_in: bool,
    /// Owner identifier for consent management
    pub owner_id: Uuid,
    /// Whether consent has been revoked (post-event)
    #[serde(default)]
    pub revoked: bool,
    /// When consent was granted
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consent_timestamp: Option<DateTime<Utc>>,
}

/// Metadata about the event
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventMetadata {
    /// Sequence number within the session
    #[serde(default)]
    pub session_sequence: u32,
    /// Total actions in this task
    #[serde(default)]
    pub total_actions: u32,
    /// Task duration in milliseconds
    #[serde(default)]
    pub duration_ms: u64,
    /// User-defined tags for categorization
    #[serde(skip_serializing_if = "Vec::is_empty")]
    #[serde(default)]
    pub tags: Vec<String>,
}

/// A sanitized experience event that can be shared with AEF
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExperienceEvent {
    /// Schema version for backward compatibility
    pub schema_version: String,
    /// Unique identifier for this experience event
    pub event_id: ExperienceEventId,
    /// ISO 8601 timestamp when the event occurred
    pub timestamp: DateTime<Utc>,
    /// Origin of the event (site and session context)
    pub origin: ExperienceOrigin,
    /// Category of task performed
    pub task_type: TaskType,
    /// Actions that were allowed and executed during this experience
    pub allowed_actions: Vec<AllowedAction>,
    /// Outcome of the task execution
    pub outcome: TaskOutcome,
    /// Provenance information about the event
    pub provenance: EventProvenance,
    /// UI capabilities available during the event
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_capabilities: Option<UiCapabilities>,
    /// Consent information for the event
    pub consent: EventConsent,
    /// Metadata about the event
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<EventMetadata>,
}

impl ExperienceEvent {
    /// Create a new experience event with default schema version
    pub fn new(
        origin: ExperienceOrigin,
        task_type: TaskType,
        allowed_actions: Vec<AllowedAction>,
        outcome: TaskOutcome,
        provenance: EventProvenance,
        consent: EventConsent,
    ) -> Self {
        Self {
            schema_version: EXPERIENCE_SCHEMA_VERSION.to_string(),
            event_id: ExperienceEventId::new(),
            timestamp: Utc::now(),
            origin,
            task_type,
            allowed_actions,
            outcome,
            provenance,
            ui_capabilities: None,
            consent,
            metadata: None,
        }
    }

    /// Set UI capabilities
    pub fn with_ui_capabilities(mut self, ui_capabilities: UiCapabilities) -> Self {
        self.ui_capabilities = Some(ui_capabilities);
        self
    }

    /// Set metadata
    pub fn with_metadata(mut self, metadata: EventMetadata) -> Self {
        self.metadata = Some(metadata);
        self
    }
}

/// A batch of experience events for efficient transmission
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExperienceEventBatch {
    /// Unique batch identifier
    pub batch_id: Uuid,
    /// Owner identifier (same across all events in batch)
    pub owner_id: Uuid,
    /// When the batch was created
    pub created_at: DateTime<Utc>,
    /// Events in this batch
    pub events: Vec<ExperienceEvent>,
    /// Batch-level metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch_metadata: Option<BatchMetadata>,
}

impl ExperienceEventBatch {
    /// Create a new event batch
    pub fn new(owner_id: Uuid, events: Vec<ExperienceEvent>) -> Self {
        Self {
            batch_id: Uuid::new_v4(),
            owner_id,
            created_at: Utc::now(),
            events,
            batch_metadata: None,
        }
    }

    /// Set batch metadata
    pub fn with_batch_metadata(mut self, batch_metadata: BatchMetadata) -> Self {
        self.batch_metadata = Some(batch_metadata);
        self
    }
}

/// Metadata about an event batch
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchMetadata {
    /// Total number of events in the batch
    pub total_events: usize,
    /// Timestamp of oldest event in batch
    pub oldest_timestamp: DateTime<Utc>,
    /// Timestamp of newest event in batch
    pub newest_timestamp: DateTime<Utc>,
}

/// Request to grant or revoke consent for experience events
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConsentRequest {
    /// Owner identifier requesting consent
    pub owner_id: Uuid,
    /// Site URL for which consent is requested
    pub site_url: String,
    /// When the request was made
    pub request_timestamp: DateTime<Utc>,
    /// Purpose of data collection
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    /// Types of data being requested
    #[serde(skip_serializing_if = "Vec::is_empty")]
    #[serde(default)]
    pub data_types: Vec<String>,
    /// Retention period in days
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retention_days: Option<u32>,
    /// Whether consent can be revoked (always true)
    #[serde(default)]
    pub can_revoke: bool,
}

/// Response to a consent request
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConsentResponse {
    /// Request identifier
    pub request_id: Uuid,
    /// Whether consent was granted
    pub granted: bool,
    /// When the response was given
    pub timestamp: DateTime<Utc>,
    /// When consent was revoked (if applicable)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<DateTime<Utc>>,
}

/// Health check request for experience service
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealthCheckRequest {
    /// Whether to check external connections
    #[serde(default)]
    pub check_connections: bool,
}

/// Health check response
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealthCheckResponse {
    /// Overall health status
    pub status: HealthStatus,
    /// When the check was performed
    pub timestamp: DateTime<Utc>,
    /// Connection health details
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connections: Option<ConnectionHealth>,
    /// Circuit breaker state
    #[serde(skip_serializing_if = "Option::is_none")]
    pub circuit_breaker: Option<CircuitBreakerState>,
}

/// Health status enum
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthStatus {
    Healthy,
    Degraded,
    Unhealthy,
}

/// Connection health details
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectionHealth {
    /// Database connection status
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database: Option<ConnectionStatus>,
    /// External service (AEF) status
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_service: Option<ConnectionStatus>,
}

/// Connection status
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectionStatus {
    /// Status of the connection
    pub status: ConnectionState,
    /// Latency in milliseconds
    pub latency_ms: u64,
    /// Last successful connection
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_success: Option<DateTime<Utc>>,
}

/// Connection state enum
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    Ok,
    Error,
}

/// Circuit breaker state
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CircuitBreakerState {
    /// Current state
    pub state: CircuitState,
    /// Number of consecutive failures
    pub failure_count: u32,
    /// When the last failure occurred
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_failure: Option<DateTime<Utc>>,
}

/// Circuit breaker states
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CircuitState {
    Closed,
    Open,
    HalfOpen,
}

/// Configuration for event batching
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchConfig {
    /// Maximum events per batch
    #[serde(default = "default_max_events")]
    pub max_events_per_batch: usize,
    /// Maximum batch size in bytes
    #[serde(default = "default_max_batch_size")]
    pub max_batch_size_bytes: usize,
    /// Flush interval in milliseconds
    #[serde(default = "default_flush_interval")]
    pub flush_interval_ms: u64,
    /// Minimum backoff time in milliseconds
    #[serde(default = "default_backoff_min")]
    pub backoff_min_ms: u64,
    /// Maximum backoff time in milliseconds
    #[serde(default = "default_backoff_max")]
    pub backoff_max_ms: u64,
}

fn default_max_events() -> usize {
    100
}

fn default_max_batch_size() -> usize {
    1_048_576 // 1MB
}

fn default_flush_interval() -> u64 {
    30_000 // 30 seconds
}

fn default_backoff_min() -> u64 {
    1_000 // 1 second
}

fn default_backoff_max() -> u64 {
    30_000 // 30 seconds
}

/// Configuration for circuit breaker
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CircuitBreakerConfig {
    /// Number of failures before opening circuit
    #[serde(default = "default_failure_threshold")]
    pub failure_threshold: u32,
    /// Recovery timeout in milliseconds
    #[serde(default = "default_recovery_timeout")]
    pub recovery_timeout_ms: u64,
    /// Number of requests to allow in half-open state
    #[serde(default = "default_half_open_requests")]
    pub half_open_requests: u32,
}

fn default_failure_threshold() -> u32 {
    5
}

fn default_recovery_timeout() -> u64 {
    30_000 // 30 seconds
}

fn default_half_open_requests() -> u32 {
    3
}

/// Configuration for the experience service
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExperienceConfig {
    /// Whether opt-in is required by default
    #[serde(default)]
    pub opt_in_required: bool,
    /// Default batch configuration
    #[serde(default)]
    pub batch: BatchConfig,
    /// Circuit breaker configuration
    #[serde(default)]
    pub circuit_breaker: CircuitBreakerConfig,
}

impl Default for ExperienceConfig {
    fn default() -> Self {
        Self {
            opt_in_required: true, // Opt-in required by default for privacy
            batch: BatchConfig::default(),
            circuit_breaker: CircuitBreakerConfig::default(),
        }
    }
}

impl Default for BatchConfig {
    fn default() -> Self {
        Self {
            max_events_per_batch: default_max_events(),
            max_batch_size_bytes: default_max_batch_size(),
            flush_interval_ms: default_flush_interval(),
            backoff_min_ms: default_backoff_min(),
            backoff_max_ms: default_backoff_max(),
        }
    }
}

impl Default for CircuitBreakerConfig {
    fn default() -> Self {
        Self {
            failure_threshold: default_failure_threshold(),
            recovery_timeout_ms: default_recovery_timeout(),
            half_open_requests: default_half_open_requests(),
        }
    }
}

/// Hint retrieved from experience memory
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExperienceHint {
    /// Unique hint identifier
    pub hint_id: Uuid,
    /// Site URL the hint applies to
    pub site_url: String,
    /// Task type the hint addresses
    pub task_type: TaskType,
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HintProvenance {
    /// When the hint was created
    pub created_at: DateTime<Utc>,
    /// Agent ID that generated the hint
    pub agent_id: Uuid,
    /// Confidence in the hint's accuracy
    pub confidence: f64,
}

/// Request to retrieve hints
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HintRequest {
    /// Site URL to search for
    pub site_url: String,
    /// Task type to match
    pub task_type: TaskType,
    /// Maximum number of hints to return
    #[serde(default = "default_hint_limit")]
    pub limit: usize,
    /// Minimum confidence threshold (0.0 to 1.0)
    #[serde(default = "default_min_confidence")]
    pub min_confidence: f64,
}

fn default_hint_limit() -> usize {
    10
}

fn default_min_confidence() -> f64 {
    0.5
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_experience_event_creation() {
        let origin = ExperienceOrigin {
            site_url: "https://example.com".to_string(),
            session_id: SessionId::new(),
            profile_id: None,
        };

        let outcome = TaskOutcome {
            success: true,
            status: TaskStatus::Completed,
            error_message: None,
            redacted_output: None,
        };

        let provenance = EventProvenance {
            agent_id: Uuid::new_v4(),
            model_provider: Some("openai".to_string()),
            model_id: Some("gpt-4o".to_string()),
            total_tokens: Some(1000),
            total_cost_usd: None,
        };

        let consent = EventConsent {
            opt_in: true,
            owner_id: Uuid::new_v4(),
            revoked: false,
            consent_timestamp: None,
        };

        let event = ExperienceEvent::new(
            origin,
            TaskType::Navigation,
            vec![],
            outcome,
            provenance,
            consent,
        );

        assert_eq!(event.schema_version, EXPERIENCE_SCHEMA_VERSION);
        assert!(event.event_id.as_uuid().is_v4());
    }

    #[test]
    fn test_batch_creation() {
        let event = ExperienceEvent::new(
            ExperienceOrigin {
                site_url: "https://example.com".to_string(),
                session_id: SessionId::new(),
                profile_id: None,
            },
            TaskType::Navigation,
            vec![],
            TaskOutcome {
                success: true,
                status: TaskStatus::Completed,
                error_message: None,
                redacted_output: None,
            },
            EventProvenance {
                agent_id: Uuid::new_v4(),
                model_provider: None,
                model_id: None,
                total_tokens: None,
                total_cost_usd: None,
            },
            EventConsent {
                opt_in: true,
                owner_id: Uuid::new_v4(),
                revoked: false,
                consent_timestamp: None,
            },
        );

        let batch = ExperienceEventBatch::new(Uuid::new_v4(), vec![event]);

        assert!(batch.batch_id.is_v4());
        assert_eq!(batch.events.len(), 1);
    }

    #[test]
    fn test_default_configs() {
        let batch_config = BatchConfig::default();
        assert_eq!(batch_config.max_events_per_batch, 100);
        assert_eq!(batch_config.max_batch_size_bytes, 1_048_576);

        let circuit_config = CircuitBreakerConfig::default();
        assert_eq!(circuit_config.failure_threshold, 5);

        let experience_config = ExperienceConfig::default();
        assert!(experience_config.opt_in_required);
    }
}
