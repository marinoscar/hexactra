//! Host commands over real HTTP (#213).

use std::time::Duration;

use hexactra_client::{ControlClient, HostClient, HostPollStatus};
use hexactra_control::runtime::{self, ApiState, RuntimeStore};
use hexactra_core::remote::{
    HostCommand, HostCommandRequest, HostWork, OperationResult, OperationState, RegisterHostRequest,
};
use serde_json::json;

const OPERATOR: &str = "operator-token-0123456789abcdefgh";

async fn start() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(runtime::serve(
        listener,
        ApiState::new(RuntimeStore::new(), OPERATOR),
        std::future::pending(),
    ));
    url
}

fn status(accepts: bool) -> HostPollStatus {
    HostPollStatus {
        browser_connected: false,
        on_demand: true,
        profiles: Some((vec!["default".into()], vec![])),
        accepts_commands: accepts,
    }
}

#[tokio::test]
async fn a_command_round_trips_through_the_host_poll() {
    let url = start().await;
    let host = HostClient::new(&url, OPERATOR).unwrap();
    let id = host
        .register(&RegisterHostRequest {
            name: "vps".into(),
            version: "0".into(),
            host_id: None,
            viewer_url: None,
            mode: None,
            desktop: false,
        })
        .await
        .unwrap()
        .host_id;
    host.poll(id, &status(true), Duration::from_millis(10))
        .await
        .unwrap();

    // The fake agent: answer the next command it is handed.
    let agent = {
        let host = host.clone();
        tokio::spawn(async move {
            loop {
                if let Some(HostWork::Command { command }) = host
                    .poll(id, &status(true), Duration::from_secs(5))
                    .await
                    .unwrap()
                {
                    assert_eq!(command.command.kind(), "create_profile");
                    host.report_command(
                        id,
                        command.id,
                        &OperationResult {
                            navigation_blocked: Vec::new(),
                            ok: true,
                            result: Some(json!({ "created": true })),
                            error: None,
                        },
                    )
                    .await
                    .unwrap();
                    return;
                }
            }
        })
    };

    let client = ControlClient::new(&url, OPERATOR).unwrap();
    let v = client
        .host_command(
            id,
            &HostCommandRequest {
                command: HostCommand::CreateProfile {
                    profile: "travel".into(),
                },
                timeout_ms: Some(10_000),
            },
        )
        .await
        .unwrap();
    agent.await.unwrap();
    assert_eq!(v.state, OperationState::Succeeded);
    assert_eq!(v.result.unwrap()["created"], true);
    let hosts = client.hosts().await.unwrap();
    assert!(hosts[0].profiles.contains(&"travel".to_string()));
    assert_eq!(client.host_commands(id).await.unwrap().len(), 1);

    // Drain is immediate and shows on the host.
    let d = client
        .host_command(
            id,
            &HostCommandRequest {
                command: HostCommand::Drain { enabled: true },
                timeout_ms: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(d.state, OperationState::Succeeded);
    assert!(client.hosts().await.unwrap()[0].draining);

    // Validation errors are 400s; unknown hosts 404.
    let bad = client
        .host_command(
            id,
            &HostCommandRequest {
                command: HostCommand::DeleteProfile {
                    profile: "default".into(),
                },
                timeout_ms: None,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(bad.status(), Some(400));
    let missing = client
        .host_command(
            uuid::Uuid::new_v4(),
            &HostCommandRequest {
                command: HostCommand::Drain { enabled: true },
                timeout_ms: None,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(missing.status(), Some(404));
}

#[tokio::test]
async fn only_the_owning_host_may_report_and_old_agents_get_operations_only() {
    let url = start().await;
    let operator = ControlClient::new(&url, OPERATOR).unwrap();
    let enroll = |label: &'static str| {
        let operator = operator.clone();
        let url = url.clone();
        async move {
            let e = operator.create_enrollment(Some(label), None).await.unwrap();
            let token = e["enrollment_token"].as_str().unwrap().to_string();
            let got = HostClient::enroll(&url, &token, label, "0").await.unwrap();
            let c = HostClient::new(&url, &got.host_token).unwrap();
            c.register(&RegisterHostRequest {
                name: label.into(),
                version: "0".into(),
                host_id: Some(got.host_id),
                viewer_url: None,
                mode: None,
                desktop: false,
            })
            .await
            .unwrap();
            (got.host_id, c)
        }
    };
    let (a_id, a) = enroll("a").await;
    let (_b_id, b) = enroll("b").await;

    let started = operator.clone();
    let pending = tokio::spawn(async move {
        started
            .host_command(
                a_id,
                &HostCommandRequest {
                    command: HostCommand::CloseBrowser {
                        profile: "default".into(),
                    },
                    timeout_ms: Some(3_000),
                },
            )
            .await
            .unwrap()
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    // An agent without command support is never handed the command.
    assert!(a
        .poll(a_id, &status(false), Duration::from_millis(200))
        .await
        .unwrap()
        .is_none());
    let Some(HostWork::Command { command }) = a
        .poll(a_id, &status(true), Duration::from_secs(2))
        .await
        .unwrap()
    else {
        panic!("expected the command");
    };
    let r = OperationResult {
        navigation_blocked: Vec::new(),
        ok: false,
        result: None,
        error: Some("close_browser: refused".into()),
    };
    // Host b cannot report for host a.
    assert_eq!(
        b.report_command(a_id, command.id, &r)
            .await
            .unwrap_err()
            .status(),
        Some(403)
    );
    a.report_command(a_id, command.id, &r).await.unwrap();
    let v = pending.await.unwrap();
    assert_eq!(v.state, OperationState::Failed);
    assert!(v.error.unwrap().contains("refused"));
}
