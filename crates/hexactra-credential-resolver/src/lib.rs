//! Credential resolver for Hexactra runtime
//!
//! This crate provides scoped credential resolution with opaque secret handles,
//! origin-bound one-time use tokens, and vault-neutral lookup.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

// ==================== Error Types ====================

/// Credential resolver error types
#[derive(Debug, Error)]
pub enum CredentialResolverError {
    #[error("Credential not found for scope: {0}")]
    NotFound(String),
    #[error("Origin verification failed for scope: {0}")]
    OriginMismatch(String),
    #[error("Owner verification failed")]
    OwnerMismatch,
    #[error("Secret handle expired")]
    HandleExpired,
    #[error("Invalid credential scope: {0}")]
    InvalidScope(String),
    #[error("Internal error: {0}")]
    Internal(String),
}

/// Result type for credential resolver operations
pub type CredentialResolverResult<T> = std::result::Result<T, CredentialResolverError>;

// ==================== Scope Types ====================

/// Credential scope for lookup
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialScope {
    /// Owner ID (user or agent)
    pub owner_id: Uuid,
    /// Target site origin (e.g., "https://example.com")
    pub origin: String,
    /// Profile name (optional)
    pub profile: Option<String>,
    /// Purpose of credential (e.g., "login", "payment")
    pub purpose: String,
}

impl CredentialScope {
    /// Create a new credential scope
    pub fn new(owner_id: Uuid, origin: String, purpose: String) -> Self {
        CredentialScope {
            owner_id,
            origin,
            profile: None,
            purpose,
        }
    }

    /// Set the profile name
    pub fn with_profile(mut self, profile: impl Into<String>) -> Self {
        self.profile = Some(profile.into());
        self
    }

    /// Validate the scope
    pub fn validate(&self) -> CredentialResolverResult<()> {
        if self.owner_id.is_nil() {
            return Err(CredentialResolverError::InvalidScope(
                "owner_id cannot be nil".to_string(),
            ));
        }
        if self.origin.is_empty() {
            return Err(CredentialResolverError::InvalidScope(
                "origin cannot be empty".to_string(),
            ));
        }
        if self.purpose.is_empty() {
            return Err(CredentialResolverError::InvalidScope(
                "purpose cannot be empty".to_string(),
            ));
        }
        Ok(())
    }

    /// Check if two scopes match (for authorization)
    pub fn matches(&self, other: &CredentialScope) -> bool {
        self.owner_id == other.owner_id
            && self.origin == other.origin
            && self.profile == other.profile
            && self.purpose == other.purpose
    }
}

// ==================== Secret Handle Types ====================

/// Unique identifier for a secret handle
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SecretHandleId(Uuid);

impl SecretHandleId {
    pub fn new() -> Self {
        SecretHandleId(Uuid::new_v4())
    }

    pub fn from_uuid(uuid: Uuid) -> Self {
        SecretHandleId(uuid)
    }

    pub fn as_uuid(&self) -> Uuid {
        self.0
    }
}

/// Opaque secret handle for one-time use
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecretHandle {
    /// Unique handle ID
    pub id: SecretHandleId,
    /// Scope that this handle is bound to
    pub scope: CredentialScope,
    /// Encrypted/obfuscated credential data
    pub encrypted_data: String,
    /// Timestamp when the handle was created
    pub created_at: DateTime<Utc>,
    /// Timestamp when the handle expires
    pub expires_at: DateTime<Utc>,
    /// Whether the handle has been used
    pub used: bool,
    /// Audit metadata
    pub audit_metadata: Option<serde_json::Value>,
}

impl SecretHandle {
    /// Create a new secret handle
    pub fn new(scope: CredentialScope, encrypted_data: impl Into<String>) -> Self {
        let now = Utc::now();
        SecretHandle {
            id: SecretHandleId::new(),
            scope,
            encrypted_data: encrypted_data.into(),
            created_at: now,
            expires_at: now + chrono::Duration::minutes(15), // Default 15 minute expiry
            used: false,
            audit_metadata: None,
        }
    }

    /// Check if the handle is expired
    pub fn is_expired(&self) -> bool {
        Utc::now() >= self.expires_at
    }

    /// Check if the handle can be used (not expired and not used)
    pub fn is_valid(&self) -> bool {
        !self.is_expired() && !self.used
    }
}

// ==================== Credential Resolution Request ====================

/// Request for credential resolution
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialResolutionRequest {
    /// Unique request ID
    pub request_id: Uuid,
    /// Scope for this credential lookup
    pub scope: CredentialScope,
    /// Whether to use cached credentials if available
    pub allow_cache: bool,
    /// Maximum age of cached credentials (milliseconds)
    pub max_cache_age_ms: u64,
}

// ==================== Credential Resolution Response ====================

/// Response with resolved credentials
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialResolutionResponse {
    /// Request ID that this responds to
    pub request_id: Uuid,
    /// Opaque secret handle for one-time use
    pub secret_handle: SecretHandle,
    /// Timestamp of resolution
    pub timestamp: DateTime<Utc>,
}

// ==================== Vault Interface ====================

/// Vault interface for credential storage and retrieval
#[async_trait::async_trait]
pub trait CredentialVault: Send + Sync {
    /// Store credentials in the vault
    async fn store_credentials(
        &self,
        scope: &CredentialScope,
        credentials: &serde_json::Value,
    ) -> CredentialResolverResult<()>;

    /// Retrieve credentials from the vault
    async fn retrieve_credentials(
        &self,
        scope: &CredentialScope,
    ) -> CredentialResolverResult<serde_json::Value>;

    /// Revoke credentials for a scope
    async fn revoke_credentials(&self, scope: &CredentialScope) -> CredentialResolverResult<()>;

    /// Rotate credentials for a scope
    async fn rotate_credentials(&self, scope: &CredentialScope) -> CredentialResolverResult<()>;
}

// ==================== Scoped Credential Resolver ====================

/// Scoped credential resolver with opaque secret handles
pub struct ScopedCredentialResolver {
    vaults: std::collections::HashMap<String, Box<dyn CredentialVault>>,
    secret_handles: std::sync::Mutex<std::collections::HashMap<SecretHandleId, SecretHandle>>,
    default_vault: Option<String>,
}

impl ScopedCredentialResolver {
    /// Create a new scoped credential resolver
    pub fn new() -> Self {
        ScopedCredentialResolver {
            vaults: std::collections::HashMap::new(),
            secret_handles: std::sync::Mutex::new(std::collections::HashMap::new()),
            default_vault: None,
        }
    }

    /// Register a vault by name
    pub fn register_vault(&mut self, name: impl Into<String>, vault: Box<dyn CredentialVault>) {
        let name = name.into();
        if self.default_vault.is_none() {
            self.default_vault = Some(name.clone());
        }
        self.vaults.insert(name, vault);
    }

    /// Set the default vault
    pub fn set_default_vault(&mut self, name: impl Into<String>) {
        self.default_vault = Some(name.into());
    }

    /// Resolve credentials for a scope
    pub async fn resolve_credentials(
        &self,
        request: &CredentialResolutionRequest,
    ) -> CredentialResolverResult<CredentialResolutionResponse> {
        // Validate the scope
        request.scope.validate()?;

        // Check if we have a vault that can handle this scope
        let vault_name = self.default_vault.as_ref().ok_or_else(|| {
            CredentialResolverError::Internal("No vault registered".to_string())
        })?;

        let vault = self.vaults.get(vault_name).ok_or_else(|| {
            CredentialResolverError::Internal(format!("Vault not found: {}", vault_name))
        })?;

        // Retrieve credentials from the vault
        let credentials = vault.retrieve_credentials(&request.scope).await?;

        // Create an opaque secret handle for one-time use
        let encrypted_data = serde_json::to_string(&credentials)
            .map_err(|e| CredentialResolverError::Internal(e.to_string()))?;

        let mut handle = SecretHandle::new(request.scope.clone(), encrypted_data);
        handle.audit_metadata = Some(serde_json::json!({
            "request_id": request.request_id,
            "created_at": handle.created_at.to_rfc3339(),
        }));

        // Store the handle in memory (in production, this would be in a database)
        self.secret_handles
            .lock()
            .map_err(|e| CredentialResolverError::Internal(e.to_string()))?
            .insert(handle.id, handle.clone());

        Ok(CredentialResolutionResponse {
            request_id: request.request_id,
            secret_handle: handle,
            timestamp: Utc::now(),
        })
    }

    /// Use a secret handle (marks it as used)
    pub fn use_secret_handle(&self, handle_id: SecretHandleId) -> CredentialResolverResult<()> {
        let mut handles = self
            .secret_handles
            .lock()
            .map_err(|e| CredentialResolverError::Internal(e.to_string()))?;

        if let Some(handle) = handles.get_mut(&handle_id) {
            if handle.is_expired() {
                return Err(CredentialResolverError::HandleExpired);
            }
            if handle.used {
                return Err(CredentialResolverError::Internal(
                    "Handle already used".to_string(),
                ));
            }
            handle.used = true;
            Ok(())
        } else {
            Err(CredentialResolverError::NotFound(format!(
                "Handle not found: {}",
                handle_id.as_uuid()
            )))
        }
    }

    /// Revoke a secret handle
    pub fn revoke_secret_handle(&self, handle_id: SecretHandleId) -> CredentialResolverResult<()> {
        let mut handles = self
            .secret_handles
            .lock()
            .map_err(|e| CredentialResolverError::Internal(e.to_string()))?;

        if handles.remove(&handle_id).is_some() {
            Ok(())
        } else {
            Err(CredentialResolverError::NotFound(format!(
                "Handle not found: {}",
                handle_id.as_uuid()
            )))
        }
    }

    /// Validate that a secret handle is valid for use
    pub fn validate_secret_handle(&self, handle_id: SecretHandleId) -> CredentialResolverResult<()> {
        let handles = self
            .secret_handles
            .lock()
            .map_err(|e| CredentialResolverError::Internal(e.to_string()))?;

        if let Some(handle) = handles.get(&handle_id) {
            if handle.is_expired() {
                return Err(CredentialResolverError::HandleExpired);
            }
            if handle.used {
                return Err(CredentialResolverError::Internal(
                    "Handle already used".to_string(),
                ));
            }
            Ok(())
        } else {
            Err(CredentialResolverError::NotFound(format!(
                "Handle not found: {}",
                handle_id.as_uuid()
            )))
        }
    }

    /// Resolve credentials with origin verification
    pub async fn resolve_credentials_with_origin(
        &self,
        request: &CredentialResolutionRequest,
        expected_origin: &str,
    ) -> CredentialResolverResult<CredentialResolutionResponse> {
        // Verify origin matches
        if request.scope.origin != expected_origin {
            return Err(CredentialResolverError::OriginMismatch(format!(
                "Expected: {}, Got: {}",
                expected_origin, request.scope.origin
            )));
        }

        self.resolve_credentials(request).await
    }
}

impl Default for ScopedCredentialResolver {
    fn default() -> Self {
        Self::new()
    }
}

// ==================== Mock Vault Implementation ====================

/// Mock vault for testing
pub mod mock_vault {
    use super::*;

    /// In-memory mock vault for testing
    pub struct MockVault {
        credentials: std::sync::Mutex<std::collections::HashMap<String, serde_json::Value>>,
    }

    impl MockVault {
        pub fn new() -> Self {
            MockVault {
                credentials: std::sync::Mutex::new(std::collections::HashMap::new()),
            }
        }
    }

    impl Default for MockVault {
        fn default() -> Self {
            Self::new()
        }
    }

    #[async_trait::async_trait]
    impl CredentialVault for MockVault {
        async fn store_credentials(
            &self,
            scope: &CredentialScope,
            credentials: &serde_json::Value,
        ) -> CredentialResolverResult<()> {
            let key = format!(
                "{}:{}:{}:{}",
                scope.owner_id, scope.origin, scope.profile.as_deref().unwrap_or(""), scope.purpose
            );
            self.credentials
                .lock()
                .map_err(|e| CredentialResolverError::Internal(e.to_string()))?
                .insert(key, credentials.clone());
            Ok(())
        }

        async fn retrieve_credentials(
            &self,
            scope: &CredentialScope,
        ) -> CredentialResolverResult<serde_json::Value> {
            let key = format!(
                "{}:{}:{}:{}",
                scope.owner_id, scope.origin, scope.profile.as_deref().unwrap_or(""), scope.purpose
            );
            let creds = self
                .credentials
                .lock()
                .map_err(|e| CredentialResolverError::Internal(e.to_string()))?
                .get(&key)
                .cloned()
                .ok_or_else(|| CredentialResolverError::NotFound(format!("Scope: {}", key)))?;
            Ok(creds)
        }

        async fn revoke_credentials(&self, scope: &CredentialScope) -> CredentialResolverResult<()> {
            let key = format!(
                "{}:{}:{}:{}",
                scope.owner_id, scope.origin, scope.profile.as_deref().unwrap_or(""), scope.purpose
            );
            self.credentials
                .lock()
                .map_err(|e| CredentialResolverError::Internal(e.to_string()))?
                .remove(&key);
            Ok(())
        }

        async fn rotate_credentials(
            &self,
            _scope: &CredentialScope,
        ) -> CredentialResolverResult<()> {
            // In a real implementation, this would generate new credentials
            // For now, we'll just return success
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
pub fn scopes_match(scope1: &CredentialScope, scope2: &CredentialScope) -> bool {
    scope1.owner_id == scope2.owner_id
        && scope1.origin == scope2.origin
        && scope1.profile == scope2.profile
        && scope1.purpose == scope2.purpose
}

/// Create a credential scope for testing
pub fn test_scope(owner_id: Uuid, origin: impl Into<String>, purpose: impl Into<String>) -> CredentialScope {
    CredentialScope {
        owner_id,
        origin: origin.into(),
        profile: None,
        purpose: purpose.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_credential_scope_validation() {
        let owner_id = Uuid::new_v4();
        
        // Valid scope
        let scope = CredentialScope::new(owner_id, "https://example.com".to_string(), "login".to_string());
        assert!(scope.validate().is_ok());

        // Invalid: nil owner_id
        let invalid_scope = CredentialScope {
            owner_id: Uuid::nil(),
            origin: "https://example.com".to_string(),
            profile: None,
            purpose: "login".to_string(),
        };
        assert!(invalid_scope.validate().is_err());

        // Invalid: empty origin
        let invalid_scope = CredentialScope {
            owner_id,
            origin: "".to_string(),
            profile: None,
            purpose: "login".to_string(),
        };
        assert!(invalid_scope.validate().is_err());

        // Invalid: empty purpose
        let invalid_scope = CredentialScope {
            owner_id,
            origin: "https://example.com".to_string(),
            profile: None,
            purpose: "".to_string(),
        };
        assert!(invalid_scope.validate().is_err());
    }

    #[test]
    fn test_secret_handle_expiry() {
        let now = Utc::now();
        let scope = CredentialScope::new(Uuid::new_v4(), "https://example.com".to_string(), "login".to_string());
        
        // Create a handle that expired 1 minute ago
        let expired_handle = SecretHandle {
            id: SecretHandleId::new(),
            scope: scope.clone(),
            encrypted_data: "test".to_string(),
            created_at: now - chrono::Duration::minutes(20),
            expires_at: now - chrono::Duration::minutes(5),
            used: false,
            audit_metadata: None,
        };
        
        assert!(expired_handle.is_expired());
        assert!(!expired_handle.is_valid());

        // Create a valid handle
        let valid_handle = SecretHandle::new(scope, "test");
        assert!(!valid_handle.is_expired());
        assert!(valid_handle.is_valid());
    }

    #[tokio::test]
    async fn test_mock_vault() {
        let vault = mock_vault::MockVault::new();
        let owner_id = Uuid::new_v4();
        let scope = CredentialScope::new(owner_id, "https://example.com".to_string(), "login".to_string());

        // Store credentials
        let credentials = serde_json::json!({
            "username": "testuser",
            "password": "testpass"
        });
        vault.store_credentials(&scope, &credentials).await.unwrap();

        // Retrieve credentials
        let retrieved = vault.retrieve_credentials(&scope).await.unwrap();
        assert_eq!(retrieved, credentials);

        // Revoke credentials
        vault.revoke_credentials(&scope).await.unwrap();
        
        // Try to retrieve again (should fail)
        assert!(vault.retrieve_credentials(&scope).await.is_err());
    }
}
