use axum::{
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use hexactra_core::{BrowserAction, Goal, GoalId, RunStatus};

use crate::state::DbState;

// ==================== Request/Response Types ====================

#[derive(Debug, Deserialize, Serialize)]
pub struct CreateGoalRequest {
    pub session_id: Uuid,
    pub actions: Vec<BrowserAction>,
}

#[derive(Debug, Serialize)]
pub struct CreateGoalResponse {
    pub goal: GoalResponse,
}

#[derive(Debug, Serialize)]
pub struct GoalResponse {
    pub id: Uuid,
    pub session_id: Uuid,
    pub actions: Vec<BrowserAction>,
    pub created_at: String,
    pub status: String,
}

#[derive(Debug, Serialize)]
pub struct ListGoalsResponse {
    pub goals: Vec<GoalResponse>,
}

// ==================== Goal Routes ====================

pub fn router() -> Router {
    Router::new()
        .route("/", get(list_goals).post(create_goal))
        .route("/{goal_id}", get(get_goal))
}

async fn list_goals() -> &'static str {
    "List goals"
}

async fn create_goal() -> &'static str {
    "Create goal"
}

async fn get_goal() -> &'static str {
    "Get goal"
}
