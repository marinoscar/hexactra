use axum::{Router, routing::{get, post}};

pub fn router() -> Router {
    Router::new()
        .route("/", get(list_sessions))
        .route("/", post(create_session))
}

async fn list_sessions() -> &'static str {
    "List sessions"
}

async fn create_session() -> &'static str {
    "Create session"
}
