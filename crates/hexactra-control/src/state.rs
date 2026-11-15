//! State management for Hexactra control plane
//!
//! This module provides typed storage operations using SQLite.

use anyhow::Result;
use chrono::{DateTime, Utc};
use sqlx::{Row, Sqlite};
use std::sync::Arc;
use uuid::Uuid;

use hexactra_core::{
    BrowserAction, Capability, DistributedLease, Goal, Host, HostExtended, HostId, HostPlatform,
    HostStatus, Lease, LeaseId, Operation, OperationStatus, Profile, ProfileAffinity, RunStatus,
    Schedule, ScheduleRun, ScheduleRunStatus, SchedulingDecision, Session, SessionId,
    SessionStatus,
};

/// Database state storage
#[derive(Clone)]
pub struct DbState {
    pool: Arc<sqlx::Pool<Sqlite>>,
}

impl DbState {
    pub fn new(pool: sqlx::Pool<Sqlite>) -> Self {
        Self {
            pool: Arc::new(pool),
        }
    }

    /// Get a clone of the database pool
    pub fn pool(&self) -> Arc<sqlx::Pool<Sqlite>> {
        self.pool.clone()
    }

    // ==================== Profile Operations ====================

    pub async fn create_profile(&self, profile: &Profile) -> Result<()> {
        let pool = self.pool.clone();
        sqlx::query(
            r#"
            INSERT INTO profiles (id, name, chrome_profile_path, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            "#,
        )
        .bind(profile.id.to_string())
        .bind(&profile.name)
        .bind(&profile.chrome_profile_path)
        .bind(profile.created_at.to_rfc3339())
        .bind(profile.updated_at.to_rfc3339())
        .execute(&*pool)
        .await?;

        Ok(())
    }

    pub async fn get_profile(&self, id: Uuid) -> Result<Option<Profile>> {
        let pool = self.pool.clone();
        let row = sqlx::query(
            r#"
            SELECT 
                id,
                name,
                chrome_profile_path,
                created_at,
                updated_at
            FROM profiles
            WHERE id = ?
            "#,
        )
        .bind(id.to_string())
        .fetch_optional(&*pool)
        .await?;

        if let Some(row) = row {
            let profile = Profile {
                id: Uuid::parse_str(&row.get::<String, _>(0))?,
                name: row.get::<String, _>(1),
                chrome_profile_path: row.get::<Option<String>, _>(2),
                created_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(3).into(),
                    Utc,
                ),
                updated_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(4).into(),
                    Utc,
                ),
            };
            Ok(Some(profile))
        } else {
            Ok(None)
        }
    }

    pub async fn list_profiles(&self) -> Result<Vec<Profile>> {
        let pool = self.pool.clone();
        let rows = sqlx::query(
            r#"
            SELECT 
                id,
                name,
                chrome_profile_path,
                created_at,
                updated_at
            FROM profiles
            ORDER BY created_at DESC
            "#,
        )
        .fetch_all(&*pool)
        .await?;

        let mut profiles = Vec::new();
        for row in rows {
            profiles.push(Profile {
                id: Uuid::parse_str(&row.get::<String, _>(0))?,
                name: row.get::<String, _>(1),
                chrome_profile_path: row.get::<Option<String>, _>(2),
                created_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(3).into(),
                    Utc,
                ),
                updated_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(4).into(),
                    Utc,
                ),
            });
        }

        Ok(profiles)
    }

    // ==================== Session Operations ====================

    pub async fn create_session(&self, session: &Session) -> Result<()> {
        let pool = self.pool.clone();
        sqlx::query(
            r#"
            INSERT INTO sessions (id, profile_id, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            "#,
        )
        .bind(session.id.as_uuid().to_string())
        .bind(session.profile_id.to_string())
        .bind(session.status.as_str_name())
        .bind(session.created_at.to_rfc3339())
        .bind(session.updated_at.to_rfc3339())
        .execute(&*pool)
        .await?;

        Ok(())
    }

    pub async fn get_session(&self, id: Uuid) -> Result<Option<Session>> {
        let pool = self.pool.clone();
        let row = sqlx::query(
            r#"
            SELECT 
                id,
                profile_id,
                status,
                created_at,
                updated_at
            FROM sessions
            WHERE id = ?
            "#,
        )
        .bind(id.to_string())
        .fetch_optional(&*pool)
        .await?;

        if let Some(row) = row {
            let session = Session {
                id: Uuid::parse_str(&row.get::<String, _>(0))?.into(),
                profile_id: Uuid::parse_str(&row.get::<String, _>(1))?,
                status: SessionStatus::from_str_name(&row.get::<String, _>(2)),
                created_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(3).into(),
                    Utc,
                ),
                updated_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(4).into(),
                    Utc,
                ),
            };
            Ok(Some(session))
        } else {
            Ok(None)
        }
    }

    pub async fn update_session_status(&self, id: Uuid, status: SessionStatus) -> Result<()> {
        let pool = self.pool.clone();
        sqlx::query(
            r#"
            UPDATE sessions 
            SET status = ?, updated_at = datetime('now')
            WHERE id = ?
            "#,
        )
        .bind(status.as_str_name())
        .bind(id.to_string())
        .execute(&*pool)
        .await?;

        Ok(())
    }

    pub async fn list_sessions(&self) -> Result<Vec<Session>> {
        let pool = self.pool.clone();
        let rows = sqlx::query(
            r#"
            SELECT 
                id,
                profile_id,
                status,
                created_at,
                updated_at
            FROM sessions
            ORDER BY created_at DESC
            "#,
        )
        .fetch_all(&*pool)
        .await?;

        let mut sessions = Vec::new();
        for row in rows {
            sessions.push(Session {
                id: Uuid::parse_str(&row.get::<String, _>(0))?.into(),
                profile_id: Uuid::parse_str(&row.get::<String, _>(1))?,
                status: SessionStatus::from_str_name(&row.get::<String, _>(2)),
                created_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(3).into(),
                    Utc,
                ),
                updated_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(4).into(),
                    Utc,
                ),
            });
        }

        Ok(sessions)
    }

    pub async fn get_session_by_profile(
        &self,
        profile_id: Uuid,
        status: Option<SessionStatus>,
    ) -> Result<Vec<Session>> {
        let pool = self.pool.clone();
        let rows = if let Some(status) = status {
            sqlx::query(
                r#"
                SELECT 
                    id,
                    profile_id,
                    status,
                    created_at,
                    updated_at
                FROM sessions
                WHERE profile_id = ? AND status = ?
                ORDER BY created_at DESC
                "#,
            )
            .bind(profile_id.to_string())
            .bind(status.as_str_name())
            .fetch_all(&*pool)
            .await?
        } else {
            sqlx::query(
                r#"
                SELECT 
                    id,
                    profile_id,
                    status,
                    created_at,
                    updated_at
                FROM sessions
                WHERE profile_id = ?
                ORDER BY created_at DESC
                "#,
            )
            .bind(profile_id.to_string())
            .fetch_all(&*pool)
            .await?
        };

        let mut sessions = Vec::new();
        for row in rows {
            sessions.push(Session {
                id: Uuid::parse_str(&row.get::<String, _>(0))?.into(),
                profile_id: Uuid::parse_str(&row.get::<String, _>(1))?,
                status: SessionStatus::from_str_name(&row.get::<String, _>(2)),
                created_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(3).into(),
                    Utc,
                ),
                updated_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(4).into(),
                    Utc,
                ),
            });
        }

        Ok(sessions)
    }

    pub async fn list_sessions_by_profile(&self, profile_id: Uuid) -> Result<Vec<Session>> {
        self.get_session_by_profile(profile_id, None).await
    }

    // ==================== Goal Operations ====================

    pub async fn create_goal(&self, goal: &Goal) -> Result<()> {
        let pool = self.pool.clone();
        let actions_json = serde_json::to_value(goal.actions.clone())?;
        sqlx::query(
            r#"
            INSERT INTO goals (id, session_id, actions, created_at, status)
            VALUES (?, ?, ?, ?, ?)
            "#,
        )
        .bind(goal.id.as_uuid().to_string())
        .bind(goal.session_id.as_uuid().to_string())
        .bind(actions_json.to_string())
        .bind(goal.created_at.to_rfc3339())
        .bind(goal.status.as_str_name())
        .execute(&*pool)
        .await?;

        Ok(())
    }

    pub async fn get_goal(&self, id: Uuid) -> Result<Option<Goal>> {
        let pool = self.pool.clone();
        let row = sqlx::query(
            r#"
            SELECT 
                id,
                session_id,
                actions,
                created_at,
                status
            FROM goals
            WHERE id = ?
            "#,
        )
        .bind(id.to_string())
        .fetch_optional(&*pool)
        .await?;

        if let Some(row) = row {
            let mut goal = Goal {
                id: Uuid::parse_str(&row.get::<String, _>(0))?.into(),
                session_id: Uuid::parse_str(&row.get::<String, _>(1))?.into(),
                actions: Vec::new(),
                created_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(3).into(),
                    Utc,
                ),
                status: RunStatus::from_str_name(&row.get::<String, _>(4)),
            };
            goal.actions = serde_json::from_str(&row.get::<String, _>(2))?;
            Ok(Some(goal))
        } else {
            Ok(None)
        }
    }

    pub async fn update_goal_status(&self, id: Uuid, status: RunStatus) -> Result<()> {
        let pool = self.pool.clone();
        sqlx::query(
            r#"
            UPDATE goals 
            SET status = ?, updated_at = datetime('now')
            WHERE id = ?
            "#,
        )
        .bind(status.as_str_name())
        .bind(id.to_string())
        .execute(&*pool)
        .await?;

        Ok(())
    }

    pub async fn list_goals_by_session(&self, session_id: Uuid) -> Result<Vec<Goal>> {
        let pool = self.pool.clone();
        let rows = sqlx::query(
            r#"
            SELECT 
                id,
                session_id,
                actions,
                created_at,
                status
            FROM goals
            WHERE session_id = ?
            ORDER BY created_at DESC
            "#,
        )
        .bind(session_id.to_string())
        .fetch_all(&*pool)
        .await?;

        let mut goals = Vec::new();
        for row in rows {
            let mut goal = Goal {
                id: Uuid::parse_str(&row.get::<String, _>(0))?.into(),
                session_id: Uuid::parse_str(&row.get::<String, _>(1))?.into(),
                actions: Vec::new(),
                created_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(3).into(),
                    Utc,
                ),
                status: RunStatus::from_str_name(&row.get::<String, _>(4)),
            };
            goal.actions = serde_json::from_str(&row.get::<String, _>(2))?;
            goals.push(goal);
        }

        Ok(goals)
    }

    // ==================== Operation Operations ====================

    pub async fn create_operation(&self, operation: &Operation) -> Result<()> {
        let pool = self.pool.clone();
        sqlx::query(
            r#"
            INSERT INTO operations (id, goal_id, status, created_at, started_at, completed_at)
            VALUES (?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(operation.id.as_uuid().to_string())
        .bind(operation.goal_id.as_uuid().to_string())
        .bind(operation.status.as_str_name())
        .bind(operation.created_at.to_rfc3339())
        .bind(operation.started_at.map(|t| t.to_rfc3339()))
        .bind(operation.completed_at.map(|t| t.to_rfc3339()))
        .execute(&*pool)
        .await?;

        Ok(())
    }

    pub async fn get_operation(&self, id: Uuid) -> Result<Option<Operation>> {
        let pool = self.pool.clone();
        let row = sqlx::query(
            r#"
            SELECT 
                id,
                goal_id,
                status,
                created_at,
                started_at,
                completed_at
            FROM operations
            WHERE id = ?
            "#,
        )
        .bind(id.to_string())
        .fetch_optional(&*pool)
        .await?;

        if let Some(row) = row {
            let operation = Operation {
                id: Uuid::parse_str(&row.get::<String, _>(0))?.into(),
                goal_id: Uuid::parse_str(&row.get::<String, _>(1))?.into(),
                status: OperationStatus::from_str_name(&row.get::<String, _>(2)),
                created_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(3).into(),
                    Utc,
                ),
                started_at: row
                    .get::<Option<chrono::NaiveDateTime>, _>(4)
                    .map(|dt| DateTime::<Utc>::from_utc(dt.into(), Utc)),
                completed_at: row
                    .get::<Option<chrono::NaiveDateTime>, _>(5)
                    .map(|dt| DateTime::<Utc>::from_utc(dt.into(), Utc)),
            };
            Ok(Some(operation))
        } else {
            Ok(None)
        }
    }

    pub async fn update_operation_status(
        &self,
        id: Uuid,
        status: OperationStatus,
        started_at: Option<DateTime<Utc>>,
        completed_at: Option<DateTime<Utc>>,
    ) -> Result<()> {
        let pool = self.pool.clone();
        sqlx::query(
            r#"
            UPDATE operations 
            SET status = ?, started_at = ?, completed_at = ?, updated_at = datetime('now')
            WHERE id = ?
            "#,
        )
        .bind(status.as_str_name())
        .bind(started_at.map(|t| t.to_rfc3339()))
        .bind(completed_at.map(|t| t.to_rfc3339()))
        .bind(id.to_string())
        .execute(&*pool)
        .await?;

        Ok(())
    }

    pub async fn list_operations_by_goal(&self, goal_id: Uuid) -> Result<Vec<Operation>> {
        let pool = self.pool.clone();
        let rows = sqlx::query(
            r#"
            SELECT 
                id,
                goal_id,
                status,
                created_at,
                started_at,
                completed_at
            FROM operations
            WHERE goal_id = ?
            ORDER BY created_at DESC
            "#,
        )
        .bind(goal_id.to_string())
        .fetch_all(&*pool)
        .await?;

        let mut operations = Vec::new();
        for row in rows {
            operations.push(Operation {
                id: Uuid::parse_str(&row.get::<String, _>(0))?.into(),
                goal_id: Uuid::parse_str(&row.get::<String, _>(1))?.into(),
                status: OperationStatus::from_str_name(&row.get::<String, _>(2)),
                created_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(3).into(),
                    Utc,
                ),
                started_at: row
                    .get::<Option<chrono::NaiveDateTime>, _>(4)
                    .map(|dt| DateTime::<Utc>::from_utc(dt.into(), Utc)),
                completed_at: row
                    .get::<Option<chrono::NaiveDateTime>, _>(5)
                    .map(|dt| DateTime::<Utc>::from_utc(dt.into(), Utc)),
            });
        }

        Ok(operations)
    }

    pub async fn list_operations_by_status(
        &self,
        status: OperationStatus,
    ) -> Result<Vec<Operation>> {
        let pool = self.pool.clone();
        let rows = sqlx::query(
            r#"
            SELECT 
                id,
                goal_id,
                status,
                created_at,
                started_at,
                completed_at
            FROM operations
            WHERE status = ?
            ORDER BY created_at DESC
            "#,
        )
        .bind(status.as_str_name())
        .fetch_all(&*pool)
        .await?;

        let mut operations = Vec::new();
        for row in rows {
            operations.push(Operation {
                id: Uuid::parse_str(&row.get::<String, _>(0))?.into(),
                goal_id: Uuid::parse_str(&row.get::<String, _>(1))?.into(),
                status: OperationStatus::from_str_name(&row.get::<String, _>(2)),
                created_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(3).into(),
                    Utc,
                ),
                started_at: row
                    .get::<Option<chrono::NaiveDateTime>, _>(4)
                    .map(|dt| DateTime::<Utc>::from_utc(dt.into(), Utc)),
                completed_at: row
                    .get::<Option<chrono::NaiveDateTime>, _>(5)
                    .map(|dt| DateTime::<Utc>::from_utc(dt.into(), Utc)),
            });
        }

        Ok(operations)
    }

    // ==================== Lease Operations ====================

    pub async fn create_lease(
        &self,
        lease_id: &LeaseId,
        resource_type: &str,
        resource_id: &str,
        owner: &Uuid,
        expires_at: DateTime<Utc>,
    ) -> Result<()> {
        let pool = self.pool.clone();
        sqlx::query(
            r#"
            INSERT INTO leases (id, resource_type, resource_id, owner, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(lease_id.as_uuid().to_string())
        .bind(resource_type)
        .bind(resource_id)
        .bind(owner.to_string())
        .bind(expires_at.to_rfc3339())
        .bind(Utc::now().to_rfc3339())
        .execute(&*pool)
        .await?;

        Ok(())
    }

    pub async fn get_active_lease(
        &self,
        resource_type: &str,
        resource_id: &Uuid,
    ) -> Result<Option<Lease>> {
        let pool = self.pool.clone();
        let row = sqlx::query(
            r#"
            SELECT 
                id,
                resource_type,
                resource_id,
                owner,
                expires_at,
                created_at
            FROM leases
            WHERE resource_type = ? AND resource_id = ? AND expires_at > datetime('now')
            "#,
        )
        .bind(resource_type)
        .bind(resource_id.to_string())
        .fetch_optional(&*pool)
        .await?;

        if let Some(row) = row {
            let lease = Lease {
                id: LeaseId::from_uuid(Uuid::parse_str(&row.get::<String, _>(0))?),
                resource_type: row.get::<String, _>(1),
                resource_id: row.get::<String, _>(2),
                owner: Uuid::parse_str(&row.get::<String, _>(3))?,
                expires_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(4).into(),
                    Utc,
                ),
                created_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(5).into(),
                    Utc,
                ),
            };
            Ok(Some(lease))
        } else {
            Ok(None)
        }
    }

    pub async fn get_lease(&self, lease_id: LeaseId) -> Result<Option<Lease>> {
        let pool = self.pool.clone();
        let row = sqlx::query(
            r#"
            SELECT 
                id,
                resource_type,
                resource_id,
                owner,
                expires_at,
                created_at
            FROM leases
            WHERE id = ?
            "#,
        )
        .bind(lease_id.as_uuid().to_string())
        .fetch_optional(&*pool)
        .await?;

        if let Some(row) = row {
            let lease = Lease {
                id: LeaseId::from_uuid(Uuid::parse_str(&row.get::<String, _>(0))?),
                resource_type: row.get::<String, _>(1),
                resource_id: row.get::<String, _>(2),
                owner: Uuid::parse_str(&row.get::<String, _>(3))?,
                expires_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(4).into(),
                    Utc,
                ),
                created_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(5).into(),
                    Utc,
                ),
            };
            Ok(Some(lease))
        } else {
            Ok(None)
        }
    }

    pub async fn release_lease(&self, lease_id: LeaseId) -> Result<()> {
        let pool = self.pool.clone();
        sqlx::query(
            r#"
            DELETE FROM leases WHERE id = ?
            "#,
        )
        .bind(lease_id.as_uuid().to_string())
        .execute(&*pool)
        .await?;

        Ok(())
    }

    // ==================== Host Operations ====================

    pub async fn create_host(&self, host: &Host) -> Result<()> {
        let pool = self.pool.clone();
        let capabilities_json = serde_json::to_value(&host.capabilities)?;
        sqlx::query(
            r#"
            INSERT INTO hosts (id, hostname, version, capabilities, status, last_heartbeat, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(host.id.as_uuid().to_string())
        .bind(&host.hostname)
        .bind(&host.version)
        .bind(capabilities_json.to_string())
        .bind(host.status.as_str_name())
        .bind(host.last_heartbeat.to_rfc3339())
        .bind(host.created_at.to_rfc3339())
        .bind(host.updated_at.to_rfc3339())
        .execute(&*pool)
        .await?;

        Ok(())
    }

    pub async fn get_host(&self, host_id: &HostId) -> Result<Option<Host>> {
        let pool = self.pool.clone();
        let row = sqlx::query(
            r#"
            SELECT 
                id,
                hostname,
                version,
                capabilities,
                status,
                last_heartbeat,
                created_at,
                updated_at
            FROM hosts
            WHERE id = ?
            "#,
        )
        .bind(host_id.as_uuid().to_string())
        .fetch_optional(&*pool)
        .await?;

        if let Some(row) = row {
            let host = Host {
                id: HostId::from_uuid(Uuid::parse_str(&row.get::<String, _>(0))?),
                hostname: row.get::<String, _>(1),
                version: row.get::<String, _>(2),
                capabilities: serde_json::from_str(&row.get::<String, _>(3))?,
                status: HostStatus::from_str_name(&row.get::<String, _>(4)),
                last_heartbeat: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(5).into(),
                    Utc,
                ),
                created_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(6).into(),
                    Utc,
                ),
                updated_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(7).into(),
                    Utc,
                ),
            };
            Ok(Some(host))
        } else {
            Ok(None)
        }
    }

    pub async fn update_host(&self, host: &Host) -> Result<()> {
        let pool = self.pool.clone();
        let capabilities_json = serde_json::to_value(&host.capabilities)?;
        sqlx::query(
            r#"
            UPDATE hosts 
            SET hostname = ?, version = ?, capabilities = ?, status = ?, 
                last_heartbeat = ?, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(&host.hostname)
        .bind(&host.version)
        .bind(capabilities_json.to_string())
        .bind(host.status.as_str_name())
        .bind(host.last_heartbeat.to_rfc3339())
        .bind(host.updated_at.to_rfc3339())
        .bind(host.id.as_uuid().to_string())
        .execute(&*pool)
        .await?;

        Ok(())
    }

    pub async fn update_host_heartbeat(&self, host_id: &HostId) -> Result<()> {
        let pool = self.pool.clone();
        sqlx::query(
            r#"
            UPDATE hosts 
            SET last_heartbeat = datetime('now'), updated_at = datetime('now')
            WHERE id = ?
            "#,
        )
        .bind(host_id.as_uuid().to_string())
        .execute(&*pool)
        .await?;

        Ok(())
    }

    pub async fn list_hosts(&self) -> Result<Vec<Host>> {
        let pool = self.pool.clone();
        let rows = sqlx::query(
            r#"
            SELECT 
                id,
                hostname,
                version,
                capabilities,
                status,
                last_heartbeat,
                created_at,
                updated_at
            FROM hosts
            ORDER BY created_at DESC
            "#,
        )
        .fetch_all(&*pool)
        .await?;

        let mut hosts = Vec::new();
        for row in rows {
            hosts.push(Host {
                id: HostId::from_uuid(Uuid::parse_str(&row.get::<String, _>(0))?),
                hostname: row.get::<String, _>(1),
                version: row.get::<String, _>(2),
                capabilities: serde_json::from_str(&row.get::<String, _>(3))?,
                status: HostStatus::from_str_name(&row.get::<String, _>(4)),
                last_heartbeat: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(5).into(),
                    Utc,
                ),
                created_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(6).into(),
                    Utc,
                ),
                updated_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(7).into(),
                    Utc,
                ),
            });
        }

        Ok(hosts)
    }

    // ==================== Event Operations ====================

    pub async fn append_event(
        &self,
        event_type: &str,
        resource_id: &str,
        resource_type: &str,
        payload: &str,
    ) -> Result<u64> {
        let pool = self.pool.clone();
        let row = sqlx::query(
            r#"
            INSERT INTO events (event_type, resource_id, resource_type, payload)
            VALUES (?, ?, ?, ?)
            "#,
        )
        .bind(event_type)
        .bind(resource_id)
        .bind(resource_type)
        .bind(payload)
        .execute(&*pool)
        .await?;

        Ok(row.last_insert_rowid() as u64)
    }

    pub async fn get_events_since(
        &self,
        cursor: i64,
        limit: i64,
    ) -> Result<Vec<(i64, String, String, String, String)>> {
        let pool = self.pool.clone();
        let events = sqlx::query(
            r#"
            SELECT id, event_type, resource_id, resource_type, payload
            FROM events
            WHERE id > ?
            ORDER BY id ASC
            LIMIT ?
            "#,
        )
        .bind(cursor)
        .bind(limit)
        .fetch_all(&*pool)
        .await?;

        let mut result = Vec::new();
        for row in events {
            result.push((
                row.get::<i64, _>(0),
                row.get::<String, _>(1),
                row.get::<String, _>(2),
                row.get::<String, _>(3),
                row.get::<String, _>(4),
            ));
        }

        Ok(result)
    }

    // ==================== Provider Registry Operations ====================

    /// Register a new provider
    pub async fn register_provider(
        &self,
        id: &str,
        name: &str,
        provider_type: &str,
        config_json: &str,
    ) -> Result<()> {
        let pool = self.pool.clone();
        sqlx::query(
            r#"
            INSERT INTO provider_registry (id, name, provider_type, config_json, enabled, health_status)
            VALUES (?, ?, ?, ?, 1, 'not_configured')
            "#,
        )
        .bind(id)
        .bind(name)
        .bind(provider_type)
        .bind(config_json)
        .execute(&*pool)
        .await?;

        Ok(())
    }

    /// Get a registered provider by ID
    pub async fn get_provider(&self, id: &str) -> Result<Option<ProviderInfo>> {
        let pool = self.pool.clone();
        let row = sqlx::query(
            r#"
            SELECT id, name, provider_type, config_json, enabled, health_status, created_at, updated_at
            FROM provider_registry
            WHERE id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(&*pool)
        .await?;

        if let Some(row) = row {
            let enabled: i32 = row.get(4);
            let health_status: String = row.get(5);

            return Ok(Some(ProviderInfo {
                id: row.get(0),
                name: row.get(1),
                provider_type: row.get(2),
                config_json: row.get(3),
                enabled: enabled > 0,
                health_status: ProviderHealth::from_str_name(&health_status),
                created_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(6).into(),
                    Utc,
                ),
                updated_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(7).into(),
                    Utc,
                ),
            }));
        }

        Ok(None)
    }

    /// List all registered providers
    pub async fn list_providers(&self) -> Result<Vec<ProviderInfo>> {
        let pool = self.pool.clone();
        let rows = sqlx::query(
            r#"
            SELECT id, name, provider_type, config_json, enabled, health_status, created_at, updated_at
            FROM provider_registry
            ORDER BY created_at DESC
            "#,
        )
        .fetch_all(&*pool)
        .await?;

        let mut providers = Vec::new();
        for row in rows {
            let enabled: i32 = row.get(4);
            let health_status: String = row.get(5);

            providers.push(ProviderInfo {
                id: row.get(0),
                name: row.get(1),
                provider_type: row.get(2),
                config_json: row.get(3),
                enabled: enabled > 0,
                health_status: ProviderHealth::from_str_name(&health_status),
                created_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(6).into(),
                    Utc,
                ),
                updated_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(7).into(),
                    Utc,
                ),
            });
        }

        Ok(providers)
    }

    /// Update provider health status
    pub async fn update_provider_health(&self, id: &str, health: ProviderHealth) -> Result<()> {
        let pool = self.pool.clone();
        sqlx::query(
            r#"
            UPDATE provider_registry 
            SET health_status = ?, updated_at = datetime('now')
            WHERE id = ?
            "#,
        )
        .bind(health.as_str_name())
        .bind(id)
        .execute(&*pool)
        .await?;

        Ok(())
    }

    /// Enable or disable a provider
    pub async fn set_provider_enabled(&self, id: &str, enabled: bool) -> Result<()> {
        let pool = self.pool.clone();
        sqlx::query(
            r#"
            UPDATE provider_registry 
            SET enabled = ?, updated_at = datetime('now')
            WHERE id = ?
            "#,
        )
        .bind(if enabled { 1 } else { 0 })
        .bind(id)
        .execute(&*pool)
        .await?;

        Ok(())
    }

    /// Delete a provider
    pub async fn delete_provider(&self, id: &str) -> Result<u64> {
        let pool = self.pool.clone();
        let result = sqlx::query(
            r#"
            DELETE FROM provider_registry WHERE id = ?
            "#,
        )
        .bind(id)
        .execute(&*pool)
        .await?;

        Ok(result.rows_affected() as u64)
    }

    // ==================== Fleet Orchestration Operations ====================

    /// Get host extended info (platform, display, capacity)
    pub async fn get_host_extended(&self, host_id: &HostId) -> Result<Option<HostExtended>> {
        let pool = self.pool.clone();
        let row = sqlx::query(
            r#"
            SELECT 
                id,
                platform,
                display_available,
                max_concurrent_sessions,
                current_load
            FROM hosts
            WHERE id = ?
            "#,
        )
        .bind(host_id.as_uuid().to_string())
        .fetch_optional(&*pool)
        .await?;

        if let Some(row) = row {
            let host_extended = HostExtended {
                id: HostId::from_uuid(Uuid::parse_str(&row.get::<String, _>(0))?),
                platform: HostPlatform::from_str_name(&row.get::<String, _>(1)),
                display_available: row.get::<i32, _>(2) != 0,
                max_concurrent_sessions: row.get::<i64, _>(3) as u32,
                current_load: row.get::<i64, _>(4) as u32,
            };
            Ok(Some(host_extended))
        } else {
            Ok(None)
        }
    }

    /// Update host extended info
    pub async fn update_host_extended(&self, host_extended: &HostExtended) -> Result<()> {
        let pool = self.pool.clone();
        sqlx::query(
            r#"
            UPDATE hosts 
            SET platform = ?, display_available = ?, max_concurrent_sessions = ?, current_load = ?
            WHERE id = ?
            "#,
        )
        .bind(host_extended.platform.as_str_name())
        .bind(if host_extended.display_available {
            1
        } else {
            0
        })
        .bind(host_extended.max_concurrent_sessions as i64)
        .bind(host_extended.current_load as i64)
        .bind(host_extended.id.as_uuid().to_string())
        .execute(&*pool)
        .await?;

        Ok(())
    }

    /// Get profile affinity assignment
    pub async fn get_profile_affinity(&self, profile_id: Uuid) -> Result<Option<ProfileAffinity>> {
        let pool = self.pool.clone();
        let row = sqlx::query(
            r#"
            SELECT 
                profile_id,
                assigned_host_id,
                assigned_at,
                assigned_by
            FROM profile_affinity
            WHERE profile_id = ?
            "#,
        )
        .bind(profile_id.to_string())
        .fetch_optional(&*pool)
        .await?;

        if let Some(row) = row {
            let affinity = ProfileAffinity {
                profile_id: Uuid::parse_str(&row.get::<String, _>(0))?,
                assigned_host_id: HostId::from_uuid(Uuid::parse_str(&row.get::<String, _>(1))?),
                assigned_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(2).into(),
                    Utc,
                ),
                assigned_by: row.get::<String, _>(3),
            };
            Ok(Some(affinity))
        } else {
            Ok(None)
        }
    }

    /// Assign a profile to a host
    pub async fn assign_profile(
        &self,
        profile_id: Uuid,
        host_id: HostId,
        assigned_by: &str,
    ) -> Result<()> {
        let pool = self.pool.clone();

        // Use UPSERT pattern for SQLite
        sqlx::query(
            r#"
            INSERT INTO profile_affinity (profile_id, assigned_host_id, assigned_at, assigned_by)
            VALUES (?, ?, datetime('now'), ?)
            ON CONFLICT(profile_id) DO UPDATE SET 
                assigned_host_id = excluded.assigned_host_id,
                assigned_at = datetime('now'),
                assigned_by = excluded.assigned_by
            "#,
        )
        .bind(profile_id.to_string())
        .bind(host_id.as_uuid().to_string())
        .bind(assigned_by)
        .execute(&*pool)
        .await?;

        Ok(())
    }

    /// Clear profile affinity (remove assignment)
    pub async fn clear_profile_affinity(&self, profile_id: Uuid) -> Result<u64> {
        let pool = self.pool.clone();
        let result = sqlx::query(
            r#"
            DELETE FROM profile_affinity WHERE profile_id = ?
            "#,
        )
        .bind(profile_id.to_string())
        .execute(&*pool)
        .await?;

        Ok(result.rows_affected() as u64)
    }

    /// Get all profiles assigned to a host
    pub async fn get_profiles_by_host(&self, host_id: HostId) -> Result<Vec<ProfileAffinity>> {
        let pool = self.pool.clone();
        let rows = sqlx::query(
            r#"
            SELECT 
                profile_id,
                assigned_host_id,
                assigned_at,
                assigned_by
            FROM profile_affinity
            WHERE assigned_host_id = ?
            "#,
        )
        .bind(host_id.as_uuid().to_string())
        .fetch_all(&*pool)
        .await?;

        let mut affinities = Vec::new();
        for row in rows {
            affinities.push(ProfileAffinity {
                profile_id: Uuid::parse_str(&row.get::<String, _>(0))?,
                assigned_host_id: HostId::from_uuid(Uuid::parse_str(&row.get::<String, _>(1))?),
                assigned_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(2).into(),
                    Utc,
                ),
                assigned_by: row.get::<String, _>(3),
            });
        }

        Ok(affinities)
    }

    /// Create a new schedule
    pub async fn create_schedule(&self, schedule: &Schedule) -> Result<()> {
        let pool = self.pool.clone();
        let goal_definition_json = serde_json::to_string(&schedule.goal_definition)?;

        sqlx::query(
            r#"
            INSERT INTO schedules (id, owner_id, name, cron_expression, timezone, goal_definition, max_retries, retry_delay_seconds, enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
            "#,
        )
        .bind(schedule.id.to_string())
        .bind(schedule.owner_id.to_string())
        .bind(&schedule.name)
        .bind(&schedule.cron_expression)
        .bind(&schedule.timezone)
        .bind(goal_definition_json)
        .bind(schedule.max_retries as i64)
        .bind(schedule.retry_delay_seconds as i64)
        .bind(if schedule.enabled { 1 } else { 0 })
        .execute(&*pool)
        .await?;

        Ok(())
    }

    /// Get a schedule by ID
    pub async fn get_schedule(&self, schedule_id: Uuid) -> Result<Option<Schedule>> {
        let pool = self.pool.clone();
        let row = sqlx::query(
            r#"
            SELECT 
                id,
                owner_id,
                name,
                cron_expression,
                timezone,
                goal_definition,
                max_retries,
                retry_delay_seconds,
                enabled,
                created_at,
                updated_at
            FROM schedules
            WHERE id = ?
            "#,
        )
        .bind(schedule_id.to_string())
        .fetch_optional(&*pool)
        .await?;

        if let Some(row) = row {
            let schedule = Schedule {
                id: Uuid::parse_str(&row.get::<String, _>(0))?,
                owner_id: Uuid::parse_str(&row.get::<String, _>(1))?,
                name: row.get::<String, _>(2),
                cron_expression: row.get::<String, _>(3),
                timezone: row.get::<String, _>(4),
                goal_definition: serde_json::from_str(&row.get::<String, _>(5))?,
                max_retries: row.get::<i64, _>(6) as u32,
                retry_delay_seconds: row.get::<i64, _>(7) as u32,
                enabled: row.get::<i32, _>(8) != 0,
                created_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(9).into(),
                    Utc,
                ),
                updated_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(10).into(),
                    Utc,
                ),
            };
            Ok(Some(schedule))
        } else {
            Ok(None)
        }
    }

    /// List schedules for an owner
    pub async fn list_schedules_by_owner(&self, owner_id: Uuid) -> Result<Vec<Schedule>> {
        let pool = self.pool.clone();
        let rows = sqlx::query(
            r#"
            SELECT 
                id,
                owner_id,
                name,
                cron_expression,
                timezone,
                goal_definition,
                max_retries,
                retry_delay_seconds,
                enabled,
                created_at,
                updated_at
            FROM schedules
            WHERE owner_id = ?
            ORDER BY created_at DESC
            "#,
        )
        .bind(owner_id.to_string())
        .fetch_all(&*pool)
        .await?;

        let mut schedules = Vec::new();
        for row in rows {
            schedules.push(Schedule {
                id: Uuid::parse_str(&row.get::<String, _>(0))?,
                owner_id: Uuid::parse_str(&row.get::<String, _>(1))?,
                name: row.get::<String, _>(2),
                cron_expression: row.get::<String, _>(3),
                timezone: row.get::<String, _>(4),
                goal_definition: serde_json::from_str(&row.get::<String, _>(5))?,
                max_retries: row.get::<i64, _>(6) as u32,
                retry_delay_seconds: row.get::<i64, _>(7) as u32,
                enabled: row.get::<i32, _>(8) != 0,
                created_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(9).into(),
                    Utc,
                ),
                updated_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(10).into(),
                    Utc,
                ),
            });
        }

        Ok(schedules)
    }

    /// Update a schedule
    pub async fn update_schedule(&self, schedule: &Schedule) -> Result<()> {
        let pool = self.pool.clone();
        let goal_definition_json = serde_json::to_string(&schedule.goal_definition)?;

        sqlx::query(
            r#"
            UPDATE schedules 
            SET name = ?, cron_expression = ?, timezone = ?, goal_definition = ?,
                max_retries = ?, retry_delay_seconds = ?, enabled = ?, updated_at = datetime('now')
            WHERE id = ?
            "#,
        )
        .bind(&schedule.name)
        .bind(&schedule.cron_expression)
        .bind(&schedule.timezone)
        .bind(goal_definition_json)
        .bind(schedule.max_retries as i64)
        .bind(schedule.retry_delay_seconds as i64)
        .bind(if schedule.enabled { 1 } else { 0 })
        .bind(schedule.id.to_string())
        .execute(&*pool)
        .await?;

        Ok(())
    }

    /// Delete a schedule
    pub async fn delete_schedule(&self, schedule_id: Uuid) -> Result<u64> {
        let pool = self.pool.clone();
        let result = sqlx::query(
            r#"
            DELETE FROM schedules WHERE id = ?
            "#,
        )
        .bind(schedule_id.to_string())
        .execute(&*pool)
        .await?;

        Ok(result.rows_affected() as u64)
    }

    /// Create a schedule run
    pub async fn create_schedule_run(&self, run: &ScheduleRun) -> Result<()> {
        let pool = self.pool.clone();

        sqlx::query(
            r#"
            INSERT INTO schedule_runs (id, schedule_id, run_number, status, host_id, session_id, started_at, completed_at, error_message, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            "#,
        )
        .bind(run.id.to_string())
        .bind(run.schedule_id.to_string())
        .bind(run.run_number as i64)
        .bind(run.status.as_str_name())
        .bind(run.host_id.map(|h| h.as_uuid().to_string()))
        .bind(run.session_id.map(|s| s.as_uuid().to_string()))
        .bind(run.started_at.map(|t| t.to_rfc3339()))
        .bind(run.completed_at.map(|t| t.to_rfc3339()))
        .bind(run.error_message.as_deref().unwrap_or(""))
        .execute(&*pool)
        .await?;

        Ok(())
    }

    /// Get a schedule run by ID
    pub async fn get_schedule_run(&self, run_id: Uuid) -> Result<Option<ScheduleRun>> {
        let pool = self.pool.clone();
        let row = sqlx::query(
            r#"
            SELECT 
                id,
                schedule_id,
                run_number,
                status,
                host_id,
                session_id,
                started_at,
                completed_at,
                error_message
            FROM schedule_runs
            WHERE id = ?
            "#,
        )
        .bind(run_id.to_string())
        .fetch_optional(&*pool)
        .await?;

        if let Some(row) = row {
            let run = ScheduleRun {
                id: Uuid::parse_str(&row.get::<String, _>(0))?,
                schedule_id: Uuid::parse_str(&row.get::<String, _>(1))?,
                run_number: row.get::<i64, _>(2) as u32,
                status: ScheduleRunStatus::from_str_name(&row.get::<String, _>(3)),
                host_id: row
                    .get::<Option<String>, _>(4)
                    .and_then(|s| Uuid::parse_str(&s).ok())
                    .map(HostId::from_uuid),
                session_id: row
                    .get::<Option<String>, _>(5)
                    .and_then(|s| Uuid::parse_str(&s).ok())
                    .map(SessionId::from_uuid),
                started_at: row
                    .get::<Option<chrono::NaiveDateTime>, _>(6)
                    .map(|dt| DateTime::<Utc>::from_utc(dt.into(), Utc)),
                completed_at: row
                    .get::<Option<chrono::NaiveDateTime>, _>(7)
                    .map(|dt| DateTime::<Utc>::from_utc(dt.into(), Utc)),
                error_message: row.get::<Option<String>, _>(8),
                created_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(9).into(),
                    Utc,
                ),
            };
            Ok(Some(run))
        } else {
            Ok(None)
        }
    }

    /// List schedule runs for a schedule
    pub async fn list_schedule_runs(&self, schedule_id: Uuid) -> Result<Vec<ScheduleRun>> {
        let pool = self.pool.clone();
        let rows = sqlx::query(
            r#"
            SELECT 
                id,
                schedule_id,
                run_number,
                status,
                host_id,
                session_id,
                started_at,
                completed_at,
                error_message
            FROM schedule_runs
            WHERE schedule_id = ?
            ORDER BY created_at DESC
            "#,
        )
        .bind(schedule_id.to_string())
        .fetch_all(&*pool)
        .await?;

        let mut runs = Vec::new();
        for row in rows {
            runs.push(ScheduleRun {
                id: Uuid::parse_str(&row.get::<String, _>(0))?,
                schedule_id: Uuid::parse_str(&row.get::<String, _>(1))?,
                run_number: row.get::<i64, _>(2) as u32,
                status: ScheduleRunStatus::from_str_name(&row.get::<String, _>(3)),
                host_id: row
                    .get::<Option<String>, _>(4)
                    .and_then(|s| Uuid::parse_str(&s).ok())
                    .map(HostId::from_uuid),
                session_id: row
                    .get::<Option<String>, _>(5)
                    .and_then(|s| Uuid::parse_str(&s).ok())
                    .map(SessionId::from_uuid),
                started_at: row
                    .get::<Option<chrono::NaiveDateTime>, _>(6)
                    .map(|dt| DateTime::<Utc>::from_utc(dt.into(), Utc)),
                completed_at: row
                    .get::<Option<chrono::NaiveDateTime>, _>(7)
                    .map(|dt| DateTime::<Utc>::from_utc(dt.into(), Utc)),
                error_message: row.get::<Option<String>, _>(8),
                created_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(9).into(),
                    Utc,
                ),
            });
        }

        Ok(runs)
    }

    /// Update schedule run status
    pub async fn update_schedule_run_status(
        &self,
        run_id: Uuid,
        status: ScheduleRunStatus,
        started_at: Option<DateTime<Utc>>,
        completed_at: Option<DateTime<Utc>>,
        error_message: Option<String>,
    ) -> Result<()> {
        let pool = self.pool.clone();

        sqlx::query(
            r#"
            UPDATE schedule_runs 
            SET status = ?, started_at = ?, completed_at = ?, error_message = ?, updated_at = datetime('now')
            WHERE id = ?
            "#,
        )
        .bind(status.as_str_name())
        .bind(started_at.map(|t| t.to_rfc3339()))
        .bind(completed_at.map(|t| t.to_rfc3339()))
        .bind(error_message.as_deref().unwrap_or(""))
        .bind(run_id.to_string())
        .execute(&*pool)
        .await?;

        Ok(())
    }

    /// Create a distributed lease
    pub async fn create_distributed_lease(&self, lease: &DistributedLease) -> Result<()> {
        let pool = self.pool.clone();

        sqlx::query(
            r#"
            INSERT INTO distributed_leases (id, resource_type, resource_id, holder_id, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(resource_type, resource_id) DO UPDATE SET 
                holder_id = excluded.holder_id,
                expires_at = excluded.expires_at,
                created_at = excluded.created_at
            "#,
        )
        .bind(lease.id.to_string())
        .bind(&lease.resource_type)
        .bind(&lease.resource_id)
        .bind(lease.holder_id.as_uuid().to_string())
        .bind(lease.expires_at.to_rfc3339())
        .execute(&*pool)
        .await?;

        Ok(())
    }

    /// Get a distributed lease
    pub async fn get_distributed_lease(
        &self,
        resource_type: &str,
        resource_id: &str,
    ) -> Result<Option<DistributedLease>> {
        let pool = self.pool.clone();
        let row = sqlx::query(
            r#"
            SELECT 
                id,
                resource_type,
                resource_id,
                holder_id,
                expires_at,
                created_at
            FROM distributed_leases
            WHERE resource_type = ? AND resource_id = ?
            "#,
        )
        .bind(resource_type)
        .bind(resource_id)
        .fetch_optional(&*pool)
        .await?;

        if let Some(row) = row {
            let lease = DistributedLease {
                id: Uuid::parse_str(&row.get::<String, _>(0))?,
                resource_type: row.get::<String, _>(1),
                resource_id: row.get::<String, _>(2),
                holder_id: HostId::from_uuid(Uuid::parse_str(&row.get::<String, _>(3))?),
                expires_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(4).into(),
                    Utc,
                ),
                created_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(5).into(),
                    Utc,
                ),
            };
            Ok(Some(lease))
        } else {
            Ok(None)
        }
    }

    /// Release a distributed lease
    pub async fn release_distributed_lease(
        &self,
        resource_type: &str,
        resource_id: &str,
    ) -> Result<u64> {
        let pool = self.pool.clone();
        let result = sqlx::query(
            r#"
            DELETE FROM distributed_leases WHERE resource_type = ? AND resource_id = ?
            "#,
        )
        .bind(resource_type)
        .bind(resource_id)
        .execute(&*pool)
        .await?;

        Ok(result.rows_affected() as u64)
    }

    /// Find eligible hosts for scheduling based on capabilities and load
    pub async fn find_eligible_hosts(
        &self,
        required_capabilities: &[&str],
        platform: Option<HostPlatform>,
    ) -> Result<Vec<Host>> {
        let pool = self.pool.clone();

        // Build query with optional filters
        let mut query = String::from(
            r#"
            SELECT 
                id, hostname, version, capabilities, status, last_heartbeat, created_at, updated_at
            FROM hosts 
            WHERE status != 'disconnected' AND status != 'offline'
            "#,
        );

        if let Some(platform) = platform {
            query.push_str(&format!(" AND platform = '{}'", platform.as_str_name()));
        }

        query.push_str(" ORDER BY last_heartbeat DESC");

        let rows = sqlx::query(&query).fetch_all(&*pool).await?;

        let mut hosts = Vec::new();
        for row in rows {
            hosts.push(Host {
                id: HostId::from_uuid(Uuid::parse_str(&row.get::<String, _>(0))?),
                hostname: row.get::<String, _>(1),
                version: row.get::<String, _>(2),
                capabilities: serde_json::from_str(&row.get::<String, _>(3))?,
                status: HostStatus::from_str_name(&row.get::<String, _>(4)),
                last_heartbeat: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(5).into(),
                    Utc,
                ),
                created_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(6).into(),
                    Utc,
                ),
                updated_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(7).into(),
                    Utc,
                ),
            });
        }

        Ok(hosts)
    }

    /// Make a scheduling decision based on host capabilities and profile affinity
    pub async fn make_scheduling_decision(
        &self,
        required_capabilities: &[&str],
        platform: Option<HostPlatform>,
        profile_id: Option<Uuid>,
    ) -> Result<Option<SchedulingDecision>> {
        // Get profile affinity if provided
        let assigned_host = if let Some(profile_id) = profile_id {
            self.get_profile_affinity(profile_id)
                .await?
                .map(|a| a.assigned_host_id)
        } else {
            None
        };

        // Find eligible hosts
        let mut eligible_hosts = self
            .find_eligible_hosts(required_capabilities, platform)
            .await?;

        // If there's an assigned host and it's still eligible, prefer it
        if let Some(assigned_host_id) = assigned_host {
            if let Some(host) = eligible_hosts.iter().find(|h| h.id == assigned_host_id) {
                return Ok(Some(SchedulingDecision {
                    host_id: host.id,
                    profile_id,
                    reason: "profile_affinity".to_string(),
                    score: 1.0,
                }));
            }
        }

        // Otherwise, pick the least loaded host
        if let Some(host) = eligible_hosts.first() {
            // Get extended info for load calculation
            let extended = self.get_host_extended(&host.id).await?;
            let score = if let Some(ext) = &extended {
                if ext.max_concurrent_sessions > 0 {
                    1.0 - (ext.current_load as f64 / ext.max_concurrent_sessions as f64)
                } else {
                    1.0
                }
            } else {
                1.0 // Default score if no extended info available
            };

            Ok(Some(SchedulingDecision {
                host_id: host.id,
                profile_id,
                reason: "least_loaded".to_string(),
                score,
            }))
        } else {
            Ok(None)
        }
    }

    /// Update host current load
    pub async fn update_host_load(&self, host_id: &HostId, new_load: u32) -> Result<()> {
        let pool = self.pool.clone();
        sqlx::query(
            r#"
            UPDATE hosts 
            SET current_load = ? WHERE id = ?
            "#,
        )
        .bind(new_load as i64)
        .bind(host_id.as_uuid().to_string())
        .execute(&*pool)
        .await?;

        Ok(())
    }

    /// Increment host load
    pub async fn increment_host_load(&self, host_id: &HostId) -> Result<u32> {
        let pool = self.pool.clone();

        // Get current load
        let row = sqlx::query(
            r#"
            SELECT current_load, max_concurrent_sessions FROM hosts WHERE id = ?
            "#,
        )
        .bind(host_id.as_uuid().to_string())
        .fetch_optional(&*pool)
        .await?;

        if let Some(row) = row {
            let current_load: i64 = row.get(0);
            let max_sessions: i64 = row.get(1);

            if current_load >= max_sessions {
                return Err(anyhow::anyhow!("Host at capacity"));
            }

            let new_load = (current_load + 1) as u32;

            sqlx::query(
                r#"
                UPDATE hosts SET current_load = ? WHERE id = ?
                "#,
            )
            .bind(current_load + 1)
            .bind(host_id.as_uuid().to_string())
            .execute(&*pool)
            .await?;

            Ok(new_load)
        } else {
            Err(anyhow::anyhow!("Host not found"))
        }
    }

    /// Decrement host load
    pub async fn decrement_host_load(&self, host_id: &HostId) -> Result<u32> {
        let pool = self.pool.clone();

        let row = sqlx::query(
            r#"
            SELECT current_load FROM hosts WHERE id = ?
            "#,
        )
        .bind(host_id.as_uuid().to_string())
        .fetch_optional(&*pool)
        .await?;

        if let Some(row) = row {
            let current_load: i64 = row.get(0);

            if current_load > 0 {
                sqlx::query(
                    r#"
                    UPDATE hosts SET current_load = ? WHERE id = ?
                    "#,
                )
                .bind(current_load - 1)
                .bind(host_id.as_uuid().to_string())
                .execute(&*pool)
                .await?;

                Ok((current_load - 1) as u32)
            } else {
                Ok(0)
            }
        } else {
            Err(anyhow::anyhow!("Host not found"))
        }
    }
}

/// Provider information struct
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub provider_type: String,
    pub config_json: String,
    pub enabled: bool,
    pub health_status: ProviderHealth,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Provider health status
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderHealth {
    Healthy,
    Degraded,
    Unavailable,
    NotConfigured,
}

impl ProviderHealth {
    /// Get string representation
    pub fn as_str_name(&self) -> &'static str {
        match self {
            ProviderHealth::Healthy => "healthy",
            ProviderHealth::Degraded => "degraded",
            ProviderHealth::Unavailable => "unavailable",
            ProviderHealth::NotConfigured => "not_configured",
        }
    }

    /// Parse from string
    pub fn from_str_name(s: &str) -> Self {
        match s {
            "healthy" => ProviderHealth::Healthy,
            "degraded" => ProviderHealth::Degraded,
            "unavailable" => ProviderHealth::Unavailable,
            "not_configured" => ProviderHealth::NotConfigured,
            _ => ProviderHealth::NotConfigured,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hexactra_core::{GoalId, SessionId};
    use tempfile::TempDir;

    async fn setup_test_db() -> DbState {
        // Use in-memory database for tests
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .unwrap();

        // Run migrations
        sqlx::migrate!("../hexactra-control/migrations")
            .run(&pool)
            .await
            .unwrap();

        DbState::new(pool)
    }

    #[tokio::test]
    async fn test_create_and_get_profile() {
        let state = setup_test_db().await;

        let profile = Profile {
            id: Uuid::new_v4(),
            name: "Test Profile".to_string(),
            chrome_profile_path: Some("/path/to/profile".to_string()),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        state.create_profile(&profile).await.unwrap();
        let retrieved = state.get_profile(profile.id).await.unwrap();

        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().name, profile.name);
    }

    #[tokio::test]
    async fn test_create_and_get_session() {
        let state = setup_test_db().await;

        // Create a profile first (required by foreign key constraint)
        let profile = Profile {
            id: Uuid::new_v4(),
            name: "Test Profile".to_string(),
            chrome_profile_path: Some("/path/to/profile".to_string()),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        state.create_profile(&profile).await.unwrap();

        let session = Session {
            id: SessionId::from_uuid(Uuid::new_v4()),
            profile_id: profile.id,
            status: SessionStatus::Initializing,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        state.create_session(&session).await.unwrap();
        let retrieved = state.get_session(session.id.as_uuid()).await.unwrap();

        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().status, SessionStatus::Initializing);
    }

    #[tokio::test]
    async fn test_create_and_get_goal() {
        let state = setup_test_db().await;

        // Create a profile first (required by foreign key constraint)
        let profile = Profile {
            id: Uuid::new_v4(),
            name: "Test Profile".to_string(),
            chrome_profile_path: Some("/path/to/profile".to_string()),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        state.create_profile(&profile).await.unwrap();

        let session_id = SessionId::from_uuid(Uuid::new_v4());

        // Create session first
        let session = Session {
            id: session_id,
            profile_id: profile.id,
            status: SessionStatus::Initializing,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        state.create_session(&session).await.unwrap();

        let goal = Goal {
            id: GoalId::from_uuid(Uuid::new_v4()),
            session_id,
            actions: vec![BrowserAction::Navigate {
                url: "https://example.com".to_string(),
            }],
            created_at: Utc::now(),
            status: RunStatus::Queued,
        };

        state.create_goal(&goal).await.unwrap();
        let retrieved = state.get_goal(goal.id.as_uuid()).await.unwrap();

        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().actions.len(), 1);
    }
    #[tokio::test]
    async fn test_provider_registry_operations() {
        use tempfile::TempDir;
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");

        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .connect(&format!("sqlite:{}?mode=rwc", db_path.display()))
            .await
            .unwrap();

        // Run migrations
        sqlx::migrate!("../hexactra-control/migrations")
            .run(&pool)
            .await
            .unwrap();

        let state = DbState::new(pool);

        // Register a provider
        state
            .register_provider(
                "test-provider-1",
                "Test Provider",
                "human_interaction",
                r#"{"config_key": "value"}"#,
            )
            .await
            .unwrap();

        // Get the provider
        let provider = state.get_provider("test-provider-1").await.unwrap();
        assert!(provider.is_some());
        let provider = provider.unwrap();
        assert_eq!(provider.name, "Test Provider");
        assert!(provider.enabled);
        assert_eq!(provider.health_status, ProviderHealth::NotConfigured);

        // List all providers
        let providers = state.list_providers().await.unwrap();
        assert_eq!(providers.len(), 1);

        // Update health status
        state
            .update_provider_health("test-provider-1", ProviderHealth::Healthy)
            .await
            .unwrap();

        let provider = state
            .get_provider("test-provider-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(provider.health_status, ProviderHealth::Healthy);

        // Disable the provider
        state
            .set_provider_enabled("test-provider-1", false)
            .await
            .unwrap();

        let provider = state
            .get_provider("test-provider-1")
            .await
            .unwrap()
            .unwrap();
        assert!(!provider.enabled);

        // Delete the provider
        let deleted = state.delete_provider("test-provider-1").await.unwrap();
        assert_eq!(deleted, 1);

        // Verify deletion
        let provider = state.get_provider("test-provider-1").await.unwrap();
        assert!(provider.is_none());
    }

    #[tokio::test]
    async fn test_provider_registry_duplicate() {
        use tempfile::TempDir;
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");

        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .connect(&format!("sqlite:{}?mode=rwc", db_path.display()))
            .await
            .unwrap();

        // Run migrations
        sqlx::migrate!("../hexactra-control/migrations")
            .run(&pool)
            .await
            .unwrap();

        let state = DbState::new(pool);

        // Register a provider
        state
            .register_provider(
                "test-provider-2",
                "Test Provider 2",
                "credential",
                r#"{"config_key": "value"}"#,
            )
            .await
            .unwrap();

        // Try to register with same ID (should fail due to primary key)
        let result = state
            .register_provider(
                "test-provider-2",
                "Duplicate Provider",
                "notification",
                r#"{"config_key": "value"}"#,
            )
            .await;

        assert!(result.is_err());
    }
}
