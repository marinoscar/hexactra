//! State management for Hexactra control plane
//!
//! This module provides typed storage operations using SQLite.

use anyhow::Result;
use chrono::{DateTime, Utc};
use sqlx::{Row, Sqlite};
use std::sync::Arc;
use uuid::Uuid;

use hexactra_core::{
    BrowserAction, Capability, Goal, Host, HostId, HostStatus, InteractionRequest,
    InteractionStatus, Operation, OperationStatus, Profile, RunStatus, Session, SessionStatus,
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

    // ==================== Interaction Request Operations ====================

    pub async fn create_interaction_request(
        &self,
        request: &InteractionRequest,
    ) -> Result<()> {
        let pool = self.pool.clone();
        let details_json = serde_json::to_value(&request.details)?;
        sqlx::query(
            r#"
            INSERT INTO interaction_requests (id, session_id, reason, details, created_at, status)
            VALUES (?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(request.id.as_uuid().to_string())
        .bind(request.session_id.as_uuid().to_string())
        .bind(&request.reason)
        .bind(details_json.to_string())
        .bind(request.created_at.to_rfc3339())
        .bind(request.status.as_str_name())
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
                status
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
                status
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
            };
            request.details = serde_json::from_str(&row.get::<String, _>(3))?;
            requests.push(request);
        }

        Ok(requests)
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
}
