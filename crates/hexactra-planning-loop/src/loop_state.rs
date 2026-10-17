//! Loop state module for tracking planning loop state

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{ActionProposal, Observation, VerificationResult};

/// State of a planning loop iteration
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum LoopState {
    /// Initial state, waiting for first observation
    Idle,
    /// Currently observing the environment
    Observing,
    /// Reasoning about the next action
    Reasoning,
    /// Dispatching an action
    Dispatching,
    /// Verifying the action result
    Verifying,
    /// Paused, waiting for user input
    Paused,
    /// Completed successfully
    Completed,
    /// Failed with an error
    Failed {
        error: String,
        last_step: u32,
    },
}

/// Full state of the planning loop
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopStateContainer {
    pub iteration_id: Uuid,
    pub run_id: Uuid,
    pub step_number: u32,
    pub state: LoopState,
    pub observations: Vec<Observation>,
    pub proposals: Vec<ActionProposal>,
    pub verification_results: Vec<VerificationResult>,
    pub created_at: DateTime<Utc>,
    pub last_updated: DateTime<Utc>,
}

impl LoopStateContainer {
    pub fn new(run_id: Uuid, iteration_id: Uuid) -> Self {
        Self {
            iteration_id,
            run_id,
            step_number: 0,
            state: LoopState::Idle,
            observations: Vec::new(),
            proposals: Vec::new(),
            verification_results: Vec::new(),
            created_at: Utc::now(),
            last_updated: Utc::now(),
        }
    }

    pub fn with_step(mut self, step: u32) -> Self {
        self.step_number = step;
        self.last_updated = Utc::now();
        self
    }

    pub fn with_state(mut self, state: LoopState) -> Self {
        self.state = state;
        self.last_updated = Utc::now();
        self
    }

    pub fn with_observation(mut self, observation: Observation) -> Self {
        self.observations.push(observation);
        self.last_updated = Utc::now();
        self
    }

    pub fn with_proposal(mut self, proposal: ActionProposal) -> Self {
        self.proposals.push(proposal);
        self.last_updated = Utc::now();
        self
    }

    pub fn with_verification_result(mut self, result: VerificationResult) -> Self {
        self.verification_results.push(result);
        self.last_updated = Utc::now();
        self
    }
}

/// State transition error
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum StateTransitionError {
    InvalidTransition {
        from: LoopState,
        to: LoopState,
    },
    InvalidStep {
        current: u32,
        expected: u32,
    },
    InvalidObservation,
    InvalidProposal,
}

impl std::fmt::Display for StateTransitionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StateTransitionError::InvalidTransition { from, to } => {
                write!(f, "Invalid transition from {:?} to {:?}", from, to)
            }
            StateTransitionError::InvalidStep { current, expected } => {
                write!(f, "Invalid step: current={}, expected={}", current, expected)
            }
            StateTransitionError::InvalidObservation => {
                write!(f, "Invalid observation")
            }
            StateTransitionError::InvalidProposal => {
                write!(f, "Invalid proposal")
            }
        }
    }
}

impl std::error::Error for StateTransitionError {}

/// State machine for the planning loop
#[derive(Clone)]
pub struct LoopStateMachine {
    state: LoopStateContainer,
    max_iterations: u32,
}

impl LoopStateMachine {
    pub fn new(run_id: Uuid, iteration_id: Uuid, max_iterations: u32) -> Self {
        Self {
            state: LoopStateContainer::new(run_id, iteration_id),
            max_iterations,
        }
    }

    pub fn current_state(&self) -> &LoopState {
        &self.state.state
    }

    pub fn step_number(&self) -> u32 {
        self.state.step_number
    }

    pub fn can_transition_to(&self, target: LoopState) -> Result<(), StateTransitionError> {
        let target_clone = target.clone();
        match (&self.state.state, target) {
            (LoopState::Idle, LoopState::Observing) => Ok(()),
            (LoopState::Observing, LoopState::Reasoning) => Ok(()),
            (LoopState::Reasoning, LoopState::Dispatching) => Ok(()),
            (LoopState::Dispatching, LoopState::Verifying) => Ok(()),
            (LoopState::Verifying, LoopState::Observing) => Ok(()),
            (LoopState::Verifying, LoopState::Completed) => Ok(()),
            (LoopState::Verifying, LoopState::Failed { .. }) => Ok(()),
            (LoopState::Verifying, LoopState::Paused) => Ok(()),
            (LoopState::Paused, LoopState::Observing) => Ok(()),
            _ => Err(StateTransitionError::InvalidTransition {
                from: self.state.state.clone(),
                to: target_clone,
            }),
        }
    }

    pub fn transition_to(mut self, target: LoopState) -> Result<Self, StateTransitionError> {
        let target_clone = target.clone();
        self.can_transition_to(target)?;
        self.state.state = target_clone;
        self.state.last_updated = Utc::now();
        Ok(self)
    }

    pub fn advance_step(&mut self) -> Result<(), StateTransitionError> {
        if self.state.step_number >= self.max_iterations {
            return Err(StateTransitionError::InvalidStep {
                current: self.state.step_number,
                expected: self.max_iterations,
            });
        }
        self.state.step_number += 1;
        self.state.last_updated = Utc::now();
        Ok(())
    }

    pub fn record_observation(&mut self, observation: Observation) {
        self.state.observations.push(observation);
        self.state.last_updated = Utc::now();
    }

    pub fn record_proposal(&mut self, proposal: ActionProposal) {
        self.state.proposals.push(proposal);
        self.state.last_updated = Utc::now();
    }

    pub fn record_verification_result(&mut self, result: VerificationResult) {
        self.state.verification_results.push(result);
        self.state.last_updated = Utc::now();
    }

    pub fn fail(mut self, error: impl Into<String>) -> Self {
        self.state.state = LoopState::Failed {
            error: error.into(),
            last_step: self.state.step_number,
        };
        self.state.last_updated = Utc::now();
        self
    }

    pub fn complete(mut self) -> Self {
        self.state.state = LoopState::Completed;
        self.state.last_updated = Utc::now();
        self
    }

    pub fn pause(mut self) -> Self {
        self.state.state = LoopState::Paused;
        self.state.last_updated = Utc::now();
        self
    }

    pub fn resume(mut self) -> Result<Self, StateTransitionError> {
        self.can_transition_to(LoopState::Observing)?;
        self.state.state = LoopState::Observing;
        self.state.last_updated = Utc::now();
        Ok(self)
    }

    pub fn state_container(&self) -> &LoopStateContainer {
        &self.state
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Import builders for tests
    use crate::{ActionProposalBuilder, ObservationBuilder, VerificationResultBuilder};

    #[test]
    fn test_loop_state_container_new() {
        let run_id = Uuid::new_v4();
        let iteration_id = Uuid::new_v4();
        let state = LoopStateContainer::new(run_id, iteration_id);

        assert_eq!(state.run_id, run_id);
        assert_eq!(state.iteration_id, iteration_id);
        assert_eq!(state.step_number, 0);
        assert_eq!(state.state, LoopState::Idle);
    }

    #[test]
    fn test_state_transitions() {
        let run_id = Uuid::new_v4();
        let iteration_id = Uuid::new_v4();
        let mut machine = LoopStateMachine::new(run_id, iteration_id, 100);

        // Test valid transitions
        assert!(machine.can_transition_to(LoopState::Observing).is_ok());
        
        machine = machine.transition_to(LoopState::Observing).unwrap();
        assert!(machine.can_transition_to(LoopState::Reasoning).is_ok());

        machine = machine.transition_to(LoopState::Reasoning).unwrap();
        assert!(machine.can_transition_to(LoopState::Dispatching).is_ok());

        machine = machine.transition_to(LoopState::Dispatching).unwrap();
        assert!(machine.can_transition_to(LoopState::Verifying).is_ok());

        machine = machine.transition_to(LoopState::Verifying).unwrap();
        assert!(machine.can_transition_to(LoopState::Observing).is_ok());
    }

    #[test]
    fn test_invalid_state_transitions() {
        let run_id = Uuid::new_v4();
        let iteration_id = Uuid::new_v4();
        let machine = LoopStateMachine::new(run_id, iteration_id, 100);

        // Cannot go from Idle directly to Reasoning
        assert!(machine.can_transition_to(LoopState::Reasoning).is_err());
    }

    #[test]
    fn test_advance_step() {
        let run_id = Uuid::new_v4();
        let iteration_id = Uuid::new_v4();
        let mut machine = LoopStateMachine::new(run_id, iteration_id, 100);

        assert_eq!(machine.step_number(), 0);
        
        machine.advance_step().unwrap();
        assert_eq!(machine.step_number(), 1);

        machine.advance_step().unwrap();
        assert_eq!(machine.step_number(), 2);
    }

    #[test]
    fn test_max_iterations() {
        let run_id = Uuid::new_v4();
        let iteration_id = Uuid::new_v4();
        let mut machine = LoopStateMachine::new(run_id, iteration_id, 2);

        machine.advance_step().unwrap();
        machine.advance_step().unwrap();
        
        // Third step should fail
        assert!(machine.advance_step().is_err());
    }

    #[test]
    fn test_record_methods() {
        let run_id = Uuid::new_v4();
        let iteration_id = Uuid::new_v4();
        let mut machine = LoopStateMachine::new(run_id, iteration_id, 100);

        let observation = ObservationBuilder::new(run_id).build();
        machine.record_observation(observation);
        assert_eq!(machine.state_container().observations.len(), 1);

        let proposal = ActionProposalBuilder::new(1).build();
        machine.record_proposal(proposal);
        assert_eq!(machine.state_container().proposals.len(), 1);

        let result = VerificationResultBuilder::new(1).build();
        machine.record_verification_result(result);
        assert_eq!(machine.state_container().verification_results.len(), 1);
    }

    #[test]
    fn test_complete_and_fail() {
        let run_id = Uuid::new_v4();
        let iteration_id = Uuid::new_v4();
        let machine = LoopStateMachine::new(run_id, iteration_id, 100);

        // Go through valid transitions: Idle -> Observing -> Reasoning -> Dispatching -> Verifying
        let machine = machine.transition_to(LoopState::Observing).unwrap();
        let machine = machine.transition_to(LoopState::Reasoning).unwrap();
        let machine = machine.transition_to(LoopState::Dispatching).unwrap();
        let machine = machine.transition_to(LoopState::Verifying).unwrap();
        
        let completed = machine.clone().complete();
        assert_eq!(completed.current_state(), &LoopState::Completed);

        let failed = machine.fail("Test error");
        match failed.current_state() {
            LoopState::Failed { error, last_step } => {
                assert_eq!(error, "Test error");
                assert_eq!(*last_step, 0);
            }
            _ => panic!("Expected Failed state"),
        }
    }

    #[test]
    fn test_pause_and_resume() {
        let run_id = Uuid::new_v4();
        let iteration_id = Uuid::new_v4();
        let mut machine = LoopStateMachine::new(run_id, iteration_id, 100);

        // Go through valid transitions first
        machine = machine.transition_to(LoopState::Observing).unwrap();
        machine = machine.transition_to(LoopState::Reasoning).unwrap();
        machine = machine.transition_to(LoopState::Dispatching).unwrap();
        machine = machine.transition_to(LoopState::Verifying).unwrap();
        machine = machine.transition_to(LoopState::Paused).unwrap();
        assert_eq!(machine.current_state(), &LoopState::Paused);

        machine = machine.resume().unwrap();
        assert_eq!(machine.current_state(), &LoopState::Observing);
    }
}
