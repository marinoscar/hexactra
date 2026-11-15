//! `/v1` HTTP API for remote browser control.
//!
//! Every route except `GET /v1/health`, the handoff answer page and host
//! enrollment requires `Authorization: Bearer <token>`. Tokens are scoped
//! (see [`super::credentials`]): operator (everything), service (client
//! routes), host (only its own host routes).

#[allow(unused_imports)]
use super::openapi::*;
use std::time::Duration;

use axum::{
    extract::{DefaultBodyLimit, Extension, Path, Query, Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use hexactra_core::remote::{
    ActionRequest, ApiError, CreateSessionRequest, HostWork, OperationResult, OperationState,
    RegisterHostRequest, RegisterHostResponse,
};
use serde::Deserialize;
use uuid::Uuid;

use super::credentials::{CredentialError, Credentials, Principal};
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
    pub credentials: Credentials,
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
        Self::with_parts(store, webhooks, Credentials::new(token))
    }

    /// Build state from its parts.
    pub fn with_parts(
        store: RuntimeStore,
        webhooks: super::webhooks::Webhooks,
        credentials: Credentials,
    ) -> Self {
        Self {
            store,
            webhooks,
            credentials,
        }
    }

    /// Resolve a bearer token.
    pub(super) fn principal(&self, presented: &str) -> Option<Principal> {
        self.credentials.authenticate(presented)
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

fn bearer(req: &Request) -> Option<&str> {
    req.headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
}

fn unauthorized() -> Response {
    AppError(
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        "missing or invalid bearer token".into(),
    )
    .into_response()
}

/// Authenticate and require an allowed principal kind; the principal is
/// stored as a request extension for handlers.
async fn authorize(
    state: &ApiState,
    mut req: Request,
    next: Next,
    allowed: fn(Principal) -> bool,
    denied: &str,
) -> Response {
    let Some(p) = bearer(&req).and_then(|t| state.principal(t)) else {
        return unauthorized();
    };
    if !allowed(p) {
        return AppError(StatusCode::FORBIDDEN, "forbidden", denied.into()).into_response();
    }
    req.extensions_mut().insert(p);
    next.run(req).await
}

async fn require_client(State(s): State<ApiState>, req: Request, next: Next) -> Response {
    authorize(
        &s,
        req,
        next,
        Principal::is_client,
        "this token cannot call client routes",
    )
    .await
}

async fn require_host(State(s): State<ApiState>, req: Request, next: Next) -> Response {
    authorize(
        &s,
        req,
        next,
        |p| matches!(p, Principal::Operator | Principal::Host(_)),
        "only host credentials (or the operator token) can call host routes",
    )
    .await
}

async fn require_operator(State(s): State<ApiState>, req: Request, next: Next) -> Response {
    authorize(
        &s,
        req,
        next,
        |p| p == Principal::Operator,
        "only the operator token can manage service tokens",
    )
    .await
}

/// A host credential may only act for its own host id.
pub(super) fn check_host(p: Principal, host_id: Uuid) -> Result<(), AppError> {
    match p {
        Principal::Host(id) if id != host_id => Err(AppError(
            StatusCode::FORBIDDEN,
            "forbidden",
            "this host credential belongs to another host".into(),
        )),
        _ => Ok(()),
    }
}

impl From<CredentialError> for AppError {
    fn from(e: CredentialError) -> Self {
        match e {
            CredentialError::InvalidEnrollment => {
                AppError(StatusCode::FORBIDDEN, "invalid_enrollment", e.to_string())
            }
            CredentialError::NotFound(_) => {
                AppError(StatusCode::NOT_FOUND, "not_found", e.to_string())
            }
            CredentialError::Invalid(_) => {
                AppError(StatusCode::BAD_REQUEST, "invalid_request", e.to_string())
            }
        }
    }
}

/// Build the `/v1` router.
pub fn router(state: ApiState) -> Router {
    let host = Router::new()
        .route("/v1/hosts/register", post(register_host))
        .route("/v1/hosts/{host_id}/next", get(next_operation))
        .route("/v1/hosts/{host_id}/offline", post(host_offline))
        .route(
            "/v1/hosts/{host_id}/operations/{op_id}/result",
            post(post_result).layer(DefaultBodyLimit::max(RESULT_BODY_LIMIT)),
        )
        .merge(super::host_commands_api::host_routes())
        .route_layer(middleware::from_fn_with_state(state.clone(), require_host));
    let client = Router::new()
        .route("/v1/hosts", get(list_hosts))
        .route("/v1/sessions", get(list_sessions).post(create_session))
        .route("/v1/sessions/{id}", get(get_session).delete(end_session))
        .route("/v1/sessions/{id}/actions", post(run_action))
        .route("/v1/operations/{id}", get(get_operation))
        .merge(super::handoff_api::protected_routes())
        .merge(super::webhook_api::routes())
        .merge(super::credentials_api::client_routes())
        .merge(super::events_api::routes())
        .merge(super::host_commands_api::client_routes())
        .route("/v1/artifacts/{id}", get(get_artifact))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_client,
        ));
    let operator = super::credentials_api::operator_routes().route_layer(
        middleware::from_fn_with_state(state.clone(), require_operator),
    );
    Router::new()
        .route("/v1/health", get(health))
        .merge(super::handoff_api::public_routes())
        .merge(super::credentials_api::public_routes())
        .merge(host)
        .merge(client)
        .merge(operator)
        .layer(middleware::from_fn(trace_request))
        .with_state(state)
}

/// One span per request, continuing the caller's trace (`traceparent`).
/// Host long-polls and the event stream get no span of their own unless
/// the caller sends a trace context: they would only add noise.
async fn trace_request(req: Request, next: Next) -> Response {
    let path = req.uri().path();
    let traced = req.headers().contains_key("traceparent");
    let noisy = path.ends_with("/next") || path == "/v1/events";
    if noisy && !traced {
        return next.run(req).await;
    }
    let route = req
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| "unmatched".into());
    let span = tracing::info_span!(
        "http.request",
        otel.name = %format!("{} {}", req.method(), route),
        http.request.method = %req.method(),
        http.route = %route,
        http.response.status_code = tracing::field::Empty,
    );
    hexactra_otel::set_parent_from_headers(&span, req.headers());
    let resp = tracing::Instrument::instrument(next.run(req), span.clone()).await;
    span.record("http.response.status_code", resp.status().as_u16());
    resp
}

#[utoipa::path(
    get,
    path = "/v1/health",
    tag = "health",
    security(()),
    responses((status = 200, description = "Liveness and version", body = Object))
)]
async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}

// ------------------------------------------------------------------ hosts

#[utoipa::path(
    get,
    path = "/v1/hosts",
    tag = "hosts",
    responses((status = 200, body = HostList), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
async fn list_hosts(State(s): State<ApiState>) -> impl IntoResponse {
    Json(serde_json::json!({ "hosts": s.store.list_hosts() }))
}

#[utoipa::path(
    post,
    path = "/v1/hosts/register",
    tag = "agent",
    request_body = RegisterHostRequest,
    responses((status = 200, body = RegisterHostResponse), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
async fn register_host(
    State(s): State<ApiState>,
    Extension(p): Extension<Principal>,
    Json(mut req): Json<RegisterHostRequest>,
) -> Result<Json<RegisterHostResponse>, AppError> {
    // A host credential always registers its own id.
    if let Principal::Host(id) = p {
        req.host_id = Some(id);
    }
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
    /// The agent can run host commands (#213).
    #[serde(default)]
    commands: bool,
}

fn split_list(s: &Option<String>) -> Vec<String> {
    s.as_deref()
        .unwrap_or("")
        .split(',')
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
        .collect()
}

#[utoipa::path(
    get,
    path = "/v1/hosts/{host_id}/next",
    tag = "agent",
    params(("host_id" = Uuid, Path,), ("wait_ms" = Option<u64>, Query,), ("browser_connected" = Option<bool>, Query,), ("on_demand" = Option<bool>, Query,), ("profiles" = Option<String>, Query, description = "Comma-separated profiles the host has"), ("running" = Option<String>, Query, description = "Comma-separated profiles running now"), ("commands" = Option<bool>, Query, description = "The agent accepts host commands")),
    responses((status = 200, description = "An operation, or `{ \"command\": … }`", body = HostWork), (status = 204, description = "Nothing to do"), (status = 404, description = "Unknown host"), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
async fn next_operation(
    State(s): State<ApiState>,
    Extension(p): Extension<Principal>,
    Path(host_id): Path<Uuid>,
    Query(q): Query<PollQuery>,
) -> Result<Response, AppError> {
    check_host(p, host_id)?;
    let wait = Duration::from_millis(q.wait_ms.unwrap_or(25_000)).min(MAX_HOST_POLL);
    s.store.set_host_on_demand(host_id, q.on_demand)?;
    if q.profiles.is_some() {
        s.store
            .set_host_profiles(host_id, split_list(&q.profiles), split_list(&q.running))?;
    }
    match s
        .store
        .next_work(host_id, q.browser_connected, q.commands, wait)
        .await?
    {
        Some(HostWork::Operation(op)) => {
            tracing::info!(op_id = %op.id, kind = op.action.kind(), "operation dispatched");
            Ok(Json(op).into_response())
        }
        Some(work @ HostWork::Command { .. }) => {
            if let HostWork::Command { command } = &work {
                tracing::info!(command_id = %command.id, kind = command.command.kind(), "host command dispatched");
            }
            Ok(Json(work).into_response())
        }
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

#[utoipa::path(
    post,
    path = "/v1/hosts/{host_id}/offline",
    tag = "agent",
    params(("host_id" = Uuid, Path,)),
    responses((status = 204, description = "Marked offline"), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
async fn host_offline(
    State(s): State<ApiState>,
    Extension(p): Extension<Principal>,
    Path(host_id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    check_host(p, host_id)?;
    s.store.set_host_offline(host_id)?;
    tracing::info!(%host_id, "host went offline");
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/v1/hosts/{host_id}/operations/{op_id}/result",
    tag = "agent",
    params(("host_id" = Uuid, Path,), ("op_id" = Uuid, Path,)),
    request_body = OperationResult,
    responses((status = 204, description = "Recorded"), (status = 404, description = "Unknown operation"), (status = 409, description = "Not dispatched, or already reported"), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
async fn post_result(
    State(s): State<ApiState>,
    Extension(p): Extension<Principal>,
    Path((host_id, op_id)): Path<(Uuid, Uuid)>,
    Json(result): Json<OperationResult>,
) -> Result<StatusCode, AppError> {
    check_host(p, host_id)?;
    let view = s.store.complete(host_id, op_id, result)?;
    tracing::info!(%op_id, state = ?view.state, "operation completed");
    Ok(StatusCode::NO_CONTENT)
}

// --------------------------------------------------------------- sessions

#[utoipa::path(
    get,
    path = "/v1/sessions",
    tag = "sessions",
    responses((status = 200, body = SessionList), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
async fn list_sessions(State(s): State<ApiState>) -> impl IntoResponse {
    Json(serde_json::json!({ "sessions": s.store.list_sessions() }))
}

#[utoipa::path(
    post,
    path = "/v1/sessions",
    tag = "sessions",
    request_body(content = Option<CreateSessionRequest>),
    responses((status = 201, body = SessionView), (status = 404, description = "Unknown host or profile"), (status = 409, description = "Host is draining"), (status = 503, description = "No host available"), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
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

#[utoipa::path(
    get,
    path = "/v1/sessions/{id}",
    tag = "sessions",
    params(("id" = Uuid, Path,)),
    responses((status = 200, body = SessionView), (status = 404, description = "Unknown session"), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
async fn get_session(
    State(s): State<ApiState>,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    Ok(Json(s.store.get_session(id)?))
}

#[utoipa::path(
    delete,
    path = "/v1/sessions/{id}",
    tag = "sessions",
    params(("id" = Uuid, Path,)),
    responses((status = 200, body = SessionView), (status = 404, description = "Unknown session"), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
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
    /// Keep screenshot bytes inline too (migration; see #214).
    #[serde(default)]
    inline_artifacts: bool,
}

#[utoipa::path(
    post,
    path = "/v1/sessions/{id}/actions",
    tag = "sessions",
    params(("id" = Uuid, Path,), ("async" = Option<bool>, Query, description = "Return 202 at once"), ("inline_artifacts" = Option<bool>, Query, description = "Also return screenshot bytes inline")),
    request_body = ActionRequest,
    responses((status = 200, description = "Final state (succeeded, failed, timed_out, cancelled)", body = OperationView), (status = 202, description = "Queued (`?async=true`)", body = OperationView), (status = 400, description = "Invalid action"), (status = 409, description = "Session ended or a handoff is pending"), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
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
    let inline = req.inline_artifacts || q.inline_artifacts;
    let (op, rx) = s
        .store
        .enqueue_with(session_id, req.action, timeout, inline)?;
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

#[utoipa::path(
    get,
    path = "/v1/operations/{id}",
    tag = "sessions",
    params(("id" = Uuid, Path,), ("wait_ms" = Option<u64>, Query,)),
    responses((status = 200, body = OperationView), (status = 404, description = "Unknown operation"), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
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

// -------------------------------------------------------------- artifacts

#[utoipa::path(
    get,
    path = "/v1/artifacts/{id}",
    tag = "artifacts",
    params(("id" = Uuid, Path,)),
    responses((status = 200, description = "The artifact bytes", content_type = "image/jpeg", body = Vec<u8>), (status = 404, description = "Unknown or expired"), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
async fn get_artifact(
    State(s): State<ApiState>,
    Path(id): Path<Uuid>,
) -> Result<Response, AppError> {
    let a = s.store.artifacts.get(id).ok_or_else(|| {
        AppError(
            StatusCode::NOT_FOUND,
            "not_found",
            "artifact not found or expired".into(),
        )
    })?;
    Ok((
        [
            (header::CONTENT_TYPE, a.mime.clone()),
            (header::CACHE_CONTROL, "no-store".to_string()),
            (
                header::HeaderName::from_static("x-content-type-options"),
                "nosniff".to_string(),
            ),
        ],
        a.bytes.as_ref().clone(),
    )
        .into_response())
}
