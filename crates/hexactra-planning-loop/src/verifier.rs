//! Verifier module for observing after-state and replanning

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{ActionResult, Observation, VerificationResult};

/// Verification strategy interface
#[async_trait]
pub trait VerificationStrategy: Send + Sync {
    async fn verify(&self, action_result: &ActionResult, previous_observation: &Observation) -> Result<VerificationResult>;
}

/// DOM-based verification strategy
pub struct DomVerificationStrategy {
    previous_dom: Option<serde_json::Value>,
}

impl DomVerificationStrategy {
    pub fn new() -> Self {
        Self { previous_dom: None }
    }

    pub fn with_previous_dom(dom: serde_json::Value) -> Self {
        Self {
            previous_dom: Some(dom),
        }
    }

    fn dom_changed(&self, current_dom: &serde_json::Value) -> bool {
        match &self.previous_dom {
            Some(previous) => previous != current_dom,
            None => true,
        }
    }
}

#[async_trait]
impl VerificationStrategy for DomVerificationStrategy {
    async fn verify(
        &self,
        action_result: &ActionResult,
        _previous_observation: &Observation,
    ) -> Result<VerificationResult> {
        // In a real implementation, this would compare DOM snapshots
        // For now, assume success and no DOM change if action succeeded
        Ok(VerificationResult {
            step_number: 0,
            success: action_result.success,
            evidence: Some(serde_json::json!({"action_success": action_result.success})),
            dom_changed: false,
        })
    }
}

/// Goal-based verification strategy
pub struct GoalVerificationStrategy {
    goal: String,
    expected_outcome: serde_json::Value,
}

impl GoalVerificationStrategy {
    pub fn new(goal: impl Into<String>, expected_outcome: serde_json::Value) -> Self {
        Self {
            goal: goal.into(),
            expected_outcome,
        }
    }
}

#[async_trait]
impl VerificationStrategy for GoalVerificationStrategy {
    async fn verify(
        &self,
        action_result: &ActionResult,
        _previous_observation: &Observation,
    ) -> Result<VerificationResult> {
        // Check if the action result indicates goal completion
        let success = action_result.success;
        
        Ok(VerificationResult {
            step_number: 0,
            success,
            evidence: Some(serde_json::json!({
                "goal": self.goal,
                "expected": self.expected_outcome,
                "actual_success": success,
            })),
            dom_changed: false,
        })
    }
}

/// Verifier that uses a strategy to verify action results
pub struct Verifier<S: VerificationStrategy> {
    strategy: S,
}

impl<S: VerificationStrategy> Verifier<S> {
    pub fn new(strategy: S) -> Self {
        Self { strategy }
    }

    pub async fn verify(
        &self,
        action_result: &ActionResult,
        previous_observation: &Observation,
    ) -> Result<VerificationResult> {
        self.strategy.verify(action_result, previous_observation).await
    }
}

/// Builder for verification results
pub struct VerificationResultBuilder {
    step_number: u32,
    success: bool,
    evidence: Option<serde_json::Value>,
    dom_changed: bool,
}

impl VerificationResultBuilder {
    pub fn new(step_number: u32) -> Self {
        Self {
            step_number,
            success: false,
            evidence: None,
            dom_changed: false,
        }
    }

    pub fn success(mut self, success: bool) -> Self {
        self.success = success;
        self
    }

    pub fn evidence(mut self, evidence: serde_json::Value) -> Self {
        self.evidence = Some(evidence);
        self
    }

    pub fn dom_changed(mut self, changed: bool) -> Self {
        self.dom_changed = changed;
        self
    }

    pub fn build(self) -> VerificationResult {
        VerificationResult {
            step_number: self.step_number,
            success: self.success,
            evidence: self.evidence,
            dom_changed: self.dom_changed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Import ObservationBuilder for tests
    use crate::ObservationBuilder;

    #[tokio::test]
    async fn test_dom_verification_strategy_success() {
        let strategy = DomVerificationStrategy::new();
        let action_result = ActionResult {
            success: true,
            error: None,
            timestamp: Utc::now(),
        };
        let observation = ObservationBuilder::new(Uuid::new_v4()).build();

        let result = strategy.verify(&action_result, &observation).await;
        
        assert!(result.is_ok());
        let verification = result.unwrap();
        assert!(verification.success);
    }

    #[tokio::test]
    async fn test_dom_verification_strategy_failure() {
        let strategy = DomVerificationStrategy::new();
        let action_result = ActionResult {
            success: false,
            error: Some("Element not found".to_string()),
            timestamp: Utc::now(),
        };
        let observation = ObservationBuilder::new(Uuid::new_v4()).build();

        let result = strategy.verify(&action_result, &observation).await;
        
        assert!(result.is_ok());
        let verification = result.unwrap();
        assert!(!verification.success);
        assert_eq!(verification.evidence.unwrap()["action_success"], false);
    }

    #[tokio::test]
    async fn test_goal_verification_strategy() {
        let strategy = GoalVerificationStrategy::new(
            "Submit the form",
            serde_json::json!({"form_submitted": true}),
        );
        let action_result = ActionResult {
            success: true,
            error: None,
            timestamp: Utc::now(),
        };
        let observation = ObservationBuilder::new(Uuid::new_v4()).build();

        let result = strategy.verify(&action_result, &observation).await;
        
        assert!(result.is_ok());
        let verification = result.unwrap();
        assert!(verification.success);
        assert!(verification.evidence.is_some());
    }

    #[test]
    fn test_verification_result_builder() {
        let result = VerificationResultBuilder::new(5)
            .success(true)
            .evidence(serde_json::json!({"test": "data"}))
            .dom_changed(true)
            .build();

        assert_eq!(result.step_number, 5);
        assert!(result.success);
        assert_eq!(result.evidence, Some(serde_json::json!({"test": "data"})));
        assert!(result.dom_changed);
    }

    #[tokio::test]
    async fn test_verifier_with_dom_strategy() {
        let strategy = DomVerificationStrategy::new();
        let verifier = Verifier::new(strategy);

        let action_result = ActionResult {
            success: true,
            error: None,
            timestamp: Utc::now(),
        };
        let observation = ObservationBuilder::new(Uuid::new_v4()).build();

        let result = verifier.verify(&action_result, &observation).await;
        assert!(result.is_ok());
    }
}
