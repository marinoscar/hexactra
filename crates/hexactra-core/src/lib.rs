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
