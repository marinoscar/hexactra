//! CLI tests: argument handling, and real commands against an in-process
//! control plane with a fake host.

use std::time::Duration;

use assert_cmd::prelude::*;
use hexactra_client::HostClient;
use hexactra_control::runtime::{self, ApiState, RuntimeStore};
use hexactra_core::remote::{OperationResult, RegisterHostRequest, RemoteAction};
use predicates::prelude::*;
use serde_json::json;
use std::process::Command;

const TOKEN: &str = "cli-test-token-0123456789abcdef";

#[test]
fn help_and_version() {
    Command::cargo_bin("hexactra-fabric")
        .unwrap()
        .arg("--help")
        .assert()
        .success()
        .stdout(predicate::str::contains("navigate"));
    Command::cargo_bin("hexactra-fabric")
        .unwrap()
        .arg("version")
        .assert()
        .success()
        .stdout(predicate::str::contains("hexactra-fabric"));
}

#[test]
fn rejects_javascript_url_before_contacting_server() {
    Command::cargo_bin("hexactra-fabric")
        .unwrap()
        .env("HEXACTRA_API_TOKEN", TOKEN)
        .args([
            "--url",
            "http://127.0.0.1:9",
            "navigate",
            "javascript:alert(1)",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("evaluate"));
}

#[test]
fn missing_token_is_explained() {
    let dir = tempfile::tempdir().unwrap();
    Command::cargo_bin("hexactra-fabric")
        .unwrap()
        .env_remove("HEXACTRA_API_TOKEN")
        .env("XDG_CONFIG_HOME", dir.path())
        .arg("status")
        .assert()
        .failure()
        .stderr(predicate::str::contains("HEXACTRA_API_TOKEN"));
}

/// Start a control plane and a fake host that answers every action.
const CLI_SECRET: &str = "771177-cli-secret";

fn start_stack() -> String {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async move {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            tokio::spawn(runtime::serve(
                listener,
                ApiState::new(RuntimeStore::new(), TOKEN),
                std::future::pending(),
            ));
            let host = HostClient::new(&url, TOKEN).unwrap();
            let id = host
                .register(&RegisterHostRequest {
                    name: "fake".into(),
                    version: "0".into(),
                    host_id: None,
                    viewer_url: None,
                    mode: None,
                    desktop: false,
                })
                .await
                .unwrap()
                .host_id;
            host.next(id, true, Duration::from_millis(10))
                .await
                .unwrap();
            tx.send(url).unwrap();
            loop {
                let Some(op) = host.next(id, true, Duration::from_secs(5)).await.unwrap() else {
                    continue;
                };
                let result = match op.action {
                    RemoteAction::Navigate { url, .. } => OperationResult {
                        ok: true,
                        result: Some(json!({"url": url, "title": "Fixture"})),
                        error: None,
                    },
                    RemoteAction::Text { .. } => OperationResult {
                        ok: true,
                        result: Some(json!({"text": "hello from the page"})),
                        error: None,
                    },
                    // Only the real secret is accepted, so a typed secret
                    // proves the host got the value the CLI never saw.
                    RemoteAction::Type { text, .. } if text == CLI_SECRET => OperationResult {
                        ok: true,
                        result: Some(json!({})),
                        error: None,
                    },
                    RemoteAction::Screenshot { .. } => OperationResult {
                        ok: true,
                        result: Some(json!({"mime": "image/jpeg", "data": "/9j/AA=="})),
                        error: None,
                    },
                    _ => OperationResult {
                        ok: false,
                        result: None,
                        error: Some("no element matches #missing".into()),
                    },
                };
                host.report(id, op.id, &result).await.unwrap();
            }
        });
    });
    rx.recv_timeout(Duration::from_secs(10)).unwrap()
}

#[test]
fn drives_a_session_end_to_end() {
    let url = start_stack();
    let cfg = tempfile::tempdir().unwrap();
    let cli = || {
        let mut c = Command::cargo_bin("hexactra-fabric").unwrap();
        c.env("HEXACTRA_API_TOKEN", TOKEN)
            .env("HEXACTRA_URL", &url)
            .env("XDG_CONFIG_HOME", cfg.path())
            .env_remove("HEXACTRA_SESSION");
        c
    };

    cli()
        .arg("status")
        .assert()
        .success()
        .stdout(predicate::str::contains("browser=true"));

    // First action creates and saves a session.
    cli()
        .args(["navigate", "https://example.test/"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Fixture"))
        .stderr(predicate::str::contains("started session"));
    assert!(cfg.path().join("hexactra/current-session").exists());

    // Second action reuses it.
    cli()
        .arg("text")
        .assert()
        .success()
        .stdout(predicate::str::contains("hello from the page"))
        .stderr(predicate::str::contains("started session").not());

    // Browser-side failure exits non-zero with the reason.
    cli()
        .args(["click", "#missing"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("no element matches #missing"));

    // Screenshot is written to a file.
    let shot = cfg.path().join("shot.jpg");
    cli()
        .args(["screenshot", "-o", shot.to_str().unwrap()])
        .assert()
        .success();
    assert_eq!(std::fs::read(&shot).unwrap(), vec![0xff, 0xd8, 0xff, 0x00]);

    cli().args(["session", "end"]).assert().success();
}

#[test]
fn handoff_and_webhook_commands() {
    let url = start_stack();
    let cfg = tempfile::tempdir().unwrap();
    let cli = || {
        let mut c = Command::cargo_bin("hexactra-fabric").unwrap();
        c.env("HEXACTRA_API_TOKEN", TOKEN)
            .env("HEXACTRA_URL", &url)
            .env("XDG_CONFIG_HOME", cfg.path())
            .env_remove("HEXACTRA_SESSION");
        c
    };

    // An agent asks for text and waits; the operator answers from another process.
    let waiter = cli()
        .args([
            "handoff",
            "request",
            "--kind",
            "other",
            "--prompt",
            "Which seat?",
            "--input",
            "text",
            "--wait",
            "--timeout-s",
            "30",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut id = None;
    for _ in 0..100 {
        let out = cli().args(["--json", "handoff", "list"]).output().unwrap();
        let list: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
        if let Some(found) = list
            .as_array()
            .and_then(|a| a.first())
            .and_then(|h| h["id"].as_str())
        {
            id = Some(found.to_string());
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let id = id.expect("handoff never appeared");

    // Browser actions are paused meanwhile.
    cli()
        .arg("tabs")
        .assert()
        .failure()
        .stderr(predicate::str::contains("handoff_pending"));

    cli()
        .args(["handoff", "respond", &id, "--value", "12A"])
        .assert()
        .success();
    let out = waiter.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("completed via cli"), "{stdout}");
    assert!(stdout.contains("12A"), "{stdout}");

    // Typed questions: multi-choice with option ids, answered with --values.
    let out = cli()
        .args([
            "handoff",
            "request",
            "--prompt",
            "Which extras?",
            "--input",
            "multi-choice",
            "--choice",
            "bag=Checked bag",
            "--choice",
            "Window seat",
            "--max-selections",
            "2",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let id = String::from_utf8_lossy(&out.stdout).trim().to_string();
    cli()
        .args(["handoff", "respond", &id, "--values", "nope"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("not one of the choices"));
    cli()
        .args([
            "handoff",
            "respond",
            &id,
            "--values",
            "bag",
            "--values",
            "Window seat",
            "--answered-by",
            "user:7",
        ])
        .assert()
        .success();
    let out = cli()
        .args(["--json", "handoff", "show", &id])
        .output()
        .unwrap();
    let h: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(
        h["choices"][0],
        json!({"id": "bag", "label": "Checked bag"})
    );
    assert_eq!(h["response"]["values"], json!(["bag", "Window seat"]));
    assert_eq!(h["response"]["by"], "user:7");
    assert_eq!(h["response"]["outcome"], "completed");

    // A number with a negative minimum and a step; the server checks bounds.
    let out = cli()
        .args([
            "handoff", "request", "--prompt", "Offset?", "--input", "number", "--min", "-5",
            "--max", "5", "--step", "0.5", "--unit", "h",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let id = String::from_utf8_lossy(&out.stdout).trim().to_string();
    cli()
        .args(["handoff", "respond", &id, "--value", "-5.25"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("between"));
    cli()
        .args(["handoff", "respond", &id, "--value", "-4.5"])
        .assert()
        .success();
    cli()
        .args(["handoff", "show", &id])
        .assert()
        .success()
        .stdout(
            predicate::str::contains("value: -4.5").and(predicate::str::contains("by: operator")),
        );

    // A secret is never printed: not by request --wait, nor by show; it is
    // typed by the control plane with type-secret, once.
    let waiter = cli()
        .args([
            "handoff",
            "request",
            "--kind",
            "code",
            "--prompt",
            "Code?",
            "--input",
            "secret",
            "--wait",
            "--timeout-s",
            "30",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut id = None;
    for _ in 0..100 {
        let out = cli().args(["--json", "handoff", "list"]).output().unwrap();
        let list: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
        if let Some(found) = list
            .as_array()
            .and_then(|a| a.first())
            .and_then(|h| h["id"].as_str())
        {
            id = Some(found.to_string());
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let id = id.expect("secret handoff never appeared");
    cli()
        .args(["handoff", "respond", &id, "--value", CLI_SECRET])
        .assert()
        .success()
        .stdout(predicate::str::contains(CLI_SECRET).not());
    let out = waiter.wait_with_output().unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!stdout.contains(CLI_SECRET), "{stdout}");
    assert!(stdout.contains("handoff type-secret"), "{stdout}");
    for args in [
        vec!["handoff", "show", &id],
        vec!["--json", "handoff", "show", &id],
    ] {
        cli()
            .args(args)
            .assert()
            .success()
            .stdout(predicate::str::contains(CLI_SECRET).not());
    }
    cli()
        .args([
            "handoff",
            "type-secret",
            &id,
            "--selector",
            "#otp",
            "--submit",
        ])
        .assert()
        .success()
        .stdout(
            predicate::str::contains("typed the secret")
                .and(predicate::str::contains(CLI_SECRET).not()),
        );
    cli()
        .args(["handoff", "type-secret", &id, "--selector", "#otp"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("secret_unavailable"));

    // Constraints that do not apply to the input are refused.
    cli()
        .args([
            "handoff", "request", "--prompt", "Approve?", "--input", "confirm", "--min", "1",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("does not apply"));

    // Webhooks: http is refused by default; https is registered and listed without its secret.
    cli()
        .args(["webhook", "add", "http://hooks.example.test/x"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("https"));
    let out = cli()
        .args(["--json", "webhook", "add", "https://hooks.example.test/x"])
        .output()
        .unwrap();
    let created: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(created["secret"].as_str().unwrap().starts_with("whsec_"));
    let wid = created["webhook"]["id"].as_str().unwrap().to_string();
    cli().args(["webhook", "list"]).assert().success().stdout(
        predicate::str::contains("hooks.example.test")
            .and(predicate::str::contains("whsec_").not()),
    );
    cli().args(["webhook", "remove", &wid]).assert().success();
}
