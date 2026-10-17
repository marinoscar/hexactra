//! Provider conformance and migration tests for Hexactra
//!
//! This crate provides end-to-end tests for provider conformance,
//! vault/HITL integration, and failure recovery scenarios.

use hexactra_provider_sdk::{
    CredentialProvider, HumanInteractionKind, HumanInteractionProvider, NotificationProvider,
};
use uuid::Uuid;

// ==================== Conformance Tests ====================

/// Test that all provider metadata is correctly populated
pub fn test_provider_metadata() {
    let credential_provider = hexactra_demo_provider::DemoCredentialProvider::new();
    let notification_provider = hexactra_demo_provider::DemoNotificationProvider::new();
    let hitl_provider = hexactra_demo_provider::DemoHumanInteractionProvider::new();

    // Check credential provider metadata
    let cred_meta = credential_provider.metadata();
    assert_eq!(cred_meta.name, "Demo Credential Provider");
    assert_eq!(cred_meta.version, "0.1.0");
    assert!(cred_meta.capabilities.credential_resolution);
    assert!(!cred_meta.capabilities.human_interaction);

    // Check notification provider metadata
    let notif_meta = notification_provider.metadata();
    assert_eq!(notif_meta.name, "Demo Notification Provider");
    assert!(notif_meta.capabilities.notification_delivery);
    assert!(notif_meta.capabilities.secure_response);

    // Check HITL provider metadata
    let hitl_meta = hitl_provider.metadata();
    assert!(hitl_meta.capabilities.human_interaction);
}

/// Test that all providers report healthy status
pub fn test_provider_health() {
    let credential_provider = hexactra_demo_provider::DemoCredentialProvider::new();
    let notification_provider = hexactra_demo_provider::DemoNotificationProvider::new();
    let hitl_provider = hexactra_demo_provider::DemoHumanInteractionProvider::new();

    assert_eq!(credential_provider.health(), hexactra_provider_sdk::ProviderHealth::Healthy);
    assert_eq!(notification_provider.health(), hexactra_provider_sdk::ProviderHealth::Healthy);
    assert_eq!(hitl_provider.health(), hexactra_provider_sdk::ProviderHealth::Healthy);
}

/// Test that providers correctly report supported scopes/recipient types
pub fn test_provider_capabilities() {
    let credential_provider = hexactra_demo_provider::DemoCredentialProvider::new();
    let notification_provider = hexactra_demo_provider::DemoNotificationProvider::new();
    let hitl_provider = hexactra_demo_provider::DemoHumanInteractionProvider::new();

    // Credential provider supports all scopes
    let scope = hexactra_provider_sdk::CredentialScope {
        owner_id: Uuid::new_v4(),
        origin: "https://example.com".to_string(),
        profile: None,
        purpose: "login".to_string(),
    };
    assert!(credential_provider.supports_scope(&scope));

    // Notification provider supports all recipients
    assert!(notification_provider.supports_recipient("user@example.com"));
    assert!(notification_provider.supports_recipient("+1234567890"));

    // HITL provider supports all interaction kinds
    for kind in [
        HumanInteractionKind::SecretText,
        HumanInteractionKind::OtpCode,
        HumanInteractionKind::OobConfirmation,
        HumanInteractionKind::PasskeyOrSecurityKey,
        HumanInteractionKind::ActionApproval,
        HumanInteractionKind::HumanTakeover,
    ] {
        assert!(hitl_provider.supports_kind(kind));
    }
}

// ==================== Integration Tests ====================

#[tokio::test]
async fn test_credential_resolution_flow() {
    let provider = hexactra_demo_provider::DemoCredentialProvider::new();
    let request = hexactra_provider_sdk::CredentialRequest {
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

    let response = provider.resolve_credentials(&request).await.unwrap();

    assert_eq!(response.request_id, request.request_id);
    assert!(!response.from_cache);
    assert_eq!(response.credentials.get("username").unwrap().as_str(), Some("demo_user"));
    assert_eq!(response.credentials.get("password").unwrap().as_str(), Some("demo_password"));
}

#[tokio::test]
async fn test_notification_delivery_flow() {
    let provider = hexactra_demo_provider::DemoNotificationProvider::new();
    let request = hexactra_provider_sdk::NotificationRequest {
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

    let response = provider.send_notification(&request).await.unwrap();

    assert_eq!(response.request_id, request.request_id);
    assert_eq!(response.status, hexactra_provider_sdk::NotificationStatus::Queued);
    assert!(response.delivery_id.is_some());
}

#[tokio::test]
async fn test_hitl_flow() {
    let provider = hexactra_demo_provider::DemoHumanInteractionProvider::new();
    let request = hexactra_provider_sdk::HumanInteractionRequest {
        request_id: Uuid::new_v4(),
        session_id: Uuid::new_v4(),
        reason: "confirm_action".to_string(),
        details: serde_json::json!({"action": "test"}),
        kind: HumanInteractionKind::HumanTakeover,
        timeout_ms: 5000,
        verify_origin: false,
    };

    // Send interaction
    provider.send_interaction(&request).await.unwrap();

    // Wait for response
    let response = provider.wait_for_response(request.request_id, 5000).await.unwrap();

    assert_eq!(response.status, hexactra_provider_sdk::InteractionStatus::Approved);
    assert!(response.data.is_some());
    assert_eq!(
        response.data.as_ref().unwrap().get("action").unwrap().as_str(),
        Some("confirmed")
    );
}

// ==================== Failure Recovery Tests ====================

#[test]
fn test_provider_registry_with_none_enabled() {
    let registry = DemoProviderRegistry::with_none_enabled();
    
    assert!(registry.credential_provider().is_none());
    assert!(registry.notification_provider().is_none());
    assert!(registry.human_interaction_provider().is_none());
}

#[test]
fn test_provider_registry_with_credentials_only() {
    let registry = DemoProviderRegistry::with_credentials_only();
    
    assert!(registry.credential_provider().is_some());
    assert!(registry.notification_provider().is_none());
    assert!(registry.human_interaction_provider().is_none());
}

#[test]
fn test_provider_registry_with_all_enabled() {
    let registry = DemoProviderRegistry::with_all_enabled();
    
    assert!(registry.credential_provider().is_some());
    assert!(registry.notification_provider().is_some());
    assert!(registry.human_interaction_provider().is_some());
}

#[cfg(test)]
mod integration_tests {
    use super::*;

    #[tokio::test]
    async fn test_full_workflow() {
        let registry = DemoProviderRegistry::with_all_enabled();
        
        // 1. Resolve credentials
        let cred_provider = registry.credential_provider().unwrap();
        let cred_request = hexactra_provider_sdk::CredentialRequest {
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
        
        let cred_response = cred_provider.resolve_credentials(&cred_request).await.unwrap();
        assert_eq!(cred_response.credentials.get("username").unwrap().as_str(), Some("demo_user"));
        
        // 2. Send notification
        let notif_provider = registry.notification_provider().unwrap();
        let notif_request = hexactra_provider_sdk::NotificationRequest {
            request_id: Uuid::new_v4(),
            message: hexactra_provider_sdk::NotificationMessage {
                recipient: "user@example.com".to_string(),
                subject: "login_attempt".to_string(),
                body: "New login detected".to_string(),
                metadata: None,
            },
            priority: hexactra_provider_sdk::NotificationPriority::Normal,
            max_attempts: 3,
            ttl_ms: 300000,
        };
        
        let notif_response = notif_provider.send_notification(&notif_request).await.unwrap();
        assert_eq!(notif_response.status, hexactra_provider_sdk::NotificationStatus::Queued);
        
        // 3. Handle HITL
        let hitl_provider = registry.human_interaction_provider().unwrap();
        let hitl_request = hexactra_provider_sdk::HumanInteractionRequest {
            request_id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            reason: "confirm_action".to_string(),
            details: serde_json::json!({"action": "test"}),
            kind: HumanInteractionKind::HumanTakeover,
            timeout_ms: 5000,
            verify_origin: false,
        };
        
        hitl_provider.send_interaction(&hitl_request).await.unwrap();
        let hitl_response = hitl_provider.wait_for_response(hitl_request.request_id, 5000).await.unwrap();
        assert_eq!(hitl_response.status, hexactra_provider_sdk::InteractionStatus::Approved);
    }

    #[tokio::test]
    async fn test_provider_failure_handling() {
        // Test that provider failures are handled gracefully
        let registry = DemoProviderRegistry::with_none_enabled();
        
        // When no providers are enabled, the registry should return None
        assert!(registry.credential_provider().is_none());
        assert!(registry.notification_provider().is_none());
        assert!(registry.human_interaction_provider().is_none());
    }
}
