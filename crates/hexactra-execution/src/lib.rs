//! Agent execution policy, budgets, retries and control takeover for Hexactra
//!
//! This crate implements:
//! - Execution policy (max steps, elapsed time, token/cost caps, model request timeouts)
//! - Per-site allowlist and high-impact action gate
//! - Suspend agent while human lease active
//! - Never blindly replay unknown non-idempotent actions

pub mod execution_policy;
pub mod budget_tracker;
pub mod retry_manager;
pub mod control_takeover;

// Re-export key types for convenience
pub use execution_policy::ExecutionPolicy;
pub use budget_tracker::BudgetTracker;
pub use retry_manager::RetryManager;
pub use control_takeover::{ControlTakeoverManager, HumanLeaseId};

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Unique identifier for an agent execution session
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ExecutionSessionId(Uuid);

impl ExecutionSessionId {
    pub fn new() -> Self {
        ExecutionSessionId(Uuid::new_v4())
    }

    pub fn from_uuid(uuid: Uuid) -> Self {
        ExecutionSessionId(uuid)
    }

    pub fn as_uuid(&self) -> Uuid {
        self.0
    }
}

impl Default for ExecutionSessionId {
    fn default() -> Self {
        Self::new()
    }
}

impl From<ExecutionSessionId> for Uuid {
    fn from(id: ExecutionSessionId) -> Self {
        id.0
    }
}

impl From<Uuid> for ExecutionSessionId {
    fn from(uuid: Uuid) -> Self {
        ExecutionSessionId::from_uuid(uuid)
    }
}

/// Agent execution state
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ExecutionState {
    /// Initial state, waiting for start
    Idle,
    /// Currently executing
    Running,
    /// Paused due to human lease or policy
    Paused {
        reason: PauseReason,
    },
    /// Completed successfully
    Completed,
    /// Failed with an error
    Failed {
        error: String,
        last_step: u32,
    },
    /// Cancelled by user
    Cancelled,
}

/// Reason for pausing execution
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum PauseReason {
    /// Human lease is active
    HumanLeaseActive,
    /// Budget exhausted
    BudgetExhausted,
    /// Time limit reached
    TimeLimitReached,
    /// Max steps reached
    MaxStepsReached,
    /// Policy violation
    PolicyViolation(String),
}

/// Execution session that combines all execution components
pub struct ExecutionSession {
    session_id: ExecutionSessionId,
    run_id: Uuid,
    state: ExecutionState,
    policy: ExecutionPolicy,
    budget: BudgetTracker,
    retry_manager: RetryManager,
    control_takeover: ControlTakeoverManager,
    created_at: DateTime<Utc>,
    last_heartbeat: DateTime<Utc>,
}

impl ExecutionSession {
    /// Create a new execution session
    pub fn new(run_id: Uuid, policy: ExecutionPolicy) -> Self {
        let session_id = ExecutionSessionId::new();
        
        Self {
            session_id,
            run_id,
            state: ExecutionState::Idle,
            policy: policy.clone(),
            budget: BudgetTracker::new(policy.budget_tokens),
            retry_manager: RetryManager::new(policy.max_retries),
            control_takeover: ControlTakeoverManager::new(),
            created_at: Utc::now(),
            last_heartbeat: Utc::now(),
        }
    }

    /// Get the session ID
    pub fn session_id(&self) -> ExecutionSessionId {
        self.session_id
    }

    /// Get the run ID
    pub fn run_id(&self) -> Uuid {
        self.run_id
    }

    /// Get the current state
    pub fn state(&self) -> &ExecutionState {
        &self.state
    }

    /// Start execution
    pub fn start(&mut self) {
        self.state = ExecutionState::Running;
        self.last_heartbeat = Utc::now();
    }

    /// Check if execution can proceed
    pub fn can_proceed(&self) -> Result<bool> {
        match &self.state {
            ExecutionState::Running => Ok(true),
            ExecutionState::Paused { reason } => {
                // Can only resume from human lease pause
                match reason {
                    PauseReason::HumanLeaseActive => Ok(false),
                    _ => Ok(true),
                }
            }
            _ => Ok(false),
        }
    }

    /// Check if execution should continue based on policy
    pub fn should_continue(&self) -> bool {
        match &self.state {
            ExecutionState::Running => {
                // Check time limit
                let elapsed = Utc::now() - self.created_at;
                if elapsed > self.policy.max_duration {
                    return false;
                }

                // Check step limit
                // Note: we would track steps in a real implementation

                // Check budget
                if !self.budget.has_budget() {
                    return false;
                }

                true
            }
            _ => false,
        }
    }

    /// Record a heartbeat
    pub fn heartbeat(&mut self) {
        self.last_heartbeat = Utc::now();
    }

    /// Get the remaining budget
    pub fn remaining_budget(&self) -> u32 {
        self.budget.remaining()
    }

    /// Try to use budget tokens
    pub fn use_budget(&mut self, tokens: u32) -> Result<bool> {
        self.budget.use_tokens(tokens)
    }

    /// Record a retry attempt
    pub fn record_retry(&mut self, success: bool) {
        self.retry_manager.record_attempt(success);
    }

    /// Check if we can retry
    pub fn can_retry(&self) -> bool {
        self.retry_manager.can_retry()
    }

    /// Take control (e.g., from human intervention)
    pub fn take_control(&mut self, reason: PauseReason) {
        self.state = ExecutionState::Paused { reason };
    }

    /// Release control (resume execution)
    pub fn release_control(&mut self) {
        if let ExecutionState::Paused { .. } = &self.state {
            self.state = ExecutionState::Running;
        }
    }

    /// Complete execution
    pub fn complete(&mut self) {
        self.state = ExecutionState::Completed;
    }

    /// Fail execution
    pub fn fail(&mut self, error: impl Into<String>, last_step: u32) {
        self.state = ExecutionState::Failed {
            error: error.into(),
            last_step,
        };
    }

    /// Cancel execution
    pub fn cancel(&mut self) {
        self.state = ExecutionState::Cancelled;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_execution_session_creation() {
        let run_id = Uuid::new_v4();
        let policy = ExecutionPolicy::default();
        let session = ExecutionSession::new(run_id, policy);

        assert_eq!(session.run_id(), run_id);
        assert_eq!(session.state(), &ExecutionState::Idle);
    }

    #[test]
    fn test_execution_state_transitions() {
        let run_id = Uuid::new_v4();
        let policy = ExecutionPolicy::default();
        let mut session = ExecutionSession::new(run_id, policy);

        // Start
        session.start();
        assert_eq!(session.state(), &ExecutionState::Running);

        // Pause due to human lease
        session.take_control(PauseReason::HumanLeaseActive);
        assert_eq!(session.state(), &ExecutionState::Paused { reason: PauseReason::HumanLeaseActive });

        // Release control
        session.release_control();
        assert_eq!(session.state(), &ExecutionState::Running);

        // Complete
        session.complete();
        assert_eq!(session.state(), &ExecutionState::Completed);
    }

    #[test]
    fn test_budget_tracking() {
        let run_id = Uuid::new_v4();
        let mut policy = ExecutionPolicy::default();
        policy.budget_tokens = Some(1000);

        let mut session = ExecutionSession::new(run_id, policy);

        // Check initial budget
        assert_eq!(session.remaining_budget(), 1000);

        // Use some tokens
        assert!(session.use_budget(500).unwrap());
        assert_eq!(session.remaining_budget(), 500);

        // Use more tokens
        assert!(session.use_budget(400).unwrap());
        assert_eq!(session.remaining_budget(), 100);

        // Try to use more than available
        assert!(!session.use_budget(200).unwrap());
    }

    #[test]
    fn test_retry_manager() {
        let run_id = Uuid::new_v4();
        let policy = ExecutionPolicy::default();
        let mut session = ExecutionSession::new(run_id, policy);

        // Should be able to retry initially
        assert!(session.can_retry());

        // Record some failures
        for _ in 0..2 {
            session.record_retry(false);
        }

        // Should still be able to retry (max_retries is 3)
        assert!(session.can_retry());
    }
}
