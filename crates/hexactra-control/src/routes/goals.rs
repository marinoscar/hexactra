use axum::{Router, routing::get};

pub fn router() -> Router {
    Router::new().route("/", get(list_goals))
}

async fn list_goals() -> &'static str {
    "List goals"
}
