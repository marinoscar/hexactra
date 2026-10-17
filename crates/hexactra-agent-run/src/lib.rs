//! Durable agent-run state machine for Hexactra
//!
//! This crate provides:
//! - Agent-run state machine with states (Queued, Running, Paused, Cancelled, Completed, Failed)
//! - SQLite-based durability with checkpoints
//! - Run ownership and policy management
//! - Progress event stream
//! - Safe restart reconciliation

pub mod state;
pub mod db;
pub mod policy;

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;
use tracing::info;

/// Unique identifier for an agent run
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AgentRunId(Uuid);

impl AgentRunId {
    pub fn new() -> Self {
        AgentRunId(Uuid::new_v4())
    }

    pub fn from_uuid(uuid: Uuid) -> Self {
        AgentRunId(uuid)
    }

    pub fn as_uuid(&self) -> Uuid {
        self.0
    }
}

impl Default for AgentRunId {
    fn default() -> Self {
        Self::new()
    }
}

impl From<AgentRunId> for Uuid {
    fn from(id: AgentRunId) -> Self {
        id.0
    }
}

impl From<Uuid> for AgentRunId {
    fn from(uuid: Uuid) -> Self {
        AgentRunId::from_uuid(uuid)
    }
}

/// Status of an agent run
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    /// Run is queued and waiting for execution
    Queued,
    /// Run is currently being executed
    Running,
    /// Run is paused by user or policy
    Paused,
    /// Run completed successfully
    Completed,
    /// Run failed during execution
    Failed,
    /// Run was cancelled
    Cancelled,
}

impl RunStatus {
    pub fn as_str_name(&self) -> &'static str {
        match self {
            RunStatus::Queued => "queued",
            RunStatus::Running => "running",
            RunStatus::Paused => "paused",
            RunStatus::Completed => "completed",
            RunStatus::Failed => "failed",
            RunStatus::Cancelled => "cancelled",
        }
    }

    pub fn from_str_name(s: &str) -> Self {
        match s {
            "queued" => RunStatus::Queued,
            "running" => RunStatus::Running,
            "paused" => RunStatus::Paused,
            "completed" => RunStatus::Completed,
            "failed" => RunStatus::Failed,
            "cancelled" => RunStatus::Cancelled,
            _ => RunStatus::Queued,
        }
    }
}

/// Agent run configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunConfig {
    pub goal: String,
    pub model_id: String,
    pub max_steps: u32,
    pub timeout_seconds: u64,
    pub budget_tokens: Option<u32>,
    pub allowlist_domains: Vec<String>,
}

impl Default for RunConfig {
    fn default() -> Self {
        Self {
            goal: "".to_string(),
            model_id: "llama3".to_string(),
            max_steps: 100,
            timeout_seconds: 3600,
            budget_tokens: Some(100000),
            allowlist_domains: vec![],
        }
    }
}

/// Agent run record
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRecord {
    pub id: AgentRunId,
    pub session_id: Uuid,
    pub owner_id: Uuid,
    pub status: RunStatus,
    pub config: RunConfig,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub paused_at: Option<DateTime<Utc>>,
    pub last_heartbeat: DateTime<Utc>,
    pub step_count: u32,
    pub total_tokens: u64,
    pub error_message: Option<String>,
}

/// Agent run event
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum RunEvent {
    Created { record: RunRecord },
    Started { record: RunRecord },
    Paused { record: RunRecord },
    Resumed { record: RunRecord },
    StepCompleted { record: RunRecord, step_result: StepResult },
    Completed { record: RunRecord, final_result: serde_json::Value },
    Failed { record: RunRecord, error: String },
    Cancelled { record: RunRecord },
}

/// Step result from agent execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepResult {
    pub step_number: u32,
    pub action_taken: Option<String>,
    pub observation: String,
    pub reasoning: String,
    pub model_response: String,
}

/// Agent run manager
pub struct RunManager {
    db: db::DbConnection,
}

impl RunManager {
    pub fn new(db_path: &str) -> Result<Self> {
        let db = db::DbConnection::new(db_path)?;
        Ok(Self { db })
    }

    /// Start a new agent run
    pub async fn start_run(&self, config: RunConfig, session_id: Uuid, owner_id: Uuid) -> Result<RunRecord> {
        let record = RunRecord {
            id: AgentRunId::new(),
            session_id,
            owner_id,
            status: RunStatus::Queued,
            config,
            created_at: Utc::now(),
            started_at: None,
            completed_at: None,
            paused_at: None,
            last_heartbeat: Utc::now(),
            step_count: 0,
            total_tokens: 0,
            error_message: None,
        };

        self.db.insert_run(&record)?;
        info!("Created new agent run: {}", record.id.as_uuid());
        Ok(record)
    }

    /// Get a run by ID
    pub fn get_run(&self, id: AgentRunId) -> Result<Option<RunRecord>> {
        self.db.get_run(id)
    }

    /// Update run status
    pub fn update_status(&self, id: AgentRunId, status: RunStatus) -> Result<Option<RunRecord>> {
        self.db.update_status(id, status)
    }

    /// Record a step completion
    pub fn record_step(&self, id: AgentRunId, result: StepResult) -> Result<Option<RunRecord>> {
        self.db.record_step(id, result)
    }

    /// Get all runs for a session
    pub fn get_session_runs(&self, session_id: Uuid) -> Result<Vec<RunRecord>> {
        self.db.get_session_runs(session_id)
    }

    /// Reconcile runs after restart (find incomplete runs and mark them as unknown)
    pub fn reconcile(&self) -> Result<Vec<RunRecord>> {
        self.db.reconcile_incomplete_runs()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_agent_run_id_default() {
        let id = AgentRunId::default();
        assert!(id.as_uuid().get_version().is_some());
    }

    #[test]
    fn test_run_status_serialization() {
        let status = RunStatus::Running;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, "\"running\"");

        let status = RunStatus::Paused;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, "\"paused\"");
    }

    #[test]
    fn test_run_config_default() {
        let config = RunConfig::default();
        assert_eq!(config.max_steps, 100);
        assert_eq!(config.timeout_seconds, 3600);
    }
}
