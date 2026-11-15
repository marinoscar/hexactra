//! `/v1` routes for host commands (#213).

#[allow(unused_imports)]
use super::openapi::*;
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

#[utoipa::path(
    post,
    path = "/v1/hosts/{host_id}/commands",
    tag = "host-commands",
    params(("host_id" = Uuid, Path,), ("async" = Option<bool>, Query,)),
    request_body = HostCommandRequest,
    responses((status = 200, body = HostCommandView), (status = 202, body = HostCommandView), (status = 400, description = "Invalid command"), (status = 404, description = "Unknown host"), (status = 409, description = "Profile in use"), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
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

#[utoipa::path(
    get,
    path = "/v1/hosts/{host_id}/commands",
    tag = "host-commands",
    params(("host_id" = Uuid, Path,)),
    responses((status = 200, body = HostCommandList), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
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

#[utoipa::path(
    get,
    path = "/v1/host-commands/{id}",
    tag = "host-commands",
    params(("id" = Uuid, Path,), ("wait_ms" = Option<u64>, Query,)),
    responses((status = 200, body = HostCommandView), (status = 404, description = "Unknown command"), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
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

#[utoipa::path(
    post,
    path = "/v1/hosts/{host_id}/commands/{command_id}/result",
    tag = "agent",
    params(("host_id" = Uuid, Path,), ("command_id" = Uuid, Path,)),
    request_body = OperationResult,
    responses((status = 204, description = "Recorded"), (status = 404, description = "Unknown command"), (status = 409, description = "Not dispatched"), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
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
