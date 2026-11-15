//! HTTP routes for webhooks (#190). All require the API token.

#[allow(unused_imports)]
use super::openapi::*;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, post},
    Json, Router,
};
use hexactra_core::remote::CreateWebhookRequest;
use uuid::Uuid;

use super::api::{ApiState, AppError};
use super::webhooks::WebhookError;

impl From<WebhookError> for AppError {
    fn from(e: WebhookError) -> Self {
        match e {
            WebhookError::Invalid(_) => {
                AppError(StatusCode::BAD_REQUEST, "invalid_request", e.to_string())
            }
            WebhookError::NotFound => AppError(StatusCode::NOT_FOUND, "not_found", e.to_string()),
            WebhookError::Io(_) => AppError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "storage_error",
                e.to_string(),
            ),
        }
    }
}

pub(super) fn routes() -> Router<ApiState> {
    Router::new()
        .route("/v1/webhooks", get(list).post(create))
        .route("/v1/webhooks/{id}", delete(remove))
        .route("/v1/webhooks/{id}/test", post(test))
        .route("/v1/webhooks/{id}/deliveries", get(deliveries))
}

#[utoipa::path(
    post,
    path = "/v1/webhooks",
    tag = "webhooks",
    request_body = CreateWebhookRequest,
    responses((status = 201, body = CreatedWebhook), (status = 400, description = "Invalid or disallowed URL"), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
async fn create(
    State(s): State<ApiState>,
    Json(req): Json<CreateWebhookRequest>,
) -> Result<impl IntoResponse, AppError> {
    Ok((StatusCode::CREATED, Json(s.webhooks.add(req)?)))
}

#[utoipa::path(
    get,
    path = "/v1/webhooks",
    tag = "webhooks",
    responses((status = 200, body = WebhookList), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
async fn list(State(s): State<ApiState>) -> impl IntoResponse {
    Json(serde_json::json!({ "webhooks": s.webhooks.list() }))
}

#[utoipa::path(
    delete,
    path = "/v1/webhooks/{id}",
    tag = "webhooks",
    params(("id" = Uuid, Path,)),
    responses((status = 204, description = "Removed"), (status = 404, description = "Unknown webhook"), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
async fn remove(State(s): State<ApiState>, Path(id): Path<Uuid>) -> Result<StatusCode, AppError> {
    s.webhooks.remove(id)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/v1/webhooks/{id}/test",
    tag = "webhooks",
    params(("id" = Uuid, Path,)),
    responses((status = 202, description = "Test event queued", body = Object), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
async fn test(
    State(s): State<ApiState>,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    let event_id = s.webhooks.send_test(id)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(serde_json::json!({ "event_id": event_id })),
    ))
}

#[utoipa::path(
    get,
    path = "/v1/webhooks/{id}/deliveries",
    tag = "webhooks",
    params(("id" = Uuid, Path,)),
    responses((status = 200, body = DeliveryList), (status = 401, description = "Missing or invalid token"), (status = 403, description = "Token not allowed here"))
)]
async fn deliveries(
    State(s): State<ApiState>,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    Ok(Json(
        serde_json::json!({ "deliveries": s.webhooks.deliveries(id)? }),
    ))
}
