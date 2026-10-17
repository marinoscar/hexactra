//! State management for Hexactra control plane
//!
//! This module provides typed storage operations using SQLite.

use anyhow::Result;
use chrono::{DateTime, Utc};
use sqlx::{Row, Sqlite};
use std::sync::Arc;
use uuid::Uuid;

use hexactra_core::{
    BrowserAction, Capability, Goal, Host, HostId, HostStatus, InteractionKind,
    InteractionRequestId, InteractionRequest, InteractionStatus, Lease, LeaseId, Operation,
    OperationStatus, Profile, RunStatus, Session, SessionStatus,
};

/// Passkey challenge information
#[derive(Debug, Clone)]
pub struct PasskeyChallengeInfo {
    pub request_id: Uuid,
    pub rp_entity_name: String,
    pub user_id: String,
    pub timeout_seconds: u32,
    pub attestation_types: Vec<String>,
    pub expires_at: DateTime<Utc>,
}

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

    pub async fn list_operations_by_status(&self, status: OperationStatus) -> Result<Vec<Operation>> {
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

    pub async fn get_active_lease(&self, resource_type: &str, resource_id: &Uuid) -> Result<Option<Lease>> {
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

    // ==================== Interaction Request Operations ====================

    pub async fn create_interaction_request(
        &self,
        request: &InteractionRequest,
    ) -> Result<()> {
        let pool = self.pool.clone();
        let details_json = serde_json::to_value(&request.details)?;
        sqlx::query(
            r#"
            INSERT INTO interaction_requests (id, session_id, reason, details, created_at, status, kind, expires_at, owner_id, origin_session_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(request.id.as_uuid().to_string())
        .bind(request.session_id.as_uuid().to_string())
        .bind(&request.reason)
        .bind(details_json.to_string())
        .bind(request.created_at.to_rfc3339())
        .bind(request.status.as_str_name())
        .bind(request.kind.as_str_name())
        .bind(request.expires_at.to_rfc3339())
        .bind(request.owner_id.map(|id| id.to_string()))
        .bind(request.origin_session_id.to_string())
        .execute(&*pool)
        .await?;

        Ok(())
    }

    pub async fn get_interaction_request(
        &self,
        id: Uuid,
    ) -> Result<Option<InteractionRequest>> {
        let pool = self.pool.clone();
        let row = sqlx::query(
            r#"
            SELECT 
                id,
                session_id,
                reason,
                details,
                created_at,
                status,
                kind,
                expires_at,
                owner_id,
                origin_session_id
            FROM interaction_requests
            WHERE id = ?
            "#,
        )
        .bind(id.to_string())
        .fetch_optional(&*pool)
        .await?;

        if let Some(row) = row {
            let mut request = InteractionRequest {
                id: Uuid::parse_str(&row.get::<String, _>(0))?.into(),
                session_id: Uuid::parse_str(&row.get::<String, _>(1))?.into(),
                reason: row.get::<String, _>(2),
                details: serde_json::Value::Null,
                created_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(4).into(),
                    Utc,
                ),
                status: InteractionStatus::from_str_name(&row.get::<String, _>(5)),
                kind: InteractionKind::from_str_name(&row.get::<String, _>(6)),
                expires_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(7).into(),
                    Utc,
                ),
                owner_id: row.get::<Option<String>, _>(8).and_then(|s| Uuid::parse_str(&s).ok()),
                origin_session_id: Uuid::parse_str(&row.get::<String, _>(9))?,
                policy: hexactra_core::InteractionPolicy {
                    approval_level: hexactra_core::ApprovalLevel::Standard,
                    verify_origin: false,
                    max_retries: 3,
                },
            };
            request.details = serde_json::from_str(&row.get::<String, _>(3))?;
            Ok(Some(request))
        } else {
            Ok(None)
        }
    }

    pub async fn update_interaction_request_status(
        &self,
        id: Uuid,
        status: InteractionStatus,
    ) -> Result<()> {
        let pool = self.pool.clone();
        sqlx::query(
            r#"
            UPDATE interaction_requests 
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

    pub async fn list_interaction_requests_by_session(
        &self,
        session_id: Uuid,
    ) -> Result<Vec<InteractionRequest>> {
        let pool = self.pool.clone();
        let rows = sqlx::query(
            r#"
            SELECT 
                id,
                session_id,
                reason,
                details,
                created_at,
                status,
                kind,
                expires_at,
                owner_id,
                origin_session_id
            FROM interaction_requests
            WHERE session_id = ?
            ORDER BY created_at DESC
            "#,
        )
        .bind(session_id.to_string())
        .fetch_all(&*pool)
        .await?;

        let mut requests = Vec::new();
        for row in rows {
            let mut request = InteractionRequest {
                id: Uuid::parse_str(&row.get::<String, _>(0))?.into(),
                session_id: Uuid::parse_str(&row.get::<String, _>(1))?.into(),
                reason: row.get::<String, _>(2),
                details: serde_json::Value::Null,
                created_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(4).into(),
                    Utc,
                ),
                status: InteractionStatus::from_str_name(&row.get::<String, _>(5)),
                kind: InteractionKind::from_str_name(&row.get::<String, _>(6)),
                expires_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(7).into(),
                    Utc,
                ),
                owner_id: row.get::<Option<String>, _>(8).and_then(|s| Uuid::parse_str(&s).ok()),
                origin_session_id: Uuid::parse_str(&row.get::<String, _>(9))?,
                policy: hexactra_core::InteractionPolicy {
                    approval_level: hexactra_core::ApprovalLevel::Standard,
                    verify_origin: false,
                    max_retries: 3,
                },
            };
            request.details = serde_json::from_str(&row.get::<String, _>(3))?;
            requests.push(request);
        }

        Ok(requests)
    }

    // ==================== OOB Confirmation Operations ====================

    /// Store OOB verification channel info
    pub async fn create_oob_channel(
        &self,
        channel_id: &str,
        verification_code: &str,
        request_id: Uuid,
        expires_at: DateTime<Utc>,
    ) -> Result<()> {
        let pool = self.pool.clone();
        sqlx::query(
            r#"
            INSERT INTO oob_channels (channel_id, verification_code, request_id, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?)
            "#,
        )
        .bind(channel_id)
        .bind(verification_code)
        .bind(request_id.to_string())
        .bind(expires_at.to_rfc3339())
        .bind(Utc::now().to_rfc3339())
        .execute(&*pool)
        .await?;

        Ok(())
    }

    /// Verify OOB channel and return the associated request ID
    pub async fn verify_oob_channel(
        &self,
        channel_id: &str,
        verification_code: &str,
    ) -> Result<Option<Uuid>> {
        let pool = self.pool.clone();
        let row = sqlx::query(
            r#"
            SELECT request_id, expires_at FROM oob_channels 
            WHERE channel_id = ? AND verification_code = ?
            "#,
        )
        .bind(channel_id)
        .bind(verification_code)
        .fetch_optional(&*pool)
        .await?;

        if let Some(row) = row {
            let request_id: String = row.get(0);
            let expires_at: chrono::NaiveDateTime = row.get(1);

            // Check if not expired
            if Utc::now().naive_utc() < expires_at {
                return Ok(Some(Uuid::parse_str(&request_id)?));
            }
        }

        Ok(None)
    }

    /// Delete OOB channel after verification
    pub async fn delete_oob_channel(&self, channel_id: &str) -> Result<u64> {
        let pool = self.pool.clone();
        let result = sqlx::query(
            r#"
            DELETE FROM oob_channels WHERE channel_id = ?
            "#,
        )
        .bind(channel_id)
        .execute(&*pool)
        .await?;

        Ok(result.rows_affected())
    }

    // ==================== Passkey Operations ====================

    /// Store passkey challenge
    pub async fn create_passkey_challenge(
        &self,
        challenge_id: &str,
        request_id: Uuid,
        rp_entity_name: &str,
        user_id: &str,
        timeout_seconds: u32,
        attestation_types: &[String],
        expires_at: DateTime<Utc>,
    ) -> Result<()> {
        let pool = self.pool.clone();
        let attestation_json = serde_json::to_value(attestation_types)?;
        sqlx::query(
            r#"
            INSERT INTO passkey_challenges (challenge_id, request_id, rp_entity_name, user_id, timeout_seconds, attestation_types, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(challenge_id)
        .bind(request_id.to_string())
        .bind(rp_entity_name)
        .bind(user_id)
        .bind(timeout_seconds.to_string())
        .bind(attestation_json.to_string())
        .bind(expires_at.to_rfc3339())
        .bind(Utc::now().to_rfc3339())
        .execute(&*pool)
        .await?;

        Ok(())
    }

    /// Get passkey challenge by ID
    pub async fn get_passkey_challenge(
        &self,
        challenge_id: &str,
    ) -> Result<Option<PasskeyChallengeInfo>> {
        let pool = self.pool.clone();
        let row = sqlx::query(
            r#"
            SELECT request_id, rp_entity_name, user_id, timeout_seconds, attestation_types, expires_at
            FROM passkey_challenges
            WHERE challenge_id = ?
            "#,
        )
        .bind(challenge_id)
        .fetch_optional(&*pool)
        .await?;

        if let Some(row) = row {
            let request_id_str: String = row.get(0);
            let rp_entity_name: String = row.get(1);
            let user_id: String = row.get(2);
            let timeout_seconds_str: String = row.get(3);
            let attestation_json: String = row.get(4);
            let expires_at: chrono::NaiveDateTime = row.get(5);

            let attestation_types: Vec<String> = serde_json::from_str(&attestation_json)?;

            return Ok(Some(PasskeyChallengeInfo {
                request_id: Uuid::parse_str(&request_id_str)?,
                rp_entity_name,
                user_id,
                timeout_seconds: timeout_seconds_str.parse().unwrap_or(60),
                attestation_types,
                expires_at: DateTime::<Utc>::from_utc(expires_at.into(), Utc),
            }));
        }

        Ok(None)
    }

    /// Delete passkey challenge after verification
    pub async fn delete_passkey_challenge(&self, challenge_id: &str) -> Result<u64> {
        let pool = self.pool.clone();
        let result = sqlx::query(
            r#"
            DELETE FROM passkey_challenges WHERE challenge_id = ?
            "#,
        )
        .bind(challenge_id)
        .execute(&*pool)
        .await?;

        Ok(result.rows_affected())
    }

    // ==================== HITL Broker Operations ====================

    /// Claim an interaction request (single-claim semantics)
    /// Returns error if already claimed by another owner
    pub async fn claim_interaction_request(
        &self,
        request_id: Uuid,
        owner_id: Uuid,
    ) -> Result<bool> {
        let pool = self.pool.clone();
        let result = sqlx::query(
            r#"
            UPDATE interaction_requests 
            SET owner_id = ?, updated_at = datetime('now')
            WHERE id = ? AND owner_id IS NULL
            "#,
        )
        .bind(owner_id.to_string())
        .bind(request_id.to_string())
        .execute(&*pool)
        .await?;

        Ok(result.rows_affected() > 0)
    }

    /// Respond to an interaction request (approve/reject/expired/cancelled)
    pub async fn respond_interaction_request(
        &self,
        request_id: Uuid,
        new_status: InteractionStatus,
        owner_id: Uuid,
    ) -> Result<bool> {
        let pool = self.pool.clone();
        
        // Verify the response is coming from the owner
        let existing = sqlx::query(
            r#"
            SELECT owner_id FROM interaction_requests WHERE id = ?
            "#,
        )
        .bind(request_id.to_string())
        .fetch_optional(&*pool)
        .await?;

        if let Some(row) = existing {
            let stored_owner: Option<String> = row.get(0);
            if stored_owner != Some(owner_id.to_string()) {
                return Ok(false); // Owner mismatch
            }
        } else {
            return Ok(false); // Request not found
        }

        let result = sqlx::query(
            r#"
            UPDATE interaction_requests 
            SET status = ?, updated_at = datetime('now')
            WHERE id = ? AND status = 'pending'
            "#,
        )
        .bind(new_status.as_str_name())
        .bind(request_id.to_string())
        .execute(&*pool)
        .await?;

        Ok(result.rows_affected() > 0)
    }

    /// Check if an interaction request has expired
    pub async fn is_interaction_request_expired(&self, request_id: Uuid) -> Result<bool> {
        let pool = self.pool.clone();
        let row = sqlx::query(
            r#"
            SELECT expires_at, status FROM interaction_requests WHERE id = ?
            "#,
        )
        .bind(request_id.to_string())
        .fetch_optional(&*pool)
        .await?;

        if let Some(row) = row {
            let expires_at: chrono::NaiveDateTime = row.get(0);
            let status: String = row.get(1);
            
            // Check if expired and still pending
            let is_expired = Utc::now().naive_utc() > expires_at;
            let is_pending = status == "pending";
            
            Ok(is_expired && is_pending)
        } else {
            Ok(false) // Request not found
        }
    }

    /// Expire all pending requests that have passed their expiry time
    pub async fn expire_pending_requests(&self) -> Result<u64> {
        let pool = self.pool.clone();
        let result = sqlx::query(
            r#"
            UPDATE interaction_requests 
            SET status = 'expired', updated_at = datetime('now')
            WHERE status = 'pending' AND expires_at < datetime('now')
            "#,
        )
        .execute(&*pool)
        .await?;

        Ok(result.rows_affected() as u64)
    }

    /// Get all pending interaction requests for a session (including expired ones for recovery)
    pub async fn get_pending_interaction_requests(
        &self,
        session_id: Uuid,
    ) -> Result<Vec<InteractionRequest>> {
        let pool = self.pool.clone();
        let rows = sqlx::query(
            r#"
            SELECT 
                id,
                session_id,
                reason,
                details,
                created_at,
                status,
                kind,
                expires_at,
                owner_id,
                origin_session_id
            FROM interaction_requests
            WHERE session_id = ? AND status IN ('pending', 'expired')
            ORDER BY created_at DESC
            "#,
        )
        .bind(session_id.to_string())
        .fetch_all(&*pool)
        .await?;

        let mut requests = Vec::new();
        for row in rows {
            let mut request = InteractionRequest {
                id: Uuid::parse_str(&row.get::<String, _>(0))?.into(),
                session_id: Uuid::parse_str(&row.get::<String, _>(1))?.into(),
                reason: row.get::<String, _>(2),
                details: serde_json::Value::Null,
                created_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(4).into(),
                    Utc,
                ),
                status: InteractionStatus::from_str_name(&row.get::<String, _>(5)),
                kind: InteractionKind::from_str_name(&row.get::<String, _>(6)),
                expires_at: DateTime::<Utc>::from_utc(
                    row.get::<chrono::NaiveDateTime, _>(7).into(),
                    Utc,
                ),
                owner_id: row.get::<Option<String>, _>(8).and_then(|s| Uuid::parse_str(&s).ok()),
                origin_session_id: Uuid::parse_str(&row.get::<String, _>(9))?,
                policy: hexactra_core::InteractionPolicy {
                    approval_level: hexactra_core::ApprovalLevel::Standard,
                    verify_origin: false,
                    max_retries: 3,
                },
            };
            request.details = serde_json::from_str(&row.get::<String, _>(3))?;
            requests.push(request);
        }

        Ok(requests)
    }

    /// Clear owner when response is consumed (single-claim/consume semantics)
    pub async fn consume_interaction_claim(&self, request_id: Uuid) -> Result<bool> {
        let pool = self.pool.clone();
        let result = sqlx::query(
            r#"
            UPDATE interaction_requests 
            SET owner_id = NULL, updated_at = datetime('now')
            WHERE id = ?
            "#,
        )
        .bind(request_id.to_string())
        .execute(&*pool)
        .await?;

        Ok(result.rows_affected() > 0)
    }

    /// Create a new interaction request with expiry
    pub async fn create_interaction_request_with_expiry(
        &self,
        request: &InteractionRequest,
        ttl_minutes: i64,
    ) -> Result<()> {
        let pool = self.pool.clone();
        let details_json = serde_json::to_value(&request.details)?;
        
        // Calculate expiry time
        let expires_at = Utc::now() + chrono::Duration::minutes(ttl_minutes);
        
        sqlx::query(
            r#"
            INSERT INTO interaction_requests (id, session_id, reason, details, created_at, status, kind, expires_at, owner_id, origin_session_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(request.id.as_uuid().to_string())
        .bind(request.session_id.as_uuid().to_string())
        .bind(&request.reason)
        .bind(details_json.to_string())
        .bind(request.created_at.to_rfc3339())
        .bind(request.status.as_str_name())
        .bind(request.kind.as_str_name())
        .bind(expires_at.to_rfc3339())
        .bind(request.owner_id.map(|id| id.to_string()))
        .bind(request.origin_session_id.to_string())
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
    use tempfile::TempDir;
    use hexactra_core::{GoalId, SessionId};

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
    async fn test_hitl_broker_create_and_get() {
        let state = setup_test_db().await;

        // Create a profile and session first
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

        let request = InteractionRequest {
            id: InteractionRequestId::from_uuid(Uuid::new_v4()),
            session_id: session.id,
            reason: "Test OTP request".to_string(),
            details: serde_json::json!({"type": "otp"}),
            created_at: Utc::now(),
            kind: InteractionKind::OtpCode,
            status: InteractionStatus::Pending,
            expires_at: Utc::now() + chrono::Duration::minutes(15),
            owner_id: None,
            origin_session_id: session.id.as_uuid(),
            policy: hexactra_core::InteractionPolicy {
                approval_level: hexactra_core::ApprovalLevel::Standard,
                verify_origin: false,
                max_retries: 3,
            },
        };
        

        state.create_interaction_request(&request).await.unwrap();
        let retrieved = state.get_interaction_request(request.id.as_uuid()).await.unwrap();

        assert!(retrieved.is_some());
        let retrieved = retrieved.unwrap();
        assert_eq!(retrieved.kind, InteractionKind::OtpCode);
        assert_eq!(retrieved.status, InteractionStatus::Pending);
    }

    #[tokio::test]
    async fn test_hitl_broker_claim_single_owner() {
        let state = setup_test_db().await;

        // Create a profile and session first
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

        let request = InteractionRequest {
            id: InteractionRequestId::from_uuid(Uuid::new_v4()),
            session_id: session.id,
            reason: "Test claim".to_string(),
            details: serde_json::json!({}),
            created_at: Utc::now(),
            kind: InteractionKind::ActionApproval,
            status: InteractionStatus::Pending,
            expires_at: Utc::now() + chrono::Duration::minutes(15),
            owner_id: None,
            origin_session_id: session.id.as_uuid(),
            policy: hexactra_core::InteractionPolicy {
                approval_level: hexactra_core::ApprovalLevel::Standard,
                verify_origin: false,
                max_retries: 3,
            },
        };
        

        state.create_interaction_request(&request).await.unwrap();

        // First claim should succeed
        let owner1 = Uuid::new_v4();
        assert!(state.claim_interaction_request(request.id.as_uuid(), owner1).await.unwrap());

        // Second claim should fail (single-claim semantics)
        let owner2 = Uuid::new_v4();
        assert!(!state.claim_interaction_request(request.id.as_uuid(), owner2).await.unwrap());
    }

    #[tokio::test]
    async fn test_hitl_broker_respond_with_owner_check() {
        let state = setup_test_db().await;

        // Create a profile and session first
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

        let request = InteractionRequest {
            id: InteractionRequestId::from_uuid(Uuid::new_v4()),
            session_id: session.id,
            reason: "Test respond".to_string(),
            details: serde_json::json!({}),
            created_at: Utc::now(),
            kind: InteractionKind::OtpCode,
            status: InteractionStatus::Pending,
            expires_at: Utc::now() + chrono::Duration::minutes(15),
            owner_id: None,
            origin_session_id: session.id.as_uuid(),
            policy: hexactra_core::InteractionPolicy {
                approval_level: hexactra_core::ApprovalLevel::Standard,
                verify_origin: false,
                max_retries: 3,
            },
        };
        

        state.create_interaction_request(&request).await.unwrap();

        // Claim the request
        let owner = Uuid::new_v4();
        assert!(state.claim_interaction_request(request.id.as_uuid(), owner).await.unwrap());

        // Respond with correct owner should succeed
        assert!(state
            .respond_interaction_request(request.id.as_uuid(), InteractionStatus::Approved, owner)
            .await
            .unwrap());

        // Verify status changed
        let retrieved = state.get_interaction_request(request.id.as_uuid()).await.unwrap();
        assert_eq!(retrieved.unwrap().status, InteractionStatus::Approved);
    }

    #[tokio::test]
    async fn test_hitl_broker_expiry() {
        use chrono::Duration;
        let state = setup_test_db().await;

        // Create a profile and session first
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

        // Create request that expired 1 minute ago
        let past_time = Utc::now() - Duration::minutes(1);
        let request = InteractionRequest {
            id: InteractionRequestId::from_uuid(Uuid::new_v4()),
            session_id: session.id,
            reason: "Test expiry".to_string(),
            details: serde_json::json!({}),
            created_at: past_time,
            kind: InteractionKind::OtpCode,
            status: InteractionStatus::Pending,
            expires_at: past_time + Duration::minutes(5), // Expired 1 minute ago
            owner_id: None,
            origin_session_id: session.id.as_uuid(),
            policy: hexactra_core::InteractionPolicy {
                approval_level: hexactra_core::ApprovalLevel::Standard,
                verify_origin: false,
                max_retries: 3,
            },
        };
        

        state.create_interaction_request(&request).await.unwrap();

        // Manually set expiry in the past for testing
        let pool = state.pool.clone();
        sqlx::query("UPDATE interaction_requests SET expires_at = datetime('now', '-1 minute')")
            .execute(&*pool)
            .await
            .unwrap();

        // Expire pending requests
        let expired_count = state.expire_pending_requests().await.unwrap();
        assert!(expired_count > 0);

        // Verify status changed to expired
        let retrieved = state.get_interaction_request(request.id.as_uuid()).await.unwrap();
        assert_eq!(retrieved.unwrap().status, InteractionStatus::Expired);
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

        let provider = state.get_provider("test-provider-1").await.unwrap().unwrap();
        assert_eq!(provider.health_status, ProviderHealth::Healthy);

        // Disable the provider
        state.set_provider_enabled("test-provider-1", false).await.unwrap();

        let provider = state.get_provider("test-provider-1").await.unwrap().unwrap();
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
