//! Fleet orchestration routes for multi-host scheduling and profile affinity

use axum::{
    extract::State,
    http::StatusCode,
    response::Json,
    routing::{delete, get, post},
    Router,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use hexactra_core::{HostId, HostPlatform, ScheduleRunStatus, SessionId};

use crate::state::DbState;
use crate::scheduler::ScheduleService;

// ==================== Profile Affinity Routes ====================

/// Get profile affinity assignment
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetProfileAffinityResponse {
    pub profile_id: String,
    pub assigned_host_id: String,
    pub assigned_at: String,
    pub assigned_by: String,
}

#[axum::debug_handler]
async fn get_profile_affinity(
    State(db_state): State<DbState>,
    profile_id: axum::extract::Path<String>,
) -> Result<Json<GetProfileAffinityResponse>, (StatusCode, String)> {
    let uuid = Uuid::parse_str(&profile_id)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    let affinity = db_state
        .get_profile_affinity(uuid)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    match affinity {
        Some(a) => Ok(Json(GetProfileAffinityResponse {
            profile_id: a.profile_id.to_string(),
            assigned_host_id: a.assigned_host_id.as_uuid().to_string(),
            assigned_at: a.assigned_at.to_rfc3339(),
            assigned_by: a.assigned_by,
        })),
        None => Err((StatusCode::NOT_FOUND, "Profile affinity not found".to_string())),
    }
}

/// Assign profile to host
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssignProfileRequest {
    pub host_id: String,
    pub assigned_by: Option<String>,
}

#[axum::debug_handler]
async fn assign_profile(
    State(db_state): State<DbState>,
    profile_id: axum::extract::Path<String>,
    Json(request): Json<AssignProfileRequest>,
) -> Result<Json<GetProfileAffinityResponse>, (StatusCode, String)> {
    let profile_uuid = Uuid::parse_str(&profile_id)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    let host_uuid = Uuid::parse_str(&request.host_id)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    db_state
        .assign_profile(profile_uuid, HostId::from_uuid(host_uuid), &request.assigned_by.unwrap_or_else(|| "api".to_string()))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Return the new affinity
    let affinity = db_state
        .get_profile_affinity(profile_uuid)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to retrieve affinity".to_string()))?;

    Ok(Json(GetProfileAffinityResponse {
        profile_id: affinity.profile_id.to_string(),
        assigned_host_id: affinity.assigned_host_id.as_uuid().to_string(),
        assigned_at: affinity.assigned_at.to_rfc3339(),
        assigned_by: affinity.assigned_by,
    }))
}

/// Clear profile affinity
#[axum::debug_handler]
async fn clear_profile_affinity(
    State(db_state): State<DbState>,
    profile_id: axum::extract::Path<String>,
) -> Result<Json<()>, (StatusCode, String)> {
    let uuid = Uuid::parse_str(&profile_id)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    db_state
        .clear_profile_affinity(uuid)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(()))
}

// ==================== Schedule Routes ====================

/// Schedule definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleDefinition {
    pub name: String,
    pub cron_expression: String,
    pub timezone: Option<String>,
    pub goal_definition: serde_json::Value,
    pub max_retries: Option<u32>,
    pub retry_delay_seconds: Option<u32>,
    pub enabled: Option<bool>,
}

/// Create schedule request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateScheduleRequest {
    pub owner_id: String,
    #[serde(flatten)]
    pub schedule: ScheduleDefinition,
}

/// Create schedule response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateScheduleResponse {
    pub schedule_id: String,
    pub name: String,
    pub enabled: bool,
}

#[axum::debug_handler]
async fn create_schedule(
    State(db_state): State<DbState>,
    Json(request): Json<CreateScheduleRequest>,
) -> Result<Json<CreateScheduleResponse>, (StatusCode, String)> {
    let owner_uuid = Uuid::parse_str(&request.owner_id)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    let schedule_id = Uuid::new_v4();
    let schedule = hexactra_core::Schedule {
        id: schedule_id,
        owner_id: owner_uuid,
        name: request.schedule.name.clone(),
        cron_expression: request.schedule.cron_expression.clone(),
        timezone: request.schedule.timezone.unwrap_or_else(|| "UTC".to_string()),
        goal_definition: request.schedule.goal_definition.clone(),
        max_retries: request.schedule.max_retries.unwrap_or(3),
        retry_delay_seconds: request.schedule.retry_delay_seconds.unwrap_or(60),
        enabled: request.schedule.enabled.unwrap_or(true),
        created_at: Utc::now(),
        updated_at: Utc::now(),
    };

    db_state
        .create_schedule(&schedule)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(CreateScheduleResponse {
        schedule_id: schedule_id.to_string(),
        name: schedule.name,
        enabled: schedule.enabled,
    }))
}

/// List schedules response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListSchedulesResponse {
    pub schedules: Vec<hexactra_core::Schedule>,
}

#[axum::debug_handler]
async fn list_schedules(
    State(db_state): State<DbState>,
    owner_id: axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Result<Json<ListSchedulesResponse>, (StatusCode, String)> {
    let owner_uuid = if let Some(id) = owner_id.get("owner_id") {
        Uuid::parse_str(id)
            .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?
    } else {
        return Err((StatusCode::BAD_REQUEST, "owner_id is required".to_string()));
    };

    let schedules = db_state
        .list_schedules_by_owner(owner_uuid)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(ListSchedulesResponse { schedules }))
}

// ==================== Host Extended Routes ====================

/// Get host extended info
#[axum::debug_handler]
async fn get_host_extended(
    State(db_state): State<DbState>,
    host_id: axum::extract::Path<String>,
) -> Result<Json<hexactra_core::HostExtended>, (StatusCode, String)> {
    let uuid = Uuid::parse_str(&host_id)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    let extended = db_state
        .get_host_extended(&HostId::from_uuid(uuid))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    match extended {
        Some(e) => Ok(Json(e)),
        None => Err((StatusCode::NOT_FOUND, "Host not found".to_string())),
    }
}

// ==================== Scheduling Routes ====================

/// Make scheduling decision
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MakeSchedulingDecisionRequest {
    pub required_capabilities: Vec<String>,
    pub platform: Option<String>,
    pub profile_id: Option<String>,
}

#[axum::debug_handler]
async fn make_scheduling_decision(
    State(db_state): State<DbState>,
    Json(request): Json<MakeSchedulingDecisionRequest>,
) -> Result<Json<hexactra_core::SchedulingDecision>, (StatusCode, String)> {
    let platform = request.platform.map(|p| HostPlatform::from_str_name(&p));

    let profile_id = request.profile_id.as_ref().and_then(|s| Uuid::parse_str(s).ok());

    let decision = db_state
        .make_scheduling_decision(
            request.required_capabilities.iter().map(|s| s.as_str()).collect::<Vec<_>>().as_slice(),
            platform,
            profile_id,
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    match decision {
        Some(d) => Ok(Json(d)),
        None => Err((StatusCode::SERVICE_UNAVAILABLE, "No eligible hosts found".to_string())),
    }
}

// ==================== Router ====================

/// Create router for fleet orchestration routes
pub fn router() -> Router<DbState> {
    Router::new()
        // Profile affinity routes
        .route("/profile-affinity/{profile_id}", get(get_profile_affinity))
        .route("/profile-assign/{profile_id}", post(assign_profile))
        .route("/profile-assign/{profile_id}", delete(clear_profile_affinity))
        // Schedule routes
        .route("/schedules", post(create_schedule))
        .route("/schedules", get(list_schedules))
        .route("/schedules/{schedule_id}/pause", post(pause_schedule))
        .route("/schedules/{schedule_id}/resume", post(resume_schedule))
        .route("/schedules/{schedule_id}/disable", post(disable_schedule))
        .route("/schedules/{schedule_id}/enable", post(enable_schedule))
        .route("/schedules/{schedule_id}/run", post(run_schedule))
        // Host extended routes
        .route("/hosts/extended/{host_id}", get(get_host_extended))
        // Scheduling routes
        .route("/schedule-decision", post(make_scheduling_decision))
}

// ==================== Schedule Control Routes ====================

/// Pause a schedule
#[axum::debug_handler]
async fn pause_schedule(
    State(db_state): State<DbState>,
    schedule_id: axum::extract::Path<String>,
) -> Result<Json<()>, (StatusCode, String)> {
    let uuid = Uuid::parse_str(&schedule_id)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    let schedule = db_state
        .get_schedule(uuid)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Schedule not found".to_string()))?;

    let mut schedule = schedule;
    schedule.enabled = false;
    schedule.updated_at = Utc::now();

    db_state
        .update_schedule(&schedule)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(()))
}

/// Resume a schedule
#[axum::debug_handler]
async fn resume_schedule(
    State(db_state): State<DbState>,
    schedule_id: axum::extract::Path<String>,
) -> Result<Json<()>, (StatusCode, String)> {
    let uuid = Uuid::parse_str(&schedule_id)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    let schedule = db_state
        .get_schedule(uuid)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Schedule not found".to_string()))?;

    let mut schedule = schedule;
    schedule.enabled = true;
    schedule.updated_at = Utc::now();

    db_state
        .update_schedule(&schedule)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(()))
}

/// Disable a schedule (permanent)
#[axum::debug_handler]
async fn disable_schedule(
    State(db_state): State<DbState>,
    schedule_id: axum::extract::Path<String>,
) -> Result<Json<()>, (StatusCode, String)> {
    pause_schedule(State(db_state), schedule_id).await
}

/// Enable a schedule
#[axum::debug_handler]
async fn enable_schedule(
    State(db_state): State<DbState>,
    schedule_id: axum::extract::Path<String>,
) -> Result<Json<()>, (StatusCode, String)> {
    resume_schedule(State(db_state), schedule_id).await
}

/// Trigger a manual run of a schedule
#[axum::debug_handler]
async fn run_schedule(
    State(db_state): State<DbState>,
    schedule_id: axum::extract::Path<String>,
) -> Result<Json<CreateScheduleResponse>, (StatusCode, String)> {
    let uuid = Uuid::parse_str(&schedule_id)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    let schedule = db_state
        .get_schedule(uuid)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Schedule not found".to_string()))?;

    // Create a run record directly in the database
    let run_id = Uuid::new_v4();
    let runs = db_state
        .list_schedule_runs(uuid)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let run_number = (runs.len() as u32) + 1;

    let run = hexactra_core::ScheduleRun {
        id: run_id,
        schedule_id: uuid,
        run_number,
        status: ScheduleRunStatus::Queued,
        host_id: None,
        session_id: None,
        started_at: None,
        completed_at: None,
        error_message: None,
        created_at: Utc::now(),
    };

    db_state.create_schedule_run(&run).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    })?;

    Ok(Json(CreateScheduleResponse {
        schedule_id: uuid.to_string(),
        name: schedule.name,
        enabled: schedule.enabled,
    }))
}
