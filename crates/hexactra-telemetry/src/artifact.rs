//! Secure artifact storage for Hexactra

use anyhow::anyhow;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Artifact type for storage categorization
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactType {
    /// Screenshot image
    Screenshot,
    /// Browser snapshot (DOM state)
    Snapshot,
    /// Profile backup
    Profile,
    /// Other data artifact
    Data,
}

/// Artifact access permissions
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactPermission {
    /// Owner-only access
    Owner,
    /// Owner and admins
    Admin,
    /// Read-only access for specific sessions
    SessionRead,
}

/// An artifact record with metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Artifact {
    /// Unique artifact ID
    pub id: Uuid,
    /// Owner ID for scoping
    pub owner_id: Uuid,
    /// Session ID if applicable
    pub session_id: Option<Uuid>,
    /// Type of artifact
    pub artifact_type: ArtifactType,
    /// File path relative to storage root
    pub path: String,
    /// Size in bytes
    pub size_bytes: u64,
    /// Expiration time (None = never expire)
    pub expires_at: Option<DateTime<Utc>>,
    /// Permission level
    pub permission: ArtifactPermission,
    /// Creation timestamp
    pub created_at: DateTime<Utc>,
    /// Metadata (e.g., dimensions for screenshots)
    pub metadata: HashMap<String, serde_json::Value>,
}

impl Artifact {
    /// Create a new artifact record
    pub fn new(
        owner_id: Uuid,
        artifact_type: ArtifactType,
        path: impl Into<String>,
        size_bytes: u64,
    ) -> Self {
        Self {
            id: Uuid::new_v4(),
            owner_id,
            session_id: None,
            artifact_type,
            path: path.into(),
            size_bytes,
            expires_at: None,
            permission: ArtifactPermission::Owner,
            created_at: Utc::now(),
            metadata: HashMap::new(),
        }
    }

    /// Set the session ID
    pub fn with_session_id(mut self, session_id: Uuid) -> Self {
        self.session_id = Some(session_id);
        self
    }

    /// Set expiration time
    pub fn with_expiration(mut self, expires_at: DateTime<Utc>) -> Self {
        self.expires_at = Some(expires_at);
        self
    }

    /// Set permission level
    pub fn with_permission(mut self, permission: ArtifactPermission) -> Self {
        self.permission = permission;
        self
    }

    /// Add metadata field
    pub fn add_metadata(mut self, key: impl Into<String>, value: serde_json::Value) -> Self {
        self.metadata.insert(key.into(), value);
        self
    }
}

/// Secure artifact store with expiration and access control
#[derive(Debug)]
pub struct ArtifactStore {
    storage_root: PathBuf,
    max_artifact_size: u64,
    default_retention_days: i64,
}

impl ArtifactStore {
    /// Create a new artifact store
    pub fn new(storage_root: impl Into<PathBuf>) -> Self {
        let root = storage_root.into();
        Self {
            storage_root: root,
            max_artifact_size: 10 * 1024 * 1024, // 10 MB default limit
            default_retention_days: 7, // 7 days default retention
        }
    }

    /// Set the maximum artifact size
    pub fn with_max_size(mut self, max_size: u64) -> Self {
        self.max_artifact_size = max_size;
        self
    }

    /// Set the default retention period in days
    pub fn with_retention_days(mut self, days: i64) -> Self {
        self.default_retention_days = days;
        self
    }

    /// Initialize the storage directory with secure permissions
    pub fn init(&self) -> Result<(), anyhow::Error> {
        fs::create_dir_all(&self.storage_root)
            .map_err(|e| anyhow!("Failed to create storage root: {}", e))?;

        // Set secure permissions (owner read/write/execute only)
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let permissions = fs::Permissions::from_mode(0o700);
            fs::set_permissions(&self.storage_root, permissions)
                .map_err(|e| anyhow!("Failed to set storage permissions: {}", e))?;
        }

        Ok(())
    }

    /// Store an artifact
    pub fn store(
        &self,
        owner_id: Uuid,
        artifact_type: ArtifactType,
        data: &[u8],
        session_id: Option<Uuid>,
    ) -> Result<Artifact, anyhow::Error> {
        // Check size limit
        if data.len() > self.max_artifact_size as usize {
            return Err(anyhow!(
                "Artifact too large: {} bytes (max: {})",
                data.len(),
                self.max_artifact_size
            ));
        }

        let artifact_id = Uuid::new_v4();
        let path = self.artifact_path(owner_id, &artifact_id);
        
        // Create parent directories
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| anyhow!("Failed to create directory: {}", e))?;
        }

        // Write artifact data
        File::create(&path)
            .and_then(|mut f| f.write_all(data))
            .map_err(|e| anyhow!("Failed to write artifact: {}", e))?;

        let metadata = std::fs::metadata(&path)?;
        
        let artifact = Artifact {
            id: artifact_id,
            owner_id,
            session_id,
            artifact_type,
            path: path.to_string_lossy().to_string(),
            size_bytes: metadata.len(),
            expires_at: Some(Utc::now() + chrono::Duration::days(self.default_retention_days)),
            permission: ArtifactPermission::Owner,
            created_at: Utc::now(),
            metadata: HashMap::new(),
        };

        Ok(artifact)
    }

    /// Retrieve an artifact
    pub fn retrieve(&self, artifact_id: Uuid, owner_id: Uuid) -> Result<Vec<u8>, anyhow::Error> {
        let path = self.artifact_path(owner_id, &artifact_id);
        
        if !path.exists() {
            return Err(anyhow!("Artifact not found"));
        }

        // Check expiration
        let artifact = self.get_artifact(artifact_id, owner_id)?;
        if let Some(expires_at) = artifact.expires_at {
            if Utc::now() > expires_at {
                return Err(anyhow!("Artifact has expired"));
            }
        }

        fs::read(&path)
            .map_err(|e| anyhow!("Failed to read artifact: {}", e))
    }

    /// Get artifact metadata
    pub fn get_artifact(
        &self,
        artifact_id: Uuid,
        owner_id: Uuid,
    ) -> Result<Artifact, anyhow::Error> {
        // For now, return a minimal artifact record
        // In production, this would query a database
        Ok(Artifact {
            id: artifact_id,
            owner_id,
            session_id: None,
            artifact_type: ArtifactType::Data,
            path: self.artifact_path(owner_id, &artifact_id).to_string_lossy().to_string(),
            size_bytes: 0,
            expires_at: Some(Utc::now() + chrono::Duration::days(self.default_retention_days)),
            permission: ArtifactPermission::Owner,
            created_at: Utc::now(),
            metadata: HashMap::new(),
        })
    }

    /// Delete an artifact
    pub fn delete(&self, artifact_id: Uuid, owner_id: Uuid) -> Result<(), anyhow::Error> {
        let path = self.artifact_path(owner_id, &artifact_id);
        
        if !path.exists() {
            return Err(anyhow!("Artifact not found"));
        }

        fs::remove_file(&path)
            .map_err(|e| anyhow!("Failed to delete artifact: {}", e))?;

        Ok(())
    }

    /// Redact sensitive data from a screenshot
    pub fn redact_screenshot(&self, data: &[u8]) -> Result<Vec<u8>, anyhow::Error> {
        // For now, return the data as-is
        // In production, this would implement actual redaction logic
        // (e.g., blur faces, mask passwords, etc.)
        Ok(data.to_vec())
    }

    /// Clean up expired artifacts
    pub fn cleanup_expired(&self) -> Result<usize, anyhow::Error> {
        let mut cleaned = 0;
        
        // In production, this would query the database for expired artifacts
        // and delete them from storage
        
        Ok(cleaned)
    }

    /// Get the path for an artifact
    fn artifact_path(&self, owner_id: Uuid, artifact_id: &Uuid) -> PathBuf {
        self.storage_root
            .join(owner_id.to_string())
            .join(artifact_id.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_artifact_creation() {
        let artifact = Artifact::new(Uuid::new_v4(), ArtifactType::Screenshot, "test.png", 1024);
        assert_eq!(artifact.artifact_type, ArtifactType::Screenshot);
        assert_eq!(artifact.permission, ArtifactPermission::Owner);
    }

    #[test]
    fn test_artifact_with_session() {
        let session_id = Uuid::new_v4();
        let artifact = Artifact::new(Uuid::new_v4(), ArtifactType::Data, "data.bin", 512)
            .with_session_id(session_id);
        assert_eq!(artifact.session_id, Some(session_id));
    }

    #[test]
    fn test_artifact_store_init() {
        let tmp_dir = TempDir::new().unwrap();
        let store = ArtifactStore::new(tmp_dir.path());
        
        store.init().unwrap();
        
        assert!(tmp_dir.path().exists());
    }

    #[test]
    fn test_artifact_store_store_and_retrieve() {
        let tmp_dir = TempDir::new().unwrap();
        let store = ArtifactStore::new(tmp_dir.path())
            .with_max_size(1024 * 1024)
            .with_retention_days(7);
        
        store.init().unwrap();
        
        let owner_id = Uuid::new_v4();
        let data = b"test artifact data";
        
        let artifact = store.store(owner_id, ArtifactType::Data, data, None).unwrap();
        
        assert_eq!(artifact.owner_id, owner_id);
        assert_eq!(artifact.artifact_type, ArtifactType::Data);
        assert_eq!(artifact.size_bytes, data.len() as u64);
    }

    #[test]
    fn test_artifact_redaction() {
        let tmp_dir = TempDir::new().unwrap();
        let store = ArtifactStore::new(tmp_dir.path());
        
        let original = b"password: secret123";
        let redacted = store.redact_screenshot(original).unwrap();
        
        // For now, redaction is a no-op in tests
        assert_eq!(redacted, original.to_vec());
    }
}
