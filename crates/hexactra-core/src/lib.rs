//! Core types and traits for Hexactra runtime
//!
//! This crate provides the foundational types used throughout the Hexactra system:
//! - Goal and RunStatus for task execution
//! - BrowserAction and ActionResult for browser operations
//! - Session and Profile for session management
//! - Operation, Lease for resource management
//! - InteractionRequest for HITL (Human-in-the-Loop) workflow

pub mod profile;
pub mod viewer;

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error as ThisError;
use uuid::Uuid;

/// Current protocol version
pub const PROTOCOL_VERSION: &str = "1.0.0";

/// Unique identifier for a goal (task)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct GoalId(Uuid);

impl GoalId {
    pub fn new() -> Self {
        GoalId(Uuid::new_v4())
    }

    pub fn from_uuid(uuid: Uuid) -> Self {
        GoalId(uuid)
    }

    pub fn as_uuid(&self) -> Uuid {
        self.0
    }
}

impl Default for GoalId {
    fn default() -> Self {
        Self::new()
    }
}

impl From<GoalId> for Uuid {
    fn from(id: GoalId) -> Self {
        id.0
    }
}

impl From<Uuid> for GoalId {
    fn from(uuid: Uuid) -> Self {
        GoalId::from_uuid(uuid)
    }
}

/// Unique identifier for a session
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionId(Uuid);

impl SessionId {
    pub fn new() -> Self {
        SessionId(Uuid::new_v4())
    }

    pub fn from_uuid(uuid: Uuid) -> Self {
        SessionId(uuid)
    }

    pub fn as_uuid(&self) -> Uuid {
        self.0
    }
}

impl Default for SessionId {
    fn default() -> Self {
        Self::new()
    }
}

impl From<SessionId> for Uuid {
    fn from(id: SessionId) -> Self {
        id.0
    }
}

impl From<Uuid> for SessionId {
    fn from(uuid: Uuid) -> Self {
        SessionId::from_uuid(uuid)
    }
}

/// Unique identifier for an operation
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct OperationId(Uuid);

impl OperationId {
    pub fn new() -> Self {
        OperationId(Uuid::new_v4())
    }

    pub fn from_uuid(uuid: Uuid) -> Self {
        OperationId(uuid)
    }

    pub fn as_uuid(&self) -> Uuid {
        self.0
    }
}

impl Default for OperationId {
    fn default() -> Self {
        Self::new()
    }
}

impl From<OperationId> for Uuid {
    fn from(id: OperationId) -> Self {
        id.0
    }
}

impl From<Uuid> for OperationId {
    fn from(uuid: Uuid) -> Self {
        OperationId::from_uuid(uuid)
    }
}

/// Unique identifier for a lease (resource lock)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct LeaseId(Uuid);

impl LeaseId {
    pub fn new() -> Self {
        LeaseId(Uuid::new_v4())
    }

    pub fn from_uuid(uuid: Uuid) -> Self {
        LeaseId(uuid)
    }

    pub fn as_uuid(&self) -> Uuid {
        self.0
    }
}

impl Default for LeaseId {
    fn default() -> Self {
        Self::new()
    }
}

/// Unique identifier for an interaction request (HITL)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct InteractionRequestId(Uuid);

impl InteractionRequestId {
    pub fn new() -> Self {
        InteractionRequestId(Uuid::new_v4())
    }

    pub fn from_uuid(uuid: Uuid) -> Self {
        InteractionRequestId(uuid)
    }

    pub fn as_uuid(&self) -> Uuid {
        self.0
    }
}

impl Default for InteractionRequestId {
    fn default() -> Self {
        Self::new()
    }
}

impl From<InteractionRequestId> for Uuid {
    fn from(id: InteractionRequestId) -> Self {
        id.0
    }
}

impl From<Uuid> for InteractionRequestId {
    fn from(uuid: Uuid) -> Self {
        InteractionRequestId::from_uuid(uuid)
    }
}

/// Unique identifier for an artifact
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ArtifactId(Uuid);

impl ArtifactId {
    pub fn new() -> Self {
        ArtifactId(Uuid::new_v4())
    }

    pub fn from_uuid(uuid: Uuid) -> Self {
        ArtifactId(uuid)
    }

    pub fn as_uuid(&self) -> Uuid {
        self.0
    }
}

impl Default for ArtifactId {
    fn default() -> Self {
        Self::new()
    }
}

impl From<ArtifactId> for Uuid {
    fn from(id: ArtifactId) -> Self {
        id.0
    }
}

impl From<Uuid> for ArtifactId {
    fn from(uuid: Uuid) -> Self {
        ArtifactId::from_uuid(uuid)
    }
}

/// Status of a goal execution
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    /// Goal is queued and waiting for execution
    Queued,
    /// Goal is currently being executed
    Running,
    /// Goal completed successfully
    Completed,
    /// Goal failed during execution
    Failed,
    /// Goal was cancelled by user or system
    Cancelled,
    /// Goal timed out
    TimedOut,
}

impl RunStatus {
    pub fn as_str_name(&self) -> &'static str {
        match self {
            RunStatus::Queued => "queued",
            RunStatus::Running => "running",
            RunStatus::Completed => "completed",
            RunStatus::Failed => "failed",
            RunStatus::Cancelled => "cancelled",
            RunStatus::TimedOut => "timed_out",
        }
    }

    pub fn from_str_name(s: &str) -> Self {
        match s {
            "queued" => RunStatus::Queued,
            "running" => RunStatus::Running,
            "completed" => RunStatus::Completed,
            "failed" => RunStatus::Failed,
            "cancelled" => RunStatus::Cancelled,
            "timed_out" => RunStatus::TimedOut,
            _ => RunStatus::Queued,
        }
    }
}

/// Result of a browser action
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ActionResult {
    pub success: bool,
    pub error: Option<String>,
    pub data: Option<serde_json::Value>,
}

/// Browser action to execute
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", content = "payload")]
pub enum BrowserAction {
    /// Navigate to a URL
    Navigate { url: String },
    /// Click an element
    Click { selector: String },
    /// Type text into an input
    Type { selector: String, text: String },
    /// Get element value
    GetValue { selector: String },
    /// Screenshot the page
    Screenshot,
    /// Execute JavaScript
    ExecuteScript { script: String },
    /// Wait for an element
    WaitForElement { selector: String, timeout_ms: u64 },
    /// Go back in history
    Back,
    /// Go forward in history
    Forward,
    /// Refresh the page
    Refresh,
}

/// A goal (task) to execute
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Goal {
    pub id: GoalId,
    pub session_id: SessionId,
    pub actions: Vec<BrowserAction>,
    pub created_at: DateTime<Utc>,
    pub status: RunStatus,
}

/// Session state
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    pub id: SessionId,
    pub profile_id: Uuid,
    pub status: SessionStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Status of a session
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    /// Session is initializing
    Initializing,
    /// Session is running
    Running,
    /// Session is paused
    Paused,
    /// Session has ended
    Ended,
}

impl SessionStatus {
    pub fn as_str_name(&self) -> &'static str {
        match self {
            SessionStatus::Initializing => "initializing",
            SessionStatus::Running => "running",
            SessionStatus::Paused => "paused",
            SessionStatus::Ended => "ended",
        }
    }

    pub fn from_str_name(s: &str) -> Self {
        match s {
            "initializing" => SessionStatus::Initializing,
            "running" => SessionStatus::Running,
            "paused" => SessionStatus::Paused,
            "ended" => SessionStatus::Ended,
            _ => SessionStatus::Initializing,
        }
    }
}

/// Profile configuration
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    pub id: Uuid,
    pub name: String,
    pub chrome_profile_path: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Operation (long-running task)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Operation {
    pub id: OperationId,
    pub goal_id: GoalId,
    pub status: OperationStatus,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
}

/// Status of an operation
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OperationStatus {
    /// Operation is queued
    Queued,
    /// Operation is in progress
    InProgress,
    /// Operation completed successfully
    Completed,
    /// Operation failed
    Failed,
}

impl OperationStatus {
    pub fn as_str_name(&self) -> &'static str {
        match self {
            OperationStatus::Queued => "queued",
            OperationStatus::InProgress => "in_progress",
            OperationStatus::Completed => "completed",
            OperationStatus::Failed => "failed",
        }
    }

    pub fn from_str_name(s: &str) -> Self {
        match s {
            "queued" => OperationStatus::Queued,
            "in_progress" => OperationStatus::InProgress,
            "completed" => OperationStatus::Completed,
            "failed" => OperationStatus::Failed,
            _ => OperationStatus::Queued,
        }
    }
}

/// Lease for resource access
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lease {
    pub id: LeaseId,
    pub resource_type: String,
    pub resource_id: String,
    pub owner: Uuid,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

/// Interaction request (HITL)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InteractionRequest {
    pub id: InteractionRequestId,
    pub session_id: SessionId,
    pub reason: String,
    pub details: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub status: InteractionStatus,
}

/// Status of an interaction request
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InteractionStatus {
    /// Request is pending human review
    Pending,
    /// Human approved the request
    Approved,
    /// Human rejected the request
    Rejected,
}

impl InteractionStatus {
    pub fn as_str_name(&self) -> &'static str {
        match self {
            InteractionStatus::Pending => "pending",
            InteractionStatus::Approved => "approved",
            InteractionStatus::Rejected => "rejected",
        }
    }

    pub fn from_str_name(s: &str) -> Self {
        match s {
            "pending" => InteractionStatus::Pending,
            "approved" => InteractionStatus::Approved,
            "rejected" => InteractionStatus::Rejected,
            _ => InteractionStatus::Pending,
        }
    }
}

/// Error types for Hexactra operations
#[derive(Debug, ThisError)]
pub enum HexactraError {
    #[error("Invalid goal id: {0}")]
    InvalidGoalId(String),
    #[error("Invalid session id: {0}")]
    InvalidSessionId(String),
    #[error("Operation not found: {0}")]
    OperationNotFound(Uuid),
    #[error("Session not found: {0}")]
    SessionNotFound(Uuid),
    #[error("Lease expired")]
    LeaseExpired,
    #[error("Unauthorized access")]
    Unauthorized,
    #[error("Invalid input: {0}")]
    InvalidInput(String),
    #[error("Internal error: {0}")]
    Internal(String),
}

impl From<anyhow::Error> for HexactraError {
    fn from(err: anyhow::Error) -> Self {
        HexactraError::Internal(err.to_string())
    }
}

/// Result type for Hexactra operations
pub type Result<T> = std::result::Result<T, HexactraError>;

// ==================== Host Types ====================

/// Unique identifier for a host
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct HostId(Uuid);

impl HostId {
    pub fn new() -> Self {
        HostId(Uuid::new_v4())
    }

    pub fn from_uuid(uuid: Uuid) -> Self {
        HostId(uuid)
    }

    pub fn as_uuid(&self) -> Uuid {
        self.0
    }
}

impl Default for HostId {
    fn default() -> Self {
        Self::new()
    }
}

impl From<HostId> for Uuid {
    fn from(id: HostId) -> Self {
        id.0
    }
}

impl From<Uuid> for HostId {
    fn from(uuid: Uuid) -> Self {
        HostId::from_uuid(uuid)
    }
}

/// Status of a host
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HostStatus {
    /// Host is connecting
    Connecting,
    /// Host is connected and ready
    Ready,
    /// Host is disconnected
    Disconnected,
    /// Host is offline
    Offline,
}

impl HostStatus {
    pub fn as_str_name(&self) -> &'static str {
        match self {
            HostStatus::Connecting => "connecting",
            HostStatus::Ready => "ready",
            HostStatus::Disconnected => "disconnected",
            HostStatus::Offline => "offline",
        }
    }

    pub fn from_str_name(s: &str) -> Self {
        match s {
            "connecting" => HostStatus::Connecting,
            "ready" => HostStatus::Ready,
            "disconnected" => HostStatus::Disconnected,
            "offline" => HostStatus::Offline,
            _ => HostStatus::Connecting,
        }
    }
}

/// A capability supported by a host
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Capability {
    pub name: String,
    pub version: String,
    pub description: Option<String>,
}

/// A host in the system
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Host {
    pub id: HostId,
    pub hostname: String,
    pub version: String,
    pub capabilities: Vec<Capability>,
    pub status: HostStatus,
    pub last_heartbeat: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

// Re-export viewer types for convenience
pub use viewer::{ViewerToken, ViewerPermissions, InputLease};
