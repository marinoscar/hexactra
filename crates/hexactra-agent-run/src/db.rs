//! SQLite database for agent runs

use super::*;
use anyhow::Context;
use rusqlite::{Connection, params};
use std::path::Path;

/// Database connection wrapper
pub struct DbConnection {
    conn: Connection,
}

impl DbConnection {
    /// Create a new database connection
    pub fn new(db_path: &str) -> Result<Self> {
        let path = Path::new(db_path);
        
        // Create parent directories if they don't exist
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("Failed to create database directory: {}", parent.display()))?;
        }

        let conn = Connection::open(db_path)
            .with_context(|| format!("Failed to open database at: {}", db_path))?;

        let mut db = Self { conn };
        db.init_schema()?;
        Ok(db)
    }

    /// Initialize the database schema
    fn init_schema(&mut self) -> Result<()> {
        self.conn.execute_batch(SCHEMA)?;
        Ok(())
    }

    /// Insert a new run record
    pub fn insert_run(&self, record: &RunRecord) -> Result<()> {
        let status_str = record.status.as_str_name();
        
        self.conn.execute(
            r#"
            INSERT INTO agent_runs (
                id, session_id, owner_id, status, config, created_at,
                started_at, completed_at, paused_at, last_heartbeat,
                step_count, total_tokens, error_message
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            "#,
            params![
                record.id.as_uuid().to_string(),
                record.session_id.to_string(),
                record.owner_id.to_string(),
                status_str,
                serde_json::to_string(&record.config)?,
                record.created_at.to_rfc3339(),
                record.started_at.map(|t| t.to_rfc3339()),
                record.completed_at.map(|t| t.to_rfc3339()),
                record.paused_at.map(|t| t.to_rfc3339()),
                record.last_heartbeat.to_rfc3339(),
                record.step_count,
                record.total_tokens,
                record.error_message,
            ],
        )?;

        Ok(())
    }

    /// Get a run by ID
    pub fn get_run(&self, id: AgentRunId) -> Result<Option<RunRecord>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT id, session_id, owner_id, status, config, created_at,
                   started_at, completed_at, paused_at, last_heartbeat,
                   step_count, total_tokens, error_message
            FROM agent_runs WHERE id = ?1
            "#,
        )?;

        let record_opt = match stmt.query_row(params![id.as_uuid().to_string()], |row| {
            self.deserialize_run(row)
        }) {
            Ok(record) => Some(record),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(e) => return Err(anyhow::Error::new(e).into()),
        };

        Ok(record_opt)
    }

    /// Update run status
    pub fn update_status(&self, id: AgentRunId, status: RunStatus) -> Result<Option<RunRecord>> {
        let current = self.get_run(id)?;
        
        if let Some(mut record) = current {
            record.status = status;
            record.last_heartbeat = Utc::now();

            let status_str = record.status.as_str_name();
            
            self.conn.execute(
                "UPDATE agent_runs SET status = ?1, last_heartbeat = ?2 WHERE id = ?3",
                params![status_str, record.last_heartbeat.to_rfc3339(), record.id.as_uuid().to_string()],
            )?;

            Ok(Some(record))
        } else {
            Ok(None)
        }
    }

    /// Record a step completion
    pub fn record_step(&self, id: AgentRunId, result: StepResult) -> Result<Option<RunRecord>> {
        let current = self.get_run(id)?;
        
        if let Some(mut record) = current {
            record.step_count += 1;
            record.total_tokens += result.model_response.len() as u64 / 4; // Approximate token count
            record.last_heartbeat = Utc::now();

            self.conn.execute(
                "UPDATE agent_runs SET step_count = ?1, total_tokens = ?2, last_heartbeat = ?3 WHERE id = ?4",
                params![
                    record.step_count,
                    record.total_tokens,
                    record.last_heartbeat.to_rfc3339(),
                    record.id.as_uuid().to_string()
                ],
            )?;

            Ok(Some(record))
        } else {
            Ok(None)
        }
    }

    /// Get all runs for a session
    pub fn get_session_runs(&self, session_id: Uuid) -> Result<Vec<RunRecord>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT id, session_id, owner_id, status, config, created_at,
                   started_at, completed_at, paused_at, last_heartbeat,
                   step_count, total_tokens, error_message
            FROM agent_runs WHERE session_id = ?1 ORDER BY created_at DESC
            "#,
        )?;

        let mut records = Vec::new();
        let mut rows = stmt.query(params![session_id.to_string()])?;
        
        while let Some(row) = rows.next()? {
            match self.deserialize_run(row) {
                Ok(record) => records.push(record),
                Err(e) => return Err(anyhow::Error::new(e).into()),
            }
        }

        Ok(records)
    }

    /// Reconcile incomplete runs after restart
    pub fn reconcile_incomplete_runs(&self) -> Result<Vec<RunRecord>> {
        let conn = &self.conn;
        let mut stmt = conn.prepare(
            r#"
            SELECT id, session_id, owner_id, status, config, created_at,
                   started_at, completed_at, paused_at, last_heartbeat,
                   step_count, total_tokens, error_message
            FROM agent_runs WHERE status IN (?1, ?2)
            "#,
        )?;

        let mut records = Vec::new();
        let mut rows = stmt.query(params![RunStatus::Running.as_str_name(), RunStatus::Paused.as_str_name()])?;
        
        while let Some(row) = rows.next()? {
            match self.deserialize_run(row) {
                Ok(record) => records.push(record),
                Err(e) => return Err(anyhow::Error::new(e).into()),
            }
        }

        // Mark incomplete runs as failed (safe default)
        for record in &records {
            let _ = self.update_status(record.id, RunStatus::Failed);
        }

        Ok(records)
    }

    /// Deserialize a run record from database rows
    fn deserialize_run(&self, row: &rusqlite::Row) -> rusqlite::Result<RunRecord> {
        let id_str: String = row.get(0)?;
        let session_id_str: String = row.get(1)?;
        let owner_id_str: String = row.get(2)?;
        let status_str: String = row.get(3)?;
        let config_json: String = row.get(4)?;
        let created_at_str: String = row.get(5)?;
        let started_at_opt: Option<String> = row.get(6)?;
        let completed_at_opt: Option<String> = row.get(7)?;
        let paused_at_opt: Option<String> = row.get(8)?;
        let last_heartbeat_str: String = row.get(9)?;
        let step_count: u32 = row.get(10)?;
        let total_tokens: u64 = row.get(11)?;
        let error_message: Option<String> = row.get(12)?;

        let id_uuid = match Uuid::parse_str(&id_str) {
            Ok(id) => id,
            Err(e) => return Err(rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))),
        };
        let session_uuid = match Uuid::parse_str(&session_id_str) {
            Ok(id) => id,
            Err(e) => return Err(rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Text, Box::new(e))),
        };
        let owner_uuid = match Uuid::parse_str(&owner_id_str) {
            Ok(id) => id,
            Err(e) => return Err(rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(e))),
        };

        let config = match serde_json::from_str(&config_json) {
            Ok(c) => c,
            Err(e) => return Err(rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(e))),
        };

        // Parse datetime - use parse_from_rfc3339 which handles the Z suffix
        let created_at = DateTime::parse_from_rfc3339(&created_at_str)
            .map_err(|e| rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(e))).unwrap().with_timezone(&Utc);

        let started_at = started_at_opt.as_ref().map(|s| {
            DateTime::parse_from_rfc3339(s)
                .map_err(|e| rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(e))).unwrap().with_timezone(&Utc)
        });

        let completed_at = completed_at_opt.as_ref().map(|s| {
            DateTime::parse_from_rfc3339(s)
                .map_err(|e| rusqlite::Error::FromSqlConversionFailure(7, rusqlite::types::Type::Text, Box::new(e))).unwrap().with_timezone(&Utc)
        });

        let paused_at = paused_at_opt.as_ref().map(|s| {
            DateTime::parse_from_rfc3339(s)
                .map_err(|e| rusqlite::Error::FromSqlConversionFailure(8, rusqlite::types::Type::Text, Box::new(e))).unwrap().with_timezone(&Utc)
        });

        let last_heartbeat = DateTime::parse_from_rfc3339(&last_heartbeat_str)
            .map_err(|e| rusqlite::Error::FromSqlConversionFailure(9, rusqlite::types::Type::Text, Box::new(e))).unwrap().with_timezone(&Utc);

        Ok(RunRecord {
            id: AgentRunId::from_uuid(id_uuid),
            session_id: session_uuid,
            owner_id: owner_uuid,
            status: RunStatus::from_str_name(&status_str),
            config,
            created_at,
            started_at,
            completed_at,
            paused_at,
            last_heartbeat,
            step_count,
            total_tokens,
            error_message,
        })
    }
}

impl Drop for DbConnection {
    fn drop(&mut self) {
        // Connection is automatically closed when dropped
        // rusqlite's Connection doesn't have a close method that takes ownership
    }
}

/// Database schema
const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
    config TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    paused_at TEXT,
    last_heartbeat TEXT NOT NULL,
    step_count INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_db_connection() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");
        
        let conn = DbConnection::new(db_path.to_str().unwrap());
        assert!(conn.is_ok());
    }

    #[test]
    fn test_insert_and_get_run() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");
        
        let conn = DbConnection::new(db_path.to_str().unwrap()).unwrap();
        
        let record = RunRecord {
            id: AgentRunId::new(),
            session_id: Uuid::new_v4(),
            owner_id: Uuid::new_v4(),
            status: RunStatus::Queued,
            config: RunConfig::default(),
            created_at: Utc::now(),
            started_at: None,
            completed_at: None,
            paused_at: None,
            last_heartbeat: Utc::now(),
            step_count: 0,
            total_tokens: 0,
            error_message: None,
        };

        conn.insert_run(&record).unwrap();
        
        // Get the record by ID
        let retrieved = conn.get_run(record.id);
        assert!(retrieved.is_ok(), "Failed to get run: {:?}", retrieved.err());
        let retrieved = retrieved.unwrap();
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().id, record.id);
    }
}
