//! Database module for Hexactra control plane
//!
//! This module provides SQLite database access with migrations,
//! transaction support, and typed queries.

use anyhow::Result;
use sqlx::{sqlite::SqlitePoolOptions, Pool, Sqlite};
use std::path::Path;

/// Database connection pool
pub type DbPool = Pool<Sqlite>;

/// Initialize the database connection pool
pub async fn init_pool(database_path: &Path) -> Result<DbPool> {
    let database_url = format!("sqlite:{}?mode=rwc", database_path.display());
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;
    
    // Run migrations
    migrate(&pool).await?;
    
    Ok(pool)
}

/// Run database migrations
pub async fn migrate(pool: &DbPool) -> Result<()> {
    // Path is relative to CARGO_MANIFEST_DIR (the crate root)
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let migrations_path = std::path::PathBuf::from(manifest_dir).join("migrations");
    
    // Use the full path as a literal string
    let migrations_str = migrations_path.to_str().unwrap();
    
    // Note: sqlx::migrate! requires a compile-time literal, so we use the path directly
    // The path is relative to CARGO_MANIFEST_DIR which points to the crate root
    sqlx::migrate!("../hexactra-control/migrations")
        .run(pool)
        .await?;
    
    Ok(())
}

/// Create the database file if it doesn't exist
pub fn ensure_database_file(database_path: &Path) -> Result<()> {
    if let Some(parent) = database_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    
    // Touch the file to ensure it exists
    if !database_path.exists() {
        std::fs::write(database_path, "")?;
    }
    
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_database_init() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");
        
        let pool = init_pool(&db_path).await.unwrap();
        
        // Test a simple query
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master")
            .fetch_one(&pool)
            .await
            .unwrap();
        
        // Migrations should have created some tables
        assert!(count > 0);
    }

    #[test]
    fn test_ensure_database_file() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("new.db");
        
        ensure_database_file(&db_path).unwrap();
        assert!(db_path.exists());
    }
}
