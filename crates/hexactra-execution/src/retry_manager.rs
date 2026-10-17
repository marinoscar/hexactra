//! Retry manager for agent execution

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// Retry manager for handling action retries
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryManager {
    /// Maximum retries per action
    max_retries: u32,
    /// Current retry count
    current_retry: u32,
}

impl RetryManager {
    /// Create a new retry manager
    pub fn new(max_retries: u32) -> Self {
        Self {
            max_retries,
            current_retry: 0,
        }
    }

    /// Get the maximum retries allowed
    pub fn max_retries(&self) -> u32 {
        self.max_retries
    }

    /// Get the current retry count
    pub fn current_retry(&self) -> u32 {
        self.current_retry
    }

    /// Record an attempt
    pub fn record_attempt(&mut self, success: bool) {
        if !success {
            self.current_retry += 1;
        } else {
            // Reset on success
            self.current_retry = 0;
        }
    }

    /// Check if we can retry
    pub fn can_retry(&self) -> bool {
        self.current_retry < self.max_retries
    }

    /// Get the next retry delay (exponential backoff)
    pub fn get_retry_delay_ms(&self) -> u64 {
        // Exponential backoff: 100ms, 200ms, 400ms, ...
        if self.current_retry == 0 {
            0
        } else {
            100u64.checked_shl((self.current_retry - 1) as u32).unwrap_or(1000)
        }
    }

    /// Check if we've exhausted retries
    pub fn is_exhausted(&self) -> bool {
        self.current_retry >= self.max_retries
    }

    /// Reset the retry count
    pub fn reset(&mut self) {
        self.current_retry = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_retry_manager_creation() {
        let manager = RetryManager::new(3);
        
        assert_eq!(manager.max_retries(), 3);
        assert_eq!(manager.current_retry(), 0);
        assert!(manager.can_retry());
    }

    #[test]
    fn test_retry_manager_record_attempts() {
        let mut manager = RetryManager::new(3);

        // Record failures
        manager.record_attempt(false);
        assert_eq!(manager.current_retry(), 1);
        assert!(manager.can_retry());

        manager.record_attempt(false);
        assert_eq!(manager.current_retry(), 2);
        assert!(manager.can_retry());

        manager.record_attempt(false);
        assert_eq!(manager.current_retry(), 3);
        assert!(!manager.can_retry());
        assert!(manager.is_exhausted());

        // Record success - should reset
        manager.record_attempt(true);
        assert_eq!(manager.current_retry(), 0);
        assert!(manager.can_retry());
    }

    #[test]
    fn test_retry_manager_exponential_backoff() {
        let mut manager = RetryManager::new(3);

        assert_eq!(manager.get_retry_delay_ms(), 0); // No retries yet

        manager.record_attempt(false);
        assert_eq!(manager.get_retry_delay_ms(), 100);

        manager.record_attempt(false);
        assert_eq!(manager.get_retry_delay_ms(), 200);

        manager.record_attempt(false);
        assert_eq!(manager.get_retry_delay_ms(), 400);
    }

    #[test]
    fn test_retry_manager_reset() {
        let mut manager = RetryManager::new(3);

        manager.record_attempt(false);
        manager.record_attempt(false);
        assert_eq!(manager.current_retry(), 2);

        manager.reset();
        assert_eq!(manager.current_retry(), 0);
    }
}
