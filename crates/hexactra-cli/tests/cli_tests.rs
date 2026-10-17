//! CLI integration tests

use assert_cmd::prelude::*;
use predicates::prelude::*;
use std::process::Command;

#[test]
fn test_help() {
    let mut cmd = Command::cargo_bin("hexactra").unwrap();
    cmd.arg("--help");
    cmd.assert().success();
}

#[test]
fn test_version() {
    let mut cmd = Command::cargo_bin("hexactra").unwrap();
    cmd.arg("version");
    cmd.assert()
        .success()
        .stdout(predicates::str::contains("hexactra-cli"));
}

#[test]
fn test_session_help() {
    let mut cmd = Command::cargo_bin("hexactra").unwrap();
    cmd.arg("session").arg("--help");
    cmd.assert().success();
}

#[test]
fn test_profile_help() {
    let mut cmd = Command::cargo_bin("hexactra").unwrap();
    cmd.arg("profile").arg("--help");
    cmd.assert().success();
}

#[test]
fn test_host_help() {
    let mut cmd = Command::cargo_bin("hexactra").unwrap();
    cmd.arg("host").arg("--help");
    cmd.assert().success();
}

#[test]
fn test_action_help() {
    let mut cmd = Command::cargo_bin("hexactra").unwrap();
    cmd.arg("action").arg("--help");
    cmd.assert().success();
}

#[test]
fn test_agent_help() {
    let mut cmd = Command::cargo_bin("hexactra").unwrap();
    cmd.arg("agent").arg("--help");
    cmd.assert().success();
}

#[test]
fn test_hitl_help() {
    let mut cmd = Command::cargo_bin("hexactra").unwrap();
    cmd.arg("hitl").arg("--help");
    cmd.assert().success();
}
