//! Core types and traits for Hexactra runtime
//!
//! This crate provides the foundational types used throughout the Hexactra system:
//! - Goal and RunStatus for task execution
//! - BrowserAction and ActionResult for browser operations
//! - Session and Profile for session management
//! - Operation, Lease for resource management
//! - InteractionRequest for HITL (Human-in-the-Loop) workflow
//! - Experience events for Agent Experience Framework (AEF) integration

pub mod profile;
pub mod viewer;
pub mod policy;
pub mod experience;

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error as ThisError;
use uuid::Uuid;

// Re-export policy types for convenience
pub use policy::{ActionPolicy, ApprovalLevel, HighImpactAction, PolicyManager};

/// Policy configuration for an interaction request
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct InteractionPolicy {
    /// Required approval level for this request
    pub approval_level: ApprovalLevel,
    /// Whether origin verification is required
    pub verify_origin: bool,
    /// Maximum number of retries allowed
    pub max_retries: u32,
}

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

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
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

impl std::fmt::Display for OperationId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
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

impl std::fmt::Display for LeaseId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
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

impl std::fmt::Display for InteractionRequestId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
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

impl std::fmt::Display for ArtifactId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
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
    pub kind: InteractionKind,
    pub status: InteractionStatus,
    /// Expiry time for the request
    pub expires_at: DateTime<Utc>,
    /// Owner who claimed this request (for single-claim semantics)
    pub owner_id: Option<Uuid>,
    /// Origin/session that created this request (for mismatch detection)
    pub origin_session_id: Uuid,
    /// Policy configuration for this request
    pub policy: InteractionPolicy,
}

impl Default for InteractionRequest {
    fn default() -> Self {
        Self {
            id: InteractionRequestId::from_uuid(Uuid::new_v4()),
            session_id: SessionId::from_uuid(Uuid::new_v4()),
            reason: String::new(),
            details: serde_json::Value::Null,
            created_at: Utc::now(),
            kind: InteractionKind::SecretText,
            status: InteractionStatus::Pending,
            expires_at: Utc::now() + chrono::Duration::minutes(15),
            owner_id: None,
            origin_session_id: Uuid::new_v4(),
            policy: InteractionPolicy {
                approval_level: ApprovalLevel::Standard,
                verify_origin: false,
                max_retries: 3,
            },
        }
    }
}

/// Type of interaction request (HITL taxonomy)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InteractionKind {
    /// Secret text input (password, API key, etc.)
    SecretText,
    /// One-time password code
    OtpCode,
    /// Out-of-band confirmation (push notification)
    OobConfirmation,
    /// Passkey or security key authentication
    PasskeyOrSecurityKey,
    /// Action approval (confirm before proceeding)
    ActionApproval,
    /// Full human takeover of browser control
    HumanTakeover,
    /// Informational message (no action required)
    Information,
}

impl InteractionKind {
    pub fn as_str_name(&self) -> &'static str {
        match self {
            InteractionKind::SecretText => "secret_text",
            InteractionKind::OtpCode => "otp_code",
            InteractionKind::OobConfirmation => "oob_confirmation",
            InteractionKind::PasskeyOrSecurityKey => "passkey_or_security_key",
            InteractionKind::ActionApproval => "action_approval",
            InteractionKind::HumanTakeover => "human_takeover",
            InteractionKind::Information => "information",
        }
    }

    pub fn from_str_name(s: &str) -> Self {
        match s {
            "secret_text" => InteractionKind::SecretText,
            "otp_code" => InteractionKind::OtpCode,
            "oob_confirmation" => InteractionKind::OobConfirmation,
            "passkey_or_security_key" => InteractionKind::PasskeyOrSecurityKey,
            "action_approval" => InteractionKind::ActionApproval,
            "human_takeover" => InteractionKind::HumanTakeover,
            "information" => InteractionKind::Information,
            _ => InteractionKind::SecretText,
        }
    }
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
    /// Request expired without response
    Expired,
    /// Request was cancelled
    Cancelled,
}

impl InteractionStatus {
    pub fn as_str_name(&self) -> &'static str {
        match self {
            InteractionStatus::Pending => "pending",
            InteractionStatus::Approved => "approved",
            InteractionStatus::Rejected => "rejected",
            InteractionStatus::Expired => "expired",
            InteractionStatus::Cancelled => "cancelled",
        }
    }

    pub fn from_str_name(s: &str) -> Self {
        match s {
            "pending" => InteractionStatus::Pending,
            "approved" => InteractionStatus::Approved,
            "rejected" => InteractionStatus::Rejected,
            "expired" => InteractionStatus::Expired,
            "cancelled" => InteractionStatus::Cancelled,
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

/// Platform type for a host
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HostPlatform {
    Linux,
    Windows,
    MacOs,
}

impl HostPlatform {
    pub fn as_str_name(&self) -> &'static str {
        match self {
            HostPlatform::Linux => "linux",
            HostPlatform::Windows => "windows",
            HostPlatform::MacOs => "macos",
        }
    }

    pub fn from_str_name(s: &str) -> Self {
        match s {
            "linux" => HostPlatform::Linux,
            "windows" => HostPlatform::Windows,
            "macos" => HostPlatform::MacOs,
            _ => HostPlatform::Linux,
        }
    }
}

/// Extended host information for fleet orchestration
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostExtended {
    pub id: HostId,
    pub platform: HostPlatform,
    pub display_available: bool,
    pub max_concurrent_sessions: u32,
    pub current_load: u32,
}

/// Profile affinity assignment
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileAffinity {
    pub profile_id: Uuid,
    pub assigned_host_id: HostId,
    pub assigned_at: DateTime<Utc>,
    pub assigned_by: String,
}

/// Schedule for automated task execution
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Schedule {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub name: String,
    pub cron_expression: String,
    pub timezone: String,
    pub goal_definition: serde_json::Value,
    pub max_retries: u32,
    pub retry_delay_seconds: u32,
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Schedule run instance
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduleRun {
    pub id: Uuid,
    pub schedule_id: Uuid,
    pub run_number: u32,
    pub status: ScheduleRunStatus,
    pub host_id: Option<HostId>,
    pub session_id: Option<SessionId>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub error_message: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// Status of a schedule run
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleRunStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Skipped,
}

impl ScheduleRunStatus {
    pub fn as_str_name(&self) -> &'static str {
        match self {
            ScheduleRunStatus::Queued => "queued",
            ScheduleRunStatus::Running => "running",
            ScheduleRunStatus::Completed => "completed",
            ScheduleRunStatus::Failed => "failed",
            ScheduleRunStatus::Skipped => "skipped",
        }
    }

    pub fn from_str_name(s: &str) -> Self {
        match s {
            "queued" => ScheduleRunStatus::Queued,
            "running" => ScheduleRunStatus::Running,
            "completed" => ScheduleRunStatus::Completed,
            "failed" => ScheduleRunStatus::Failed,
            "skipped" => ScheduleRunStatus::Skipped,
            _ => ScheduleRunStatus::Queued,
        }
    }
}

/// Distributed lease for coordinating across hosts
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DistributedLease {
    pub id: Uuid,
    pub resource_type: String,
    pub resource_id: String,
    pub holder_id: HostId,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

/// Fleet scheduling decision
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchedulingDecision {
    pub host_id: HostId,
    pub profile_id: Option<Uuid>,
    pub reason: String,
    pub score: f64,
}

// Re-export viewer types for convenience
pub use viewer::{ViewerToken, ViewerPermissions, InputLease};

// Re-export secret transport for integration
pub mod secret_transport;
