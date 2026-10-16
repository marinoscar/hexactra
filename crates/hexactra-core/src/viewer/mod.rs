//! Remote viewer for Hexactra
//!
//! This module provides authenticated remote desktop viewing and input control
//! with lease-based exclusivity for input operations.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use thiserror::Error as ThisError;
use tokio::fs;
use uuid::Uuid;

/// Viewer access token
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewerToken {
    pub id: Uuid,
    pub session_id: Uuid,
    pub viewer_id: Uuid,
    pub expires_at: DateTime<Utc>,
    pub permissions: ViewerPermissions,
}

impl ViewerToken {
    pub fn new(session_id: Uuid, viewer_id: Uuid, permissions: ViewerPermissions) -> Self {
        Self {
            id: Uuid::new_v4(),
            session_id,
            viewer_id,
            expires_at: Utc::now() + chrono::Duration::minutes(30),
            permissions,
        }
    }

    pub fn is_expired(&self) -> bool {
        Utc::now() >= self.expires_at
    }

    pub fn can_view(&self) -> bool {
        self.permissions.view
    }

    pub fn can_input(&self) -> bool {
        self.permissions.input
    }
}

/// Viewer permissions
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ViewerPermissions {
    pub view: bool,
    pub input: bool,
}

/// Lease for input control
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InputLease {
    pub id: Uuid,
    pub session_id: Uuid,
    pub owner_id: Uuid,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

impl InputLease {
    pub fn new(session_id: Uuid, owner_id: Uuid) -> Self {
        Self {
            id: Uuid::new_v4(),
            session_id,
            owner_id,
            expires_at: Utc::now() + chrono::Duration::minutes(5),
            created_at: Utc::now(),
        }
    }

    pub fn is_expired(&self) -> bool {
        Utc::now() >= self.expires_at
    }
}

/// Remote viewer configuration
#[derive(Debug, Clone)]
pub struct ViewerConfig {
    pub bind_address: String,
    pub port: u16,
    pub token_expiry_minutes: u64,
    pub lease_expiry_minutes: u64,
}

impl Default for ViewerConfig {
    fn default() -> Self {
        Self {
            bind_address: "0.0.0.0".to_string(),
            port: 8080,
            token_expiry_minutes: 30,
            lease_expiry_minutes: 5,
        }
    }
}

/// Remote viewer service
pub struct ViewerService {
    config: ViewerConfig,
    tokens: HashMap<Uuid, ViewerToken>,
    input_leases: HashMap<Uuid, InputLease>,
}

impl ViewerService {
    /// Create a new viewer service
    pub fn new(config: ViewerConfig) -> Self {
        Self {
            config,
            tokens: HashMap::new(),
            input_leases: HashMap::new(),
        }
    }

    /// Generate a new viewer token for a session
    pub fn generate_token(
        &mut self,
        session_id: Uuid,
        viewer_id: Uuid,
        permissions: ViewerPermissions,
    ) -> Result<ViewerToken> {
        let token = ViewerToken::new(session_id, viewer_id, permissions);
        self.tokens.insert(token.id, token.clone());
        Ok(token)
    }

    /// Validate a viewer token
    pub fn validate_token(&self, token_id: &Uuid) -> Result<Option<ViewerToken>> {
        match self.tokens.get(token_id) {
            Some(token) if !token.is_expired() => Ok(Some(token.clone())),
            Some(_) => Ok(None), // Token expired
            None => Ok(None),
        }
    }

    /// Revoke a viewer token
    pub fn revoke_token(&mut self, token_id: &Uuid) -> bool {
        self.tokens.remove(token_id).is_some()
    }

    /// Acquire an input lease for a session
    pub fn acquire_input_lease(
        &mut self,
        session_id: Uuid,
        owner_id: Uuid,
    ) -> Result<InputLease> {
        // Check if there's an existing lease for this session
        if let Some(lease) = self.input_leases.get(&session_id) {
            if !lease.is_expired() {
                return Err(anyhow::anyhow!(
                    "Input lease already held by another viewer"
                ));
            }
        }

        let lease = InputLease::new(session_id, owner_id);
        self.input_leases.insert(session_id, lease.clone());
        Ok(lease)
    }

    /// Release an input lease
    pub fn release_input_lease(&mut self, session_id: &Uuid) -> bool {
        self.input_leases.remove(session_id).is_some()
    }

    /// Check if a viewer has input lease for a session
    pub fn has_input_lease(&self, session_id: &Uuid, owner_id: &Uuid) -> Result<bool> {
        match self.input_leases.get(session_id) {
            Some(lease) if !lease.is_expired() && lease.owner_id == *owner_id => Ok(true),
            Some(_) => Ok(false), // Lease exists but owned by someone else or expired
            None => Ok(false),
        }
    }

    /// Takeover input control from another viewer
    pub fn takeover_input_lease(
        &mut self,
        session_id: Uuid,
        new_owner_id: Uuid,
    ) -> Result<InputLease> {
        // Remove existing lease if any
        self.input_leases.remove(&session_id);

        let lease = InputLease::new(session_id, new_owner_id);
        self.input_leases.insert(session_id, lease.clone());
        Ok(lease)
    }

    /// Get all active tokens for a session
    pub fn get_session_tokens(&self, session_id: &Uuid) -> Vec<ViewerToken> {
        self.tokens
            .values()
            .filter(|t| t.session_id == *session_id && !t.is_expired())
            .cloned()
            .collect()
    }

    /// Clean up expired tokens and leases
    pub fn cleanup(&mut self) {
        let now = Utc::now();
        self.tokens.retain(|_, t| !t.is_expired());
        self.input_leases.retain(|_, l| !l.is_expired());
    }
}

/// Error types for viewer operations
#[derive(Debug, ThisError)]
pub enum ViewerError {
    #[error("Invalid token")]
    InvalidToken,
    #[error("Token expired")]
    TokenExpired,
    #[error("Input lease not held")]
    NoInputLease,
    #[error("Session not found")]
    SessionNotFound,
}

impl From<anyhow::Error> for ViewerError {
    fn from(err: anyhow::Error) -> Self {
        match err.downcast::<ViewerError>() {
            Ok(e) => e,
            Err(_) => ViewerError::InvalidToken,
        }
    }
}

/// Result type for viewer operations
pub type ViewerResult<T> = std::result::Result<T, ViewerError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_token_generation() {
        let mut service = ViewerService::new(ViewerConfig::default());
        let session_id = Uuid::new_v4();
        let viewer_id = Uuid::new_v4();

        let token = service
            .generate_token(session_id, viewer_id, ViewerPermissions::default())
            .unwrap();

        assert_eq!(token.session_id, session_id);
        assert_eq!(token.viewer_id, viewer_id);
        assert!(!token.can_view());
        assert!(!token.can_input());
    }

    #[test]
    fn test_token_validation() {
        let mut service = ViewerService::new(ViewerConfig::default());
        let session_id = Uuid::new_v4();
        let viewer_id = Uuid::new_v4();

        let token = service
            .generate_token(session_id, viewer_id, ViewerPermissions::default())
            .unwrap();

        let validated = service.validate_token(&token.id).unwrap();
        assert!(validated.is_some());
    }

    #[test]
    fn test_input_lease() {
        let mut service = ViewerService::new(ViewerConfig::default());
        let session_id = Uuid::new_v4();
        let owner_id = Uuid::new_v4();

        // Acquire lease
        let lease = service.acquire_input_lease(session_id, owner_id).unwrap();
        assert_eq!(lease.owner_id, owner_id);

        // Check lease ownership
        let has_lease = service.has_input_lease(&session_id, &owner_id).unwrap();
        assert!(has_lease);

        // Try to acquire lease for same session (should fail)
        let another_owner = Uuid::new_v4();
        let result = service.acquire_input_lease(session_id, another_owner);
        assert!(result.is_err());
    }

    #[test]
    fn test_input_lease_takeover() {
        let mut service = ViewerService::new(ViewerConfig::default());
        let session_id = Uuid::new_v4();
        let owner_id = Uuid::new_v4();

        // Acquire initial lease
        service.acquire_input_lease(session_id, owner_id).unwrap();

        // Takeover from another owner
        let new_owner = Uuid::new_v4();
        let lease = service.takeover_input_lease(session_id, new_owner).unwrap();
        assert_eq!(lease.owner_id, new_owner);
    }

    #[test]
    fn test_token_cleanup() {
        let mut service = ViewerService::new(ViewerConfig::default());
        let session_id = Uuid::new_v4();
        let viewer_id = Uuid::new_v4();

        // Generate token
        let token = service
            .generate_token(session_id, viewer_id, ViewerPermissions::default())
            .unwrap();

        // Cleanup should not remove valid token
        service.cleanup();
        assert!(service.tokens.contains_key(&token.id));
    }
}
