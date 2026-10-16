use axum::{
    extract::{State, Path},
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use hexactra_core::{OperationStatus, RunStatus, SessionStatus};

use crate::state::DbState;
use crate::auth::{validate_token, AuthContext, Scope, ResourceType};

// ==================== Request/Response Types ====================

#[derive(Debug, Deserialize)]
pub struct ListSessionsQuery {
    pub profile_id: Option<Uuid>,
    pub status: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
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

pub fn router() -> Router<DbState> {
    Router::new()
        .route("/", get(list_sessions).post(create_session))
        .route("/{id}", get(get_session))
}

/// Extract auth context from Bearer token
async fn extract_auth_context(
    headers: axum::http::HeaderMap,
) -> Result<AuthContext, (StatusCode, String)> {
    let auth_header = headers.get("authorization")
        .and_then(|h| h.to_str().ok());
    
    let token = auth_header.ok_or((StatusCode::UNAUTHORIZED, "Missing Authorization header".to_string()))?;
    
    if !token.starts_with("Bearer ") {
        return Err((StatusCode::UNAUTHORIZED, "Invalid Authorization header format".to_string()));
    }
    
    let token = &token[7..];
    
    match validate_token(token) {
        Ok(auth_context) => Ok(auth_context),
        Err(e) => Err((StatusCode::UNAUTHORIZED, format!("Invalid token: {}", e))),
    }
}

/// Check if user owns the resource (profile or session)
fn check_ownership(auth_context: &AuthContext, owner_id: Uuid) -> bool {
    auth_context.identity_id.as_uuid() == owner_id
}

#[axum::debug_handler]
async fn list_sessions(
    State(db_state): State<DbState>,
    headers: axum::http::HeaderMap,
) -> Result<Json<ListSessionsResponse>, (StatusCode, String)> {
    // Extract and validate auth context
    let auth_context = extract_auth_context(headers).await?;
    
    // Check if user has permission to list sessions
    if !auth_context.authorize(ResourceType::Session, "read") {
        return Err((StatusCode::FORBIDDEN, "Insufficient permissions to list sessions".to_string()));
    }
    
    let sessions = db_state.list_sessions().await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e))
    })?;
    
    let session_responses: Vec<SessionResponse> = sessions.iter().map(|s| SessionResponse {
        id: s.id.as_uuid(),
        profile_id: s.profile_id,
        status: s.status.as_str_name().to_string(),
        host_id: None,  // TODO: implement host_id
        created_at: s.created_at.to_rfc3339(),
        updated_at: s.updated_at.to_rfc3339(),
    }).collect();
    
    Ok(Json(ListSessionsResponse { sessions: session_responses }))
}

#[axum::debug_handler]
async fn create_session(
    State(db_state): State<DbState>,
    headers: axum::http::HeaderMap,
    Json(request): Json<CreateSessionRequest>,
) -> Result<Json<CreateSessionResponse>, (StatusCode, String)> {
    // Extract and validate auth context
    let auth_context = extract_auth_context(headers).await?;
    
    // Check if user has permission to create sessions
    if !auth_context.authorize(ResourceType::Session, "write") {
        return Err((StatusCode::FORBIDDEN, "Insufficient permissions to create sessions".to_string()));
    }
    
    // TODO: Implement session creation with host assignment
    Err((StatusCode::NOT_IMPLEMENTED, "Session creation not yet implemented".to_string()))
}

#[axum::debug_handler]
async fn get_session(
    State(db_state): State<DbState>,
    headers: axum::http::HeaderMap,
    Path(session_id): Path<Uuid>,
) -> Result<Json<SessionResponse>, (StatusCode, String)> {
    // Extract and validate auth context
    let auth_context = extract_auth_context(headers).await?;
    
    // Check if user has permission to get session
    if !auth_context.authorize(ResourceType::Session, "read") {
        return Err((StatusCode::FORBIDDEN, "Insufficient permissions to get session".to_string()));
    }
    
    let session = db_state.get_session(session_id).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e))
    })?;
    
    if let Some(session) = session {
        Ok(Json(SessionResponse {
            id: session.id.as_uuid(),
            profile_id: session.profile_id,
            status: session.status.as_str_name().to_string(),
            host_id: None,
            created_at: session.created_at.to_rfc3339(),
            updated_at: session.updated_at.to_rfc3339(),
        }))
    } else {
        Err((StatusCode::NOT_FOUND, "Session not found".to_string()))
    }
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
