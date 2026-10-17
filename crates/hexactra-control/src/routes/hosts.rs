//! Host registration and management routes

use axum::{
    extract::State,
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use hexactra_core::{Capability, Host, HostId, HostStatus};

use crate::state::DbState;
use tracing::instrument;
use hexactra_telemetry::Metrics;

/// Host registration request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterHostRequest {
    pub hostname: String,
    pub version: String,
    pub capabilities: Vec<Capability>,
}

/// Host registration response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterHostResponse {
    pub host_id: String,
    pub hostname: String,
    pub status: String,
}

/// Capability discovery response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilityDiscoveryResponse {
    pub host_id: String,
    pub capabilities: Vec<Capability>,
}

/// Get all hosts
#[axum::debug_handler]
#[instrument(skip(db_state), level = "info", fields(session_id = "control-plane"))]
async fn list_hosts(State(db_state): State<DbState>) -> Json<Vec<Host>> {
    tracing::info!("Handling hosts.list request");
    let hosts = db_state.list_hosts().await.unwrap_or_default();
    Json(hosts)
}

/// Register a new host
#[axum::debug_handler]
#[instrument(skip(db_state, request), level = "info", fields(session_id = "control-plane"))]
async fn register_host(
    State(db_state): State<DbState>,
    Json(request): Json<RegisterHostRequest>,
) -> Result<Json<RegisterHostResponse>, (StatusCode, String)> {
    tracing::info!("Handling hosts.register request");
    
    let host_id = HostId::from_uuid(Uuid::new_v4());

    let host = Host {
        id: host_id,
        hostname: request.hostname.clone(),
        version: request.version.clone(),
        capabilities: request.capabilities.clone(),
        status: HostStatus::Connecting,
        last_heartbeat: Utc::now(),
        created_at: Utc::now(),
        updated_at: Utc::now(),
    };

    // Store in database
    db_state.create_host(&host).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    })?;

    // Track host registration
    let _ = Metrics::new();

    Ok(Json(RegisterHostResponse {
        host_id: host_id.as_uuid().to_string(),
        hostname: request.hostname,
        status: HostStatus::Connecting.as_str_name().to_string(),
    }))
}

/// Get host by ID
#[axum::debug_handler]
#[instrument(skip(db_state, host_id), level = "info", fields(session_id = "control-plane"))]
async fn get_host(
    State(db_state): State<DbState>,
    host_id: axum::extract::Path<String>,
) -> Result<Json<Host>, (StatusCode, String)> {
    tracing::info!("Handling hosts.get request");
    
    let uuid = Uuid::parse_str(&host_id)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    let host = db_state
        .get_host(&uuid.into())
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    match host {
        Some(h) => Ok(Json(h)),
        None => Err((StatusCode::NOT_FOUND, "Host not found".to_string())),
    }
}

/// Update host status (heartbeat)
#[axum::debug_handler]
#[instrument(skip(db_state, host_id), level = "info", fields(session_id = "control-plane"))]
async fn update_host_heartbeat(
    State(db_state): State<DbState>,
    host_id: axum::extract::Path<String>,
) -> Result<Json<RegisterHostResponse>, (StatusCode, String)> {
    tracing::info!("Handling hosts.heartbeat request");
    
    let uuid = Uuid::parse_str(&host_id)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    let host = db_state
        .get_host(&uuid.into())
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Host not found".to_string()))?;

    // Update heartbeat
    db_state
        .update_host_heartbeat(&uuid.into())
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(RegisterHostResponse {
        host_id: uuid.to_string(),
        hostname: host.hostname,
        status: HostStatus::Ready.as_str_name().to_string(),
    }))
}

/// Capability discovery for a host
#[axum::debug_handler]
#[instrument(skip(db_state, host_id), level = "info", fields(session_id = "control-plane"))]
async fn discover_capabilities(
    State(db_state): State<DbState>,
    host_id: axum::extract::Path<String>,
) -> Result<Json<CapabilityDiscoveryResponse>, (StatusCode, String)> {
    tracing::info!("Handling hosts.capabilities request");
    
    let uuid = Uuid::parse_str(&host_id)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    let host = db_state
        .get_host(&uuid.into())
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Host not found".to_string()))?;

    Ok(Json(CapabilityDiscoveryResponse {
        host_id: uuid.to_string(),
        capabilities: host.capabilities,
    }))
}

/// Update host capabilities
#[axum::debug_handler]
#[instrument(skip(db_state, host_id, request), level = "info", fields(session_id = "control-plane"))]
async fn update_capabilities(
    State(db_state): State<DbState>,
    host_id: axum::extract::Path<String>,
    Json(request): Json<Vec<Capability>>,
) -> Result<Json<Host>, (StatusCode, String)> {
    tracing::info!("Handling hosts.update_capabilities request");
    
    let uuid = Uuid::parse_str(&host_id)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    let mut host = db_state
        .get_host(&uuid.into())
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Host not found".to_string()))?;

    host.capabilities = request;
    host.updated_at = Utc::now();

    db_state
        .update_host(&host)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(host))
}

/// Host disconnect notification
#[axum::debug_handler]
#[instrument(skip(db_state, host_id), level = "info", fields(session_id = "control-plane"))]
async fn host_disconnect(
    State(db_state): State<DbState>,
    host_id: axum::extract::Path<String>,
) -> Result<Json<RegisterHostResponse>, (StatusCode, String)> {
    tracing::info!("Handling hosts.disconnect request");
    
    let uuid = Uuid::parse_str(&host_id)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    let mut host = db_state
        .get_host(&uuid.into())
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Host not found".to_string()))?;

    host.status = HostStatus::Disconnected;
    host.updated_at = Utc::now();

    db_state
        .update_host(&host)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(RegisterHostResponse {
        host_id: uuid.to_string(),
        hostname: host.hostname,
        status: HostStatus::Disconnected.as_str_name().to_string(),
    }))
}

/// Create router for host routes
pub fn router() -> Router<DbState> {
    Router::new()
        .route("/", get(list_hosts))
        .route("/", post(register_host))
        .route("/{host_id}", get(get_host))
        .route("/{host_id}/heartbeat", post(update_host_heartbeat))
        .route(
            "/{host_id}/capabilities",
            get(discover_capabilities).put(update_capabilities),
        )
        .route("/{host_id}/disconnect", post(host_disconnect))
}
