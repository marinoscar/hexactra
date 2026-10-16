use axum::{Router, routing::get};

pub fn router() -> Router {
    Router::new()
        .route("/", get(list_operations))
        .route("/{operation_id}", get(get_operation))
}

async fn list_operations() -> &'static str {
    "List operations"
}

async fn get_operation() -> &'static str {
    "Get operation"
}
