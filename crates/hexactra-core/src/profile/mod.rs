//! Profile registry for Hexactra
//!
//! This module provides persistent profile registration with SQLite storage,
//! exclusive file locks, and session volume mapping.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqlitePoolOptions, Row, SqlitePool};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tempfile::TempDir;
use uuid::Uuid;

// Flock constants
#[cfg(unix)]
mod flock {
    use std::os::unix::io::RawFd;
    
    pub const LOCK_EX: i32 = 2;
    pub const LOCK_SH: i32 = 1;
    pub const LOCK_NB: i32 = 4;
    pub const LOCK_UN: i32 = 8;
    
    pub unsafe fn flock(fd: RawFd, operation: i32) -> Result<(), std::io::Error> {
        let result = libc::flock(fd, operation);
        if result == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
}

/// Profile record in the database
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileRecord {
    pub id: String,
    pub name: String,
    pub alias: Option<String>,
    pub host: String,
    pub path: String,
    pub owner: String,
    pub created_at: String,
    pub updated_at: String,
}

impl ProfileRecord {
    pub fn new(name: String, path: String, owner: Uuid) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            name,
            alias: None,
            host: "localhost".to_string(),
            path,
            owner: owner.to_string(),
            created_at: now.to_rfc3339(),
            updated_at: now.to_rfc3339(),
        }
    }

    pub fn with_alias(mut self, alias: String) -> Self {
        self.alias = Some(alias);
        self
    }

    pub fn id_uuid(&self) -> Uuid {
        Uuid::parse_str(&self.id).unwrap()
    }

    pub fn owner_uuid(&self) -> Uuid {
        Uuid::parse_str(&self.owner).unwrap()
    }
}

/// Profile lock manager for exclusive access
pub struct ProfileLock {
    lock_path: PathBuf,
    lock_file: Option<File>,
}

impl ProfileLock {
    /// Create a new lock for the given profile path
    pub fn new(profile_path: &Path) -> Self {
        let lock_path = profile_path.join(".hexactra.lock");
        Self {
            lock_path,
            lock_file: None,
        }
    }

    /// Try to acquire an exclusive lock
    pub fn try_lock(&mut self) -> Result<bool> {
        let parent = self.lock_path.parent().context("Invalid lock path")?;
        fs::create_dir_all(parent)?;

        match File::create(&self.lock_path) {
            Ok(mut file) => {
                // Write PID to the lock file
                let pid = std::process::id();
                file.write_all(pid.to_string().as_bytes())?;

                // Try to flock the file for exclusive access
                #[cfg(unix)]
                {
                    use std::os::unix::io::AsRawFd;
                    match unsafe { flock::flock(file.as_raw_fd(), flock::LOCK_EX | flock::LOCK_NB) } {
                        Ok(()) => {
                            self.lock_file = Some(file);
                            Ok(true)
                        }
                        Err(e) => {
                            // Lock is held by another process
                            if e.raw_os_error() == Some(libc::EWOULDBLOCK) {
                                Ok(false)
                            } else {
                                Err(anyhow::Error::from(e).context("Failed to acquire lock"))
                            }
                        }
                    }
                }

                #[cfg(not(unix))]
                {
                    // Fallback for non-Unix systems
                    self.lock_file = Some(file);
                    Ok(true)
                }
            }
            Err(e) => Err(anyhow::Error::from(e).context("Failed to create lock file")),
        }
    }

    /// Release the lock
    pub fn release(&mut self) -> Result<()> {
        if let Some(file) = self.lock_file.take() {
            #[cfg(unix)]
            {
                use std::os::unix::io::AsRawFd;
                unsafe { flock::flock(file.as_raw_fd(), flock::LOCK_UN)?; }
            }

            // Remove the lock file
            let path = self.lock_path.clone();
            drop(file);
            fs::remove_file(path)?;
        }
        Ok(())
    }

    /// Check if a profile is locked
    pub fn is_locked(profile_path: &Path) -> Result<bool> {
        let lock_path = profile_path.join(".hexactra.lock");
        
        if !lock_path.exists() {
            return Ok(false);
        }

        // Try to acquire shared lock - if it fails, file is exclusively locked
        match File::open(&lock_path) {
            Ok(file) => {
                #[cfg(unix)]
                {
                    use std::os::unix::io::AsRawFd;
                    match unsafe { flock::flock(file.as_raw_fd(), flock::LOCK_SH | flock::LOCK_NB) } {
                        Ok(()) => {
                            // Lock is not held exclusively
                            unsafe { flock::flock(file.as_raw_fd(), flock::LOCK_UN)?; }
                            Ok(false)
                        }
                        Err(e) => {
                            if e.raw_os_error() == Some(libc::EWOULDBLOCK) {
                                Ok(true)
                            } else {
                                Err(anyhow::Error::from(e).context("Failed to check lock"))
                            }
                        }
                    }
                }

                #[cfg(not(unix))]
                {
                    // Fallback for non-Unix systems
                    Ok(true)
                }
            }
            Err(_) => Ok(false),
        }
    }
}

impl Drop for ProfileLock {
    fn drop(&mut self) {
        let _ = self.release();
    }
}

/// Profile registry with SQLite storage
pub struct ProfileRegistry {
    pool: SqlitePool,
    profiles_dir: PathBuf,
}

impl ProfileRegistry {
    /// Create a new profile registry from a database file path
    pub async fn new_from_file(db_file: &Path, profiles_dir: &Path) -> Result<Self> {
        // Ensure directories exist
        if let Some(parent) = db_file.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::create_dir_all(profiles_dir)?;

        // Initialize database
        let connect_opts = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(db_file)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(connect_opts)
            .await?;

        // Create schema
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS profiles (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                alias TEXT,
                host TEXT NOT NULL,
                path TEXT NOT NULL,
                owner TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_profiles_name ON profiles(name);
            CREATE INDEX IF NOT EXISTS idx_profiles_owner ON profiles(owner);
            CREATE INDEX IF NOT EXISTS idx_profiles_host ON profiles(host);
            "#,
        )
        .execute(&pool)
        .await?;

        Ok(Self {
            pool,
            profiles_dir: profiles_dir.to_path_buf(),
        })
    }

    /// Create a new profile registry
    pub async fn new(db_path: &Path, profiles_dir: &Path) -> Result<Self> {
        let db_file = db_path.join("profile-registry.db");
        Self::new_from_file(&db_file, profiles_dir).await
    }

    /// Register a new profile
    pub async fn register_profile(
        &self,
        name: String,
        path: String,
        owner: Uuid,
    ) -> Result<ProfileRecord> {
        // Check if path is already registered
        let existing = self.get_profile_by_path(&path).await?;
        if existing.is_some() {
            return Err(anyhow::anyhow!("Profile at {} is already registered", path));
        }

        // Check for name collision (excluding aliases)
        let existing_by_name = self.get_profile_by_name(&name).await?;
        if existing_by_name.is_some() {
            return Err(anyhow::anyhow!("Profile name '{}' is already in use", name));
        }

        // Create profile record
        let record = ProfileRecord::new(name.clone(), path.clone(), owner);

        // Insert into database
        sqlx::query(
            r#"
            INSERT INTO profiles (id, name, alias, host, path, owner, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&record.id)
        .bind(&record.name)
        .bind(&record.alias)
        .bind(&record.host)
        .bind(&record.path)
        .bind(&record.owner)
        .bind(&record.created_at)
        .bind(&record.updated_at)
        .execute(&self.pool)
        .await?;

        Ok(record)
    }

    /// Get profile by ID
    pub async fn get_profile(&self, id: &Uuid) -> Result<Option<ProfileRecord>> {
        let row = sqlx::query(
            r#"
            SELECT id, name, alias, host, path, owner, created_at, updated_at
            FROM profiles WHERE id = ?
            "#,
        )
        .bind(id.to_string())
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(|r| ProfileRecord {
            id: r.get(0),
            name: r.get(1),
            alias: r.get(2),
            host: r.get(3),
            path: r.get(4),
            owner: r.get(5),
            created_at: r.get(6),
            updated_at: r.get(7),
        }))
    }

    /// Get profile by name
    pub async fn get_profile_by_name(&self, name: &str) -> Result<Option<ProfileRecord>> {
        let row = sqlx::query(
            r#"
            SELECT id, name, alias, host, path, owner, created_at, updated_at
            FROM profiles WHERE name = ?
            "#,
        )
        .bind(name)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(|r| ProfileRecord {
            id: r.get(0),
            name: r.get(1),
            alias: r.get(2),
            host: r.get(3),
            path: r.get(4),
            owner: r.get(5),
            created_at: r.get(6),
            updated_at: r.get(7),
        }))
    }

    /// Get profile by path
    pub async fn get_profile_by_path(&self, path: &str) -> Result<Option<ProfileRecord>> {
        let row = sqlx::query(
            r#"
            SELECT id, name, alias, host, path, owner, created_at, updated_at
            FROM profiles WHERE path = ?
            "#,
        )
        .bind(path)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(|r| ProfileRecord {
            id: r.get(0),
            name: r.get(1),
            alias: r.get(2),
            host: r.get(3),
            path: r.get(4),
            owner: r.get(5),
            created_at: r.get(6),
            updated_at: r.get(7),
        }))
    }

    /// List all profiles
    pub async fn list_profiles(&self) -> Result<Vec<ProfileRecord>> {
        let rows = sqlx::query(
            r#"
            SELECT id, name, alias, host, path, owner, created_at, updated_at
            FROM profiles ORDER BY created_at DESC
            "#,
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| ProfileRecord {
                id: r.get(0),
                name: r.get(1),
                alias: r.get(2),
                host: r.get(3),
                path: r.get(4),
                owner: r.get(5),
                created_at: r.get(6),
                updated_at: r.get(7),
            })
            .collect())
    }

    /// Delete a profile
    pub async fn delete_profile(&self, id: &Uuid) -> Result<usize> {
        let result = sqlx::query("DELETE FROM profiles WHERE id = ?")
            .bind(id.to_string())
            .execute(&self.pool)
            .await?;

        Ok(result.rows_affected() as usize)
    }

    /// Acquire exclusive lock for a profile
    pub async fn acquire_profile_lock(&self, profile_path: &Path) -> Result<ProfileLock> {
        let mut lock = ProfileLock::new(profile_path);
        
        // Try to acquire lock with retry
        for _ in 0..10 {
            if lock.try_lock()? {
                return Ok(lock);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        Err(anyhow::anyhow!(
            "Failed to acquire lock for profile at {}",
            profile_path.display()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_profile_registry_creation() {
        let temp_dir = TempDir::new().unwrap();
        let db_file = temp_dir.path().join("profile-registry.db");
        let profiles_dir = temp_dir.path().join("profiles");

        let registry = ProfileRegistry::new_from_file(&db_file, &profiles_dir)
            .await
            .unwrap();

        assert!(registry.list_profiles().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_register_and_get_profile() {
        let temp_dir = TempDir::new().unwrap();
        let db_file = temp_dir.path().join("profile-registry.db");
        let profiles_dir = temp_dir.path().join("profiles");

        let registry = ProfileRegistry::new_from_file(&db_file, &profiles_dir)
            .await
            .unwrap();

        let owner = Uuid::new_v4();
        let profile = registry
            .register_profile("test-profile".to_string(), "/tmp/test".to_string(), owner)
            .await
            .unwrap();

        assert_eq!(profile.name, "test-profile");
        assert_eq!(profile.path, "/tmp/test");

        let retrieved = registry.get_profile(&profile.id_uuid()).await.unwrap();
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().name, "test-profile");
    }

    #[tokio::test]
    async fn test_duplicate_profile_prevention() {
        let temp_dir = TempDir::new().unwrap();
        let db_file = temp_dir.path().join("profile-registry.db");
        let profiles_dir = temp_dir.path().join("profiles");

        let registry = ProfileRegistry::new_from_file(&db_file, &profiles_dir)
            .await
            .unwrap();

        let owner = Uuid::new_v4();
        registry
            .register_profile("test".to_string(), "/tmp/test1".to_string(), owner)
            .await
            .unwrap();

        // Try to register same path again
        let result = registry
            .register_profile("test2".to_string(), "/tmp/test1".to_string(), owner)
            .await;

        assert!(result.is_err());

        // Try to register same name with different path
        let result = registry
            .register_profile("test".to_string(), "/tmp/test2".to_string(), owner)
            .await;

        assert!(result.is_err());
    }

    #[test]
    fn test_profile_lock() {
        let temp_dir = TempDir::new().unwrap();
        let profile_path = temp_dir.path().join("profile");
        fs::create_dir(&profile_path).unwrap();

        let mut lock1 = ProfileLock::new(&profile_path);
        assert!(lock1.try_lock().unwrap());

        // Try to acquire second lock
        let mut lock2 = ProfileLock::new(&profile_path);
        assert!(!lock2.try_lock().unwrap());

        // Release first lock
        lock1.release().unwrap();

        // Now should be able to acquire
        assert!(lock2.try_lock().unwrap());
        lock2.release().unwrap();
    }
}
