//! Control plane API for Hexactra

pub mod routes {
    pub mod sessions;
    pub mod goals;
    pub mod operations;
    pub mod interaction;
}
pub mod state;
pub mod auth;

use axum::{Router, routing::get};
use hexactra_core::{GoalId, SessionId, RunStatus};

/// Create the main application router
pub fn create_router() -> Router {
    Router::new()
        .route("/health", get(health))
        .nest("/sessions", routes::sessions::router())
        .nest("/goals", routes::goals::router())
        .nest("/operations", routes::operations::router())
        .nest("/interaction-requests", routes::interaction::router())
}

/// Health check endpoint
async fn health() -> &'static str {
    "OK"
}

// Re-export types from core for convenience
pub use hexactra_core::{Goal, Session, Operation, InteractionRequest, BrowserAction};
