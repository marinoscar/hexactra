//! Control plane API for Hexactra

pub mod routes {
    pub mod sessions;
    pub mod goals;
}
pub mod state;
pub mod auth;

use axum::{Router, routing};

/// Create the main application router
pub fn create_router() -> Router {
    Router::new()
        .route("/health", routing::get(health))
        .nest("/sessions", routes::sessions::router())
        .nest("/goals", routes::goals::router())
}

/// Health check endpoint
async fn health() -> &'static str {
    "OK"
}
