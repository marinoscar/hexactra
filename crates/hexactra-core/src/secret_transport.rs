//! Secure secret transport for HITL operations
//!
//! This module provides ephemeral secret storage and transport mechanisms
//! that ensure secrets never enter logs, telemetry, or persisted state.

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

/// Unique identifier for a secret
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SecretId(Uuid);

impl SecretId {
    pub fn new() -> Self {
        SecretId(Uuid::new_v4())
    }

    pub fn from_uuid(uuid: Uuid) -> Self {
        SecretId(uuid)
    }

    pub fn as_uuid(&self) -> Uuid {
        self.0
    }
}

impl Default for SecretId {
    fn default() -> Self {
        Self::new()
    }
}

impl From<SecretId> for Uuid {
    fn from(id: SecretId) -> Self {
        id.0
    }
}

impl From<Uuid> for SecretId {
    fn from(uuid: Uuid) -> Self {
        SecretId::from_uuid(uuid)
    }
}

/// Secret content - stored only in memory, never persisted
#[derive(Debug, Clone)]
pub struct SecretContent {
    pub value: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub max_uses: u32,
    pub current_uses: u32,
}

impl SecretContent {
    pub fn new(value: String, ttl_minutes: i64) -> Self {
        let now = Utc::now();
        Self {
            value,
            created_at: now,
            expires_at: now + chrono::Duration::minutes(ttl_minutes),
            max_uses: 1,
            current_uses: 0,
        }
    }

    pub fn is_expired(&self) -> bool {
        Utc::now() > self.expires_at
    }

    pub fn can_be_used(&self) -> bool {
        !self.is_expired() && self.current_uses < self.max_uses
    }

    pub fn mark_used(&mut self) {
        self.current_uses += 1;
    }
}

/// Secure secret store - ephemeral only, never persisted to disk
#[derive(Clone, Default)]
pub struct SecretStore {
    secrets: Arc<RwLock<HashMap<SecretId, SecretContent>>>,
}

impl SecretStore {
    pub fn new() -> Self {
        Self {
            secrets: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Store a secret with TTL
    pub async fn store_secret(&self, value: String, ttl_minutes: i64) -> SecretId {
        let secret = SecretContent::new(value, ttl_minutes);
        let id = SecretId::new();
        
        let mut store = self.secrets.write().await;
        store.insert(id, secret);
        
        id
    }

    /// Retrieve a secret (consumes it)
    pub async fn retrieve_secret(&self, id: SecretId) -> Result<Option<String>> {
        let mut store = self.secrets.write().await;
        
        if let Some(secret) = store.get_mut(&id) {
            if secret.can_be_used() {
                secret.mark_used();
                Ok(Some(secret.value.clone()))
            } else {
                // Secret expired or already used
                Ok(None)
            }
        } else {
            Ok(None)
        }
    }

    /// Verify a secret exists and is valid (without consuming it)
    pub async fn verify_secret(&self, id: SecretId) -> Result<bool> {
        let store = self.secrets.read().await;
        
        if let Some(secret) = store.get(&id) {
            Ok(secret.can_be_used())
        } else {
            Ok(false)
        }
    }

    /// Delete a secret immediately
    pub async fn delete_secret(&self, id: SecretId) -> Result<bool> {
        let mut store = self.secrets.write().await;
        
        if store.remove(&id).is_some() {
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Cleanup expired secrets
    pub async fn cleanup_expired(&self) -> Result<u64> {
        let now = Utc::now();
        let mut store = self.secrets.write().await;
        
        let expired_ids: Vec<SecretId> = store
            .iter()
            .filter(|(_, secret)| secret.is_expired())
            .map(|(id, _)| *id)
            .collect();

        for id in &expired_ids {
            store.remove(id);
        }

        Ok(expired_ids.len() as u64)
    }

    /// Get count of active secrets
    pub async fn active_count(&self) -> usize {
        let store = self.secrets.read().await;
        
        store
            .iter()
            .filter(|(_, secret)| secret.can_be_used())
            .count()
    }
}

/// Secret reference for transport between components
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecretReference {
    pub id: SecretId,
    pub session_id: Uuid,
    pub action_id: Uuid,
    pub created_at: String,
    pub expires_at: String,
}

impl SecretReference {
    pub fn new(id: SecretId, session_id: Uuid, action_id: Uuid, ttl_minutes: i64) -> Self {
        let now = Utc::now();
        Self {
            id,
            session_id,
            action_id,
            created_at: now.to_rfc3339(),
            expires_at: (now + chrono::Duration::minutes(ttl_minutes)).to_rfc3339(),
        }
    }
}

/// Secure secret transport that wraps the store
#[derive(Clone)]
pub struct SecretTransport {
    store: SecretStore,
}

impl SecretTransport {
    pub fn new() -> Self {
        Self {
            store: SecretStore::new(),
        }
    }

    /// Create a secret reference for transport to worker/native host
    pub async fn create_secret_reference(
        &self,
        value: String,
        session_id: Uuid,
        action_id: Uuid,
        ttl_minutes: i64,
    ) -> Result<SecretReference> {
        let id = self.store.store_secret(value, ttl_minutes).await;
        
        Ok(SecretReference::new(id, session_id, action_id, ttl_minutes))
    }

    /// Retrieve secret from reference
    pub async fn retrieve_secret_from_reference(&self, ref_: &SecretReference) -> Result<Option<String>> {
        self.store.retrieve_secret(ref_.id).await
    }

    /// Verify secret is still valid
    pub async fn verify_secret_reference(&self, ref_: &SecretReference) -> Result<bool> {
        self.store.verify_secret(ref_.id).await
    }

    /// Cleanup expired secrets
    pub async fn cleanup(&self) -> Result<u64> {
        self.store.cleanup_expired().await
    }
}

impl Default for SecretTransport {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_store_and_retrieve_secret() {
        let store = SecretStore::new();
        
        let secret_id = store.store_secret("test-password".to_string(), 15).await;
        
        // Retrieve should work
        let retrieved = store.retrieve_secret(secret_id).await.unwrap();
        assert_eq!(retrieved, Some("test-password".to_string()));
        
        // Retrieve again should fail (single-use)
        let retrieved_again = store.retrieve_secret(secret_id).await.unwrap();
        assert_eq!(retrieved_again, None);
    }

    #[tokio::test]
    async fn test_secret_expiry() {
        let store = SecretStore::new();
        
        // Store with very short TTL
        let secret_id = store.store_secret("expired-test".to_string(), -1).await;
        
        // Should be expired
        let retrieved = store.retrieve_secret(secret_id).await.unwrap();
        assert_eq!(retrieved, None);
    }

    #[tokio::test]
    async fn test_cleanup_expired() {
        let store = SecretStore::new();
        
        // Store multiple secrets with different TTLs
        let _id1 = store.store_secret("secret1".to_string(), 15).await;
        let _id2 = store.store_secret("secret2".to_string(), -1).await;
        
        // Cleanup should remove expired ones
        let removed = store.cleanup_expired().await.unwrap();
        assert_eq!(removed, 1);
        
        // Active count should be 1
        assert_eq!(store.active_count().await, 1);
    }

    #[tokio::test]
    async fn test_secret_transport() {
        let transport = SecretTransport::new();
        
        let session_id = Uuid::new_v4();
        let action_id = Uuid::new_v4();
        
        // Create reference
        let ref_ = transport
            .create_secret_reference("test-secret".to_string(), session_id, action_id, 15)
            .await
            .unwrap();
        
        assert_eq!(ref_.session_id, session_id);
        assert_eq!(ref_.action_id, action_id);
        
        // Retrieve should work
        let secret = transport.retrieve_secret_from_reference(&ref_).await.unwrap();
        assert_eq!(secret, Some("test-secret".to_string()));
    }
}
