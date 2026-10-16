use axum::{
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use hexactra_core::{InteractionRequest, InteractionRequestId, InteractionStatus};

// ==================== Request/Response Types ====================

#[derive(Debug, Deserialize, Serialize)]
pub struct CreateInteractionRequestRequest {
    pub session_id: Uuid,
    pub reason: String,
    pub details: serde_json::Value,
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
    pub status: String,
}

#[derive(Debug, Serialize)]
pub struct ListInteractionRequestsResponse {
    pub requests: Vec<InteractionRequestResponse>,
}

// ==================== Interaction Request Routes ====================

pub fn router() -> Router {
    Router::new()
        .route("/", get(list_interaction_requests).post(create_interaction_request))
        .route("/{request_id}", get(get_interaction_request))
}

async fn list_interaction_requests() -> &'static str {
    "List interaction requests"
}

async fn create_interaction_request() -> &'static str {
    "Create interaction request"
}

async fn get_interaction_request() -> &'static str {
    "Get interaction request"
}
