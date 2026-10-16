//! Control plane API for Hexactra

pub mod auth;
pub mod config;
pub mod db;
pub mod redact;
pub mod routes {
    pub mod goals;
    pub mod interaction_requests;
    pub mod operations;
    pub mod sessions;
}
pub mod state;

use axum::{Router, routing::get};
use crate::config::Config;
use crate::state::DbState;

/// Create the main application router
pub fn create_router(_config: &Config, db_state: DbState) -> Router {
    Router::new()
        .route("/health", get(health))
        .with_state(db_state)
}

/// Health check endpoint
async fn health() -> &'static str {
    "OK"
}

// Re-export types from core for convenience
pub use hexactra_core::{Goal, Session, Operation, InteractionRequest, BrowserAction};
