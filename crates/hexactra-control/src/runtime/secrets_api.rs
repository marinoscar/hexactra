//! HTTP routes for an owner's secrets providers (#590): which provider the
//! owner's sessions use and what the fabric needs to call it. Client routes
//! (operator and service tokens); the console registers a provider with a
//! freshly minted token and removes it when the owner disconnects.
//!
//! The token in a registration is Secret Material: it is kept in memory,
//! never returned, never logged and never written to the state database.

#[allow(unused_imports)]
use super::openapi::*;
use axum::{
    extract::{Path, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, put},
    Json, Router,
};
use hexactra_core::remote::{RegisterSecretsProviderRequest, SecretsProviderView};

use super::api::{ApiState, AppError};
use super::secrets::RegisterError;

pub(super) fn routes() -> Router<ApiState> {
    Router::new()
        .route("/v1/secrets-providers/{owner_id}", get(list))
        .route(
            "/v1/secrets-providers/{owner_id}/{provider}",
            put(register).delete(remove),
        )
}

fn no_store(mut r: Response) -> Response {
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

#[utoipa::path(
    put,
    path = "/v1/secrets-providers/{owner_id}/{provider}",
    tag = "secrets",
    params(("owner_id" = String, Path, description = "The owner's user id, as a session's `owner_id`"), ("provider" = String, Path, description = "The id actions name: `vault`, `builtin`, `test`")),
    request_body = RegisterSecretsProviderRequest,
    description = "Register (or replace) the secrets provider an owner's sessions use for `secrets_lookup`, `type_from_provider` and `type_code_from_provider`. The access token is held in memory only: never written to the state database, never returned, never logged. A registration with `expires_at` disappears then; register again with a fresh token. Kinds `vault` and `console` answer `501 provider_kind_unsupported` until their providers ship; `test` exists only in builds with the `test-provider` feature.",
    responses((status = 200, body = SecretsProviderView), (status = 400, description = "Invalid owner, provider id, `base_url` or expiry"), (status = 501, description = "`provider_kind_unsupported`"), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
async fn register(
    State(s): State<ApiState>,
    Path((owner_id, provider)): Path<(String, String)>,
    Json(req): Json<RegisterSecretsProviderRequest>,
) -> Result<Response, AppError> {
    let kind = req.kind;
    let view = s
        .secrets
        .register(&owner_id, &provider, req)
        .map_err(|e| match e {
            RegisterError::Invalid(m) => AppError(StatusCode::BAD_REQUEST, "invalid_request", m),
            RegisterError::Unsupported(m) => {
                AppError(StatusCode::NOT_IMPLEMENTED, "provider_kind_unsupported", m)
            }
        })?;
    // Never the request: it holds a token.
    tracing::info!(%owner_id, %provider, ?kind, "secrets provider registered");
    s.store.log.emit(
        "secrets.provider_registered",
        serde_json::json!({ "owner_id": owner_id, "provider": provider, "kind": kind, "expires_at": view.expires_at }),
    );
    Ok(no_store(Json(view).into_response()))
}

#[utoipa::path(
    delete,
    path = "/v1/secrets-providers/{owner_id}/{provider}",
    tag = "secrets",
    params(("owner_id" = String, Path,), ("provider" = String, Path,)),
    description = "Drop a registration, and with it the provider's token. Idempotent.",
    responses((status = 204, description = "Removed (or there was none)"), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
async fn remove(
    State(s): State<ApiState>,
    Path((owner_id, provider)): Path<(String, String)>,
) -> StatusCode {
    if s.secrets.remove(&owner_id, &provider) {
        tracing::info!(%owner_id, %provider, "secrets provider removed");
        s.store.log.emit(
            "secrets.provider_removed",
            serde_json::json!({ "owner_id": owner_id, "provider": provider }),
        );
    }
    StatusCode::NO_CONTENT
}

#[utoipa::path(
    get,
    path = "/v1/secrets-providers/{owner_id}",
    tag = "secrets",
    params(("owner_id" = String, Path,)),
    description = "The owner's live registrations. Never a token.",
    responses((status = 200, body = SecretsProviderList), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
async fn list(State(s): State<ApiState>, Path(owner_id): Path<String>) -> Response {
    no_store(Json(serde_json::json!({ "providers": s.secrets.list(&owner_id) })).into_response())
}
