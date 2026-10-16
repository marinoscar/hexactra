//! Control plane API for Hexactra

pub mod config;
pub mod redact;
pub mod routes {
    pub mod sessions;
    pub mod goals;
}
pub mod state;
pub mod auth;

use axum::{Router, routing::get};
use crate::config::Config;

/// Create the main application router
pub fn create_router(_config: &Config) -> Router {
    Router::new()
        .route("/health", get(health))
        .nest("/sessions", routes::sessions::router())
        .nest("/goals", routes::goals::router())
}

/// Health check endpoint
async fn health() -> &'static str {
    "OK"
}
