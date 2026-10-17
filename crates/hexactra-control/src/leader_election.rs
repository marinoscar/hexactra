//! Leader election for distributed scheduling coordination
//!
//! This module provides:
//! - Distributed lock-based leader election using database
//! - Automatic leader failover on node failure
//! - Idempotent leadership claims

use anyhow::Result;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqliteQueryResult;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::state::DbState;

/// Leader election state
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeaderState {
    /// This node is the current leader
    Leader,
    /// This node is a follower
    Follower,
    /// No leader elected yet
    NoLeader,
}

/// Leader information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeaderInfo {
    pub leader_id: String,
    pub acquired_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub is_active: bool,
}

/// Leader election configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeaderConfig {
    /// Lock duration in seconds
    pub lock_duration_seconds: i64,
    /// Heartbeat interval in seconds
    pub heartbeat_interval_seconds: u64,
    /// Maximum leader failover time in seconds
    pub max_failover_seconds: u64,
}

impl Default for LeaderConfig {
    fn default() -> Self {
        LeaderConfig {
            lock_duration_seconds: 30,      // 30 seconds
            heartbeat_interval_seconds: 10, // 10 seconds
            max_failover_seconds: 15,       // 15 seconds
        }
    }
}

/// Leader election service
#[derive(Clone)]
pub struct LeaderElection {
    db_state: DbState,
    node_id: String,
    config: LeaderConfig,
    leader_state: Arc<Mutex<LeaderState>>,
    current_leader: Arc<Mutex<Option<LeaderInfo>>>,
}

impl LeaderElection {
    pub fn new(db_state: DbState, node_id: impl Into<String>, config: Option<LeaderConfig>) -> Self {
        Self {
            db_state,
            node_id: node_id.into(),
            config: config.unwrap_or_default(),
            leader_state: Arc::new(Mutex::new(LeaderState::NoLeader)),
            current_leader: Arc::new(Mutex::new(None)),
        }
    }

    /// Try to acquire leadership
    pub async fn try_acquire_leadership(&self) -> Result<bool> {
        let lock_key = "scheduler_leader";
        let now = Utc::now();
        let expires_at = now + Duration::seconds(self.config.lock_duration_seconds);

        // Try to insert a new leader record
        let pool = self.db_state.pool();
        let result: SqliteQueryResult = sqlx::query(
            r#"
            INSERT INTO distributed_leases (id, resource_type, resource_id, holder_id, expires_at, created_at)
            VALUES ($1, 'leader', $2, $3, $4, $5)
            ON CONFLICT (resource_type, resource_id) DO NOTHING
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(lock_key)
        .bind(&self.node_id)
        .bind(expires_at)
        .bind(now)
        .execute(&*pool)
        .await?;

        let acquired = result.rows_affected() > 0;

        if acquired {
            let mut state = self.leader_state.lock().await;
            *state = LeaderState::Leader;

            let mut leader = self.current_leader.lock().await;
            *leader = Some(LeaderInfo {
                leader_id: self.node_id.clone(),
                acquired_at: now,
                expires_at,
                is_active: true,
            });
        }

        Ok(acquired)
    }

    /// Renew leadership lock
    pub async fn renew_leadership(&self) -> Result<bool> {
        let lock_key = "scheduler_leader";
        let now = Utc::now();
        let expires_at = now + Duration::seconds(self.config.lock_duration_seconds);

        let pool = self.db_state.pool();
        let result: SqliteQueryResult = sqlx::query(
            r#"
            UPDATE distributed_leases
            SET holder_id = $1, expires_at = $2
            WHERE resource_type = 'leader' AND resource_id = $3 AND holder_id = $1
            "#,
        )
        .bind(&self.node_id)
        .bind(expires_at)
        .bind(lock_key)
        .execute(&*pool)
        .await?;

        Ok(result.rows_affected() > 0)
    }

    /// Release leadership
    pub async fn release_leadership(&self) -> Result<()> {
        let lock_key = "scheduler_leader";

        self.db_state
            .release_distributed_lease("leader", lock_key)
            .await?;

        let mut state = self.leader_state.lock().await;
        *state = LeaderState::NoLeader;

        let mut leader = self.current_leader.lock().await;
        *leader = None;

        Ok(())
    }

    /// Check if this node is the current leader
    pub async fn is_leader(&self) -> bool {
        let state = self.leader_state.lock().await;
        matches!(*state, LeaderState::Leader)
    }

    /// Get current leader info
    pub async fn get_leader_info(&self) -> Result<Option<LeaderInfo>> {
        let lock_key = "scheduler_leader";

        let lease = self
            .db_state
            .get_distributed_lease("leader", lock_key)
            .await?;

        Ok(lease.map(|l| LeaderInfo {
            leader_id: l.holder_id.as_uuid().to_string(),
            acquired_at: l.created_at,
            expires_at: l.expires_at,
            is_active: l.expires_at > Utc::now(),
        }))
    }

    /// Check if leadership needs to be acquired (no leader or leader expired)
    pub async fn should_acquire_leadership(&self) -> Result<bool> {
        let info = self.get_leader_info().await?;

        match info {
            Some(leader) => {
                // Check if leader is still valid
                Ok(Utc::now() > leader.expires_at - Duration::seconds(self.config.max_failover_seconds as i64))
            }
            None => Ok(true), // No leader exists
        }
    }

    /// Run leader election loop (for background task)
    pub async fn run_election_loop(&self) -> Result<()> {
        let mut last_renewal = Utc::now();

        loop {
            tokio::time::sleep(std::time::Duration::from_secs(self.config.heartbeat_interval_seconds)).await;

            // Check if we need to acquire leadership
            if self.should_acquire_leadership().await? {
                if self.try_acquire_leadership().await? {
                    tracing::info!("Acquired leadership");
                }
            } else if self.is_leader().await {
                // Renew leadership if we're the leader
                if !self.renew_leadership().await? {
                    tracing::warn!("Failed to renew leadership, stepping down");
                    self.release_leadership().await?;
                }
            }

            last_renewal = Utc::now();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_leader_election_basic() {
        // Test with in-memory database
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .unwrap();

        // Run migrations
        sqlx::migrate!("../hexactra-control/migrations")
            .run(&pool)
            .await
            .unwrap();

        let db_state = crate::state::DbState::new(pool);
        let db_state2 = db_state.clone();
        let election = LeaderElection::new(db_state, "node-1", None);

        // First node should acquire leadership
        assert!(election.try_acquire_leadership().await.unwrap());

        // Second node should not acquire
        let election2 = LeaderElection::new(db_state2, "node-2", None);
        assert!(!election2.try_acquire_leadership().await.unwrap());

        // First node should still be leader
        assert!(election.is_leader().await);

        // Release leadership
        election.release_leadership().await.unwrap();

        // Now second node can acquire
        assert!(election2.try_acquire_leadership().await.unwrap());
    }
}
