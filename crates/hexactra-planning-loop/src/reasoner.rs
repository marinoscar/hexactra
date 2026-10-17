//! Reasoner module for submitting typed action proposals from model

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{ActionProposal, Observation};

/// Model adapter interface for getting action proposals
#[async_trait]
pub trait ModelAdapter: Send + Sync {
    async fn get_action_proposal(
        &self,
        observations: &[Observation],
        context: &ReasoningContext,
    ) -> Result<ActionProposal>;
}

/// Context for reasoning about actions
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReasoningContext {
    pub session_id: Uuid,
    pub goal: String,
    pub available_actions: Vec<String>,
    pub max_steps: u32,
    pub current_step: u32,
    pub budget_remaining: Option<u32>,
}

impl ReasoningContext {
    pub fn new(session_id: Uuid, goal: impl Into<String>) -> Self {
        Self {
            session_id,
            goal: goal.into(),
            available_actions: vec![],
            max_steps: 100,
            current_step: 0,
            budget_remaining: None,
        }
    }

    pub fn with_available_actions(mut self, actions: Vec<String>) -> Self {
        self.available_actions = actions;
        self
    }

    pub fn with_max_steps(mut self, steps: u32) -> Self {
        self.max_steps = steps;
        self
    }

    pub fn with_current_step(mut self, step: u32) -> Self {
        self.current_step = step;
        self
    }

    pub fn with_budget_remaining(mut self, tokens: Option<u32>) -> Self {
        self.budget_remaining = tokens;
        self
    }
}

/// Reasoner that uses a model adapter to generate action proposals
pub struct Reasoner<A: ModelAdapter> {
    model_adapter: A,
}

impl<A: ModelAdapter> Reasoner<A> {
    pub fn new(model_adapter: A) -> Self {
        Self { model_adapter }
    }

    pub async fn reason(
        &self,
        observations: &[Observation],
        context: &ReasoningContext,
    ) -> Result<ActionProposal> {
        self.model_adapter.get_action_proposal(observations, context).await
    }
}

/// Builder for creating action proposals
pub struct ActionProposalBuilder {
    step_number: u32,
    action_type: String,
    parameters: serde_json::Value,
    reasoning: String,
}

impl ActionProposalBuilder {
    pub fn new(step_number: u32) -> Self {
        Self {
            step_number,
            action_type: String::new(),
            parameters: serde_json::json!({}),
            reasoning: String::new(),
        }
    }

    pub fn action_type(mut self, action: impl Into<String>) -> Self {
        self.action_type = action.into();
        self
    }

    pub fn parameters(mut self, params: serde_json::Value) -> Self {
        self.parameters = params;
        self
    }

    pub fn reasoning(mut self, reason: impl Into<String>) -> Self {
        self.reasoning = reason.into();
        self
    }

    pub fn build(self) -> ActionProposal {
        ActionProposal {
            step_number: self.step_number,
            action_type: self.action_type,
            parameters: self.parameters,
            reasoning: self.reasoning,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Import builders for tests
    use crate::ObservationBuilder;

    struct TestModelAdapter;

    #[async_trait]
    impl ModelAdapter for TestModelAdapter {
        async fn get_action_proposal(
            &self,
            _observations: &[Observation],
            context: &ReasoningContext,
        ) -> Result<ActionProposal> {
            Ok(ActionProposalBuilder::new(context.current_step)
                .action_type("click")
                .parameters(serde_json::json!({"selector": "#submit"}))
                .reasoning(format!("Goal: {}", context.goal))
                .build())
        }
    }

    #[tokio::test]
    async fn test_reasoner() {
        let observations = vec![
            ObservationBuilder::new(Uuid::new_v4())
                .page_url("https://example.com")
                .build(),
        ];

        let context = ReasoningContext::new(Uuid::new_v4(), "Click the submit button")
            .with_current_step(1)
            .with_max_steps(10);

        let model_adapter = TestModelAdapter;
        let reasoner = Reasoner::new(model_adapter);

        let result = reasoner.reason(&observations, &context).await;
        assert!(result.is_ok());

        let proposal = result.unwrap();
        assert_eq!(proposal.step_number, 1);
        assert_eq!(proposal.action_type, "click");
    }

    #[test]
    fn test_action_proposal_builder() {
        let proposal = ActionProposalBuilder::new(5)
            .action_type("type")
            .parameters(serde_json::json!({"text": "hello"}))
            .reasoning("Type hello into the input field")
            .build();

        assert_eq!(proposal.step_number, 5);
        assert_eq!(proposal.action_type, "type");
        assert_eq!(
            proposal.parameters,
            serde_json::json!({"text": "hello"})
        );
        assert_eq!(
            proposal.reasoning,
            "Type hello into the input field"
        );
    }

    #[test]
    fn test_reasoning_context_builder() {
        let context = ReasoningContext::new(Uuid::new_v4(), "Test goal")
            .with_available_actions(vec!["click".to_string(), "type".to_string()])
            .with_max_steps(50)
            .with_current_step(3)
            .with_budget_remaining(Some(50000));

        assert_eq!(context.goal, "Test goal");
        assert_eq!(context.available_actions, vec!["click", "type"]);
        assert_eq!(context.max_steps, 50);
        assert_eq!(context.current_step, 3);
        assert_eq!(context.budget_remaining, Some(50000));
    }
}
