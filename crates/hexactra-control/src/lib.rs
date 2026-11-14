//! Control plane API for Hexactra

pub mod auth;
pub mod config;
pub mod db;
pub mod leader_election;
pub mod redact;
pub mod routes {
    pub mod durable_actions;
    pub mod fleet;
    pub mod goals;
    pub mod hitl_broker;
    pub mod hosts;
    pub mod interaction_requests;
    pub mod mcp;
    pub mod operations;
    pub mod session_lifecycle;
    pub mod sessions;
    pub mod viewers;
}
pub mod scheduler;
pub mod state;

use crate::config::Config;
use crate::state::DbState;
use axum::{routing::get, Router};

/// Create the main application router
pub fn create_router(_config: &Config, db_state: DbState) -> Router<DbState> {
    Router::new()
        .with_state(db_state.clone())
        .route("/health", get(health))
        .merge(routes::sessions::router())
        .merge(routes::hosts::router())
        .merge(routes::session_lifecycle::router())
        .merge(routes::viewers::router())
        .merge(routes::hitl_broker::router())
        .merge(routes::mcp::router(db_state.clone()))
        .merge(routes::fleet::router())
}

/// Health check endpoint
async fn health() -> &'static str {
    "OK"
}

// Re-export types from core for convenience
pub use hexactra_core::{
    BrowserAction, Capability, Goal, Host, HostId, HostStatus, InteractionRequest, Operation,
    Session,
};
