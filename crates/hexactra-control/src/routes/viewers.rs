//! Viewer management routes

use axum::{
    extract::State,
    http::StatusCode,
    response::Json,
    routing::{get, post, delete},
    Router,
};
use chrono::Utc;
use uuid::Uuid;

use hexactra_core::{ViewerPermissions, InputLease};
use serde::{Deserialize, Serialize};

use crate::state::DbState;

/// Request to generate a viewer token
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GenerateViewerTokenRequest {
    pub session_id: Uuid,
    pub viewer_id: Uuid,
    pub permissions: ViewerPermissions,
}

/// Response for viewer token generation
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GenerateViewerTokenResponse {
    pub token_id: Uuid,
    pub expires_at: String,
    pub permissions: ViewerPermissions,
}

/// Request to acquire an input lease
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AcquireInputLeaseRequest {
    pub session_id: Uuid,
    pub owner_id: Uuid,
}

/// Response for input lease acquisition
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AcquireInputLeaseResponse {
    pub lease_id: Uuid,
    pub session_id: Uuid,
    pub owner_id: Uuid,
    pub expires_at: String,
}

/// Generate a viewer token for a session
async fn generate_token(
    State(db_state): State<DbState>,
    Json(request): Json<GenerateViewerTokenRequest>,
) -> Result<Json<GenerateViewerTokenResponse>, (StatusCode, String)> {
    // TODO: Store token in database with expiration
    let token_id = Uuid::new_v4();
    let expires_at = Utc::now() + chrono::Duration::minutes(30);

    // For now, just return the token info without persisting
    // In production, this would store the token in the database

    Ok(Json(GenerateViewerTokenResponse {
        token_id,
        expires_at: expires_at.to_rfc3339(),
        permissions: request.permissions,
    }))
}

/// Validate a viewer token
async fn validate_token(
    State(_db_state): State<DbState>,
    token_id: axum::extract::Path<Uuid>,
) -> Result<Json<GenerateViewerTokenResponse>, (StatusCode, String)> {
    // TODO: Validate token from database
    // For now, return a mock response
    let token_id = *token_id;

    Ok(Json(GenerateViewerTokenResponse {
        token_id,
        expires_at: Utc::now().to_rfc3339(),
        permissions: ViewerPermissions {
            view: true,
            input: false,
        },
    }))
}

/// Revoke a viewer token
async fn revoke_token(
    State(_db_state): State<DbState>,
    token_id: axum::extract::Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    // TODO: Revoke token from database
    let _ = token_id;
    Ok(StatusCode::NO_CONTENT)
}

/// Acquire an input lease for a session
async fn acquire_input_lease(
    State(db_state): State<DbState>,
    Json(request): Json<AcquireInputLeaseRequest>,
) -> Result<Json<AcquireInputLeaseResponse>, (StatusCode, String)> {
    // TODO: Check if lease already exists and enforce exclusivity
    let lease_id = Uuid::new_v4();
    let expires_at = Utc::now() + chrono::Duration::minutes(5);

    // For now, just return the lease info without persisting
    // In production, this would store the lease in the database

    Ok(Json(AcquireInputLeaseResponse {
        lease_id,
        session_id: request.session_id,
        owner_id: request.owner_id,
        expires_at: expires_at.to_rfc3339(),
    }))
}

/// Release an input lease for a session
async fn release_input_lease(
    State(_db_state): State<DbState>,
    session_id: axum::extract::Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    // TODO: Release lease from database
    let _ = session_id;
    Ok(StatusCode::NO_CONTENT)
}

/// Create router for viewer routes
pub fn router() -> Router<DbState> {
    Router::new()
        .route("/viewers/token", post(generate_token))
        .route("/viewers/token/{token_id}", get(validate_token).delete(revoke_token))
        .route("/viewers/input-lease", post(acquire_input_lease))
        .route("/viewers/input-lease/{session_id}", delete(release_input_lease))
}
