//! Action dispatcher module for validating and dispatching actions

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{ActionProposal, ActionResult};

/// Action dispatcher interface for executing actions
#[async_trait]
pub trait ActionDispatcher: Send + Sync {
    async fn dispatch(&self, proposal: &ActionProposal) -> Result<ActionResult>;
    fn supports_action_type(&self, action_type: &str) -> bool;
}

/// Browser action types supported by the dispatcher
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum BrowserActionType {
    Click,
    Type,
    Navigate,
    Screenshot,
    SelectOption,
    Hover,
    Scroll,
    PressKey,
}

impl BrowserActionType {
    pub fn as_str(&self) -> &'static str {
        match self {
            BrowserActionType::Click => "click",
            BrowserActionType::Type => "type",
            BrowserActionType::Navigate => "navigate",
            BrowserActionType::Screenshot => "screenshot",
            BrowserActionType::SelectOption => "select_option",
            BrowserActionType::Hover => "hover",
            BrowserActionType::Scroll => "scroll",
            BrowserActionType::PressKey => "press_key",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "click" => Some(BrowserActionType::Click),
            "type" => Some(BrowserActionType::Type),
            "navigate" => Some(BrowserActionType::Navigate),
            "screenshot" => Some(BrowserActionType::Screenshot),
            "select_option" => Some(BrowserActionType::SelectOption),
            "hover" => Some(BrowserActionType::Hover),
            "scroll" => Some(BrowserActionType::Scroll),
            "press_key" => Some(BrowserActionType::PressKey),
            _ => None,
        }
    }
}

/// Browser action parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserActionParams {
    pub session_id: Uuid,
    pub action_type: BrowserActionType,
    pub selector: Option<String>,
    pub text: Option<String>,
    pub url: Option<String>,
    pub x_offset: Option<i32>,
    pub y_offset: Option<i32>,
    pub key: Option<String>,
}

/// Browser worker dispatcher for executing browser actions
pub struct BrowserWorkerDispatcher {
    session_id: Uuid,
}

impl BrowserWorkerDispatcher {
    pub fn new(session_id: Uuid) -> Self {
        Self { session_id }
    }

    fn validate_proposal(&self, proposal: &ActionProposal) -> Result<BrowserActionParams> {
        let action_type = BrowserActionType::from_str(&proposal.action_type)
            .ok_or_else(|| anyhow::anyhow!("Unsupported action type: {}", proposal.action_type))?;

        let params = BrowserActionParams {
            session_id: self.session_id,
            action_type,
            selector: proposal.parameters.get("selector").and_then(|v| v.as_str().map(String::from)),
            text: proposal.parameters.get("text").and_then(|v| v.as_str().map(String::from)),
            url: proposal.parameters.get("url").and_then(|v| v.as_str().map(String::from)),
            x_offset: proposal.parameters.get("x_offset").and_then(|v| v.as_i64().map(|x| x as i32)),
            y_offset: proposal.parameters.get("y_offset").and_then(|v| v.as_i64().map(|y| y as i32)),
            key: proposal.parameters.get("key").and_then(|v| v.as_str().map(String::from)),
        };

        Ok(params)
    }
}

#[async_trait]
impl ActionDispatcher for BrowserWorkerDispatcher {
    async fn dispatch(&self, proposal: &ActionProposal) -> Result<ActionResult> {
        // Validate the proposal
        let params = self.validate_proposal(proposal)?;

        // In a real implementation, this would send the action to the browser worker
        // For now, simulate successful execution
        Ok(ActionResult {
            success: true,
            error: None,
            timestamp: Utc::now(),
        })
    }

    fn supports_action_type(&self, action_type: &str) -> bool {
        BrowserActionType::from_str(action_type).is_some()
    }
}

/// Validator for action proposals
pub struct ProposalValidator;

impl ProposalValidator {
    pub fn validate(proposal: &ActionProposal) -> Result<()> {
        if proposal.action_type.is_empty() {
            return Err(anyhow::anyhow!("Action type cannot be empty"));
        }

        if proposal.step_number == 0 {
            return Err(anyhow::anyhow!("Step number must be greater than 0"));
        }

        // Validate parameters is an object
        if !proposal.parameters.is_object() {
            return Err(anyhow::anyhow!("Parameters must be a JSON object"));
        }

        Ok(())
    }

    pub fn validate_with_domain(proposal: &ActionProposal, domain: &str) -> Result<()> {
        Self::validate(proposal)?;

        // Check if the action is allowed for this domain
        let binding = serde_json::Map::new();
        let params = proposal.parameters.as_object().unwrap_or(&binding);
        
        // Example: check URL in parameters against domain
        let url_str = params.get("url").and_then(|v| v.as_str());
        
        if let Some(url) = url_str {
            if !url.starts_with(domain) {
                return Err(anyhow::anyhow!(
                    "Action URL {} does not match allowed domain {}",
                    url,
                    domain
                ));
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Import builders for tests
    use crate::ActionProposalBuilder;

    #[test]
    fn test_browser_action_type_from_str() {
        assert_eq!(BrowserActionType::from_str("click"), Some(BrowserActionType::Click));
        assert_eq!(BrowserActionType::from_str("type"), Some(BrowserActionType::Type));
        assert_eq!(BrowserActionType::from_str("navigate"), Some(BrowserActionType::Navigate));
        assert_eq!(BrowserActionType::from_str("invalid"), None);
    }

    #[test]
    fn test_browser_action_type_as_str() {
        assert_eq!(BrowserActionType::Click.as_str(), "click");
        assert_eq!(BrowserActionType::Type.as_str(), "type");
        assert_eq!(BrowserActionType::Navigate.as_str(), "navigate");
    }

    #[test]
    fn test_proposal_validator_valid() {
        let proposal = ActionProposalBuilder::new(1)
            .action_type("click")
            .parameters(serde_json::json!({"selector": "#button"}))
            .build();

        let result = ProposalValidator::validate(&proposal);
        assert!(result.is_ok());
    }

    #[test]
    fn test_proposal_validator_empty_action_type() {
        let proposal = ActionProposalBuilder::new(1)
            .action_type("")
            .parameters(serde_json::json!({}))
            .build();

        let result = ProposalValidator::validate(&proposal);
        assert!(result.is_err());
    }

    #[test]
    fn test_proposal_validator_invalid_step() {
        let proposal = ActionProposalBuilder::new(0)
            .action_type("click")
            .parameters(serde_json::json!({}))
            .build();

        let result = ProposalValidator::validate(&proposal);
        assert!(result.is_err());
    }

    #[test]
    fn test_proposal_validator_invalid_parameters() {
        let proposal = ActionProposalBuilder::new(1)
            .action_type("click")
            .parameters(serde_json::json!("not an object"))
            .build();

        let result = ProposalValidator::validate(&proposal);
        assert!(result.is_err());
    }

    #[test]
    fn test_proposal_validator_domain_check() {
        let proposal = ActionProposalBuilder::new(1)
            .action_type("navigate")
            .parameters(serde_json::json!({"url": "https://example.com/page"}))
            .build();

        let result = ProposalValidator::validate_with_domain(&proposal, "https://example.com");
        assert!(result.is_ok());
    }

    #[test]
    fn test_proposal_validator_domain_check_fail() {
        let proposal = ActionProposalBuilder::new(1)
            .action_type("navigate")
            .parameters(serde_json::json!({"url": "https://malicious.com"}))
            .build();

        let result = ProposalValidator::validate_with_domain(&proposal, "https://example.com");
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_browser_worker_dispatcher() {
        let session_id = Uuid::new_v4();
        let dispatcher = BrowserWorkerDispatcher::new(session_id);

        let proposal = ActionProposalBuilder::new(1)
            .action_type("click")
            .parameters(serde_json::json!({"selector": "#button"}))
            .build();

        let result = dispatcher.dispatch(&proposal).await;
        assert!(result.is_ok());
        assert!(result.unwrap().success);
    }

    #[test]
    fn test_browser_worker_dispatcher_supports() {
        let session_id = Uuid::new_v4();
        let dispatcher = BrowserWorkerDispatcher::new(session_id);

        assert!(dispatcher.supports_action_type("click"));
        assert!(dispatcher.supports_action_type("type"));
        assert!(!dispatcher.supports_action_type("invalid_action"));
    }
}
