//! Managed observe→reason→action→verify planning loop for Hexactra
//!
//! This crate implements the agent's planning loop:
//! - Observe: Consume browser worker snapshots
//! - Reason: Submit typed action proposals from model
//! - Action: Validate and dispatch actions
//! - Verify: Observe after-state and replan

pub mod loop_state;
pub mod observer;
pub mod reasoner;
pub mod action_dispatcher;
pub mod verifier;

// Re-export builders for convenience
pub use observer::ObservationBuilder;
pub use reasoner::ActionProposalBuilder;
pub use verifier::VerificationResultBuilder;

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use uuid::Uuid;
use tracing::{info, warn};

/// Unique identifier for a planning loop iteration
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct LoopIterationId(Uuid);

impl LoopIterationId {
    pub fn new() -> Self {
        LoopIterationId(Uuid::new_v4())
    }

    pub fn from_uuid(uuid: Uuid) -> Self {
        LoopIterationId(uuid)
    }

    pub fn as_uuid(&self) -> Uuid {
        self.0
    }
}

impl Default for LoopIterationId {
    fn default() -> Self {
        Self::new()
    }
}

impl From<LoopIterationId> for Uuid {
    fn from(id: LoopIterationId) -> Self {
        id.0
    }
}

impl From<Uuid> for LoopIterationId {
    fn from(uuid: Uuid) -> Self {
        LoopIterationId::from_uuid(uuid)
    }
}

/// Agent observation from browser worker
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Observation {
    pub timestamp: DateTime<Utc>,
    pub session_id: Uuid,
    pub page_url: String,
    pub dom_snapshot: serde_json::Value,
    pub viewport_size: (u32, u32),
    pub focused_element: Option<String>,
}

/// Action proposal from model
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionProposal {
    pub step_number: u32,
    pub action_type: String,
    pub parameters: serde_json::Value,
    pub reasoning: String,
}

/// Action execution result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionResult {
    pub success: bool,
    pub error: Option<String>,
    pub timestamp: DateTime<Utc>,
}

/// Verification result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerificationResult {
    pub step_number: u32,
    pub success: bool,
    pub evidence: Option<serde_json::Value>,
    pub dom_changed: bool,
}

/// Planning loop configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopConfig {
    pub max_iterations: u32,
    pub step_timeout: Duration,
    pub budget_tokens: Option<u32>,
    pub allowlist_domains: Vec<String>,
}

impl Default for LoopConfig {
    fn default() -> Self {
        Self {
            max_iterations: 100,
            step_timeout: Duration::from_secs(30),
            budget_tokens: Some(100000),
            allowlist_domains: vec![],
        }
    }
}

/// Planning loop state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopState {
    pub iteration_id: LoopIterationId,
    pub run_id: Uuid,
    pub step_number: u32,
    pub observations: Vec<Observation>,
    pub proposals: Vec<ActionProposal>,
    pub action_results: Vec<ActionResult>,
    pub verification_results: Vec<VerificationResult>,
    pub created_at: DateTime<Utc>,
    pub last_heartbeat: DateTime<Utc>,
}

/// Managed planning loop
pub struct ManagedPlanningLoop {
    config: LoopConfig,
    state: LoopState,
}

impl ManagedPlanningLoop {
    /// Create a new managed planning loop
    pub fn new(run_id: Uuid, config: LoopConfig) -> Self {
        let state = LoopState {
            iteration_id: LoopIterationId::new(),
            run_id,
            step_number: 0,
            observations: Vec::new(),
            proposals: Vec::new(),
            action_results: Vec::new(),
            verification_results: Vec::new(),
            created_at: Utc::now(),
            last_heartbeat: Utc::now(),
        };

        Self { config, state }
    }

    /// Observe the current state
    pub fn observe(&mut self, observation: Observation) {
        self.state.observations.push(observation);
        self.state.last_heartbeat = Utc::now();
    }

    /// Reason about the next action
    pub fn reason(&mut self, _model_response: serde_json::Value) -> ActionProposal {
        // This would call the model adapter to get action proposals
        // For now, return a placeholder
        ActionProposal {
            step_number: self.state.step_number,
            action_type: "placeholder".to_string(),
            parameters: serde_json::json!({}),
            reasoning: "Placeholder reasoning".to_string(),
        }
    }

    /// Dispatch an action
    pub async fn dispatch_action(&mut self, _proposal: ActionProposal) -> Result<ActionResult> {
        // This would dispatch to the browser worker
        Ok(ActionResult {
            success: true,
            error: None,
            timestamp: Utc::now(),
        })
    }

    /// Verify the action result
    pub async fn verify(&mut self, _action_result: &ActionResult) -> Result<VerificationResult> {
        // This would verify the action result against expected state
        Ok(VerificationResult {
            step_number: self.state.step_number,
            success: true,
            evidence: None,
            dom_changed: false,
        })
    }

    /// Check if the loop should continue
    pub fn should_continue(&self) -> bool {
        self.state.step_number < self.config.max_iterations
    }

    /// Get the current state
    pub fn state(&self) -> &LoopState {
        &self.state
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_loop_iteration_id_default() {
        let id = LoopIterationId::default();
        assert!(id.as_uuid().get_version().is_some());
    }

    #[test]
    fn test_loop_config_default() {
        let config = LoopConfig::default();
        assert_eq!(config.max_iterations, 100);
        assert_eq!(config.step_timeout, Duration::from_secs(30));
    }

    #[test]
    fn test_managed_planning_loop_creation() {
        let run_id = Uuid::new_v4();
        let config = LoopConfig::default();
        let loop_instance = ManagedPlanningLoop::new(run_id, config);
        
        assert_eq!(loop_instance.state.step_number, 0);
        assert!(loop_instance.should_continue());
    }
}
