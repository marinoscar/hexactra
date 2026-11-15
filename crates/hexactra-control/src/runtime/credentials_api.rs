//! HTTP routes for credentials and host enrollment (#210).
//!
//! - public: `POST /v1/hosts/enroll` exchanges a single-use enrollment
//!   token for a host credential.
//! - client (operator or service): create and list enrollments, revoke a host.
//! - operator only: create, list and revoke service tokens.

use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::api::{ApiState, AppError};
use super::credentials::{EnrollmentView, ServiceTokenView};

const DEFAULT_ENROLLMENT_TTL: Duration = Duration::from_secs(60 * 60);
const MAX_ENROLLMENT_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

pub(super) fn public_routes() -> Router<ApiState> {
    Router::new().route("/v1/hosts/enroll", post(enroll))
}

pub(super) fn client_routes() -> Router<ApiState> {
    Router::new()
        .route(
            "/v1/admin/hosts/enrollments",
            get(list_enrollments).post(create_enrollment),
        )
        .route("/v1/admin/hosts/{id}", delete(revoke_host))
}

pub(super) fn operator_routes() -> Router<ApiState> {
    Router::new()
        .route(
            "/v1/admin/service-tokens",
            get(list_service_tokens).post(create_service_token),
        )
        .route(
            "/v1/admin/service-tokens/{id}",
            delete(revoke_service_token),
        )
}

/// `POST /v1/hosts/enroll`
#[derive(Debug, Deserialize, Serialize)]
pub struct EnrollRequest {
    pub enrollment_token: String,
    /// Host display name (defaults to the enrollment's suggested name).
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct EnrollResponse {
    pub host_id: Uuid,
    /// The host's own credential (`hxh_…`). Shown once.
    pub host_token: String,
}

async fn enroll(
    State(s): State<ApiState>,
    Json(req): Json<EnrollRequest>,
) -> Result<Json<EnrollResponse>, AppError> {
    let (host_id, host_token, suggested) =
        s.credentials.enroll_host(req.enrollment_token.trim())?;
    let name = req
        .name
        .filter(|n| !n.trim().is_empty())
        .or(suggested)
        .unwrap_or_else(|| format!("host-{}", &host_id.simple().to_string()[..8]));
    let name: String = name.trim().chars().take(128).collect();
    s.store.register_host(
        Some(host_id),
        name,
        req.version.unwrap_or_else(|| "unknown".into()),
    );
    tracing::info!(%host_id, "host enrolled");
    Ok(Json(EnrollResponse {
        host_id,
        host_token,
    }))
}

#[derive(Debug, Default, Deserialize, Serialize)]
pub struct CreateEnrollmentRequest {
    #[serde(default)]
    pub name: Option<String>,
    /// Validity in seconds (default 3600, at most 7 days).
    #[serde(default)]
    pub ttl_s: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct CreatedEnrollment {
    pub enrollment: EnrollmentView,
    /// Single-use token (`hxe_…`) for `hexactra-agent daemon --enrollment-token`.
    pub enrollment_token: String,
}

async fn create_enrollment(
    State(s): State<ApiState>,
    body: Option<Json<CreateEnrollmentRequest>>,
) -> Result<impl IntoResponse, AppError> {
    let req = body.map(|Json(b)| b).unwrap_or_default();
    let ttl = req
        .ttl_s
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_ENROLLMENT_TTL)
        .clamp(Duration::from_secs(60), MAX_ENROLLMENT_TTL);
    let (enrollment, enrollment_token) = s.credentials.create_enrollment(req.name, ttl)?;
    tracing::info!(enrollment_id = %enrollment.id, "host enrollment created");
    Ok((
        StatusCode::CREATED,
        Json(CreatedEnrollment {
            enrollment,
            enrollment_token,
        }),
    ))
}

async fn list_enrollments(State(s): State<ApiState>) -> impl IntoResponse {
    Json(serde_json::json!({ "enrollments": s.credentials.list_enrollments() }))
}

async fn revoke_host(
    State(s): State<ApiState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    let had_credential = s.credentials.revoke_host(id);
    let removed = s.store.remove_host(id);
    if !had_credential && !removed {
        return Err(AppError(
            StatusCode::NOT_FOUND,
            "not_found",
            "host not found".into(),
        ));
    }
    tracing::info!(host_id = %id, "host revoked");
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize, Serialize)]
pub struct CreateServiceTokenRequest {
    pub name: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct CreatedServiceToken {
    pub service_token: ServiceTokenView,
    /// The token (`hxs_…`). Shown once.
    pub token: String,
}

async fn create_service_token(
    State(s): State<ApiState>,
    Json(req): Json<CreateServiceTokenRequest>,
) -> Result<impl IntoResponse, AppError> {
    let (service_token, token) = s.credentials.create_service_token(&req.name)?;
    tracing::info!(id = %service_token.id, "service token created");
    Ok((
        StatusCode::CREATED,
        Json(CreatedServiceToken {
            service_token,
            token,
        }),
    ))
}

async fn list_service_tokens(State(s): State<ApiState>) -> impl IntoResponse {
    Json(serde_json::json!({ "service_tokens": s.credentials.list_service_tokens() }))
}

async fn revoke_service_token(
    State(s): State<ApiState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    s.credentials.revoke_service_token(id)?;
    Ok(StatusCode::NO_CONTENT)
}
