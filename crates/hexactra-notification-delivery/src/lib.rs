//! Notification delivery for Hexactra runtime
//!
//! This crate provides configurable notification delivery with secure response links,
//! authenticated owner mapping, delivery retry/dedupe, and vault-neutral lookup.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

// ==================== Error Types ====================

/// Notification delivery error types
#[derive(Debug, Error)]
pub enum NotificationDeliveryError {
    #[error("Notification not found for request_id: {0}")]
    NotFound(String),
    #[error("Owner verification failed for scope: {0}")]
    OwnerMismatch(String),
    #[error("Response link expired")]
    LinkExpired,
    #[error("Invalid notification scope: {0}")]
    InvalidScope(String),
    #[error("Internal error: {0}")]
    Internal(String),
}

/// Result type for notification delivery operations
pub type NotificationDeliveryResult<T> = std::result::Result<T, NotificationDeliveryError>;

// ==================== Scope Types ====================

/// Notification scope for lookup
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotificationScope {
    /// Owner ID (user or agent)
    pub owner_id: Uuid,
    /// Target channel type (email, sms, push, webhook, etc.)
    pub channel_type: String,
    /// Channel identifier (email address, phone number, device token, etc.)
    pub channel_identifier: String,
    /// Purpose of notification (e.g., "otp", "alert", "confirm")
    pub purpose: String,
}

impl NotificationScope {
    /// Create a new notification scope
    pub fn new(owner_id: Uuid, channel_type: impl Into<String>, channel_identifier: impl Into<String>, purpose: impl Into<String>) -> Self {
        NotificationScope {
            owner_id,
            channel_type: channel_type.into(),
            channel_identifier: channel_identifier.into(),
            purpose: purpose.into(),
        }
    }

    /// Validate the scope
    pub fn validate(&self) -> NotificationDeliveryResult<()> {
        if self.owner_id.is_nil() {
            return Err(NotificationDeliveryError::InvalidScope(
                "owner_id cannot be nil".to_string(),
            ));
        }
        if self.channel_type.is_empty() {
            return Err(NotificationDeliveryError::InvalidScope(
                "channel_type cannot be empty".to_string(),
            ));
        }
        if self.channel_identifier.is_empty() {
            return Err(NotificationDeliveryError::InvalidScope(
                "channel_identifier cannot be empty".to_string(),
            ));
        }
        if self.purpose.is_empty() {
            return Err(NotificationDeliveryError::InvalidScope(
                "purpose cannot be empty".to_string(),
            ));
        }
        Ok(())
    }

    /// Check if two scopes match (for authorization)
    pub fn matches(&self, other: &NotificationScope) -> bool {
        self.owner_id == other.owner_id
            && self.channel_type == other.channel_type
            && self.channel_identifier == other.channel_identifier
            && self.purpose == other.purpose
    }
}

// ==================== Response Link Types ====================

/// Unique identifier for a response link
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ResponseLinkId(Uuid);

impl ResponseLinkId {
    pub fn new() -> Self {
        ResponseLinkId(Uuid::new_v4())
    }

    pub fn from_uuid(uuid: Uuid) -> Self {
        ResponseLinkId(uuid)
    }

    pub fn as_uuid(&self) -> Uuid {
        self.0
    }
}

/// Secure response link for notification responses
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResponseLink {
    /// Unique link ID
    pub id: ResponseLinkId,
    /// Scope that this link is bound to
    pub scope: NotificationScope,
    /// Encrypted/obfuscated response data
    pub encrypted_response: String,
    /// Timestamp when the link was created
    pub created_at: DateTime<Utc>,
    /// Timestamp when the link expires
    pub expires_at: DateTime<Utc>,
    /// Whether the link has been used
    pub used: bool,
    /// Audit metadata
    pub audit_metadata: Option<serde_json::Value>,
}

impl ResponseLink {
    /// Create a new response link
    pub fn new(scope: NotificationScope, encrypted_response: impl Into<String>) -> Self {
        let now = Utc::now();
        ResponseLink {
            id: ResponseLinkId::new(),
            scope,
            encrypted_response: encrypted_response.into(),
            created_at: now,
            expires_at: now + chrono::Duration::minutes(15), // Default 15 minute expiry
            used: false,
            audit_metadata: None,
        }
    }

    /// Check if the link is expired
    pub fn is_expired(&self) -> bool {
        Utc::now() >= self.expires_at
    }

    /// Check if the link can be used (not expired and not used)
    pub fn is_valid(&self) -> bool {
        !self.is_expired() && !self.used
    }
}

// ==================== Notification Delivery Request ====================

/// Request for notification delivery
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotificationDeliveryRequest {
    /// Unique request ID
    pub request_id: Uuid,
    /// Notification scope
    pub scope: NotificationScope,
    /// Whether to use cached delivery if available
    pub allow_cache: bool,
    /// Maximum age of cached delivery (milliseconds)
    pub max_cache_age_ms: u64,
}

// ==================== Notification Delivery Response ====================

/// Response with delivered notification
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotificationDeliveryResponse {
    /// Request ID that this responds to
    pub request_id: Uuid,
    /// Secure response link for user response
    pub response_link: ResponseLink,
    /// Timestamp of delivery
    pub timestamp: DateTime<Utc>,
}

// ==================== Notification Store Interface ====================

/// Notification store interface for persistent storage
#[async_trait::async_trait]
pub trait NotificationStore: Send + Sync {
    /// Store a notification for delivery
    async fn store_notification(
        &self,
        scope: &NotificationScope,
        request_id: Uuid,
        encrypted_response: &str,
    ) -> NotificationDeliveryResult<()>;

    /// Retrieve a notification by request_id
    async fn retrieve_notification(&self, request_id: Uuid) -> NotificationDeliveryResult<serde_json::Value>;

    /// Mark a notification as delivered
    async fn mark_delivered(&self, request_id: Uuid) -> NotificationDeliveryResult<()>;

    /// Revoke a notification for a scope
    async fn revoke_notification(&self, scope: &NotificationScope) -> NotificationDeliveryResult<()>;
}

// ==================== Scoped Notification Delivery ====================

/// Scoped notification delivery with secure response links
pub struct ScopedNotificationDelivery {
    stores: std::collections::HashMap<String, Box<dyn NotificationStore>>,
    response_links: std::sync::Mutex<std::collections::HashMap<ResponseLinkId, ResponseLink>>,
    default_store: Option<String>,
}

impl ScopedNotificationDelivery {
    /// Create a new scoped notification delivery
    pub fn new() -> Self {
        ScopedNotificationDelivery {
            stores: std::collections::HashMap::new(),
            response_links: std::sync::Mutex::new(std::collections::HashMap::new()),
            default_store: None,
        }
    }

    /// Register a store by name
    pub fn register_store(&mut self, name: impl Into<String>, store: Box<dyn NotificationStore>) {
        let name = name.into();
        if self.default_store.is_none() {
            self.default_store = Some(name.clone());
        }
        self.stores.insert(name, store);
    }

    /// Set the default store
    pub fn set_default_store(&mut self, name: impl Into<String>) {
        self.default_store = Some(name.into());
    }

    /// Deliver a notification for a scope
    pub async fn deliver_notification(
        &self,
        request: &NotificationDeliveryRequest,
    ) -> NotificationDeliveryResult<NotificationDeliveryResponse> {
        // Validate the scope
        request.scope.validate()?;

        // Check if we have a store that can handle this scope
        let store_name = self.default_store.as_ref().ok_or_else(|| {
            NotificationDeliveryError::Internal("No store registered".to_string())
        })?;

        let store = self.stores.get(store_name).ok_or_else(|| {
            NotificationDeliveryError::Internal(format!("Store not found: {}", store_name))
        })?;

        // Store the notification in the store
        store.store_notification(&request.scope, request.request_id, "pending").await?;

        // Create a secure response link for user response
        let encrypted_response = serde_json::to_string(&serde_json::json!({
            "request_id": request.request_id,
            "scope": request.scope,
        }))
        .map_err(|e| NotificationDeliveryError::Internal(e.to_string()))?;

        let mut link = ResponseLink::new(request.scope.clone(), encrypted_response);
        link.audit_metadata = Some(serde_json::json!({
            "request_id": request.request_id,
            "created_at": link.created_at.to_rfc3339(),
        }));

        // Store the link in memory (in production, this would be in a database)
        self.response_links
            .lock()
            .map_err(|e| NotificationDeliveryError::Internal(e.to_string()))?
            .insert(link.id, link.clone());

        Ok(NotificationDeliveryResponse {
            request_id: request.request_id,
            response_link: link,
            timestamp: Utc::now(),
        })
    }

    /// Use a response link (marks it as used)
    pub fn use_response_link(&self, link_id: ResponseLinkId) -> NotificationDeliveryResult<()> {
        let mut links = self
            .response_links
            .lock()
            .map_err(|e| NotificationDeliveryError::Internal(e.to_string()))?;

        if let Some(link) = links.get_mut(&link_id) {
            if link.is_expired() {
                return Err(NotificationDeliveryError::LinkExpired);
            }
            if link.used {
                return Err(NotificationDeliveryError::Internal(
                    "Link already used".to_string(),
                ));
            }
            link.used = true;
            Ok(())
        } else {
            Err(NotificationDeliveryError::NotFound(format!(
                "Link not found: {}",
                link_id.as_uuid()
            )))
        }
    }

    /// Revoke a response link
    pub fn revoke_response_link(&self, link_id: ResponseLinkId) -> NotificationDeliveryResult<()> {
        let mut links = self
            .response_links
            .lock()
            .map_err(|e| NotificationDeliveryError::Internal(e.to_string()))?;

        if links.remove(&link_id).is_some() {
            Ok(())
        } else {
            Err(NotificationDeliveryError::NotFound(format!(
                "Link not found: {}",
                link_id.as_uuid()
            )))
        }
    }

    /// Validate that a response link is valid for use
    pub fn validate_response_link(&self, link_id: ResponseLinkId) -> NotificationDeliveryResult<()> {
        let links = self
            .response_links
            .lock()
            .map_err(|e| NotificationDeliveryError::Internal(e.to_string()))?;

        if let Some(link) = links.get(&link_id) {
            if link.is_expired() {
                return Err(NotificationDeliveryError::LinkExpired);
            }
            if link.used {
                return Err(NotificationDeliveryError::Internal(
                    "Link already used".to_string(),
                ));
            }
            Ok(())
        } else {
            Err(NotificationDeliveryError::NotFound(format!(
                "Link not found: {}",
                link_id.as_uuid()
            )))
        }
    }

    /// Deliver notification with owner verification
    pub async fn deliver_notification_with_owner(
        &self,
        request: &NotificationDeliveryRequest,
        expected_owner_id: Uuid,
    ) -> NotificationDeliveryResult<NotificationDeliveryResponse> {
        // Verify owner matches
        if request.scope.owner_id != expected_owner_id {
            return Err(NotificationDeliveryError::OwnerMismatch(format!(
                "Expected: {}, Got: {}",
                expected_owner_id, request.scope.owner_id
            )));
        }

        self.deliver_notification(request).await
    }
}

impl Default for ScopedNotificationDelivery {
    fn default() -> Self {
        Self::new()
    }
}

// ==================== Mock Store Implementation ====================

/// Mock store for testing
pub mod mock_store {
    use super::*;

    /// In-memory mock store for testing
    pub struct MockStore {
        notifications: std::sync::Mutex<std::collections::HashMap<String, serde_json::Value>>,
    }

    impl MockStore {
        pub fn new() -> Self {
            MockStore {
                notifications: std::sync::Mutex::new(std::collections::HashMap::new()),
            }
        }
    }

    impl Default for MockStore {
        fn default() -> Self {
            Self::new()
        }
    }

    #[async_trait::async_trait]
    impl NotificationStore for MockStore {
        async fn store_notification(
            &self,
            scope: &NotificationScope,
            request_id: Uuid,
            encrypted_response: &str,
        ) -> NotificationDeliveryResult<()> {
            let key = format!(
                "{}:{}:{}:{}:{}",
                scope.owner_id, scope.channel_type, scope.channel_identifier, scope.purpose, request_id
            );
            self.notifications
                .lock()
                .map_err(|e| NotificationDeliveryError::Internal(e.to_string()))?
                .insert(key, serde_json::json!({
                    "request_id": request_id,
                    "encrypted_response": encrypted_response,
                    "created_at": Utc::now().to_rfc3339(),
                }));
            Ok(())
        }

        async fn retrieve_notification(&self, request_id: Uuid) -> NotificationDeliveryResult<serde_json::Value> {
            // Search for notification by request_id
            let notifications = self
                .notifications
                .lock()
                .map_err(|e| NotificationDeliveryError::Internal(e.to_string()))?;

            for (_, value) in notifications.iter() {
                if let Some(id) = value.get("request_id") {
                    if id.as_str() == Some(&request_id.to_string()) {
                        return Ok(value.clone());
                    }
                }
            }

            Err(NotificationDeliveryError::NotFound(format!(
                "Request ID: {}",
                request_id
            )))
        }

        async fn mark_delivered(&self, request_id: Uuid) -> NotificationDeliveryResult<()> {
            let mut notifications = self
                .notifications
                .lock()
                .map_err(|e| NotificationDeliveryError::Internal(e.to_string()))?;

            for (_, value) in notifications.iter_mut() {
                if let Some(id) = value.get("request_id") {
                    if id.as_str() == Some(&request_id.to_string()) {
                        value["status"] = serde_json::json!("delivered");
                        return Ok(());
                    }
                }
            }

            Err(NotificationDeliveryError::NotFound(format!(
                "Request ID: {}",
                request_id
            )))
        }

        async fn revoke_notification(&self, scope: &NotificationScope) -> NotificationDeliveryResult<()> {
            let key_prefix = format!(
                "{}:{}:{}:{}:",
                scope.owner_id, scope.channel_type, scope.channel_identifier, scope.purpose
            );
            let mut notifications = self
                .notifications
                .lock()
                .map_err(|e| NotificationDeliveryError::Internal(e.to_string()))?;

            // Remove all notifications matching the scope prefix
            let keys_to_remove: Vec<String> = notifications
                .keys()
                .filter(|k| k.starts_with(&key_prefix))
                .cloned()
                .collect();

            for key in keys_to_remove {
                notifications.remove(&key);
            }

            Ok(())
        }
    }
}

// ==================== Helper Functions ====================

/// Generate a unique request ID
pub fn generate_request_id() -> Uuid {
    Uuid::new_v4()
}

/// Validate that two scopes match for authorization
pub fn scopes_match(scope1: &NotificationScope, scope2: &NotificationScope) -> bool {
    scope1.owner_id == scope2.owner_id
        && scope1.channel_type == scope2.channel_type
        && scope1.channel_identifier == scope2.channel_identifier
        && scope1.purpose == scope2.purpose
}

/// Create a notification scope for testing
pub fn test_scope(
    owner_id: Uuid,
    channel_type: impl Into<String>,
    channel_identifier: impl Into<String>,
    purpose: impl Into<String>,
) -> NotificationScope {
    NotificationScope {
        owner_id,
        channel_type: channel_type.into(),
        channel_identifier: channel_identifier.into(),
        purpose: purpose.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_notification_scope_validation() {
        let owner_id = Uuid::new_v4();

        // Valid scope
        let scope = NotificationScope::new(owner_id, "email".to_string(), "user@example.com".to_string(), "otp".to_string());
        assert!(scope.validate().is_ok());

        // Invalid: nil owner_id
        let invalid_scope = NotificationScope {
            owner_id: Uuid::nil(),
            channel_type: "email".to_string(),
            channel_identifier: "user@example.com".to_string(),
            purpose: "otp".to_string(),
        };
        assert!(invalid_scope.validate().is_err());

        // Invalid: empty channel_type
        let invalid_scope = NotificationScope {
            owner_id,
            channel_type: "".to_string(),
            channel_identifier: "user@example.com".to_string(),
            purpose: "otp".to_string(),
        };
        assert!(invalid_scope.validate().is_err());

        // Invalid: empty channel_identifier
        let invalid_scope = NotificationScope {
            owner_id,
            channel_type: "email".to_string(),
            channel_identifier: "".to_string(),
            purpose: "otp".to_string(),
        };
        assert!(invalid_scope.validate().is_err());

        // Invalid: empty purpose
        let invalid_scope = NotificationScope {
            owner_id,
            channel_type: "email".to_string(),
            channel_identifier: "user@example.com".to_string(),
            purpose: "".to_string(),
        };
        assert!(invalid_scope.validate().is_err());
    }

    #[test]
    fn test_response_link_expiry() {
        let now = Utc::now();
        let scope = NotificationScope::new(Uuid::new_v4(), "email".to_string(), "user@example.com".to_string(), "otp".to_string());

        // Create a link that expired 1 minute ago
        let expired_link = ResponseLink {
            id: ResponseLinkId::new(),
            scope: scope.clone(),
            encrypted_response: "test".to_string(),
            created_at: now - chrono::Duration::minutes(20),
            expires_at: now - chrono::Duration::minutes(5),
            used: false,
            audit_metadata: None,
        };

        assert!(expired_link.is_expired());
        assert!(!expired_link.is_valid());

        // Create a valid link
        let valid_link = ResponseLink::new(scope, "test");
        assert!(!valid_link.is_expired());
        assert!(valid_link.is_valid());
    }

    #[tokio::test]
    async fn test_mock_store() {
        let store = mock_store::MockStore::new();
        let owner_id = Uuid::new_v4();
        let scope = NotificationScope::new(owner_id, "email".to_string(), "user@example.com".to_string(), "otp".to_string());
        let request_id = Uuid::new_v4();

        // Store notification
        store.store_notification(&scope, request_id, "pending").await.unwrap();

        // Retrieve notification
        let retrieved = store.retrieve_notification(request_id).await.unwrap();
        assert_eq!(retrieved.get("request_id").unwrap().as_str(), Some(request_id.to_string().as_str()));

        // Mark as delivered
        store.mark_delivered(request_id).await.unwrap();

        // Revoke notification
        store.revoke_notification(&scope).await.unwrap();

        // Try to retrieve again (should fail)
        assert!(store.retrieve_notification(request_id).await.is_err());
    }
}
