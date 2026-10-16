use axum::{Router, routing::{get, post}};

pub fn router() -> Router {
    Router::new()
        .route("/", get(list_requests).post(create_request))
        .route("/{request_id}/approve", post(approve_request))
        .route("/{request_id}/reject", post(reject_request))
}

async fn list_requests() -> &'static str {
    "List interaction requests"
}

async fn create_request() -> &'static str {
    "Create interaction request"
}

async fn approve_request() -> &'static str {
    "Approve interaction request"
}

async fn reject_request() -> &'static str {
    "Reject interaction request"
}
