//! Policy definitions for HITL operations
//!
//! This module provides:
//! - High-impact action policies (irreversible operations)
//! - Rate limiting for repeated OTP requests
//! - Origin-specific approval requirements

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

/// High-impact action types that require additional safeguards
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HighImpactAction {
    /// Send money or crypto
    TransferFunds,
    /// Delete resources (files, accounts)
    DeleteResource,
    /// Modify critical settings
    ModifySettings,
    /// Grant permissions
    GrantPermissions,
    /// Execute irreversible operations
    IrreversibleOperation,
}

impl HighImpactAction {
    pub fn as_str_name(&self) -> &'static str {
        match self {
            HighImpactAction::TransferFunds => "transfer_funds",
            HighImpactAction::DeleteResource => "delete_resource",
            HighImpactAction::ModifySettings => "modify_settings",
            HighImpactAction::GrantPermissions => "grant_permissions",
            HighImpactAction::IrreversibleOperation => "irreversible_operation",
        }
    }

    pub fn from_str_name(s: &str) -> Self {
        match s {
            "transfer_funds" => HighImpactAction::TransferFunds,
            "delete_resource" => HighImpactAction::DeleteResource,
            "modify_settings" => HighImpactAction::ModifySettings,
            "grant_permissions" => HighImpactAction::GrantPermissions,
            "irreversible_operation" => HighImpactAction::IrreversibleOperation,
            _ => HighImpactAction::TransferFunds,
        }
    }
}

/// Policy configuration for an action
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ActionPolicy {
    /// Required approval level for this action
    pub approval_level: ApprovalLevel,
    /// Whether origin verification is required
    pub verify_origin: bool,
    /// Maximum number of retries allowed
    pub max_retries: u32,
    /// Time window for rate limiting (in seconds)
    pub rate_limit_window_seconds: u64,
    /// Maximum requests in the time window
    pub rate_limit_max_requests: u32,
}

impl Default for ActionPolicy {
    fn default() -> Self {
        Self {
            approval_level: ApprovalLevel::Standard,
            verify_origin: false,
            max_retries: 3,
            rate_limit_window_seconds: 60,
            rate_limit_max_requests: 5,
        }
    }
}

/// Approval level required for an action
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalLevel {
    /// Standard approval (any HITL method)
    Standard,
    /// Requires out-of-band confirmation (push notification)
    OobConfirmation,
    /// Requires passkey/security key
    Passkey,
    /// Requires human takeover
    HumanTakeover,
}

impl ApprovalLevel {
    pub fn as_str_name(&self) -> &'static str {
        match self {
            ApprovalLevel::Standard => "standard",
            ApprovalLevel::OobConfirmation => "oob_confirmation",
            ApprovalLevel::Passkey => "passkey",
            ApprovalLevel::HumanTakeover => "human_takeover",
        }
    }

    pub fn from_str_name(s: &str) -> Self {
        match s {
            "standard" => ApprovalLevel::Standard,
            "oob_confirmation" => ApprovalLevel::OobConfirmation,
            "passkey" => ApprovalLevel::Passkey,
            "human_takeover" => ApprovalLevel::HumanTakeover,
            _ => ApprovalLevel::Standard,
        }
    }
}

/// Rate limit state for an origin
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RateLimitState {
    /// Number of requests in the current window
    pub request_count: u32,
    /// Window start time
    pub window_start: DateTime<Utc>,
}

impl RateLimitState {
    pub fn new() -> Self {
        Self {
            request_count: 0,
            window_start: Utc::now(),
        }
    }

    /// Reset the rate limit state
    pub fn reset(&mut self) {
        self.request_count = 0;
        self.window_start = Utc::now();
    }

    /// Increment the request count
    pub fn increment(&mut self) {
        self.request_count += 1;
    }
}

/// Policy manager for HITL operations
#[derive(Debug, Clone)]
pub struct PolicyManager {
    /// Default policy for actions without specific overrides
    default_policy: ActionPolicy,
    /// Per-origin policies
    origin_policies: HashMap<String, ActionPolicy>,
    /// Rate limit state per origin
    rate_limit_states: HashMap<String, RateLimitState>,
}

impl PolicyManager {
    pub fn new() -> Self {
        Self {
            default_policy: ActionPolicy::default(),
            origin_policies: HashMap::new(),
            rate_limit_states: HashMap::new(),
        }
    }

    /// Get the policy for an action
    pub fn get_policy(&self, action: &HighImpactAction) -> ActionPolicy {
        // Check if there's a specific policy for this action type
        // For now, use default policy with elevated approval level for high-impact actions
        let mut policy = self.default_policy.clone();
        
        match action {
            HighImpactAction::TransferFunds
            | HighImpactAction::DeleteResource
            | HighImpactAction::ModifySettings => {
                policy.approval_level = ApprovalLevel::OobConfirmation;
                policy.verify_origin = true;
            }
            HighImpactAction::GrantPermissions
            | HighImpactAction::IrreversibleOperation => {
                policy.approval_level = ApprovalLevel::HumanTakeover;
                policy.verify_origin = true;
            }
            _ => {}
        }

        policy
    }

    /// Check if rate limiting allows a request
    pub fn check_rate_limit(&mut self, origin: &str, policy: &ActionPolicy) -> bool {
        let now = Utc::now();
        
        let state = self.rate_limit_states
            .entry(origin.to_string())
            .or_insert_with(RateLimitState::new);

        // Check if window has expired
        let elapsed = (now - state.window_start).num_seconds();
        if elapsed > policy.rate_limit_window_seconds as i64 {
            state.reset();
        }

        // Check if within rate limit
        if state.request_count < policy.rate_limit_max_requests {
            state.increment();
            true
        } else {
            false
        }
    }

    /// Register a new origin with custom policy
    pub fn register_origin(&mut self, origin: String, policy: ActionPolicy) {
        self.origin_policies.insert(origin, policy);
    }

    /// Get the policy for a specific origin
    pub fn get_origin_policy(&self, origin: &str) -> Option<&ActionPolicy> {
        self.origin_policies.get(origin)
    }
}

impl Default for PolicyManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_high_impact_action_serialization() {
        let action = HighImpactAction::TransferFunds;
        let json = serde_json::to_string(&action).unwrap();
        assert_eq!(json, "\"transfer_funds\"");
        
        let parsed: HighImpactAction = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, action);
    }

    #[test]
    fn test_approval_level_serialization() {
        let level = ApprovalLevel::OobConfirmation;
        let json = serde_json::to_string(&level).unwrap();
        assert_eq!(json, "\"oob_confirmation\"");
        
        let parsed: ApprovalLevel = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, level);
    }

    #[test]
    fn test_policy_manager_high_impact_actions() {
        let manager = PolicyManager::new();
        
        // High-impact actions should have elevated approval requirements
        let transfer_policy = manager.get_policy(&HighImpactAction::TransferFunds);
        assert_eq!(transfer_policy.approval_level, ApprovalLevel::OobConfirmation);
        assert!(transfer_policy.verify_origin);

        let delete_policy = manager.get_policy(&HighImpactAction::DeleteResource);
        assert_eq!(delete_policy.approval_level, ApprovalLevel::OobConfirmation);
    }

    #[test]
    fn test_rate_limiting() {
        let mut manager = PolicyManager::new();
        
        let origin = "https://example.com".to_string();
        let policy = ActionPolicy {
            rate_limit_window_seconds: 60,
            rate_limit_max_requests: 3,
            ..Default::default()
        };

        // First two requests should succeed
        assert!(manager.check_rate_limit(&origin, &policy));
        assert!(manager.check_rate_limit(&origin, &policy));

        // Third request should also succeed (within limit)
        assert!(manager.check_rate_limit(&origin, &policy));

        // Fourth request should be rate limited
        assert!(!manager.check_rate_limit(&origin, &policy));
    }
}
