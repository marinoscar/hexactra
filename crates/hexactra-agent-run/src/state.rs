//! State machine transitions for agent runs

use super::*;

/// State machine transitions
pub struct StateMachine {
    current_state: RunStatus,
}

impl StateMachine {
    /// Create a new state machine with the given initial state
    pub fn new(initial: RunStatus) -> Self {
        Self { current_state: initial }
    }

    /// Get the current state
    pub fn current(&self) -> RunStatus {
        self.current_state
    }

    /// Transition to a new state
    pub fn transition(&mut self, new_state: RunStatus) -> bool {
        if self.can_transition_to(new_state) {
            self.current_state = new_state;
            true
        } else {
            false
        }
    }

    /// Check if a transition is allowed
    pub fn can_transition_to(&self, new_state: RunStatus) -> bool {
        match self.current_state {
            RunStatus::Queued => matches!(new_state, RunStatus::Running | RunStatus::Cancelled),
            RunStatus::Running => matches!(
                new_state,
                RunStatus::Paused | RunStatus::Completed | RunStatus::Failed | RunStatus::Cancelled
            ),
            RunStatus::Paused => matches!(
                new_state,
                RunStatus::Running | RunStatus::Cancelled | RunStatus::Completed | RunStatus::Failed
            ),
            RunStatus::Completed => false, // Terminal state
            RunStatus::Failed => false,      // Terminal state
            RunStatus::Cancelled => false,   // Terminal state
        }
    }

    /// Check if the current state is terminal
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.current_state,
            RunStatus::Completed | RunStatus::Failed | RunStatus::Cancelled
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_transitions() {
        let mut sm = StateMachine::new(RunStatus::Queued);
        assert!(sm.transition(RunStatus::Running));
        assert_eq!(sm.current(), RunStatus::Running);

        assert!(sm.transition(RunStatus::Paused));
        assert_eq!(sm.current(), RunStatus::Paused);

        assert!(sm.transition(RunStatus::Running));
        assert_eq!(sm.current(), RunStatus::Running);

        assert!(sm.transition(RunStatus::Completed));
        assert_eq!(sm.current(), RunStatus::Completed);
    }

    #[test]
    fn test_invalid_transitions() {
        let mut sm = StateMachine::new(RunStatus::Completed);
        assert!(!sm.transition(RunStatus::Running));
        assert_eq!(sm.current(), RunStatus::Completed);
    }

    #[test]
    fn test_terminal_states() {
        assert!(StateMachine::new(RunStatus::Completed).is_terminal());
        assert!(StateMachine::new(RunStatus::Failed).is_terminal());
        assert!(StateMachine::new(RunStatus::Cancelled).is_terminal());
        assert!(!StateMachine::new(RunStatus::Running).is_terminal());
        assert!(!StateMachine::new(RunStatus::Paused).is_terminal());
    }
}
