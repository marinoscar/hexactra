use axum::{Router, routing::{get, post}};

pub fn router() -> Router {
    Router::new()
        .route("/", get(list_goals))
        .route("/", post(create_goal))
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
