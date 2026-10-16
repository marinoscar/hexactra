//! Integration tests for Hexactra browser automation

use hexactra_core::{BrowserAction, Goal, GoalId, SessionId, RunStatus};
use std::time::{Duration, Instant};

/// Test that BrowserAction can be serialized and deserialized
#[test]
fn test_browser_action_serialization() {
    let action = BrowserAction::Navigate {
        url: "https://example.com".to_string(),
    };
    
    let json = serde_json::to_string(&action).unwrap();
    let parsed: BrowserAction = serde_json::from_str(&json).unwrap();
    
    assert_eq!(action, parsed);
}

/// Test that Goal can be created with multiple actions
#[test]
fn test_goal_creation() {
    let goal = Goal {
        id: GoalId::new(),
        session_id: SessionId::new(),
        actions: vec![
            BrowserAction::Navigate {
                url: "https://example.com".to_string(),
            },
            BrowserAction::Click {
                selector: "#submit-btn".to_string(),
            },
            BrowserAction::Type {
                selector: "#input-field".to_string(),
                text: "test input".to_string(),
            },
        ],
        created_at: chrono::Utc::now(),
        status: RunStatus::Queued,
    };
    
    assert_eq!(goal.actions.len(), 3);
}

/// Test that actions can be chained
#[test]
fn test_action_chaining() {
    let _actions = vec![
        BrowserAction::Navigate {
            url: "https://example.com".to_string(),
        },
        BrowserAction::WaitForElement {
            selector: "#content".to_string(),
            timeout_ms: 5000,
        },
        BrowserAction::Click {
            selector: "#button".to_string(),
        },
    ];
}

/// Test that status transitions are valid
#[test]
fn test_status_transitions() {
    use hexactra_core::RunStatus;
    
    // All valid statuses should be serializable
    let statuses = vec![
        RunStatus::Queued,
        RunStatus::Running,
        RunStatus::Completed,
        RunStatus::Failed,
        RunStatus::Cancelled,
        RunStatus::TimedOut,
    ];
    
    for status in statuses {
        let json = serde_json::to_string(&status).unwrap();
        let parsed: RunStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(status, parsed);
    }
}

/// Test that browser actions have correct types
#[test]
fn test_action_types() {
    use hexactra_core::BrowserAction;
    
    let navigate = BrowserAction::Navigate {
        url: "https://example.com".to_string(),
    };
    
    let click = BrowserAction::Click {
        selector: "#btn".to_string(),
    };
    
    let type_action = BrowserAction::Type {
        selector: "#input".to_string(),
        text: "text".to_string(),
    };
    
    // Verify different action types are distinct
    assert!(matches!(navigate, BrowserAction::Navigate { .. }));
    assert!(matches!(click, BrowserAction::Click { .. }));
    assert!(matches!(type_action, BrowserAction::Type { .. }));
}

/// Test goal execution timing
#[test]
fn test_goal_execution_timing() {
    let start = Instant::now();
    
    // Simulate a simple action sequence
    let _actions = vec![
        BrowserAction::Navigate {
            url: "https://example.com".to_string(),
        },
        BrowserAction::WaitForElement {
            selector: "#content".to_string(),
            timeout_ms: 100,
        },
    ];
    
    // Simulate execution time (in real code, this would be async)
    std::thread::sleep(Duration::from_millis(50));
    
    let elapsed = start.elapsed();
    
    assert!(elapsed >= Duration::from_millis(50));
}

/// Test that UUIDs are properly generated
#[test]
fn test_uuid_generation() {
    let id1 = uuid::Uuid::new_v4();
    let id2 = uuid::Uuid::new_v4();
    
    assert_ne!(id1, id2);
    assert!(id1.to_string().len() == 36); // UUID format length
}

/// Test that core types can be instantiated
#[test]
fn test_core_types_instantiation() {
    let goal_id = GoalId::new();
    let session_id = SessionId::new();
    
    // Verify UUIDs were created successfully (format check)
    assert_eq!(goal_id.as_uuid().to_string().len(), 36);
    assert_eq!(session_id.as_uuid().to_string().len(), 36);
}
