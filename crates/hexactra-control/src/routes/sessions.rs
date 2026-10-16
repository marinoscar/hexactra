use axum::{Router, routing::get};

pub fn router() -> Router {
    Router::new().route("/", get(list_sessions))
}

async fn list_sessions() -> &'static str {
    "List sessions"
}
