// E03 Smoke Tests - Unattended Linux Host
//
// These tests verify the end-to-end functionality of the Hexactra host agent
// and related components for unattended Linux operation.

use std::process::Command;

#[test]
fn test_rust_build_succeeds() {
    // Verify the Rust project builds successfully
    let output = Command::new("cargo")
        .args(["build", "--package", "hexactra-core"])
        .output()
        .expect("Failed to execute cargo build");

    assert!(output.status.success(), "Rust build failed");
}

#[test]
fn test_core_unit_tests_pass() {
    // Run unit tests for the core crate
    let output = Command::new("cargo")
        .args(["test", "--package", "hexactra-core", "--lib"])
        .output()
        .expect("Failed to execute cargo test");

    assert!(output.status.success(), "Core unit tests failed");
}

#[test]
fn test_profile_registry_module_exists() {
    // Verify the profile registry module is present
    let output = Command::new("cargo")
        .args(["test", "--package", "hexactra-core", "profile"])
        .output()
        .expect("Failed to execute cargo test");

    assert!(output.status.success(), "Profile registry tests failed");
}

#[test]
fn test_viewer_module_exists() {
    // Verify the viewer module is present
    let output = Command::new("cargo")
        .args(["test", "--package", "hexactra-core", "viewer"])
        .output()
        .expect("Failed to execute cargo test");

    assert!(output.status.success(), "Viewer tests failed");
}

#[test]
fn test_chrome_module_exists() {
    // Verify the chrome module is present
    let output = Command::new("cargo")
        .args(["test", "--package", "hexactra-agent", "chrome"])
        .output()
        .expect("Failed to execute cargo test");

    assert!(output.status.success(), "Chrome tests failed");
}

#[test]
fn test_systemd_service_file_exists() {
    // Verify systemd service file is present
    let service_path = "deploy/systemd/hexactra-agent.service";
    assert!(
        std::path::Path::new(service_path).exists(),
        "Systemd service file not found"
    );
}

#[test]
fn test_chrome_install_script_exists() {
    // Verify Chrome installation script is present
    let script_path = "deploy/chrome/install-chrome.sh";
    assert!(
        std::path::Path::new(script_path).exists(),
        "Chrome install script not found"
    );
}

#[test]
fn test_agent_config_example_exists() {
    // Verify agent configuration example is present
    let config_path = "config/agent.toml.example";
    assert!(
        std::path::Path::new(config_path).exists(),
        "Agent config example not found"
    );
}

#[test]
fn test_chrome_config_example_exists() {
    // Verify Chrome configuration example is present
    let config_path = "deploy/chrome/chrome-config.toml.example";
    assert!(
        std::path::Path::new(config_path).exists(),
        "Chrome config example not found"
    );
}
