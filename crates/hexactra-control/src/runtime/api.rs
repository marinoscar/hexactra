//! `/v1` HTTP API for remote browser control.
//!
//! Every route except `GET /v1/health` requires `Authorization: Bearer <token>`.
//! Clients and host agents use the same token in this first slice; separate
//! host credentials are follow-up work on epic #173.

use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use hexactra_core::remote::{
    ActionRequest, ApiError, CreateSessionRequest, OperationResult, OperationState,
    RegisterHostRequest, RegisterHostResponse,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::store::{RuntimeStore, StoreError};

/// Default time a caller waits for an action result.
pub const DEFAULT_ACTION_TIMEOUT: Duration = Duration::from_secs(30);
/// Upper bound on any action timeout.
pub const MAX_ACTION_TIMEOUT: Duration = Duration::from_secs(120);
/// Upper bound on a host long-poll.
pub const MAX_HOST_POLL: Duration = Duration::from_secs(30);
/// Results carry screenshots; allow up to 25 MiB.
const RESULT_BODY_LIMIT: usize = 25 * 1024 * 1024;

/// Shared state for the `/v1` router.
#[derive(Clone)]
pub struct ApiState {
    pub store: RuntimeStore,
    pub webhooks: super::webhooks::Webhooks,
    token_digest: Arc<[u8; 32]>,
}

impl ApiState {
    /// Build state with the bearer token clients and hosts must present and
    /// a memory-only webhook registry.
    pub fn new(store: RuntimeStore, token: &str) -> Self {
        Self::with_webhooks(store, token, super::webhooks::Webhooks::in_memory())
    }

    /// Build state with a configured webhook registry.
    pub fn with_webhooks(
        store: RuntimeStore,
        token: &str,
        webhooks: super::webhooks::Webhooks,
    ) -> Self {
        Self {
            store,
            webhooks,
            token_digest: Arc::new(Sha256::digest(token.as_bytes()).into()),
        }
    }

    /// Constant-time token check (compares SHA-256 digests).
    pub(super) fn token_matches(&self, presented: &str) -> bool {
        let d: [u8; 32] = Sha256::digest(presented.as_bytes()).into();
        d.iter()
            .zip(self.token_digest.iter())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
    }
}

/// API error with a stable machine-readable code.
pub struct AppError(pub StatusCode, pub &'static str, pub String);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (
            self.0,
            Json(ApiError {
                error: self.1.to_string(),
                message: self.2,
            }),
        )
            .into_response()
    }
}

impl From<StoreError> for AppError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::NotFound(_) => AppError(StatusCode::NOT_FOUND, "not_found", e.to_string()),
            StoreError::Conflict(_) => AppError(StatusCode::CONFLICT, "conflict", e.to_string()),
            StoreError::NoHostAvailable => AppError(
                StatusCode::SERVICE_UNAVAILABLE,
                "no_host_available",
                e.to_string(),
            ),
            StoreError::HandoffPending(_) => {
                AppError(StatusCode::CONFLICT, "handoff_pending", e.to_string())
            }
            StoreError::Invalid(_) => {
                AppError(StatusCode::BAD_REQUEST, "invalid_request", e.to_string())
            }
            StoreError::Forbidden => AppError(StatusCode::FORBIDDEN, "forbidden", e.to_string()),
            StoreError::ProfileNotFound(_) => {
                AppError(StatusCode::NOT_FOUND, "profile_not_found", e.to_string())
            }
        }
    }
}

async fn require_token(State(state): State<ApiState>, req: Request, next: Next) -> Response {
    let presented = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    match presented {
        Some(t) if state.token_matches(t) => next.run(req).await,
        _ => AppError(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or invalid bearer token".into(),
        )
        .into_response(),
    }
}

/// Build the `/v1` router.
pub fn router(state: ApiState) -> Router {
    let protected = Router::new()
        .route("/v1/hosts", get(list_hosts))
        .route("/v1/hosts/register", post(register_host))
        .route("/v1/hosts/{host_id}/next", get(next_operation))
        .route(
            "/v1/hosts/{host_id}/operations/{op_id}/result",
            post(post_result).layer(DefaultBodyLimit::max(RESULT_BODY_LIMIT)),
        )
        .route("/v1/sessions", get(list_sessions).post(create_session))
        .route("/v1/sessions/{id}", get(get_session).delete(end_session))
        .route("/v1/sessions/{id}/actions", post(run_action))
        .route("/v1/operations/{id}", get(get_operation))
        .merge(super::handoff_api::protected_routes())
        .merge(super::webhook_api::routes())
        .route_layer(middleware::from_fn_with_state(state.clone(), require_token));
    Router::new()
        .route("/v1/health", get(health))
        .merge(super::handoff_api::public_routes())
        .merge(protected)
        .with_state(state)
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}

// ------------------------------------------------------------------ hosts

async fn list_hosts(State(s): State<ApiState>) -> impl IntoResponse {
    Json(serde_json::json!({ "hosts": s.store.list_hosts() }))
}

async fn register_host(
    State(s): State<ApiState>,
    Json(req): Json<RegisterHostRequest>,
) -> Result<Json<RegisterHostResponse>, AppError> {
    let name = req.name.trim();
    if name.is_empty() || name.len() > 128 {
        return Err(AppError(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "name must be 1-128 characters".into(),
        ));
    }
    let viewer_url = match req.viewer_url.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(u) => {
            let ok = u.len() <= 2048
                && url::Url::parse(u)
                    .map(|p| matches!(p.scheme(), "http" | "https") && p.host_str().is_some())
                    .unwrap_or(false);
            if !ok {
                return Err(AppError(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "viewer_url must be an http(s) URL".into(),
                ));
            }
            Some(u.to_string())
        }
    };
    let host_id = s
        .store
        .register_host(req.host_id, name.to_string(), req.version);
    s.store.set_host_viewer_url(host_id, viewer_url)?;
    tracing::info!(%host_id, "host registered");
    Ok(Json(RegisterHostResponse { host_id }))
}

#[derive(Deserialize)]
struct PollQuery {
    wait_ms: Option<u64>,
    #[serde(default)]
    browser_connected: bool,
    #[serde(default)]
    on_demand: bool,
    /// Comma-separated profile names the host has.
    profiles: Option<String>,
    /// Comma-separated profile names whose browser is running.
    running: Option<String>,
}

fn split_list(s: &Option<String>) -> Vec<String> {
    s.as_deref()
        .unwrap_or("")
        .split(',')
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
        .collect()
}

async fn next_operation(
    State(s): State<ApiState>,
    Path(host_id): Path<Uuid>,
    Query(q): Query<PollQuery>,
) -> Result<Response, AppError> {
    let wait = Duration::from_millis(q.wait_ms.unwrap_or(25_000)).min(MAX_HOST_POLL);
    s.store.set_host_on_demand(host_id, q.on_demand)?;
    if q.profiles.is_some() {
        s.store
            .set_host_profiles(host_id, split_list(&q.profiles), split_list(&q.running))?;
    }
    match s
        .store
        .next_operation(host_id, q.browser_connected, wait)
        .await?
    {
        Some(op) => {
            tracing::info!(op_id = %op.id, kind = op.action.kind(), "operation dispatched");
            Ok(Json(op).into_response())
        }
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

async fn post_result(
    State(s): State<ApiState>,
    Path((host_id, op_id)): Path<(Uuid, Uuid)>,
    Json(result): Json<OperationResult>,
) -> Result<StatusCode, AppError> {
    let view = s.store.complete(host_id, op_id, result)?;
    tracing::info!(%op_id, state = ?view.state, "operation completed");
    Ok(StatusCode::NO_CONTENT)
}

// --------------------------------------------------------------- sessions

async fn list_sessions(State(s): State<ApiState>) -> impl IntoResponse {
    Json(serde_json::json!({ "sessions": s.store.list_sessions() }))
}

async fn create_session(
    State(s): State<ApiState>,
    body: Option<Json<CreateSessionRequest>>,
) -> Result<impl IntoResponse, AppError> {
    let req = body.map(|Json(b)| b).unwrap_or_default();
    if req.label.as_deref().map(str::len).unwrap_or(0) > 200 {
        return Err(AppError(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "label longer than 200 characters".into(),
        ));
    }
    let session =
        s.store
            .create_session_for(req.host_id, req.label, req.profile, req.create_profile)?;
    tracing::info!(session_id = %session.id, host_id = %session.host_id, "session created");
    Ok((StatusCode::CREATED, Json(session)))
}

async fn get_session(
    State(s): State<ApiState>,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    Ok(Json(s.store.get_session(id)?))
}

async fn end_session(
    State(s): State<ApiState>,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    let session = s.store.end_session(id)?;
    tracing::info!(session_id = %id, "session ended");
    Ok(Json(session))
}

// ------------------------------------------------------------- operations

#[derive(Deserialize)]
struct ActionQuery {
    /// Return 202 immediately instead of waiting for the result.
    #[serde(default, rename = "async")]
    is_async: bool,
}

async fn run_action(
    State(s): State<ApiState>,
    Path(session_id): Path<Uuid>,
    Query(q): Query<ActionQuery>,
    Json(req): Json<ActionRequest>,
) -> Result<Response, AppError> {
    req.action
        .validate()
        .map_err(|e| AppError(StatusCode::BAD_REQUEST, "invalid_action", e.0))?;
    let timeout = req
        .timeout_ms
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_ACTION_TIMEOUT)
        .clamp(Duration::from_millis(100), MAX_ACTION_TIMEOUT);
    let kind = req.action.kind();
    let (op, rx) = s.store.enqueue(session_id, req.action, timeout)?;
    tracing::info!(op_id = %op.id, %session_id, kind, "operation queued");
    if q.is_async {
        // Expire the operation in the background so it cannot sit queued forever.
        let store = s.store.clone();
        let op_id = op.id;
        tokio::spawn(async move {
            let _ = store.wait_for(op_id, rx, timeout, true).await;
        });
        return Ok((StatusCode::ACCEPTED, Json(op)).into_response());
    }
    let done = s.store.wait_for(op.id, rx, timeout, true).await?;
    if done.state == OperationState::TimedOut {
        tracing::warn!(op_id = %done.id, kind, "operation timed out");
    }
    Ok(Json(done).into_response())
}

#[derive(Deserialize)]
struct GetOperationQuery {
    wait_ms: Option<u64>,
}

async fn get_operation(
    State(s): State<ApiState>,
    Path(id): Path<Uuid>,
    Query(q): Query<GetOperationQuery>,
) -> Result<impl IntoResponse, AppError> {
    let view = match q.wait_ms {
        Some(ms) if ms > 0 => {
            let rx = s.store.subscribe(id)?;
            let wait = Duration::from_millis(ms).min(MAX_ACTION_TIMEOUT);
            s.store.wait_for(id, rx, wait, false).await?
        }
        _ => s.store.get_operation(id)?,
    };
    Ok(Json(view))
}
