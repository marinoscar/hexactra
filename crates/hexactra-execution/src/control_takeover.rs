//! Control takeover manager for agent execution

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::PauseReason;

/// Human lease identifier
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct HumanLeaseId(Uuid);

impl HumanLeaseId {
    pub fn new() -> Self {
        HumanLeaseId(Uuid::new_v4())
    }

    pub fn from_uuid(uuid: Uuid) -> Self {
        HumanLeaseId(uuid)
    }

    pub fn as_uuid(&self) -> Uuid {
        self.0
    }
}

impl Default for HumanLeaseId {
    fn default() -> Self {
        Self::new()
    }
}

impl From<HumanLeaseId> for Uuid {
    fn from(id: HumanLeaseId) -> Self {
        id.0
    }
}

impl From<Uuid> for HumanLeaseId {
    fn from(uuid: Uuid) -> Self {
        HumanLeaseId::from_uuid(uuid)
    }
}

/// Control takeover state
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ControlState {
    /// Agent has full control
    Agent,
    /// Human has taken control
    Human {
        lease_id: HumanLeaseId,
        expires_at: DateTime<Utc>,
    },
}

/// Control takeover manager
pub struct ControlTakeoverManager {
    state: ControlState,
    lease_duration: chrono::Duration,
}

impl ControlTakeoverManager {
    /// Create a new control takeover manager
    pub fn new() -> Self {
        Self {
            state: ControlState::Agent,
            lease_duration: chrono::Duration::minutes(15),
        }
    }

    /// Get the current control state
    pub fn state(&self) -> &ControlState {
        &self.state
    }

    /// Check if human has control
    pub fn human_has_control(&self) -> bool {
        matches!(self.state, ControlState::Human { .. })
    }

    /// Take control for a human lease
    pub fn take_control_for_human(&mut self) -> HumanLeaseId {
        let lease_id = HumanLeaseId::new();
        let expires_at = Utc::now() + self.lease_duration;
        
        self.state = ControlState::Human {
            lease_id,
            expires_at,
        };
        
        lease_id
    }

    /// Release control back to agent
    pub fn release_control(&mut self) {
        if let ControlState::Human { .. } = &self.state {
            self.state = ControlState::Agent;
        }
    }

    /// Check if a lease is still valid
    pub fn is_lease_valid(&self, lease_id: HumanLeaseId) -> bool {
        match &self.state {
            ControlState::Human { lease_id: current_lease_id, expires_at } => {
                *current_lease_id == lease_id && Utc::now() < *expires_at
            }
            ControlState::Agent => false,
        }
    }

    /// Extend a lease
    pub fn extend_lease(&mut self, lease_id: HumanLeaseId) -> bool {
        if self.is_lease_valid(lease_id) {
            match &mut self.state {
                ControlState::Human { expires_at, .. } => {
                    *expires_at = Utc::now() + self.lease_duration;
                    true
                }
                ControlState::Agent => false,
            }
        } else {
            false
        }
    }

    /// Check if lease has expired
    pub fn is_lease_expired(&self) -> bool {
        match &self.state {
            ControlState::Human { expires_at, .. } => Utc::now() >= *expires_at,
            ControlState::Agent => false,
        }
    }

    /// Get the remaining lease time
    pub fn remaining_lease_time(&self) -> Option<chrono::Duration> {
        match &self.state {
            ControlState::Human { expires_at, .. } => {
                let remaining = *expires_at - Utc::now();
                if remaining > chrono::Duration::zero() {
                    Some(remaining)
                } else {
                    None
                }
            }
            ControlState::Agent => None,
        }
    }

    /// Take control with a reason (for pausing agent)
    pub fn takeover_with_reason(&mut self) -> PauseReason {
        let lease_id = self.take_control_for_human();
        
        // Return the appropriate pause reason based on state
        PauseReason::HumanLeaseActive
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_control_takeover_initial_state() {
        let manager = ControlTakeoverManager::new();
        
        assert_eq!(manager.state(), &ControlState::Agent);
        assert!(!manager.human_has_control());
    }

    #[test]
    fn test_human_lease_creation() {
        let mut manager = ControlTakeoverManager::new();
        
        let lease_id = manager.take_control_for_human();
        
        assert!(manager.human_has_control());
        match &manager.state {
            ControlState::Human { lease_id: lid, .. } => {
                assert_eq!(*lid, lease_id);
            }
            _ => panic!("Expected Human state"),
        }
    }

    #[test]
    fn test_release_control() {
        let mut manager = ControlTakeoverManager::new();
        
        manager.take_control_for_human();
        assert!(manager.human_has_control());

        manager.release_control();
        assert!(!manager.human_has_control());
        assert_eq!(manager.state(), &ControlState::Agent);
    }

    #[test]
    fn test_lease_validation() {
        let mut manager = ControlTakeoverManager::new();
        
        let lease_id = manager.take_control_for_human();
        
        // Valid lease
        assert!(manager.is_lease_valid(lease_id));

        // Invalid lease
        let invalid_lease = HumanLeaseId::new();
        assert!(!manager.is_lease_valid(invalid_lease));
    }

    #[test]
    fn test_lease_extension() {
        let mut manager = ControlTakeoverManager::new();
        
        let lease_id = manager.take_control_for_human();
        
        // Extend the lease
        assert!(manager.extend_lease(lease_id));
        
        // Try to extend invalid lease
        let invalid_lease = HumanLeaseId::new();
        assert!(!manager.extend_lease(invalid_lease));
    }

    #[test]
    fn test_takeover_with_reason() {
        let mut manager = ControlTakeoverManager::new();
        
        let reason = manager.takeover_with_reason();
        
        assert_eq!(reason, PauseReason::HumanLeaseActive);
        assert!(manager.human_has_control());
    }
}
