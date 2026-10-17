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
    pub mod hosts;
    pub mod session_lifecycle;
    pub mod viewers;
}
pub mod state;

use axum::{Router, routing::get};
use crate::config::Config;
use crate::state::DbState;

/// Create the main application router
pub fn create_router(_config: &Config, db_state: DbState) -> Router<DbState> {
    Router::new()
        .with_state(db_state)
        .route("/health", get(health))
        .merge(routes::sessions::router())
        .merge(routes::hosts::router())
        .merge(routes::session_lifecycle::router())
        .merge(routes::viewers::router())
}

/// Health check endpoint
async fn health() -> &'static str {
    "OK"
}

// Re-export types from core for convenience
pub use hexactra_core::{Goal, Session, Operation, InteractionRequest, BrowserAction, Host, HostId, HostStatus, Capability};
