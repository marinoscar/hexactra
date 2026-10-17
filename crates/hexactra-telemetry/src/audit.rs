//! Audit logging and provenance tracking for Hexactra

use anyhow::anyhow;
use chrono::{DateTime, Utc};
use rusqlite::{params, params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

/// Event types for audit logging
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AuditEventType {
    /// User authentication event
    Auth,
    /// Session lifecycle events
    Session,
    /// Browser action execution
    Action,
    /// Human-in-the-loop decision
    HITL,
    /// Credential provider interaction
    Credential,
    /// System takeover or cancellation
    Takeover,
}

impl AuditEventType {
    pub fn as_str_name(&self) -> &'static str {
        match self {
            AuditEventType::Auth => "auth",
            AuditEventType::Session => "session",
            AuditEventType::Action => "action",
            AuditEventType::HITL => "hitl",
            AuditEventType::Credential => "credential",
            AuditEventType::Takeover => "takeover",
        }
    }
}

/// Severity levels for audit events
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AuditSeverity {
    /// Informational event
    Info,
    /// Warning event
    Warning,
    /// Error event
    Error,
    /// Security-related event
    Security,
}

impl AuditSeverity {
    pub fn as_str_name(&self) -> &'static str {
        match self {
            AuditSeverity::Info => "info",
            AuditSeverity::Warning => "warning",
            AuditSeverity::Error => "error",
            AuditSeverity::Security => "security",
        }
    }
}

/// An audit event record
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEvent {
    /// Unique event ID
    pub id: Uuid,
    /// Event type
    #[serde(rename = "type")]
    pub event_type: AuditEventType,
    /// Severity level
    pub severity: AuditSeverity,
    /// Timestamp of the event
    pub timestamp: DateTime<Utc>,
    /// Principal (user/system) that triggered the event
    pub principal: String,
    /// Owner ID for scoping
    pub owner_id: Uuid,
    /// Session ID if applicable
    pub session_id: Option<Uuid>,
    /// Event details (redacted to exclude sensitive data)
    pub details: HashMap<String, serde_json::Value>,
    /// Correlation ID for tracing
    pub correlation_id: Option<Uuid>,
    /// IP address of the requester (if available)
    pub ip_address: Option<String>,
    /// User agent string (if available)
    pub user_agent: Option<String>,
}

impl AuditEvent {
    /// Create a new audit event
    pub fn new(
        event_type: AuditEventType,
        severity: AuditSeverity,
        principal: impl Into<String>,
        owner_id: Uuid,
    ) -> Self {
        Self {
            id: Uuid::new_v4(),
            event_type,
            severity,
            timestamp: Utc::now(),
            principal: principal.into(),
            owner_id,
            session_id: None,
            details: HashMap::new(),
            correlation_id: None,
            ip_address: None,
            user_agent: None,
        }
    }

    /// Set the session ID
    pub fn with_session_id(mut self, session_id: Uuid) -> Self {
        self.session_id = Some(session_id);
        self
    }

    /// Set the correlation ID
    pub fn with_correlation_id(mut self, correlation_id: Uuid) -> Self {
        self.correlation_id = Some(correlation_id);
        self
    }

    /// Set IP address
    pub fn with_ip_address(mut self, ip_address: impl Into<String>) -> Self {
        self.ip_address = Some(ip_address.into());
        self
    }

    /// Add a detail field (automatically redacts sensitive data)
    pub fn add_detail(mut self, key: impl Into<String>, value: serde_json::Value) -> Self {
        let key = key.into();
        let is_sensitive = ["password", "token", "secret", "key", "otp", "credential"]
            .iter()
            .any(|sk| key.to_lowercase().contains(sk));
        let redacted = if is_sensitive {
            serde_json::json!("[REDACTED]")
        } else {
            value.clone()
        };
        self.details.insert(key, redacted);
        self
    }
    pub fn auth(principal: impl Into<String>, owner_id: Uuid, success: bool) -> Self {
        let mut event = Self::new(
            AuditEventType::Auth,
            if success { AuditSeverity::Info } else { AuditSeverity::Security },
            principal,
            owner_id,
        );
        event.details.insert("success".to_string(), serde_json::json!(success));
        event
    }

    /// Create a session event
    pub fn session(
        principal: impl Into<String>,
        owner_id: Uuid,
        session_id: Uuid,
        action: impl Into<String>,
    ) -> Self {
        let mut event = Self::new(
            AuditEventType::Session,
            AuditSeverity::Info,
            principal,
            owner_id,
        );
        event.session_id = Some(session_id);
        event.details.insert("action".to_string(), serde_json::json!(action.into()));
        event
    }

    /// Create an action event
    pub fn action(
        principal: impl Into<String>,
        owner_id: Uuid,
        session_id: Uuid,
        action_type: impl Into<String>,
    ) -> Self {
        let mut event = Self::new(
            AuditEventType::Action,
            AuditSeverity::Info,
            principal,
            owner_id,
        );
        event.session_id = Some(session_id);
        event.details.insert("action_type".to_string(), serde_json::json!(action_type.into()));
        event
    }

    /// Create a HITL event
    pub fn hitl(
        principal: impl Into<String>,
        owner_id: Uuid,
        session_id: Uuid,
        decision: impl Into<String>,
    ) -> Self {
        let decision_str = decision.into();
        let mut event = Self::new(
            AuditEventType::HITL,
            if decision_str == "approved" { AuditSeverity::Info } else { AuditSeverity::Warning },
            principal,
            owner_id,
        );
        event.session_id = Some(session_id);
        event.details.insert("decision".to_string(), serde_json::json!(decision_str));
        event
    }
}

/// Audit store for persistent logging
#[derive(Debug)]
pub struct AuditStore {
    db_path: String,
}

impl AuditStore {
    /// Create a new audit store
    pub fn new(db_path: impl Into<String>) -> Self {
        Self {
            db_path: db_path.into(),
        }
    }

    /// Open or create the audit database
    pub fn open(&self) -> Result<AuditDb, anyhow::Error> {
        AuditDb::new(&self.db_path)
    }
}

/// SQLite-based audit database
#[derive(Debug)]
pub struct AuditDb {
    conn: Connection,
}

impl AuditDb {
    /// Create or open the audit database
    pub fn new(db_path: &str) -> Result<Self, anyhow::Error> {
        let conn = Connection::open(db_path)
            .map_err(|e| anyhow!("Failed to open database: {}", e))?;
        
        // Create the audit table if it doesn't exist
        conn.execute_batch(AUDIT_TABLE_SQL)
            .map_err(|e| anyhow!("Failed to create audit table: {}", e))?;
        
        Ok(Self { conn })
    }

    /// Append an audit event
    pub fn append(&self, event: &AuditEvent) -> Result<(), anyhow::Error> {
        let json_details = serde_json::to_string(&event.details)
            .map_err(|e| anyhow!("Failed to serialize details: {}", e))?;
        let json_correlation_id = event.correlation_id.map(|id| id.to_string());
        let json_session_id = event.session_id.map(|id| id.to_string());

        self.conn.execute(
            AUDIT_INSERT_SQL,
            params![
                event.id.to_string(),
                event.event_type.as_str_name(),
                event.severity.as_str_name(),
                event.timestamp.to_rfc3339(),
                event.principal,
                event.owner_id.to_string(),
                json_session_id,
                json_details,
                json_correlation_id,
                event.ip_address,
                event.user_agent,
            ],
        ).map_err(|e| anyhow!("Failed to insert audit event: {}", e))?;

        Ok(())
    }

    /// Query events by owner
    pub fn query_by_owner(
        &self,
        owner_id: Uuid,
        start_time: Option<DateTime<Utc>>,
        end_time: Option<DateTime<Utc>>,
        limit: Option<u32>,
    ) -> Result<Vec<AuditEvent>, anyhow::Error> {
        let mut query = String::from(AUDIT_QUERY_BY_OWNER_SQL);
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(owner_id.to_string())];

        if let Some(start) = start_time {
            query.push_str(" AND timestamp >= ?");
            params.push(Box::new(start.to_rfc3339()));
        }

        if let Some(end) = end_time {
            query.push_str(" AND timestamp <= ?");
            params.push(Box::new(end.to_rfc3339()));
        }

        query.push_str(" ORDER BY timestamp DESC");
        
        if let Some(lim) = limit {
            query.push_str(&format!(" LIMIT {}", lim));
        }

        let mut stmt = self.conn.prepare(&query)
            .map_err(|e| anyhow!("Failed to prepare query: {}", e))?;
        let events = stmt.query_map(params_from_iter(params.iter()), |row| {
            Ok(self.row_to_event(row)?)
        }).map_err(|e| anyhow!("Failed to execute query: {}", e))?;

        let mut result = Vec::new();
        for event in events {
            result.push(event?);
        }

        Ok(result)
    }

    /// Export events as JSON
    pub fn export_json(&self, owner_id: Uuid) -> Result<String, anyhow::Error> {
        let events = self.query_by_owner(owner_id, None, None, None)?;
        serde_json::to_string_pretty(&events).map_err(|e| anyhow!("Failed to serialize: {}", e))
    }

    /// Convert a database row to an AuditEvent
    fn row_to_event(&self, row: &rusqlite::Row) -> Result<AuditEvent, rusqlite::Error> {
        let id_str: String = match row.get(0) {
            Ok(s) => s,
            Err(_) => return Err(rusqlite::Error::InvalidParameterName("id".to_string())),
        };
        let event_type_str: String = match row.get(1) {
            Ok(s) => s,
            Err(_) => return Err(rusqlite::Error::InvalidParameterName("event_type".to_string())),
        };
        let severity_str: String = match row.get(2) {
            Ok(s) => s,
            Err(_) => return Err(rusqlite::Error::InvalidParameterName("severity".to_string())),
        };
        let timestamp_str: String = match row.get(3) {
            Ok(s) => s,
            Err(_) => return Err(rusqlite::Error::InvalidParameterName("timestamp".to_string())),
        };
        let principal: String = match row.get(4) {
            Ok(s) => s,
            Err(_) => return Err(rusqlite::Error::InvalidParameterName("principal".to_string())),
        };
        let owner_id_str: String = match row.get(5) {
            Ok(s) => s,
            Err(_) => return Err(rusqlite::Error::InvalidParameterName("owner_id".to_string())),
        };
        let session_id_opt: Option<String> = match row.get(6) {
            Ok(s) => s,
            Err(_) => return Err(rusqlite::Error::InvalidParameterName("session_id".to_string())),
        };
        let details_json: String = match row.get(7) {
            Ok(s) => s,
            Err(_) => return Err(rusqlite::Error::InvalidParameterName("details".to_string())),
        };
        let correlation_id_opt: Option<String> = match row.get(8) {
            Ok(s) => s,
            Err(_) => return Err(rusqlite::Error::InvalidParameterName("correlation_id".to_string())),
        };
        let ip_address_opt: Option<String> = match row.get(9) {
            Ok(s) => s,
            Err(_) => return Err(rusqlite::Error::InvalidParameterName("ip_address".to_string())),
        };
        let user_agent_opt: Option<String> = match row.get(10) {
            Ok(s) => s,
            Err(_) => return Err(rusqlite::Error::InvalidParameterName("user_agent".to_string())),
        };

        let id = match Uuid::parse_str(&id_str) {
            Ok(id) => id,
            Err(_) => return Err(rusqlite::Error::InvalidParameterName("id_parse".to_string())),
        };
        let event_type = parse_audit_event_type(&event_type_str)
            .unwrap_or(AuditEventType::Session);
        let severity = parse_audit_severity(&severity_str)
            .unwrap_or(AuditSeverity::Info);
        let timestamp = match DateTime::parse_from_rfc3339(&timestamp_str) {
            Ok(dt) => dt.into(),
            Err(_) => return Err(rusqlite::Error::InvalidParameterName("timestamp_parse".to_string())),
        };
        let owner_id = match Uuid::parse_str(&owner_id_str) {
            Ok(id) => id,
            Err(_) => return Err(rusqlite::Error::InvalidParameterName("owner_id_parse".to_string())),
        };
        let session_id = session_id_opt.and_then(|s| Uuid::parse_str(&s).ok());
        let details: HashMap<String, serde_json::Value> = match serde_json::from_str(&details_json) {
            Ok(d) => d,
            Err(_) => return Err(rusqlite::Error::InvalidParameterName("details_parse".to_string())),
        };

        Ok(AuditEvent {
            id,
            event_type,
            severity,
            timestamp,
            principal,
            owner_id,
            session_id,
            details,
            correlation_id: correlation_id_opt.and_then(|s| Uuid::parse_str(&s).ok()),
            ip_address: ip_address_opt,
            user_agent: user_agent_opt,
        })
    }
}

impl Drop for AuditDb {
    fn drop(&mut self) {
        // Connection will be automatically closed when dropped
        // We don't need to explicitly close it
    }
}

// SQL statements
const AUDIT_TABLE_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    principal TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    session_id TEXT,
    details TEXT NOT NULL,
    correlation_id TEXT,
    ip_address TEXT,
    user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_owner ON audit_events(owner_id);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_events(session_id);
"#;

const AUDIT_INSERT_SQL: &str = r#"
INSERT INTO audit_events (
    id, event_type, severity, timestamp, principal, owner_id,
    session_id, details, correlation_id, ip_address, user_agent
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"#;

const AUDIT_QUERY_BY_OWNER_SQL: &str = r#"
SELECT id, event_type, severity, timestamp, principal, owner_id,
       session_id, details, correlation_id, ip_address, user_agent
FROM audit_events
WHERE owner_id = ?
"#;

// Helper functions
fn parse_audit_event_type(s: &str) -> Option<AuditEventType> {
    match s {
        "auth" => Some(AuditEventType::Auth),
        "session" => Some(AuditEventType::Session),
        "action" => Some(AuditEventType::Action),
        "hitl" => Some(AuditEventType::HITL),
        _ => None,
    }
}

fn parse_audit_severity(s: &str) -> Option<AuditSeverity> {
    match s {
        "info" => Some(AuditSeverity::Info),
        "warning" => Some(AuditSeverity::Warning),
        "error" => Some(AuditSeverity::Error),
        "security" => Some(AuditSeverity::Security),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_audit_event_creation() {
        let event = AuditEvent::auth("user@example.com", Uuid::new_v4(), true);
        assert_eq!(event.event_type, AuditEventType::Auth);
        assert_eq!(event.severity, AuditSeverity::Info);
    }

    #[test]
    fn test_audit_event_with_session() {
        let session_id = Uuid::new_v4();
        let event = AuditEvent::session("user", Uuid::new_v4(), session_id, "create");
        assert_eq!(event.session_id, Some(session_id));
        assert_eq!(event.event_type, AuditEventType::Session);
    }

    #[test]
    fn test_audit_event_details_redaction() {
        let mut event = AuditEvent::new(
            AuditEventType::Action,
            AuditSeverity::Info,
            "user",
            Uuid::new_v4(),
        );
        event = event.add_detail("password", serde_json::json!("secret123"));
        event = event.add_detail("username", serde_json::json!("john"));

        let details = &event.details;
        assert_eq!(details.get("password"), Some(&serde_json::json!("[REDACTED]")));
        assert_eq!(details.get("username"), Some(&serde_json::json!("john")));
    }

    #[test]
    fn test_audit_event_serialization() {
        let event = AuditEvent::auth("user@example.com", Uuid::new_v4(), true);
        let json = serde_json::to_string(&event).unwrap();
        let restored: AuditEvent = serde_json::from_str(&json).unwrap();

        assert_eq!(event.id, restored.id);
        assert_eq!(event.event_type, restored.event_type);
    }
}
