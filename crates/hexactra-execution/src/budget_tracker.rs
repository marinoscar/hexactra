//! Budget tracker for agent execution

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// Budget tracker for token/cost management
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetTracker {
    /// Total budget (0 = unlimited)
    total: u32,
    /// Remaining budget
    remaining: u32,
    /// Used budget
    used: u32,
}

impl BudgetTracker {
    /// Create a new budget tracker
    pub fn new(total: Option<u32>) -> Self {
        match total {
            Some(0) => Self {
                total: 0,  // 0 means zero budget (no budget available)
                remaining: 0,
                used: 0,
            },
            Some(amount) => Self {
                total: amount,
                remaining: amount,
                used: 0,
            },
            None => Self {
                total: u32::MAX,  // Max value indicates unlimited
                remaining: u32::MAX,
                used: 0,
            },
        }
    }

    /// Get the total budget
    pub fn total(&self) -> u32 {
        self.total
    }

    /// Get the remaining budget
    pub fn remaining(&self) -> u32 {
        self.remaining
    }

    /// Get the used budget
    pub fn used(&self) -> u32 {
        self.used
    }

    /// Check if budget is available
    pub fn has_budget(&self) -> bool {
        // total == u32::MAX means unlimited budget (has budget)
        // total > 0 with remaining == 0 means zero budget (no budget)
        self.total == u32::MAX || self.remaining > 0
    }

    /// Use budget tokens
    pub fn use_tokens(&mut self, tokens: u32) -> Result<bool> {
        if self.total == u32::MAX {
            // Unlimited budget
            self.used += tokens;
            Ok(true)
        } else if tokens <= self.remaining {
            self.remaining -= tokens;
            self.used += tokens;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Reset the budget
    pub fn reset(&mut self) {
        self.remaining = self.total;
        self.used = 0;
    }

    /// Check if budget is exhausted
    pub fn is_exhausted(&self) -> bool {
        // total == 0 means zero budget (exhausted)
        // total > 0 with remaining == 0 means limited budget exhausted
        self.total == 0 || (self.total > 0 && self.remaining == 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_budget_tracker_unlimited() {
        let mut tracker = BudgetTracker::new(None);
        
        assert!(tracker.has_budget());
        assert!(tracker.use_tokens(1000).unwrap());
        assert!(tracker.has_budget());
        assert_eq!(tracker.used(), 1000);
    }

    #[test]
    fn test_budget_tracker_limited() {
        let mut tracker = BudgetTracker::new(Some(1000));
        
        assert!(tracker.has_budget());
        assert_eq!(tracker.total(), 1000);
        assert_eq!(tracker.remaining(), 1000);

        // Use some tokens
        assert!(tracker.use_tokens(500).unwrap());
        assert_eq!(tracker.remaining(), 500);
        assert_eq!(tracker.used(), 500);

        // Use more tokens
        assert!(tracker.use_tokens(400).unwrap());
        assert_eq!(tracker.remaining(), 100);
        assert_eq!(tracker.used(), 900);

        // Try to use more than available
        assert!(!tracker.use_tokens(200).unwrap());
        assert_eq!(tracker.remaining(), 100); // Unchanged

        // Budget still has some left
        assert!(tracker.has_budget());

        // Use the last tokens
        assert!(tracker.use_tokens(100).unwrap());
        assert!(!tracker.has_budget());
        assert!(tracker.is_exhausted());
    }

    #[test]
    fn test_budget_tracker_zero() {
        let tracker = BudgetTracker::new(Some(0));
        
        // Zero budget means no budget available
        assert!(!tracker.has_budget());
        assert!(tracker.is_exhausted());
    }

    #[test]
    fn test_budget_reset() {
        let mut tracker = BudgetTracker::new(Some(1000));
        
        tracker.use_tokens(500).unwrap();
        assert_eq!(tracker.remaining(), 500);

        tracker.reset();
        assert_eq!(tracker.remaining(), 1000);
        assert_eq!(tracker.used(), 0);
    }
}
