//! Fleet orchestration routes for multi-host scheduling and profile affinity

use axum::{
    extract::State,
    http::StatusCode,
    response::Json,
    routing::{delete, get, post},
    Router,
};
use chrono::{DateTime, Datelike, Timelike, Utc};
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
        // Dashboard routes
        .route("/dashboard/summary", get(get_dashboard_summary))
        .route("/hosts/health", get(get_hosts_health))
        .route("/health/metrics", get(get_health_metrics))
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

// ==================== Dashboard Routes ====================

/// Dashboard summary response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DashboardSummary {
    pub total_hosts: u64,
    pub active_hosts: u64,
    pub total_profiles: u64,
    pub active_schedules: u64,
    pub pending_hitl_requests: u64,
    pub scheduled_runs_today: u64,
}

/// Get dashboard summary
#[axum::debug_handler]
async fn get_dashboard_summary(
    State(db_state): State<DbState>,
) -> Result<Json<DashboardSummary>, (StatusCode, String)> {
    let total_hosts = db_state
        .list_hosts()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .len() as u64;

    let active_hosts = db_state
        .list_hosts()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .into_iter()
        .filter(|h| h.status == hexactra_core::HostStatus::Ready)
        .count() as u64;

    let total_profiles = db_state
        .list_profiles()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .len() as u64;

    let active_schedules = db_state
        .list_schedules_by_owner(Uuid::nil())
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .into_iter()
        .filter(|s| s.enabled)
        .count() as u64;

    // Count pending HITL requests - query directly for pending status
    let pool = db_state.pool();
    let pending_hitl: u64 = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(*) FROM interaction_requests WHERE status = 'pending'
        "#,
    )
    .fetch_one(&*pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .try_into()
    .unwrap_or(0);

    // Count scheduled runs for today
    let now = Utc::now();
    let today_start = DateTime::<Utc>::from_utc(
        chrono::NaiveDate::from_ymd_opt(now.year(), now.month(), now.day())
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap(),
        Utc,
    );

    let scheduled_runs = db_state
        .list_schedule_runs(Uuid::nil())
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .into_iter()
        .filter(|r| r.created_at >= today_start && r.status != hexactra_core::ScheduleRunStatus::Skipped)
        .count() as u64;

    Ok(Json(DashboardSummary {
        total_hosts,
        active_hosts,
        total_profiles,
        active_schedules,
        pending_hitl_requests: pending_hitl,
        scheduled_runs_today: scheduled_runs,
    }))
}

/// Host health status response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostHealthStatus {
    pub host_id: String,
    pub hostname: String,
    pub status: String,
    pub last_heartbeat: String,
    pub current_load: u32,
    pub max_concurrent_sessions: u32,
    pub platform: String,
}

/// Get all hosts health status
#[axum::debug_handler]
async fn get_hosts_health(
    State(db_state): State<DbState>,
) -> Result<Json<Vec<HostHealthStatus>>, (StatusCode, String)> {
    let hosts = db_state
        .list_hosts()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let hosts_health: Vec<HostHealthStatus> = hosts
        .into_iter()
        .map(|h| HostHealthStatus {
            host_id: h.id.as_uuid().to_string(),
            hostname: h.hostname,
            status: format!("{:?}", h.status),
            last_heartbeat: h.last_heartbeat.to_rfc3339(),
            current_load: 0, // Will be populated from extended info
            max_concurrent_sessions: 1, // Default value
            platform: h.version.clone(), // Use version as placeholder for platform
        })
        .collect();

    Ok(Json(hosts_health))
}

/// Get health metrics for OTel integration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthMetrics {
    pub timestamp: String,
    pub uptime_seconds: u64,
    pub active_sessions: u64,
    pub pending_operations: u64,
}

/// Get health metrics
#[axum::debug_handler]
async fn get_health_metrics(
    State(db_state): State<DbState>,
) -> Result<Json<HealthMetrics>, (StatusCode, String)> {
    let now = Utc::now();

    // Count active sessions (running)
    let active_sessions = db_state
        .list_sessions()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .into_iter()
        .filter(|s| s.status == hexactra_core::SessionStatus::Running)
        .count() as u64;

    // Count pending operations (queued or in progress)
    let pending_operations = db_state
        .list_operations_by_status(hexactra_core::OperationStatus::Queued)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .into_iter()
        .filter(|o| o.status == hexactra_core::OperationStatus::InProgress)
        .count() as u64;

    Ok(Json(HealthMetrics {
        timestamp: now.to_rfc3339(),
        uptime_seconds: 0, // Would need start time tracking
        active_sessions,
        pending_operations,
    }))
}
