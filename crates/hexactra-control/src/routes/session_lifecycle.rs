//! Session lifecycle management routes

use axum::{
    extract::State,
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use chrono::Utc;
use uuid::Uuid;

use hexactra_core::{HostId, HostStatus, Session, SessionId, SessionStatus};
use serde::{Deserialize, Serialize};

use crate::state::DbState;
use tracing::instrument;

/// Request to start a session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartSessionRequest {
    pub profile_id: Uuid,
    pub host_id: Option<Uuid>,
}

/// Response for session start
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartSessionResponse {
    pub session_id: Uuid,
    pub status: String,
}

/// Request to stop a session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StopSessionRequest {
    pub reason: Option<String>,
}

/// Request to restart a session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestartSessionRequest {
    pub force: bool,
}

/// Session status update request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateSessionStatusRequest {
    pub status: String,
    pub details: Option<serde_json::Value>,
}

/// Get session by ID with full details
#[axum::debug_handler]
#[instrument(skip(db_state, session_id), level = "info", fields(session_id = "control-plane"))]
async fn get_session_full(
    State(db_state): State<DbState>,
    session_id: axum::extract::Path<Uuid>,
) -> Result<Json<Session>, (StatusCode, String)> {
    tracing::info!("Handling session_lifecycle.get request");
    
    let session = db_state
        .get_session(*session_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    match session {
        Some(s) => Ok(Json(s)),
        None => Err((StatusCode::NOT_FOUND, "Session not found".to_string())),
    }
}

/// Start a new session
#[axum::debug_handler]
#[instrument(skip(db_state, request), level = "info", fields(session_id = "control-plane"))]
async fn start_session(
    State(db_state): State<DbState>,
    Json(request): Json<StartSessionRequest>,
) -> Result<Json<StartSessionResponse>, (StatusCode, String)> {
    tracing::info!("Handling session_lifecycle.start request");
    
    // Check if profile exists
    let profile = db_state
        .get_profile(request.profile_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    if profile.is_none() {
        return Err((StatusCode::NOT_FOUND, "Profile not found".to_string()));
    }

    // Check if host is available if specified
    if let Some(host_id) = request.host_id {
        let host = db_state
            .get_host(&HostId::from_uuid(host_id))
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

        match host {
            Some(h) => {
                if h.status != HostStatus::Ready {
                    return Err((StatusCode::BAD_REQUEST, "Host is not ready".to_string()));
                }
            }
            None => {
                return Err((StatusCode::NOT_FOUND, "Host not found".to_string()));
            }
        }
    }

    // Create session
    let session_id = SessionId::from_uuid(Uuid::new_v4());
    let session = Session {
        id: session_id,
        profile_id: request.profile_id,
        status: SessionStatus::Initializing,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    };

    db_state
        .create_session(&session)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to create session: {}", e)))?;

    Ok(Json(StartSessionResponse {
        session_id: session_id.as_uuid(),
        status: SessionStatus::Initializing.as_str_name().to_string(),
    }))
}

/// Stop a session
#[axum::debug_handler]
#[instrument(skip(db_state, session_id), level = "info", fields(session_id = "control-plane"))]
async fn stop_session(
    State(db_state): State<DbState>,
    session_id: axum::extract::Path<Uuid>,
) -> Result<Json<StartSessionResponse>, (StatusCode, String)> {
    tracing::info!("Handling session_lifecycle.stop request");
    
    let session = db_state
        .get_session(*session_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    match session {
        Some(mut s) => {
            s.status = SessionStatus::Ended;
            s.updated_at = Utc::now();

            db_state
                .update_session_status(s.id.as_uuid(), s.status)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to stop session: {}", e)))?;

            Ok(Json(StartSessionResponse {
                session_id: s.id.as_uuid(),
                status: SessionStatus::Ended.as_str_name().to_string(),
            }))
        }
        None => Err((StatusCode::NOT_FOUND, "Session not found".to_string())),
    }
}

/// Restart a session
#[axum::debug_handler]
#[instrument(skip(db_state, session_id, request), level = "info", fields(session_id = "control-plane"))]
async fn restart_session(
    State(db_state): State<DbState>,
    session_id: axum::extract::Path<Uuid>,
    Json(request): Json<RestartSessionRequest>,
) -> Result<Json<StartSessionResponse>, (StatusCode, String)> {
    tracing::info!("Handling session_lifecycle.restart request");
    
    let session = db_state
        .get_session(*session_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    match session {
        Some(mut s) => {
            // Force restart can override status checks
            if !request.force && s.status != SessionStatus::Ended {
                return Err((StatusCode::BAD_REQUEST, "Session must be ended before restart".to_string()));
            }

            s.status = SessionStatus::Initializing;
            s.updated_at = Utc::now();

            db_state
                .update_session_status(s.id.as_uuid(), s.status)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to restart session: {}", e)))?;

            Ok(Json(StartSessionResponse {
                session_id: s.id.as_uuid(),
                status: SessionStatus::Initializing.as_str_name().to_string(),
            }))
        }
        None => Err((StatusCode::NOT_FOUND, "Session not found".to_string())),
    }
}

/// Update session status (e.g., from host)
#[axum::debug_handler]
#[instrument(skip(db_state, session_id, request), level = "info", fields(session_id = "control-plane"))]
async fn update_session_status(
    State(db_state): State<DbState>,
    session_id: axum::extract::Path<Uuid>,
    Json(request): Json<UpdateSessionStatusRequest>,
) -> Result<Json<StartSessionResponse>, (StatusCode, String)> {
    tracing::info!("Handling session_lifecycle.update_status request");
    
    let status = SessionStatus::from_str_name(&request.status);

    let session = db_state
        .get_session(*session_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    match session {
        Some(mut s) => {
            s.status = status;
            s.updated_at = Utc::now();

            db_state
                .update_session_status(s.id.as_uuid(), status)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to update session status: {}", e)))?;

            Ok(Json(StartSessionResponse {
                session_id: s.id.as_uuid(),
                status: status.as_str_name().to_string(),
            }))
        }
        None => Err((StatusCode::NOT_FOUND, "Session not found".to_string())),
    }
}

/// Get sessions by profile
async fn get_sessions_by_profile(
    State(db_state): State<DbState>,
    profile_id: axum::extract::Path<Uuid>,
) -> Result<Json<Vec<Session>>, (StatusCode, String)> {
    let sessions = db_state
        .list_sessions_by_profile(*profile_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    Ok(Json(sessions))
}

/// Check session readiness
async fn check_session_readiness(
    State(db_state): State<DbState>,
    session_id: axum::extract::Path<Uuid>,
) -> Result<Json<Session>, (StatusCode, String)> {
    let session = db_state
        .get_session(*session_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    match session {
        Some(s) => {
            if s.status != SessionStatus::Running {
                return Err((StatusCode::BAD_REQUEST, "Session must be running to check readiness".to_string()));
            }
            Ok(Json(s))
        }
        None => Err((StatusCode::NOT_FOUND, "Session not found".to_string())),
    }
}

/// Create router for session lifecycle routes
pub fn router() -> Router<DbState> {
    Router::new()
        .route("/{id}", get(get_session_full))
        .route("/", post(start_session))
        .route("/{id}/stop", post(stop_session))
        .route("/{id}/restart", post(restart_session))
        .route("/{id}/status", post(update_session_status))
        .route("/profile/{profile_id}", get(get_sessions_by_profile))
        .route("/{id}/ready", get(check_session_readiness))
}

// Tests are temporarily disabled due to axum 0.8 API changes
