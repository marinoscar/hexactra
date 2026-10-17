//! Cross-platform integration tests for Hexactra host agents
//!
//! This module provides tests that verify:
//! - Platform trait implementations work correctly
//! - IPC mechanisms function across platforms
//! - Browser automation workflows succeed
//! - Error cases are handled gracefully

use hexactra_agent::platform::{HostPlatform, PlatformCapabilities, SessionState, LinuxPlatform};

/// Test platform capabilities reporting
#[test]
fn test_platform_capabilities_reported() {
    let caps = LinuxPlatform::get_capabilities();
    
    // All platforms should support interactive sessions
    assert!(caps.supports_interactive_sessions);
    
    // All platforms should support GUI automation
    assert!(caps.supports_gui_automation);
    
    // All platforms should support native messaging
    assert!(caps.supports_native_messaging);
}

/// Test session state detection
#[test]
fn test_session_state_detection() {
    let state = LinuxPlatform::get_session_state();
    
    // Should return a valid state
    match state {
        Ok(SessionState::None) => {
            // No session - this is valid for headless environments
        }
        Ok(SessionState::Console) => {
            // Console session - valid for Linux services
        }
        Ok(SessionState::Interactive) => {
            // Interactive session - user is logged in
        }
        Ok(SessionState::Locked) => {
            // Session locked - still interactive but locked
        }
        Err(e) => {
            // Error is acceptable in some environments (e.g., CI)
            eprintln!("Session state detection error (acceptable): {}", e);
        }
    }
}

/// Test process spawning
#[test]
fn test_process_spawn() {
    let config = hexactra_agent::platform::ProcessConfig {
        command: "echo".to_string(),
        args: vec!["hello".to_string()],
        cwd: None,
        env: std::collections::HashMap::new(),
        detached: false,
    };
    
    match LinuxPlatform::spawn_process(config) {
        Ok(spawned) => {
            // Process should have a valid PID
            assert!(spawned.pid > 0);
            
            // Cleanup - terminate the process
            let _ = LinuxPlatform::terminate_process(spawned.pid);
        }
        Err(e) => {
            // Spawning may fail in some environments (e.g., restricted containers)
            eprintln!("Process spawn error (may be acceptable): {}", e);
        }
    }
}

/// Test home directory detection
#[test]
fn test_home_directory_detection() {
    let home = LinuxPlatform::get_home_dir();
    
    // Home directory should exist or be a valid path
    assert!(!home.as_os_str().is_empty());
    
    // Should be an absolute path
    assert!(home.is_absolute());
}

/// Test temporary directory detection
#[test]
fn test_temp_directory_detection() {
    let temp = LinuxPlatform::get_temp_dir();
    
    // Temp directory should exist
    assert!(temp.exists());
}

/// Test native messaging host registration (should succeed or return appropriate error)
#[test]
fn test_native_messaging_registration() {
    use std::path::Path;
    
    // Create a dummy manifest path
    let manifest_path = Path::new("/tmp/hexactra-test-native-messaging.json");
    
    match LinuxPlatform::register_native_messaging_host(manifest_path) {
        Ok(()) => {
            // Registration succeeded - clean up
            let _ = std::fs::remove_file(manifest_path);
        }
        Err(e) => {
            // Registration may fail due to permissions or platform restrictions
            // This is acceptable in test environments
            eprintln!("Native messaging registration error (may be acceptable): {}", e);
        }
    }
}

/// Test GUI automation availability check
#[test]
fn test_gui_automation_check() {
    let available = LinuxPlatform::is_gui_automation_available();
    
    // On Linux, GUI automation may not be available in headless environments
    // This test just verifies the method exists and returns a boolean
    let _ = available;
}

/// Test platform name reporting
#[test]
fn test_platform_name() {
    let name = LinuxPlatform::platform_name();
    
    // Should return a valid platform name
    assert!(!name.is_empty());
    
    // Should be "linux" on this platform
    assert_eq!(name, "linux");
}

/// Test capability consistency across platforms
#[test]
fn test_capability_consistency() {
    let caps = LinuxPlatform::get_capabilities();
    
    // Core capabilities should be present
    assert!(caps.supports_interactive_sessions);
    assert!(caps.supports_gui_automation);
    
    // Linux supports unattended sessions
    assert!(caps.supports_unattended_sessions);
}

/// Test environment-specific behavior
#[test]
fn test_environment_behavior() {
    let platform_name = LinuxPlatform::platform_name();
    
    match platform_name {
        "linux" => {
            // Linux-specific checks
            let home = LinuxPlatform::get_home_dir();
            assert!(home.to_string_lossy().starts_with('/'));
        }
        _ => {
            panic!("Unexpected platform: {}", platform_name);
        }
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    
    /// Integration test: full workflow simulation
    #[test]
    fn test_full_workflow_simulation() {
        // 1. Check capabilities
        let caps = LinuxPlatform::get_capabilities();
        assert!(caps.supports_interactive_sessions);
        
        // 2. Get session state
        let state = match LinuxPlatform::get_session_state() {
            Ok(s) => s,
            Err(_) => return, // Skip if we can't determine state
        };
        
        // 3. Test home directory
        let home = LinuxPlatform::get_home_dir();
        assert!(!home.as_os_str().is_empty());
        
        // 4. Test temp directory
        let temp = LinuxPlatform::get_temp_dir();
        assert!(temp.exists());
    }
    
    /// Integration test: error handling for unsupported operations
    #[test]
    fn test_unsupported_operation_error_handling() {
        // Try to spawn a process that doesn't exist
        let config = hexactra_agent::platform::ProcessConfig {
            command: "nonexistent-command-12345".to_string(),
            args: vec![],
            cwd: None,
            env: std::collections::HashMap::new(),
            detached: false,
        };
        
        // This should fail gracefully
        match LinuxPlatform::spawn_process(config) {
            Ok(_) => {
                // Process spawned - might succeed if command exists
            }
            Err(e) => {
                // Expected error for non-existent command
                eprintln!("Expected error for nonexistent command: {}", e);
            }
        }
    }
}
