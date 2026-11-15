//! `/v1` routes for host commands (#213).

use std::time::Duration;

use axum::{
    extract::{Extension, Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use hexactra_core::remote::{
    HostCommandRequest, OperationResult, DEFAULT_HOST_COMMAND_TIMEOUT_MS,
    MAX_HOST_COMMAND_TIMEOUT_MS,
};
use serde::Deserialize;
use uuid::Uuid;

use super::api::{check_host, ApiState, AppError};
use super::credentials::Principal;

/// Client routes (service or operator token).
pub(super) fn client_routes() -> Router<ApiState> {
    Router::new()
        .route(
            "/v1/hosts/{host_id}/commands",
            get(list_commands).post(create_command),
        )
        .route("/v1/host-commands/{id}", get(get_command))
}

/// Host routes (the host's own token).
pub(super) fn host_routes() -> Router<ApiState> {
    Router::new().route(
        "/v1/hosts/{host_id}/commands/{command_id}/result",
        post(post_result),
    )
}

#[derive(Deserialize)]
struct CreateQuery {
    /// Return 202 at once instead of waiting for the result.
    #[serde(default, rename = "async")]
    is_async: bool,
}

async fn create_command(
    State(s): State<ApiState>,
    Path(host_id): Path<Uuid>,
    Query(q): Query<CreateQuery>,
    Json(req): Json<HostCommandRequest>,
) -> Result<Response, AppError> {
    let timeout = Duration::from_millis(
        req.timeout_ms
            .unwrap_or(DEFAULT_HOST_COMMAND_TIMEOUT_MS)
            .clamp(100, MAX_HOST_COMMAND_TIMEOUT_MS),
    );
    let kind = req.command.kind();
    let (view, rx) = s
        .store
        .enqueue_host_command(host_id, req.command, timeout)?;
    tracing::info!(command_id = %view.id, %host_id, kind, "host command queued");
    if view.state.is_terminal() {
        return Ok(Json(view).into_response());
    }
    if q.is_async {
        let store = s.store.clone();
        let id = view.id;
        tokio::spawn(async move {
            let _ = store.wait_for_host_command(id, rx, timeout, true).await;
        });
        return Ok((StatusCode::ACCEPTED, Json(view)).into_response());
    }
    let done = s
        .store
        .wait_for_host_command(view.id, rx, timeout, true)
        .await?;
    Ok(Json(done).into_response())
}

async fn list_commands(
    State(s): State<ApiState>,
    Path(host_id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    Ok(Json(
        serde_json::json!({ "commands": s.store.list_host_commands(host_id)? }),
    ))
}

#[derive(Deserialize)]
struct GetQuery {
    wait_ms: Option<u64>,
}

async fn get_command(
    State(s): State<ApiState>,
    Path(id): Path<Uuid>,
    Query(q): Query<GetQuery>,
) -> Result<impl IntoResponse, AppError> {
    let view = match q.wait_ms {
        Some(ms) if ms > 0 => {
            let rx = s.store.subscribe_host_command(id)?;
            let wait = Duration::from_millis(ms.min(MAX_HOST_COMMAND_TIMEOUT_MS));
            s.store.wait_for_host_command(id, rx, wait, false).await?
        }
        _ => s.store.get_host_command(id)?,
    };
    Ok(Json(view))
}

async fn post_result(
    State(s): State<ApiState>,
    Extension(p): Extension<Principal>,
    Path((host_id, command_id)): Path<(Uuid, Uuid)>,
    Json(result): Json<OperationResult>,
) -> Result<StatusCode, AppError> {
    check_host(p, host_id)?;
    let v = s.store.complete_host_command(host_id, command_id, result)?;
    tracing::info!(%command_id, kind = v.command.kind(), state = ?v.state, "host command completed");
    Ok(StatusCode::NO_CONTENT)
}
