//! Demo provider integration for Hexactra
//!
//! This crate provides example implementations of real provider integrations
//! for credentials and notifications. It demonstrates how to integrate with
//! actual vaults and notification services.

use hexactra_provider_sdk::{
    CredentialProvider, CredentialRequest, CredentialResponse, HumanInteractionKind,
    HumanInteractionProvider, HumanInteractionRequest, HumanInteractionResponse,
    NotificationProvider, NotificationRequest, NotificationResponse, ProviderCapabilities,
    ProviderHealth, ProviderId, ProviderMetadata, ProviderResult,
};
use serde_json::json;
use uuid::Uuid;

// ==================== Demo Credential Provider Implementation ====================

/// Demo implementation of the CredentialProvider trait
#[derive(Debug)]
pub struct DemoCredentialProvider {
    metadata: ProviderMetadata,
}

impl DemoCredentialProvider {
    pub fn new() -> Self {
        DemoCredentialProvider {
            metadata: ProviderMetadata {
                id: ProviderId::new(),
                name: "Demo Credential Provider".to_string(),
                version: "0.1.0".to_string(),
                description: Some("Demo credential provider for testing".to_string()),
                capabilities: ProviderCapabilities {
                    human_interaction: false,
                    credential_resolution: true,
                    notification_delivery: false,
                    secure_response: false,
                    origin_verification: false,
                },
                config_schema: None,
            },
        }
    }
}

impl Default for DemoCredentialProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl CredentialProvider for DemoCredentialProvider {
    fn metadata(&self) -> &ProviderMetadata {
        &self.metadata
    }

    async fn resolve_credentials(
        &self,
        request: &CredentialRequest,
    ) -> ProviderResult<CredentialResponse> {
        // In a real implementation, this would retrieve credentials from a vault
        // For demo purposes, we'll return mock credentials
        Ok(CredentialResponse {
            request_id: request.request_id,
            credentials: json!({
                "username": "demo_user",
                "password": "demo_password"
            }),
            from_cache: false,
            timestamp: chrono::Utc::now(),
        })
    }

    async fn revoke_credential(&self, _credential_id: &str) -> ProviderResult<()> {
        // In a real implementation, this would revoke a credential by ID
        Ok(())
    }

    async fn rotate_credentials(
        &self,
        _scope: &hexactra_provider_sdk::CredentialScope,
    ) -> ProviderResult<()> {
        // In a real implementation, this would rotate credentials
        Ok(())
    }

    fn health(&self) -> ProviderHealth {
        ProviderHealth::Healthy
    }

    fn supports_scope(&self, _scope: &hexactra_provider_sdk::CredentialScope) -> bool {
        // This demo provider supports all scopes
        true
    }
}

// ==================== Demo Notification Provider Implementation ====================

/// Demo implementation of the NotificationProvider trait
#[derive(Debug)]
pub struct DemoNotificationProvider {
    metadata: ProviderMetadata,
}

impl DemoNotificationProvider {
    pub fn new() -> Self {
        DemoNotificationProvider {
            metadata: ProviderMetadata {
                id: ProviderId::new(),
                name: "Demo Notification Provider".to_string(),
                version: "0.1.0".to_string(),
                description: Some("Demo notification provider for testing".to_string()),
                capabilities: ProviderCapabilities {
                    human_interaction: false,
                    credential_resolution: false,
                    notification_delivery: true,
                    secure_response: true,
                    origin_verification: false,
                },
                config_schema: None,
            },
        }
    }
}

impl Default for DemoNotificationProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl NotificationProvider for DemoNotificationProvider {
    fn metadata(&self) -> &ProviderMetadata {
        &self.metadata
    }

    async fn send_notification(
        &self,
        request: &NotificationRequest,
    ) -> ProviderResult<NotificationResponse> {
        // In a real implementation, this would send a notification via email/SMS/push
        // For demo purposes, we'll just log and return success
        Ok(NotificationResponse {
            request_id: request.request_id,
            status: hexactra_provider_sdk::NotificationStatus::Queued,
            delivery_id: Some("demo-delivery-123".to_string()),
            timestamp: chrono::Utc::now(),
        })
    }

    async fn cancel_notification(&self, _request_id: uuid::Uuid) -> ProviderResult<()> {
        // In a real implementation, this would cancel a pending notification
        Ok(())
    }

    fn health(&self) -> ProviderHealth {
        ProviderHealth::Healthy
    }

    fn supports_recipient(&self, _recipient: &str) -> bool {
        // This demo provider supports all recipients
        true
    }
}

// ==================== Demo Human Interaction Provider Implementation ====================

/// Demo implementation of the HumanInteractionProvider trait
#[derive(Debug)]
pub struct DemoHumanInteractionProvider {
    metadata: ProviderMetadata,
}

impl DemoHumanInteractionProvider {
    pub fn new() -> Self {
        DemoHumanInteractionProvider {
            metadata: ProviderMetadata {
                id: ProviderId::new(),
                name: "Demo HITL Provider".to_string(),
                version: "0.1.0".to_string(),
                description: Some("Demo human-in-the-loop provider for testing".to_string()),
                capabilities: ProviderCapabilities {
                    human_interaction: true,
                    credential_resolution: false,
                    notification_delivery: false,
                    secure_response: false,
                    origin_verification: false,
                },
                config_schema: None,
            },
        }
    }
}

impl Default for DemoHumanInteractionProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl HumanInteractionProvider for DemoHumanInteractionProvider {
    fn metadata(&self) -> &ProviderMetadata {
        &self.metadata
    }

    async fn send_interaction(&self, _request: &HumanInteractionRequest) -> ProviderResult<()> {
        // In a real implementation, this would send an interaction request to the user
        Ok(())
    }

    async fn wait_for_response(
        &self,
        _request_id: uuid::Uuid,
        _timeout_ms: u64,
    ) -> ProviderResult<HumanInteractionResponse> {
        // In a real implementation, this would wait for human input
        // For demo purposes, we'll return a mock response
        Ok(HumanInteractionResponse {
            request_id: Uuid::new_v4(),
            status: hexactra_provider_sdk::InteractionStatus::Approved,
            data: Some(json!({"action": "confirmed"})),
            timestamp: chrono::Utc::now(),
        })
    }

    async fn cancel_interaction(&self, _request_id: uuid::Uuid) -> ProviderResult<()> {
        // In a real implementation, this would cancel a pending interaction request
        Ok(())
    }

    fn health(&self) -> ProviderHealth {
        ProviderHealth::Healthy
    }

    fn supports_kind(&self, _kind: HumanInteractionKind) -> bool {
        // This demo provider supports all interaction kinds
        true
    }
}

// ==================== Demo Provider Registry ====================

/// Registry for demo providers
pub struct DemoProviderRegistry {
    credential_provider: Option<std::sync::Arc<dyn CredentialProvider>>,
    notification_provider: Option<std::sync::Arc<dyn NotificationProvider>>,
    human_interaction_provider: Option<std::sync::Arc<dyn HumanInteractionProvider>>,
}

impl DemoProviderRegistry {
    /// Create a new registry with all demo providers enabled
    pub fn with_all_enabled() -> Self {
        DemoProviderRegistry {
            credential_provider: Some(std::sync::Arc::new(DemoCredentialProvider::new())),
            notification_provider: Some(std::sync::Arc::new(DemoNotificationProvider::new())),
            human_interaction_provider: Some(std::sync::Arc::new(DemoHumanInteractionProvider::new())),
        }
    }

    /// Create a new registry with only credential provider enabled
    pub fn with_credentials_only() -> Self {
        DemoProviderRegistry {
            credential_provider: Some(std::sync::Arc::new(DemoCredentialProvider::new())),
            notification_provider: None,
            human_interaction_provider: None,
        }
    }

    /// Create a new registry with no providers enabled
    pub fn with_none_enabled() -> Self {
        DemoProviderRegistry {
            credential_provider: None,
            notification_provider: None,
            human_interaction_provider: None,
        }
    }

    /// Get the credential provider if enabled
    pub fn credential_provider(&self) -> Option<&std::sync::Arc<dyn CredentialProvider>> {
        self.credential_provider.as_ref()
    }

    /// Get the notification provider if enabled
    pub fn notification_provider(&self) -> Option<&std::sync::Arc<dyn NotificationProvider>> {
        self.notification_provider.as_ref()
    }

    /// Get the human interaction provider if enabled
    pub fn human_interaction_provider(&self) -> Option<&std::sync::Arc<dyn HumanInteractionProvider>> {
        self.human_interaction_provider.as_ref()
    }
}

impl Default for DemoProviderRegistry {
    fn default() -> Self {
        Self::with_none_enabled()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_demo_credential_provider() {
        let provider = DemoCredentialProvider::new();
        let request = CredentialRequest {
            request_id: Uuid::new_v4(),
            scope: hexactra_provider_sdk::CredentialScope {
                owner_id: Uuid::new_v4(),
                origin: "https://example.com".to_string(),
                profile: None,
                purpose: "login".to_string(),
            },
            allow_cache: false,
            max_cache_age_ms: 0,
        };

        // Resolve credentials
        let response = provider.resolve_credentials(&request).await.unwrap();
        assert_eq!(response.credentials.get("username").unwrap().as_str(), Some("demo_user"));

        // Test health
        assert_eq!(provider.health(), ProviderHealth::Healthy);

        // Test supports_scope
        assert!(provider.supports_scope(&request.scope));
    }

    #[tokio::test]
    async fn test_demo_notification_provider() {
        let provider = DemoNotificationProvider::new();
        let request = NotificationRequest {
            request_id: Uuid::new_v4(),
            message: hexactra_provider_sdk::NotificationMessage {
                recipient: "user@example.com".to_string(),
                subject: "otp".to_string(),
                body: "Your OTP is 123456".to_string(),
                metadata: None,
            },
            priority: hexactra_provider_sdk::NotificationPriority::Normal,
            max_attempts: 3,
            ttl_ms: 300000,
        };

        // Send notification
        let response = provider.send_notification(&request).await.unwrap();
        assert_eq!(response.status, hexactra_provider_sdk::NotificationStatus::Queued);
        assert!(response.delivery_id.is_some());

        // Test health
        assert_eq!(provider.health(), ProviderHealth::Healthy);

        // Test supports_recipient
        assert!(provider.supports_recipient("user@example.com"));
    }

    #[tokio::test]
    async fn test_demo_hitl_provider() {
        let provider = DemoHumanInteractionProvider::new();
        let request = HumanInteractionRequest {
            request_id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            reason: "confirm_action".to_string(),
            details: json!({"action": "test"}),
            kind: HumanInteractionKind::HumanTakeover,
            timeout_ms: 5000,
            verify_origin: false,
        };

        // Send interaction
        provider.send_interaction(&request).await.unwrap();

        // Wait for response
        let response = provider.wait_for_response(request.request_id, 5000).await.unwrap();
        assert_eq!(response.status, hexactra_provider_sdk::InteractionStatus::Approved);

        // Test health
        assert_eq!(provider.health(), ProviderHealth::Healthy);

        // Test supports_kind
        assert!(provider.supports_kind(HumanInteractionKind::HumanTakeover));
    }

    #[test]
    fn test_demo_registry() {
        // Test with all enabled
        let registry = DemoProviderRegistry::with_all_enabled();
        assert!(registry.credential_provider().is_some());
        assert!(registry.notification_provider().is_some());
        assert!(registry.human_interaction_provider().is_some());

        // Test with credentials only
        let registry = DemoProviderRegistry::with_credentials_only();
        assert!(registry.credential_provider().is_some());
        assert!(registry.notification_provider().is_none());
        assert!(registry.human_interaction_provider().is_none());

        // Test with none enabled
        let registry = DemoProviderRegistry::with_none_enabled();
        assert!(registry.credential_provider().is_none());
        assert!(registry.notification_provider().is_none());
        assert!(registry.human_interaction_provider().is_none());
    }
}
