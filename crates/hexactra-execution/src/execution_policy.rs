//! Execution policy configuration

use anyhow::Result;
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Execution policy for agent runs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionPolicy {
    /// Maximum number of steps
    pub max_steps: u32,
    /// Maximum duration for execution
    pub max_duration: Duration,
    /// Budget tokens (0 = unlimited)
    pub budget_tokens: Option<u32>,
    /// Model request timeout
    pub model_timeout: Duration,
    /// Per-site allowlist (empty = allow all)
    pub allowlist_domains: HashSet<String>,
    /// High-impact action gate (requires human approval)
    pub high_impact_actions: HashSet<String>,
    /// Maximum retries per action
    pub max_retries: u32,
    /// Action cooldown period
    pub action_cooldown: Duration,
}

impl Default for ExecutionPolicy {
    fn default() -> Self {
        Self {
            max_steps: 100,
            max_duration: Duration::hours(1),
            budget_tokens: Some(100000),
            model_timeout: Duration::seconds(30),
            allowlist_domains: HashSet::new(),
            high_impact_actions: [
                "delete_element".to_string(),
                "form_submit".to_string(),
                "file_upload".to_string(),
                "navigation".to_string(),
            ].iter().map(|s| s.to_string()).collect(),
            max_retries: 3,
            action_cooldown: Duration::milliseconds(500),
        }
    }
}

impl ExecutionPolicy {
    /// Check if a domain is allowed
    pub fn is_domain_allowed(&self, domain: &str) -> bool {
        self.allowlist_domains.is_empty() || self.allowlist_domains.contains(domain)
    }

    /// Check if an action requires high-impact gate
    pub fn requires_high_impact_gate(&self, action_type: &str) -> bool {
        self.high_impact_actions.contains(action_type)
    }

    /// Validate the policy
    pub fn validate(&self) -> Result<()> {
        if let Some(budget) = self.budget_tokens {
            if budget == 0 {
                return Err(anyhow::anyhow!("Budget must be > 0 or None for unlimited"));
            }
        }

        if self.max_steps == 0 {
            return Err(anyhow::anyhow!("Max steps must be > 0"));
        }

        if self.max_duration <= Duration::zero() {
            return Err(anyhow::anyhow!("Max duration must be > 0"));
        }

        Ok(())
    }
}

/// Domain allowlist builder
pub struct AllowlistBuilder {
    domains: HashSet<String>,
}

impl AllowlistBuilder {
    pub fn new() -> Self {
        Self {
            domains: HashSet::new(),
        }
    }

    pub fn add_domain(mut self, domain: impl Into<String>) -> Self {
        self.domains.insert(domain.into());
        self
    }

    pub fn add_domains(mut self, domains: Vec<String>) -> Self {
        self.domains.extend(domains);
        self
    }

    pub fn build(self) -> HashSet<String> {
        self.domains
    }
}

/// High-impact action gate builder
pub struct HighImpactGateBuilder {
    actions: HashSet<String>,
}

impl HighImpactGateBuilder {
    pub fn new() -> Self {
        Self {
            actions: HashSet::new(),
        }
    }

    pub fn add_action(mut self, action: impl Into<String>) -> Self {
        self.actions.insert(action.into());
        self
    }

    pub fn add_actions(mut self, actions: Vec<String>) -> Self {
        self.actions.extend(actions);
        self
    }

    pub fn build(self) -> HashSet<String> {
        self.actions
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_execution_policy_default() {
        let policy = ExecutionPolicy::default();
        
        assert_eq!(policy.max_steps, 100);
        assert_eq!(policy.budget_tokens, Some(100000));
        assert_eq!(policy.max_retries, 3);
    }

    #[test]
    fn test_domain_allowlist() {
        let policy = ExecutionPolicy::default();
        
        // Empty allowlist means all domains allowed
        assert!(policy.is_domain_allowed("example.com"));
        assert!(policy.is_domain_allowed("malicious.com"));

        // Test with specific allowlist
        let allowlist = AllowlistBuilder::new()
            .add_domain("example.com")
            .add_domain("trusted.org")
            .build();

        let mut policy_with_allowlist = ExecutionPolicy::default();
        policy_with_allowlist.allowlist_domains = allowlist;

        assert!(policy_with_allowlist.is_domain_allowed("example.com"));
        assert!(policy_with_allowlist.is_domain_allowed("trusted.org"));
        assert!(!policy_with_allowlist.is_domain_allowed("untrusted.com"));
    }

    #[test]
    fn test_high_impact_gate() {
        let policy = ExecutionPolicy::default();
        
        assert!(policy.requires_high_impact_gate("delete_element"));
        assert!(policy.requires_high_impact_gate("form_submit"));
        assert!(!policy.requires_high_impact_gate("click"));
    }

    #[test]
    fn test_policy_validation() {
        // Valid policy
        let valid_policy = ExecutionPolicy::default();
        assert!(valid_policy.validate().is_ok());

        // Invalid: zero budget
        let mut invalid_policy = ExecutionPolicy::default();
        invalid_policy.budget_tokens = Some(0);
        assert!(invalid_policy.validate().is_err());

        // Invalid: zero max steps
        let mut invalid_policy = ExecutionPolicy::default();
        invalid_policy.max_steps = 0;
        assert!(invalid_policy.validate().is_err());

        // Invalid: negative duration
        let mut invalid_policy = ExecutionPolicy::default();
        invalid_policy.max_duration = Duration::zero();
        assert!(invalid_policy.validate().is_err());
    }
}
