use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use hexactra_core::{InteractionKind, InteractionRequestId, InteractionRequest, InteractionStatus};

use crate::state::DbState;

// ==================== Request/Response Types ====================

#[derive(Debug, Deserialize)]
pub struct CreateInteractionRequestRequest {
    pub session_id: Uuid,
    pub reason: String,
    pub details: serde_json::Value,
    #[serde(default)]
    pub kind: Option<String>, // Optional kind, defaults to secret_text
    #[serde(default = "default_ttl")]
    pub ttl_minutes: i64, // Time-to-live in minutes
}

#[derive(Debug, Serialize)]
pub struct CreateInteractionRequestResponse {
    pub request: InteractionRequestResponse,
}

#[derive(Debug, Serialize)]
pub struct InteractionRequestResponse {
    pub id: Uuid,
    pub session_id: Uuid,
    pub reason: String,
    pub details: serde_json::Value,
    pub created_at: String,
    pub kind: String,
    pub status: String,
    pub expires_at: String,
}

#[derive(Debug, Serialize)]
pub struct ListInteractionRequestsResponse {
    pub requests: Vec<InteractionRequestResponse>,
}

#[derive(Debug, Deserialize)]
pub struct ClaimInteractionRequestRequest {
    pub owner_id: Uuid,
}

#[derive(Debug, Serialize)]
pub struct ClaimInteractionRequestResponse {
    pub claimed: bool,
}

#[derive(Debug, Deserialize)]
pub struct RespondInteractionRequestRequest {
    pub owner_id: Uuid,
    pub status: String, // approved, rejected, expired, cancelled
}

#[derive(Debug, Serialize)]
pub struct RespondInteractionRequestResponse {
    pub responded: bool,
}

#[derive(Debug, Serialize)]
pub struct GetPendingRequestsResponse {
    pub requests: Vec<InteractionRequestResponse>,
}

#[derive(Debug, Deserialize)]
pub struct RequestOobConfirmationRequest {
    pub session_id: Uuid,
    pub reason: String,
    pub details: serde_json::Value,
    #[serde(default = "default_ttl")]
    pub ttl_minutes: i64,
}

#[derive(Debug, Serialize)]
pub struct RequestOobConfirmationResponse {
    pub request: InteractionRequestResponse,
    pub oob_channel: OobChannelInfo,
}

#[derive(Debug, Serialize)]
pub struct OobChannelInfo {
    pub channel_id: String,
    pub verification_uri: String,
    pub verification_code: String,
    pub expires_at: String,
}

#[derive(Debug, Deserialize)]
pub struct VerifyOobRequest {
    pub channel_id: String,
    pub verification_code: String,
}

#[derive(Debug, Serialize)]
pub struct VerifyOobResponse {
    pub verified: bool,
}

#[derive(Debug, Deserialize)]
pub struct RequestPasskeyRequest {
    pub session_id: Uuid,
    pub reason: String,
    pub details: serde_json::Value,
    #[serde(default = "default_ttl")]
    pub ttl_minutes: i64,
}

#[derive(Debug, Serialize)]
pub struct RequestPasskeyResponse {
    pub request: InteractionRequestResponse,
    pub passkey_challenge: PasskeyChallenge,
}

#[derive(Debug, Serialize)]
pub struct PasskeyChallenge {
    pub challenge_id: String,
    pub rp_entity_name: String,
    pub user_id: String,
    pub timeout_seconds: u32,
    pub attestation_types: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct VerifyPasskeyRequest {
    pub challenge_id: String,
    pub credential_id: String,
    pub authenticator_data: String,
    pub client_data_json: String,
    pub signature: String,
}

#[derive(Debug, Serialize)]
pub struct VerifyPasskeyResponse {
    pub verified: bool,
    pub credential_id: String,
}

// ==================== Default values ====================

fn default_ttl() -> i64 {
    15 // Default 15 minutes TTL
}

// ==================== HITL Broker Routes ====================

pub fn router() -> Router<DbState> {
    Router::new()
        .route("/", get(list_requests).post(create_request))
        .route("/{request_id}", get(get_request))
        .route("/{request_id}/claim", post(claim_request))
        .route("/{request_id}/respond", post(respond_request))
        .route("/pending", get(get_pending_requests))
        .route("/oob/confirm", post(request_oob_confirmation))
        .route("/oob/verify", post(verify_oob))
        .route("/passkey/request", post(request_passkey))
        .route("/passkey/verify", post(verify_passkey))
}

async fn list_requests(
    State(state): State<DbState>,
) -> Result<Json<ListInteractionRequestsResponse>, (StatusCode, String)> {
    // TODO: Implement proper filtering by session
    let requests = state
        .list_interaction_requests_by_session(Uuid::new_v4()) // Placeholder - should filter by session
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut response_requests = Vec::new();
    for req in requests {
        response_requests.push(InteractionRequestResponse {
            id: req.id.as_uuid(),
            session_id: req.session_id.as_uuid(),
            reason: req.reason,
            details: req.details,
            created_at: req.created_at.to_rfc3339(),
            kind: req.kind.as_str_name().to_string(),
            status: req.status.as_str_name().to_string(),
            expires_at: req.expires_at.to_rfc3339(),
        });
    }

    Ok(Json(ListInteractionRequestsResponse {
        requests: response_requests,
    }))
}

async fn create_request(
    State(state): State<DbState>,
    Json(payload): Json<CreateInteractionRequestRequest>,
) -> Result<Json<CreateInteractionRequestResponse>, (StatusCode, String)> {
    // Validate session exists by trying to get it
    if state.get_session(payload.session_id).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    })?.is_none() {
        return Err((StatusCode::NOT_FOUND, "Session not found".to_string()));
    }

    let kind = payload
        .kind
        .as_deref()
        .map(InteractionKind::from_str_name)
        .unwrap_or(InteractionKind::SecretText);

    let request = InteractionRequest {
        id: InteractionRequestId::from_uuid(Uuid::new_v4()),
        session_id: hexactra_core::SessionId::from_uuid(payload.session_id),
        reason: payload.reason,
        details: payload.details,
        created_at: Utc::now(),
        kind,
        status: InteractionStatus::Pending,
        expires_at: Utc::now() + chrono::Duration::minutes(payload.ttl_minutes),
        owner_id: None,
        origin_session_id: payload.session_id,
        policy: hexactra_core::InteractionPolicy {
            approval_level: hexactra_core::ApprovalLevel::Standard,
            verify_origin: false,
            max_retries: 3,
        },
    };

    state.create_interaction_request(&request).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to create request: {}", e))
    })?;

    Ok(Json(CreateInteractionRequestResponse {
        request: InteractionRequestResponse {
            id: request.id.as_uuid(),
            session_id: request.session_id.as_uuid(),
            reason: request.reason,
            details: request.details,
            created_at: request.created_at.to_rfc3339(),
            kind: request.kind.as_str_name().to_string(),
            status: request.status.as_str_name().to_string(),
            expires_at: request.expires_at.to_rfc3339(),
        },
    }))
}

async fn get_request(
    State(state): State<DbState>,
    Path(request_id): Path<Uuid>,
) -> Result<Json<InteractionRequestResponse>, (StatusCode, String)> {
    let request = state
        .get_interaction_request(request_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if let Some(req) = request {
        Ok(Json(InteractionRequestResponse {
            id: req.id.as_uuid(),
            session_id: req.session_id.as_uuid(),
            reason: req.reason,
            details: req.details,
            created_at: req.created_at.to_rfc3339(),
            kind: req.kind.as_str_name().to_string(),
            status: req.status.as_str_name().to_string(),
            expires_at: req.expires_at.to_rfc3339(),
        }))
    } else {
        Err((StatusCode::NOT_FOUND, "Request not found".to_string()))
    }
}

async fn claim_request(
    State(state): State<DbState>,
    Path(request_id): Path<Uuid>,
    Json(payload): Json<ClaimInteractionRequestRequest>,
) -> Result<Json<ClaimInteractionRequestResponse>, (StatusCode, String)> {
    let claimed = state
        .claim_interaction_request(request_id, payload.owner_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(ClaimInteractionRequestResponse { claimed }))
}

async fn respond_request(
    State(state): State<DbState>,
    Path(request_id): Path<Uuid>,
    Json(payload): Json<RespondInteractionRequestRequest>,
) -> Result<Json<RespondInteractionRequestResponse>, (StatusCode, String)> {
    let status = InteractionStatus::from_str_name(&payload.status);

    let responded = state
        .respond_interaction_request(request_id, status, payload.owner_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(RespondInteractionRequestResponse { responded }))
}

async fn get_pending_requests(
    State(state): State<DbState>,
) -> Result<Json<GetPendingRequestsResponse>, (StatusCode, String)> {
    // TODO: Implement session-based filtering
    let requests = state
        .list_interaction_requests_by_session(Uuid::new_v4()) // Placeholder - should filter by session
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut response_requests = Vec::new();
    for req in requests {
        response_requests.push(InteractionRequestResponse {
            id: req.id.as_uuid(),
            session_id: req.session_id.as_uuid(),
            reason: req.reason,
            details: req.details,
            created_at: req.created_at.to_rfc3339(),
            kind: req.kind.as_str_name().to_string(),
            status: req.status.as_str_name().to_string(),
            expires_at: req.expires_at.to_rfc3339(),
        });
    }

    Ok(Json(GetPendingRequestsResponse {
        requests: response_requests,
    }))
}

// ==================== OOB Confirmation Routes ====================

async fn request_oob_confirmation(
    State(state): State<DbState>,
    Json(payload): Json<RequestOobConfirmationRequest>,
) -> Result<Json<RequestOobConfirmationResponse>, (StatusCode, String)> {
    // Create the interaction request
    let request = InteractionRequest {
        id: InteractionRequestId::from_uuid(Uuid::new_v4()),
        session_id: hexactra_core::SessionId::from_uuid(payload.session_id),
        reason: payload.reason,
        details: payload.details,
        created_at: Utc::now(),
        kind: InteractionKind::OobConfirmation,
        status: InteractionStatus::Pending,
        expires_at: Utc::now() + chrono::Duration::minutes(payload.ttl_minutes),
        owner_id: None,
        origin_session_id: payload.session_id,
        policy: hexactra_core::InteractionPolicy {
            approval_level: hexactra_core::ApprovalLevel::OobConfirmation,
            verify_origin: false,
            max_retries: 3,
        },
    };

    state.create_interaction_request(&request).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to create request: {}", e))
    })?;

    // Generate OOB channel info
    let channel_id = Uuid::new_v4().to_string();
    let verification_code = generate_verification_code();
    let verification_uri = format!("https://hexactra.example.com/verify?code={}", verification_code);

    Ok(Json(RequestOobConfirmationResponse {
        request: InteractionRequestResponse {
            id: request.id.as_uuid(),
            session_id: request.session_id.as_uuid(),
            reason: request.reason,
            details: request.details,
            created_at: request.created_at.to_rfc3339(),
            kind: request.kind.as_str_name().to_string(),
            status: request.status.as_str_name().to_string(),
            expires_at: request.expires_at.to_rfc3339(),
        },
        oob_channel: OobChannelInfo {
            channel_id,
            verification_uri,
            verification_code,
            expires_at: request.expires_at.to_rfc3339(),
        },
    }))
}

async fn verify_oob(
    State(state): State<DbState>,
    Json(payload): Json<VerifyOobRequest>,
) -> Result<Json<VerifyOobResponse>, (StatusCode, String)> {
    // In a real implementation, this would verify the code against stored channel info
    // For now, we'll just mark all OOB requests as verified
    let _ = payload.channel_id;
    let _ = payload.verification_code;

    // TODO: Implement actual verification logic
    Ok(Json(VerifyOobResponse { verified: true }))
}

// ==================== Passkey Routes ====================

async fn request_passkey(
    State(state): State<DbState>,
    Json(payload): Json<RequestPasskeyRequest>,
) -> Result<Json<RequestPasskeyResponse>, (StatusCode, String)> {
    // Create the interaction request
    let request = InteractionRequest {
        id: InteractionRequestId::from_uuid(Uuid::new_v4()),
        session_id: hexactra_core::SessionId::from_uuid(payload.session_id),
        reason: payload.reason,
        details: payload.details,
        created_at: Utc::now(),
        kind: InteractionKind::PasskeyOrSecurityKey,
        status: InteractionStatus::Pending,
        expires_at: Utc::now() + chrono::Duration::minutes(payload.ttl_minutes),
        owner_id: None,
        origin_session_id: payload.session_id,
        policy: hexactra_core::InteractionPolicy {
            approval_level: hexactra_core::ApprovalLevel::Passkey,
            verify_origin: true,
            max_retries: 3,
        },
    };

    state.create_interaction_request(&request).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to create request: {}", e))
    })?;

    // Generate passkey challenge
    let challenge_id = Uuid::new_v4().to_string();

    Ok(Json(RequestPasskeyResponse {
        request: InteractionRequestResponse {
            id: request.id.as_uuid(),
            session_id: request.session_id.as_uuid(),
            reason: request.reason,
            details: request.details,
            created_at: request.created_at.to_rfc3339(),
            kind: request.kind.as_str_name().to_string(),
            status: request.status.as_str_name().to_string(),
            expires_at: request.expires_at.to_rfc3339(),
        },
        passkey_challenge: PasskeyChallenge {
            challenge_id,
            rp_entity_name: "Hexactra".to_string(),
            user_id: Uuid::new_v4().to_string(),
            timeout_seconds: 60,
            attestation_types: vec!["direct".to_string()],
        },
    }))
}

async fn verify_passkey(
    State(state): State<DbState>,
    Json(payload): Json<VerifyPasskeyRequest>,
) -> Result<Json<VerifyPasskeyResponse>, (StatusCode, String)> {
    // In a real implementation, this would verify the passkey credential
    // For now, we'll just mark all passkey verifications as successful
    let _ = payload.challenge_id;
    let _ = payload.credential_id;
    let _ = payload.authenticator_data;
    let _ = payload.client_data_json;
    let _ = payload.signature;

    // TODO: Implement actual WebAuthn verification
    Ok(Json(VerifyPasskeyResponse {
        verified: true,
        credential_id: payload.credential_id,
    }))
}

// ==================== Helper Functions ====================

fn generate_verification_code() -> String {
    // Generate a 6-digit numeric code
    let code: u32 = rand::random::<u32>() % 1_000_000;
    format!("{:06}", code)
}
