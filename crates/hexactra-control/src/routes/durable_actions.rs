//! Durable actions, event stream, reconciliation and leases routes

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use chrono::Utc;
use uuid::Uuid;

use hexactra_core::{GoalId, Lease, LeaseId, Operation, OperationId, OperationStatus};
use serde::{Deserialize, Serialize};

use crate::state::DbState;

/// Request to create an operation
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CreateOperationRequest {
    pub goal_id: Uuid,
    pub action: serde_json::Value,
}

/// Response for operation creation
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CreateOperationResponse {
    pub operation_id: Uuid,
    pub status: String,
}

/// Request to acknowledge an operation
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AcknowledgeOperationRequest {
    pub operation_id: Uuid,
}

/// Request to update operation status
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct UpdateOperationStatusRequest {
    pub status: String,
}

/// Request for lease acquisition
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AcquireLeaseRequest {
    pub resource_type: String,
    pub resource_id: Uuid,
    pub holder_type: String,
    pub holder_id: Uuid,
    pub ttl_seconds: i64,
}

/// Response for lease acquisition
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AcquireLeaseResponse {
    pub lease_id: Uuid,
    pub resource_type: String,
    pub resource_id: Uuid,
    pub holder_type: String,
    pub holder_id: Uuid,
    pub expires_at: String,
}

/// Request to release a lease
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReleaseLeaseRequest {
    pub lease_id: Uuid,
}

/// Get operation by ID with full details
async fn get_operation_full(
    State(db_state): State<DbState>,
    operation_id: axum::extract::Path<Uuid>,
) -> Result<Json<Operation>, (StatusCode, String)> {
    let operation = db_state
        .get_operation(*operation_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    match operation {
        Some(o) => Ok(Json(o)),
        None => Err((StatusCode::NOT_FOUND, "Operation not found".to_string())),
    }
}

/// Create a new operation (durable action)
async fn create_operation(
    State(db_state): State<DbState>,
    Json(request): Json<CreateOperationRequest>,
) -> Result<Json<CreateOperationResponse>, (StatusCode, String)> {
    let operation_id = OperationId::from_uuid(Uuid::new_v4());

    let operation = Operation {
        id: operation_id,
        goal_id: GoalId::from_uuid(request.goal_id),
        status: OperationStatus::Queued,
        created_at: Utc::now(),
        started_at: None,
        completed_at: None,
    };

    db_state
        .create_operation(&operation)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to create operation: {}", e)))?;

    // Append event for audit trail
    let _ = db_state
        .append_event(
            "operation.created",
            &operation_id.as_uuid().to_string(),
            "operation",
            &serde_json::to_string(&operation).unwrap_or_default(),
        )
        .await;

    Ok(Json(CreateOperationResponse {
        operation_id: operation_id.as_uuid(),
        status: OperationStatus::Queued.as_str_name().to_string(),
    }))
}

/// Acknowledge operation receipt
async fn acknowledge_operation(
    State(db_state): State<DbState>,
    Json(request): Json<AcknowledgeOperationRequest>,
) -> Result<Json<CreateOperationResponse>, (StatusCode, String)> {
    let mut operation = db_state
        .get_operation(request.operation_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Operation not found".to_string()))?;

    if operation.status != OperationStatus::Queued {
        return Err((StatusCode::BAD_REQUEST, "Operation already acknowledged".to_string()));
    }

    operation.status = OperationStatus::InProgress;
    operation.started_at = Some(Utc::now());

    db_state
        .update_operation_status(
            operation.id.as_uuid(),
            operation.status,
            operation.started_at,
            operation.completed_at,
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to update operation: {}", e)))?;

    // Append event for audit trail
    let _ = db_state
        .append_event(
            "operation.acknowledged",
            &operation.id.as_uuid().to_string(),
            "operation",
            &serde_json::to_string(&operation).unwrap_or_default(),
        )
        .await;

    Ok(Json(CreateOperationResponse {
        operation_id: operation.id.as_uuid(),
        status: OperationStatus::InProgress.as_str_name().to_string(),
    }))
}

/// Update operation status (e.g., from worker)
async fn update_operation_status(
    State(db_state): State<DbState>,
    operation_id: axum::extract::Path<Uuid>,
    Json(request): Json<UpdateOperationStatusRequest>,
) -> Result<Json<CreateOperationResponse>, (StatusCode, String)> {
    let status = OperationStatus::from_str_name(&request.status);

    let operation = db_state
        .get_operation(*operation_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Operation not found".to_string()))?;

    let started_at = if status == OperationStatus::InProgress {
        operation.started_at
    } else {
        None
    };

    let completed_at = if status == OperationStatus::Completed || status == OperationStatus::Failed {
        Some(Utc::now())
    } else {
        None
    };

    db_state
        .update_operation_status(operation.id.as_uuid(), status, started_at, completed_at)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to update operation: {}", e)))?;

    // Append event for audit trail
    let _ = db_state
        .append_event(
            "operation.status_updated",
            &operation.id.as_uuid().to_string(),
            "operation",
            &serde_json::to_string(&operation).unwrap_or_default(),
        )
        .await;

    Ok(Json(CreateOperationResponse {
        operation_id: operation.id.as_uuid(),
        status: status.as_str_name().to_string(),
    }))
}

/// Acquire a lease for exclusive access
async fn acquire_lease(
    State(db_state): State<DbState>,
    Json(request): Json<AcquireLeaseRequest>,
) -> Result<Json<AcquireLeaseResponse>, (StatusCode, String)> {
    let lease_id = Uuid::new_v4();
    let expires_at = Utc::now() + chrono::Duration::seconds(request.ttl_seconds);

    // Check if lease already exists
    let existing_lease = db_state
        .get_active_lease(&request.resource_type, &request.resource_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    if existing_lease.is_some() {
        return Err((StatusCode::CONFLICT, "Resource is already leased".to_string()));
    }

    // Store lease in database
    db_state
        .create_lease(
            &LeaseId::from_uuid(lease_id),
            &request.resource_type,
            &request.resource_id.to_string(),
            &request.holder_id,
            expires_at,
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to acquire lease: {}", e)))?;

    Ok(Json(AcquireLeaseResponse {
        lease_id,
        resource_type: request.resource_type,
        resource_id: request.resource_id,
        holder_type: request.holder_type,
        holder_id: request.holder_id,
        expires_at: expires_at.to_rfc3339(),
    }))
}

/// Release a lease
async fn release_lease(
    State(db_state): State<DbState>,
    Json(request): Json<ReleaseLeaseRequest>,
) -> Result<Json<AcquireLeaseResponse>, (StatusCode, String)> {
    let lease = db_state
        .get_lease(LeaseId::from_uuid(request.lease_id))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Lease not found".to_string()))?;

    db_state
        .release_lease(LeaseId::from_uuid(request.lease_id))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to release lease: {}", e)))?;

    Ok(Json(AcquireLeaseResponse {
        lease_id: request.lease_id,
        resource_type: lease.resource_type,
        resource_id: Uuid::parse_str(&lease.resource_id).unwrap(),
        holder_type: lease.owner.to_string(),
        holder_id: lease.owner,
        expires_at: lease.expires_at.to_rfc3339(),
    }))
}

/// Get events since cursor (SSE/long-polling)
async fn get_events_since(
    State(db_state): State<DbState>,
    Query(params): axum::extract::Query<std::collections::HashMap<String, i64>>,
) -> Result<Json<Vec<serde_json::Value>>, (StatusCode, String)> {
    let cursor = *params.get("cursor").unwrap_or(&0i64);
    let limit = *params.get("limit").unwrap_or(&100i64);

    let events = db_state
        .get_events_since(cursor, limit)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    let mut result = Vec::new();
    for (id, event_type, resource_id, resource_type, payload) in events {
        let mut event = serde_json::Map::new();
        event.insert("id".to_string(), serde_json::Value::Number(id.into()));
        event.insert("event_type".to_string(), event_type.into());
        event.insert("resource_id".to_string(), resource_id.into());
        event.insert("resource_type".to_string(), resource_type.into());
        event.insert("payload".to_string(), serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null));
        result.push(serde_json::Value::Object(event));
    }

    Ok(Json(result))
}

/// Reconcile operations (find operations that may need retry/recovery)
async fn reconcile_operations(
    State(db_state): State<DbState>,
) -> Result<Json<Vec<Operation>>, (StatusCode, String)> {
    // Find operations that are in RUNNING state but haven't been updated recently
    // This is a simplified version - in production you'd use a more sophisticated algorithm
    let operations = db_state
        .list_operations_by_status(OperationStatus::InProgress)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    Ok(Json(operations))
}

/// Create router for durable actions routes
pub fn router() -> Router<DbState> {
    Router::new()
        .route("/operations", post(create_operation))
        .route("/operations/{id}", get(get_operation_full))
        .route("/operations/{id}/acknowledge", post(acknowledge_operation))
        .route("/operations/{id}/status", post(update_operation_status))
        .route("/leases/acquire", post(acquire_lease))
        .route("/leases/release", post(release_lease))
        .route("/events", get(get_events_since))
        .route("/reconcile", get(reconcile_operations))
}
