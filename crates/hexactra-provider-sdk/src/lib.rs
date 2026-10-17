//! Provider SDK for Hexactra runtime
//!
//! This crate provides the interfaces and types for pluggable providers:
//! - HumanInteractionProvider: for HITL (Human-in-the-Loop) interactions
//! - CredentialProvider: for credential resolution
//! - NotificationProvider: for configurable notification delivery

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fmt;
use thiserror::Error;

// ==================== Error Types ====================

/// Provider error types
#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("Provider not found: {0}")]
    NotFound(String),
    #[error("Provider not configured")]
    NotConfigured,
    #[error("Provider timeout after {0}ms")]
    Timeout(u64),
    #[error("Provider returned invalid data: {0}")]
    InvalidData(String),
    #[error("Provider authorization failed: {0}")]
    Authorization(String),
    #[error("Provider unavailable: {0}")]
    Unavailable(String),
    #[error("Provider internal error: {0}")]
    Internal(String),
}

/// Result type for provider operations
pub type ProviderResult<T> = std::result::Result<T, ProviderError>;

// ==================== Provider Metadata ====================

/// Unique identifier for a provider instance
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ProviderId(pub uuid::Uuid);

impl ProviderId {
    pub fn new() -> Self {
        ProviderId(uuid::Uuid::new_v4())
    }

    pub fn from_uuid(uuid: uuid::Uuid) -> Self {
        ProviderId(uuid)
    }

    pub fn as_uuid(&self) -> uuid::Uuid {
        self.0
    }
}

impl fmt::Display for ProviderId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Provider capability flags
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderCapabilities {
    /// Supports human interaction prompts
    pub human_interaction: bool,
    /// Supports credential resolution
    pub credential_resolution: bool,
    /// Supports notification delivery
    pub notification_delivery: bool,
    /// Supports secure response channels
    pub secure_response: bool,
    /// Supports origin verification
    pub origin_verification: bool,
}

/// Provider health status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProviderHealth {
    /// Provider is healthy and ready
    Healthy,
    /// Provider is degraded but operational
    Degraded,
    /// Provider is unavailable
    Unavailable,
    /// Provider is not configured
    NotConfigured,
}

// ==================== HumanInteractionProvider ====================

/// Request for human interaction
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HumanInteractionRequest {
    /// Unique request ID
    pub request_id: uuid::Uuid,
    /// Session ID associated with this request
    pub session_id: uuid::Uuid,
    /// Reason for the interaction request
    pub reason: String,
    /// Additional details (JSON-serializable)
    pub details: serde_json::Value,
    /// Request kind (secret_text, otp_code, passkey, etc.)
    pub kind: HumanInteractionKind,
    /// Maximum time to wait for response (milliseconds)
    pub timeout_ms: u64,
    /// Whether origin verification is required
    pub verify_origin: bool,
}

/// Response to a human interaction request
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HumanInteractionResponse {
    /// Request ID that this responds to
    pub request_id: uuid::Uuid,
    /// Response status
    pub status: InteractionStatus,
    /// Response data (if any)
    pub data: Option<serde_json::Value>,
    /// Timestamp of response
    pub timestamp: DateTime<Utc>,
}

/// Kinds of human interaction requests
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum HumanInteractionKind {
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
}

impl fmt::Display for HumanInteractionKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HumanInteractionKind::SecretText => write!(f, "secret_text"),
            HumanInteractionKind::OtpCode => write!(f, "otp_code"),
            HumanInteractionKind::OobConfirmation => write!(f, "oob_confirmation"),
            HumanInteractionKind::PasskeyOrSecurityKey => write!(f, "passkey_or_security_key"),
            HumanInteractionKind::ActionApproval => write!(f, "action_approval"),
            HumanInteractionKind::HumanTakeover => write!(f, "human_takeover"),
        }
    }
}

/// Status of an interaction request
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
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

impl fmt::Display for InteractionStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            InteractionStatus::Pending => write!(f, "pending"),
            InteractionStatus::Approved => write!(f, "approved"),
            InteractionStatus::Rejected => write!(f, "rejected"),
            InteractionStatus::Expired => write!(f, "expired"),
            InteractionStatus::Cancelled => write!(f, "cancelled"),
        }
    }
}

/// HumanInteractionProvider trait for HITL workflows
#[async_trait::async_trait]
pub trait HumanInteractionProvider: Send + Sync + fmt::Debug {
    /// Get provider metadata
    fn metadata(&self) -> &ProviderMetadata;

    /// Send an interaction request to the user
    async fn send_interaction(&self, request: &HumanInteractionRequest) -> ProviderResult<()>;

    /// Wait for a response to an interaction request
    async fn wait_for_response(
        &self,
        request_id: uuid::Uuid,
        timeout_ms: u64,
    ) -> ProviderResult<HumanInteractionResponse>;

    /// Cancel a pending interaction request
    async fn cancel_interaction(&self, request_id: uuid::Uuid) -> ProviderResult<()>;

    /// Get the health status of this provider
    fn health(&self) -> ProviderHealth;

    /// Validate that this provider supports the given interaction kind
    fn supports_kind(&self, kind: HumanInteractionKind) -> bool;
}

// ==================== CredentialProvider ====================

/// Scope for credential resolution
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialScope {
    /// Owner ID (user or agent)
    pub owner_id: uuid::Uuid,
    /// Target site origin (e.g., "https://example.com")
    pub origin: String,
    /// Profile name (optional)
    pub profile: Option<String>,
    /// Purpose of credential (e.g., "login", "payment")
    pub purpose: String,
}

/// Credential resolution request
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialRequest {
    /// Unique request ID
    pub request_id: uuid::Uuid,
    /// Scope for this credential lookup
    pub scope: CredentialScope,
    /// Whether to use cached credentials if available
    pub allow_cache: bool,
    /// Maximum age of cached credentials (milliseconds)
    pub max_cache_age_ms: u64,
}

/// Credential resolution response
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialResponse {
    /// Request ID that this responds to
    pub request_id: uuid::Uuid,
    /// Resolved credentials
    pub credentials: serde_json::Value,
    /// Whether the credential was from cache
    pub from_cache: bool,
    /// Timestamp of resolution
    pub timestamp: DateTime<Utc>,
}

/// CredentialProvider trait for secure credential resolution
#[async_trait::async_trait]
pub trait CredentialProvider: Send + Sync + fmt::Debug {
    /// Get provider metadata
    fn metadata(&self) -> &ProviderMetadata;

    /// Resolve credentials for the given scope
    async fn resolve_credentials(
        &self,
        request: &CredentialRequest,
    ) -> ProviderResult<CredentialResponse>;

    /// Revoke a credential by ID
    async fn revoke_credential(&self, credential_id: &str) -> ProviderResult<()>;

    /// Rotate credentials for the given scope
    async fn rotate_credentials(&self, scope: &CredentialScope) -> ProviderResult<()>;

    /// Get the health status of this provider
    fn health(&self) -> ProviderHealth;

    /// Validate that this provider supports the given scope
    fn supports_scope(&self, scope: &CredentialScope) -> bool;
}

// ==================== NotificationProvider ====================

/// Notification message
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotificationMessage {
    /// Recipient identifier (email, phone, user ID, etc.)
    pub recipient: String,
    /// Subject/title of the notification
    pub subject: String,
    /// Body content
    pub body: String,
    /// Optional metadata (links, buttons, etc.)
    pub metadata: Option<serde_json::Value>,
}

/// Notification delivery request
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotificationRequest {
    /// Unique request ID
    pub request_id: uuid::Uuid,
    /// Message to deliver
    pub message: NotificationMessage,
    /// Delivery priority (low, normal, high)
    pub priority: NotificationPriority,
    /// Maximum delivery attempts
    pub max_attempts: u32,
    /// Time-to-live for the notification (milliseconds)
    pub ttl_ms: u64,
}

/// Notification delivery response
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotificationResponse {
    /// Request ID that this responds to
    pub request_id: uuid::Uuid,
    /// Delivery status
    pub status: NotificationStatus,
    /// Provider-specific delivery ID
    pub delivery_id: Option<String>,
    /// Timestamp of delivery attempt
    pub timestamp: DateTime<Utc>,
}

/// Notification priority levels
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum NotificationPriority {
    Low,
    Normal,
    High,
}

impl fmt::Display for NotificationPriority {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            NotificationPriority::Low => write!(f, "low"),
            NotificationPriority::Normal => write!(f, "normal"),
            NotificationPriority::High => write!(f, "high"),
        }
    }
}

/// Notification delivery status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum NotificationStatus {
    /// Notification queued for delivery
    Queued,
    /// Notification sent successfully
    Delivered,
    /// Notification failed to deliver
    Failed,
    /// Notification expired before delivery
    Expired,
}

impl fmt::Display for NotificationStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            NotificationStatus::Queued => write!(f, "queued"),
            NotificationStatus::Delivered => write!(f, "delivered"),
            NotificationStatus::Failed => write!(f, "failed"),
            NotificationStatus::Expired => write!(f, "expired"),
        }
    }
}

/// NotificationProvider trait for configurable notification delivery
#[async_trait::async_trait]
pub trait NotificationProvider: Send + Sync + fmt::Debug {
    /// Get provider metadata
    fn metadata(&self) -> &ProviderMetadata;

    /// Send a notification
    async fn send_notification(
        &self,
        request: &NotificationRequest,
    ) -> ProviderResult<NotificationResponse>;

    /// Cancel a pending notification
    async fn cancel_notification(&self, request_id: uuid::Uuid) -> ProviderResult<()>;

    /// Get the health status of this provider
    fn health(&self) -> ProviderHealth;

    /// Validate that this provider supports the given recipient type
    fn supports_recipient(&self, recipient: &str) -> bool;
}

// ==================== Provider Registry ====================

/// Metadata about a provider
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderMetadata {
    /// Unique identifier for this provider
    pub id: ProviderId,
    /// Human-readable name
    pub name: String,
    /// Provider version
    pub version: String,
    /// Provider description
    pub description: Option<String>,
    /// Capabilities supported by this provider
    pub capabilities: ProviderCapabilities,
    /// Configuration schema (JSON Schema)
    pub config_schema: Option<serde_json::Value>,
}

/// Registry for loading and managing providers
pub struct ProviderRegistry {
    providers: std::collections::HashMap<String, Box<dyn AnyProvider>>,
}

impl ProviderRegistry {
    /// Create a new empty registry
    pub fn new() -> Self {
        ProviderRegistry {
            providers: std::collections::HashMap::new(),
        }
    }

    /// Register a provider by name
    pub fn register<P: AnyProvider + 'static>(&mut self, name: &str, provider: P) {
        self.providers.insert(name.to_string(), Box::new(provider));
    }

    /// Get a reference to a registered provider
    pub fn get(&self, name: &str) -> Option<&dyn AnyProvider> {
        self.providers.get(name).map(|p| p.as_ref())
    }

    /// Get the health of all registered providers
    pub fn health_all(&self) -> std::collections::HashMap<String, ProviderHealth> {
        self.providers
            .iter()
            .map(|(name, provider)| (name.clone(), provider.health()))
            .collect()
    }
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Trait for any provider type (used for dynamic dispatch in registry)
pub trait AnyProvider: Send + Sync {
    fn metadata(&self) -> &ProviderMetadata;
    fn health(&self) -> ProviderHealth;
}

impl<T: AnyProvider> AnyProvider for Box<T> {
    fn metadata(&self) -> &ProviderMetadata {
        (**self).metadata()
    }

    fn health(&self) -> ProviderHealth {
        (**self).health()
    }
}

// ==================== Built-in Human Provider ====================

/// Default built-in human interaction provider (always available)
pub mod builtin_human_provider {
    use super::*;

    /// Built-in provider for HITL via in-app UI
    pub struct BuiltInHumanProvider {
        metadata: ProviderMetadata,
    }

    impl BuiltInHumanProvider {
        pub fn new() -> Self {
            BuiltInHumanProvider {
                metadata: ProviderMetadata {
                    id: ProviderId::from_uuid(uuid::Uuid::parse_str("00000000-0000-0000-0000-000000000001").unwrap()),
                    name: "BuiltInHumanProvider".to_string(),
                    version: "1.0.0".to_string(),
                    description: Some("Default human interaction provider via in-app UI".to_string()),
                    capabilities: ProviderCapabilities {
                        human_interaction: true,
                        credential_resolution: false,
                        notification_delivery: false,
                        secure_response: true,
                        origin_verification: true,
                    },
                    config_schema: None,
                },
            }
        }
    }

    impl fmt::Debug for BuiltInHumanProvider {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.debug_struct("BuiltInHumanProvider").finish()
        }
    }

    #[async_trait::async_trait]
    impl HumanInteractionProvider for BuiltInHumanProvider {
        fn metadata(&self) -> &ProviderMetadata {
            &self.metadata
        }

        async fn send_interaction(&self, _request: &HumanInteractionRequest) -> ProviderResult<()> {
            // In a real implementation, this would push to the in-app inbox
            Ok(())
        }

        async fn wait_for_response(
            &self,
            _request_id: uuid::Uuid,
            _timeout_ms: u64,
        ) -> ProviderResult<HumanInteractionResponse> {
            // In a real implementation, this would wait for user action in the UI
            Err(ProviderError::Unavailable("BuiltInHumanProvider does not block for responses".to_string()))
        }

        async fn cancel_interaction(&self, _request_id: uuid::Uuid) -> ProviderResult<()> {
            Ok(())
        }

        fn health(&self) -> ProviderHealth {
            ProviderHealth::Healthy
        }

        fn supports_kind(&self, _kind: HumanInteractionKind) -> bool {
            true
        }
    }

    impl AnyProvider for BuiltInHumanProvider {
        fn metadata(&self) -> &ProviderMetadata {
            &self.metadata
        }

        fn health(&self) -> ProviderHealth {
            ProviderHealth::Healthy
        }
    }
}

// ==================== Helper Functions ====================

/// Generate a unique request ID
pub fn generate_request_id() -> uuid::Uuid {
    uuid::Uuid::new_v4()
}

/// Check if two scopes match (for authorization)
pub fn scopes_match(scope1: &CredentialScope, scope2: &CredentialScope) -> bool {
    scope1.owner_id == scope2.owner_id
        && scope1.origin == scope2.origin
        && scope1.profile == scope2.profile
        && scope1.purpose == scope2.purpose
}

/// Validate a credential scope
pub fn validate_scope(scope: &CredentialScope) -> ProviderResult<()> {
    if scope.owner_id.is_nil() {
        return Err(ProviderError::InvalidData("owner_id cannot be nil".to_string()));
    }
    if scope.origin.is_empty() {
        return Err(ProviderError::InvalidData("origin cannot be empty".to_string()));
    }
    if scope.purpose.is_empty() {
        return Err(ProviderError::InvalidData("purpose cannot be empty".to_string()));
    }
    Ok(())
}
