//! Agent run policy management

use super::*;
use std::collections::HashSet;
use tracing::{info, warn};

/// Policy evaluation result
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyResult {
    Allowed,
    Denied(String),
    RateLimited(String),
}

/// Agent run policy
#[derive(Debug, Clone)]
pub struct RunPolicy {
    pub max_steps: u32,
    pub timeout_seconds: u64,
    pub budget_tokens: Option<u32>,
    pub allowlist_domains: HashSet<String>,
    pub require_human_approval_for: HashSet<String>,
}

impl Default for RunPolicy {
    fn default() -> Self {
        let mut allowlist = HashSet::new();
        allowlist.insert("localhost".to_string());
        
        let mut approval_required = HashSet::new();
        approval_required.insert("file_write".to_string());
        approval_required.insert("system_command".to_string());

        Self {
            max_steps: 100,
            timeout_seconds: 3600,
            budget_tokens: Some(100000),
            allowlist_domains: allowlist,
            require_human_approval_for: approval_required,
        }
    }
}

impl RunPolicy {
    /// Check if a domain is allowed
    pub fn is_domain_allowed(&self, domain: &str) -> bool {
        // If allowlist is empty, allow all domains
        if self.allowlist_domains.is_empty() {
            return true;
        }
        
        self.allowlist_domains.iter().any(|allowed| {
            domain.ends_with(allowed) || domain == allowed
        })
    }

    /// Check if an action requires human approval
    pub fn requires_approval(&self, action_type: &str) -> bool {
        self.require_human_approval_for.contains(action_type)
    }

    /// Check if run is within budget
    pub fn check_budget(&self, current_tokens: u64) -> PolicyResult {
        if let Some(max_tokens) = self.budget_tokens {
            if current_tokens > max_tokens as u64 {
                return PolicyResult::RateLimited(format!(
                    "Budget exceeded: {} tokens used, {} max",
                    current_tokens, max_tokens
                ));
            }
        }
        PolicyResult::Allowed
    }

    /// Check if run is within step limit
    pub fn check_steps(&self, current_steps: u32) -> PolicyResult {
        if current_steps >= self.max_steps {
            return PolicyResult::Denied(format!(
                "Step limit reached: {} steps, {} max",
                current_steps, self.max_steps
            ));
        }
        PolicyResult::Allowed
    }

    /// Check if run has timed out
    pub fn check_timeout(&self, started_at: DateTime<Utc>, now: DateTime<Utc>) -> PolicyResult {
        let elapsed = (now - started_at).num_seconds();
        if elapsed > self.timeout_seconds as i64 {
            return PolicyResult::Denied(format!(
                "Timeout reached: {} seconds elapsed, {} max",
                elapsed, self.timeout_seconds
            ));
        }
        PolicyResult::Allowed
    }

    /// Evaluate policy for a run
    pub fn evaluate(&self, record: &RunRecord) -> PolicyResult {
        // Check budget
        if let PolicyResult::RateLimited(msg) = self.check_budget(record.total_tokens) {
            return PolicyResult::RateLimited(msg);
        }

        // Check steps
        if let PolicyResult::Denied(msg) = self.check_steps(record.step_count) {
            return PolicyResult::Denied(msg);
        }

        // Check timeout (only if started)
        if let Some(started_at) = record.started_at {
            let now = Utc::now();
            if let PolicyResult::Denied(msg) = self.check_timeout(started_at, now) {
                return PolicyResult::Denied(msg);
            }
        }

        PolicyResult::Allowed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_policy() {
        let policy = RunPolicy::default();
        assert_eq!(policy.max_steps, 100);
        assert_eq!(policy.timeout_seconds, 3600);
    }

    #[test]
    fn test_domain_allowlist() {
        let mut policy = RunPolicy::default();
        policy.allowlist_domains.insert("example.com".to_string());
        
        assert!(policy.is_domain_allowed("sub.example.com"));
        assert!(!policy.is_domain_allowed("malicious.com"));
    }

    #[test]
    fn test_step_limit() {
        let policy = RunPolicy::default();
        
        assert_eq!(policy.check_steps(50), PolicyResult::Allowed);
        match policy.check_steps(100) {
            PolicyResult::Denied(_) => {}
            _ => panic!("Expected Denied"),
        }
    }
}
