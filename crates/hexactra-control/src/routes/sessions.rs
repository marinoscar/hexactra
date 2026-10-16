use axum::{
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use hexactra_core::{OperationStatus, RunStatus, SessionStatus};

use crate::state::DbState;

// ==================== Request/Response Types ====================

#[derive(Debug, Deserialize)]
pub struct ListSessionsQuery {
    pub profile_id: Option<Uuid>,
    pub status: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CreateSessionRequest {
    pub profile_id: Uuid,
    pub host_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CreateSessionResponse {
    pub session: SessionResponse,
}

#[derive(Debug, Serialize)]
pub struct SessionResponse {
    pub id: Uuid,
    pub profile_id: Uuid,
    pub status: String,
    pub host_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct ListSessionsResponse {
    pub sessions: Vec<SessionResponse>,
}

// ==================== Session Routes ====================

pub fn router() -> Router {
    Router::new()
        .route("/", get(list_sessions).post(create_session))
        .route("/{id}", get(get_session))
}

async fn list_sessions() -> &'static str {
    "List sessions"
}

async fn create_session() -> &'static str {
    "Create session"
}

async fn get_session() -> &'static str {
    "Get session"
}

// ==================== Helper Functions ====================

fn parse_session_status(s: &str) -> Result<SessionStatus, ()> {
    match s {
        "initializing" => Ok(SessionStatus::Initializing),
        "running" => Ok(SessionStatus::Running),
        "paused" => Ok(SessionStatus::Paused),
        "ended" => Ok(SessionStatus::Ended),
        _ => Err(()),
    }
}

fn parse_run_status(s: &str) -> Result<RunStatus, ()> {
    match s {
        "queued" => Ok(RunStatus::Queued),
        "running" => Ok(RunStatus::Running),
        "completed" => Ok(RunStatus::Completed),
        "failed" => Ok(RunStatus::Failed),
        "cancelled" => Ok(RunStatus::Cancelled),
        "timed_out" => Ok(RunStatus::TimedOut),
        _ => Err(()),
    }
}

fn parse_operation_status(s: &str) -> Result<OperationStatus, ()> {
    match s {
        "queued" => Ok(OperationStatus::Queued),
        "in_progress" => Ok(OperationStatus::InProgress),
        "completed" => Ok(OperationStatus::Completed),
        "failed" => Ok(OperationStatus::Failed),
        _ => Err(()),
    }
}
