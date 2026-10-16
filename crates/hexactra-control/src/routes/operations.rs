use axum::{
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use hexactra_core::{Operation, OperationId, OperationStatus};

// ==================== Request/Response Types ====================

#[derive(Debug, Serialize)]
pub struct ListOperationsResponse {
    pub operations: Vec<OperationResponse>,
}

#[derive(Debug, Serialize)]
pub struct OperationResponse {
    pub id: Uuid,
    pub goal_id: Uuid,
    pub status: String,
    pub created_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GetOperationResponse {
    pub operation: OperationResponse,
}

// ==================== Operation Routes ====================

pub fn router() -> Router {
    Router::new()
        .route("/", get(list_operations))
        .route("/{operation_id}", get(get_operation))
}

async fn list_operations() -> &'static str {
    "List operations"
}

async fn get_operation() -> &'static str {
    "Get operation"
}
