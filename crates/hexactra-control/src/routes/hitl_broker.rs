use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use hexactra_core::{InteractionKind, InteractionRequestId, InteractionRequest, InteractionStatus};

use crate::state::DbState;

// ==================== Request/Response Types ====================

#[derive(Debug, Deserialize)]
pub struct CreateInteractionRequestRequest {
    pub session_id: Uuid,
    pub reason: String,
    pub details: serde_json::Value,
    #[serde(default)]
    pub kind: Option<String>, // Optional kind, defaults to secret_text
    #[serde(default = "default_ttl")]
    pub ttl_minutes: i64, // Time-to-live in minutes
}

#[derive(Debug, Serialize)]
pub struct CreateInteractionRequestResponse {
    pub request: InteractionRequestResponse,
}

#[derive(Debug, Serialize)]
pub struct InteractionRequestResponse {
    pub id: Uuid,
    pub session_id: Uuid,
    pub reason: String,
    pub details: serde_json::Value,
    pub created_at: String,
    pub kind: String,
    pub status: String,
    pub expires_at: String,
}

#[derive(Debug, Serialize)]
pub struct ListInteractionRequestsResponse {
    pub requests: Vec<InteractionRequestResponse>,
}

#[derive(Debug, Deserialize)]
pub struct ClaimInteractionRequestRequest {
    pub owner_id: Uuid,
}

#[derive(Debug, Serialize)]
pub struct ClaimInteractionRequestResponse {
    pub claimed: bool,
}

#[derive(Debug, Deserialize)]
pub struct RespondInteractionRequestRequest {
    pub owner_id: Uuid,
    pub status: String, // approved, rejected, expired, cancelled
}

#[derive(Debug, Serialize)]
pub struct RespondInteractionRequestResponse {
    pub responded: bool,
}

#[derive(Debug, Serialize)]
pub struct GetPendingRequestsResponse {
    pub requests: Vec<InteractionRequestResponse>,
}

// ==================== Default values ====================

fn default_ttl() -> i64 {
    15 // Default 15 minutes TTL
}

// ==================== HITL Broker Routes ====================

pub fn router() -> Router<DbState> {
    Router::new()
        .route("/", get(list_requests).post(create_request))
        .route("/{request_id}", get(get_request))
        .route("/{request_id}/claim", post(claim_request))
        .route("/{request_id}/respond", post(respond_request))
        .route("/pending", get(get_pending_requests))
}

async fn list_requests(
    State(state): State<DbState>,
) -> Result<Json<ListInteractionRequestsResponse>, (StatusCode, String)> {
    // TODO: Implement proper filtering by session
    let requests = state
        .list_interaction_requests_by_session(Uuid::new_v4()) // Placeholder - should filter by session
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut response_requests = Vec::new();
    for req in requests {
        response_requests.push(InteractionRequestResponse {
            id: req.id.as_uuid(),
            session_id: req.session_id.as_uuid(),
            reason: req.reason,
            details: req.details,
            created_at: req.created_at.to_rfc3339(),
            kind: req.kind.as_str_name().to_string(),
            status: req.status.as_str_name().to_string(),
            expires_at: req.expires_at.to_rfc3339(),
        });
    }

    Ok(Json(ListInteractionRequestsResponse {
        requests: response_requests,
    }))
}

async fn create_request(
    State(state): State<DbState>,
    Json(payload): Json<CreateInteractionRequestRequest>,
) -> Result<Json<CreateInteractionRequestResponse>, (StatusCode, String)> {
    // Validate session exists by trying to get it
    if state.get_session(payload.session_id).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    })?.is_none() {
        return Err((StatusCode::NOT_FOUND, "Session not found".to_string()));
    }

    let kind = payload
        .kind
        .as_deref()
        .map(InteractionKind::from_str_name)
        .unwrap_or(InteractionKind::SecretText);

    let request = InteractionRequest {
        id: InteractionRequestId::from_uuid(Uuid::new_v4()),
        session_id: hexactra_core::SessionId::from_uuid(payload.session_id),
        reason: payload.reason,
        details: payload.details,
        created_at: Utc::now(),
        kind,
        status: InteractionStatus::Pending,
        expires_at: Utc::now() + chrono::Duration::minutes(payload.ttl_minutes),
        owner_id: None,
        origin_session_id: payload.session_id,
    };

    state.create_interaction_request(&request).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to create request: {}", e))
    })?;

    Ok(Json(CreateInteractionRequestResponse {
        request: InteractionRequestResponse {
            id: request.id.as_uuid(),
            session_id: request.session_id.as_uuid(),
            reason: request.reason,
            details: request.details,
            created_at: request.created_at.to_rfc3339(),
            kind: request.kind.as_str_name().to_string(),
            status: request.status.as_str_name().to_string(),
            expires_at: request.expires_at.to_rfc3339(),
        },
    }))
}

async fn get_request(
    State(state): State<DbState>,
    Path(request_id): Path<Uuid>,
) -> Result<Json<InteractionRequestResponse>, (StatusCode, String)> {
    let request = state
        .get_interaction_request(request_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if let Some(req) = request {
        Ok(Json(InteractionRequestResponse {
            id: req.id.as_uuid(),
            session_id: req.session_id.as_uuid(),
            reason: req.reason,
            details: req.details,
            created_at: req.created_at.to_rfc3339(),
            kind: req.kind.as_str_name().to_string(),
            status: req.status.as_str_name().to_string(),
            expires_at: req.expires_at.to_rfc3339(),
        }))
    } else {
        Err((StatusCode::NOT_FOUND, "Request not found".to_string()))
    }
}

async fn claim_request(
    State(state): State<DbState>,
    Path(request_id): Path<Uuid>,
    Json(payload): Json<ClaimInteractionRequestRequest>,
) -> Result<Json<ClaimInteractionRequestResponse>, (StatusCode, String)> {
    let claimed = state
        .claim_interaction_request(request_id, payload.owner_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(ClaimInteractionRequestResponse { claimed }))
}

async fn respond_request(
    State(state): State<DbState>,
    Path(request_id): Path<Uuid>,
    Json(payload): Json<RespondInteractionRequestRequest>,
) -> Result<Json<RespondInteractionRequestResponse>, (StatusCode, String)> {
    let status = InteractionStatus::from_str_name(&payload.status);

    let responded = state
        .respond_interaction_request(request_id, status, payload.owner_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(RespondInteractionRequestResponse { responded }))
}

async fn get_pending_requests(
    State(state): State<DbState>,
) -> Result<Json<GetPendingRequestsResponse>, (StatusCode, String)> {
    // TODO: Implement session-based filtering
    let requests = state
        .list_interaction_requests_by_session(Uuid::new_v4()) // Placeholder - should filter by session
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut response_requests = Vec::new();
    for req in requests {
        response_requests.push(InteractionRequestResponse {
            id: req.id.as_uuid(),
            session_id: req.session_id.as_uuid(),
            reason: req.reason,
            details: req.details,
            created_at: req.created_at.to_rfc3339(),
            kind: req.kind.as_str_name().to_string(),
            status: req.status.as_str_name().to_string(),
            expires_at: req.expires_at.to_rfc3339(),
        });
    }

    Ok(Json(GetPendingRequestsResponse {
        requests: response_requests,
    }))
}
