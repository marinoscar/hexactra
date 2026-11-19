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
    routing::{get, post, put},
    Json, Router,
};
use hexactra_core::remote::{
    RegisterSecretsProviderRequest, SaveLoginRequest, SaveLoginResult, SecretsProviderView,
};

use super::api::{ApiState, AppError};
use super::secrets::RegisterError;

pub(super) fn routes() -> Router<ApiState> {
    Router::new()
        .route("/v1/secrets-providers/{owner_id}", get(list))
        .route(
            "/v1/secrets-providers/{owner_id}/{provider}",
            put(register).delete(remove),
        )
        .route(
            "/v1/secrets-providers/{owner_id}/{provider}/save-login",
            post(save_login),
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
    description = "Register (or replace) the secrets provider an owner's sessions use for `secrets_lookup`, `type_from_provider`, `type_code_from_provider`, `select_from_provider` and `type_card_field`. The access token is held in memory only: never written to the state database, never returned, never logged. A registration with `expires_at` disappears then; register again with a fresh token. Kind `vault` (a Vault's agent credential API) needs `base_url` (the Vault's `APP_URL`, `https` or loopback `http`), `access_token` (the short-lived `oat_` token) and `expires_at`. Kind `console` (the console's built-in store, which the fabric calls back) needs `base_url` (the console's internal address, `https` or `http` on a private network such as `http://api:3000/api/internal/secrets-store/v1`), `access_token` (the owner's `sct_` credential) and `expires_at`; `test` exists only in builds with the `test-provider` feature.",
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

/// The HTTP status of a save's failure code.
fn save_status(code: &str) -> StatusCode {
    match code {
        "invalid_request" => StatusCode::BAD_REQUEST,
        "not_found" | "no_provider" => StatusCode::NOT_FOUND,
        "name_taken" | "secret_unavailable" | "conflict" => StatusCode::CONFLICT,
        "rate_limited" => StatusCode::TOO_MANY_REQUESTS,
        "unsupported" | "refused" | "disabled" => StatusCode::UNPROCESSABLE_ENTITY,
        _ => StatusCode::BAD_GATEWAY,
    }
}

#[utoipa::path(
    post,
    path = "/v1/secrets-providers/{owner_id}/{provider}/save-login",
    tag = "secrets",
    params(("owner_id" = String, Path, description = "The owner's user id, as a session's `owner_id`"), ("provider" = String, Path, description = "The provider to save in: `vault`")),
    request_body = SaveLoginRequest,
    description = "Save the sign-in the owner typed into a `credentials` handoff (E37.4b), so the next run does not ask. The handoff must have been created with `offer_save: true` and answered, and the password typed with a `type_secret` action: the control plane keeps a copy in memory for ten minutes after the answer (surviving the end of the session) and sends it to the provider's create route (Vault: `POST /credentials`, `purpose: \"save_login\"`, scope `vault:items_write`, agent contract 1.3), bound to `origin`. The caller never holds the password and the answer never carries it: `{ saved: true, item_id }`. The copy is consumed only on success: a taken name (`409 name_taken`), an unreachable provider or a refused token leaves it, so the owner can try again until it expires. A password that is gone (saved, erased, expired, a restart, or being saved by another call) is `409 secret_unavailable`; a handoff that is not the owner's, or was not created with `offer_save`, is `404 not_found`. Provider failures keep their codes (`name_taken`, `unauthorized`, `disabled`, `rate_limited`, `unavailable`, `refused`, `unsupported`, `timed_out`). The audit event is `secrets.release` with purpose `save_login`, field `password` and outcome `saved` or the failure code: never the password or the username.",
    responses((status = 200, body = SaveLoginResult), (status = 400, description = "Invalid name or origin"), (status = 404, description = "No such provider, handoff or offer"), (status = 409, description = "`name_taken` or `secret_unavailable`"), (status = 422, description = "The provider cannot save or refused"), (status = 429, description = "Rate limited by the provider"), (status = 502, description = "The provider was unreachable or refused the token"), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
async fn save_login(
    State(s): State<ApiState>,
    Path((owner_id, provider)): Path<(String, String)>,
    Json(req): Json<SaveLoginRequest>,
) -> Response {
    // A failure is `no-store` too: it names a provider's code and must not be cached.
    match super::secrets::save_login(&s, &owner_id, &provider, req).await {
        Ok(saved) => no_store(Json(saved).into_response()),
        Err(f) => no_store(AppError(save_status(f.code), f.code, f.message).into_response()),
    }
}
