//! Integration tests for the `/v1` remote-control API over real HTTP (#175).

use std::time::Duration;

use hexactra_client::{ControlClient, HostClient};
use hexactra_control::runtime::{self, ApiState, RuntimeStore};
use hexactra_core::remote::{
    CreateSessionRequest, OperationResult, OperationState, RegisterHostRequest, RemoteAction,
};
use serde_json::json;

const TOKEN: &str = "test-token-0123456789abcdef0123";

async fn start() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = ApiState::new(RuntimeStore::new(), TOKEN);
    tokio::spawn(runtime::serve(listener, state, std::future::pending()));
    format!("http://{addr}")
}

async fn register(url: &str) -> (HostClient, uuid::Uuid) {
    let host = HostClient::new(url, TOKEN).unwrap();
    let id = host
        .register(&RegisterHostRequest {
            name: "test-host".into(),
            version: "0".into(),
            host_id: None,
            viewer_url: None,
            mode: None,
            desktop: false,
        })
        .await
        .unwrap()
        .host_id;
    // First poll marks the browser as connected.
    assert!(host
        .next(id, true, Duration::from_millis(10))
        .await
        .unwrap()
        .is_none());
    (host, id)
}

#[tokio::test]
async fn health_is_public_everything_else_needs_token() {
    let url = start().await;
    let anon = reqwest::get(format!("{url}/v1/health")).await.unwrap();
    assert_eq!(anon.status(), 200);

    let r = reqwest::get(format!("{url}/v1/sessions")).await.unwrap();
    assert_eq!(r.status(), 401);

    let bad = ControlClient::new(&url, "wrong-token-wrong-token-wrong").unwrap();
    assert_eq!(bad.sessions().await.unwrap_err().status(), Some(401));

    let good = ControlClient::new(&url, TOKEN).unwrap();
    assert!(good.sessions().await.unwrap().is_empty());
}

#[tokio::test]
async fn action_round_trip_through_host() {
    let url = start().await;
    let (host, host_id) = register(&url).await;
    let client = ControlClient::new(&url, TOKEN).unwrap();

    let session = client
        .create_session(&CreateSessionRequest::default())
        .await
        .unwrap();
    assert_eq!(session.host_id, host_id);

    // Fake host: execute one operation and report a result.
    let worker = tokio::spawn(async move {
        let op = host
            .next(host_id, true, Duration::from_secs(5))
            .await
            .unwrap()
            .expect("operation");
        assert!(matches!(op.action, RemoteAction::Navigate { .. }));
        host.report(
            host_id,
            op.id,
            &OperationResult {
                ok: true,
                result: Some(json!({"url": "https://example.test/", "title": "Example"})),
                error: None,
            },
        )
        .await
        .unwrap();
    });

    let done = client
        .act(
            session.id,
            RemoteAction::Navigate {
                url: "https://example.test/".into(),
                tab_id: None,
            },
            Some(Duration::from_secs(5)),
        )
        .await
        .unwrap();
    worker.await.unwrap();
    assert_eq!(done.state, OperationState::Succeeded);
    assert_eq!(done.result.unwrap()["title"], "Example");

    let fetched = client.operation(done.id).await.unwrap();
    assert_eq!(fetched.state, OperationState::Succeeded);
}

#[tokio::test]
async fn browser_failure_is_reported_as_failed_state() {
    let url = start().await;
    let (host, host_id) = register(&url).await;
    let client = ControlClient::new(&url, TOKEN).unwrap();
    let session = client
        .create_session(&CreateSessionRequest::default())
        .await
        .unwrap();
    tokio::spawn(async move {
        let op = host
            .next(host_id, true, Duration::from_secs(5))
            .await
            .unwrap()
            .unwrap();
        host.report(
            host_id,
            op.id,
            &OperationResult {
                ok: false,
                result: None,
                error: Some("no element matches #missing".into()),
            },
        )
        .await
        .unwrap();
    });
    let done = client
        .act(
            session.id,
            RemoteAction::Click {
                selector: "#missing".into(),
                tab_id: None,
            },
            Some(Duration::from_secs(5)),
        )
        .await
        .unwrap();
    assert_eq!(done.state, OperationState::Failed);
    assert!(done.error.unwrap().contains("#missing"));
}

#[tokio::test]
async fn no_host_and_timeout_paths() {
    let url = start().await;
    let client = ControlClient::new(&url, TOKEN).unwrap();
    let err = client
        .create_session(&CreateSessionRequest::default())
        .await
        .unwrap_err();
    assert_eq!(err.status(), Some(503));

    let (_host, _id) = register(&url).await;
    let session = client
        .create_session(&CreateSessionRequest::default())
        .await
        .unwrap();
    // Nobody polls, so the operation times out without running.
    let done = client
        .act(
            session.id,
            RemoteAction::Tabs,
            Some(Duration::from_millis(200)),
        )
        .await
        .unwrap();
    assert_eq!(done.state, OperationState::TimedOut);
    assert!(done.error.unwrap().contains("did not run"));
}

#[tokio::test]
async fn invalid_actions_and_ended_sessions_are_rejected() {
    let url = start().await;
    let (_host, _id) = register(&url).await;
    let client = ControlClient::new(&url, TOKEN).unwrap();
    let session = client
        .create_session(&CreateSessionRequest::default())
        .await
        .unwrap();

    let err = client
        .act(
            session.id,
            RemoteAction::Navigate {
                url: "javascript:alert(1)".into(),
                tab_id: None,
            },
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(err.status(), Some(400));

    // Unknown action types are rejected at deserialisation.
    let r = reqwest::Client::new()
        .post(format!("{url}/v1/sessions/{}/actions", session.id))
        .bearer_auth(TOKEN)
        .json(&json!({"action": {"type": "execute_script", "script": "1"}}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 422);

    client.end_session(session.id).await.unwrap();
    let err = client
        .act(session.id, RemoteAction::Tabs, None)
        .await
        .unwrap_err();
    assert_eq!(err.status(), Some(409));
}

#[tokio::test]
async fn profiles_over_http() {
    use hexactra_client::HostPollStatus;
    let url = start().await;
    let host = HostClient::new(&url, TOKEN).unwrap();
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
    host.poll(
        id,
        &HostPollStatus {
            browser_connected: false,
            on_demand: true,
            profiles: Some((vec!["default".into(), "travel".into()], vec![])),
            accepts_commands: false,
        },
        Duration::from_millis(10),
    )
    .await
    .unwrap();
    let client = ControlClient::new(&url, TOKEN).unwrap();
    let hosts = client.hosts().await.unwrap();
    assert_eq!(hosts[0].profiles, vec!["default", "travel"]);

    let s = client
        .create_session(&CreateSessionRequest {
            profile: Some("travel".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(s.profile, "travel");

    let err = client
        .create_session(&CreateSessionRequest {
            profile: Some("work".into()),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(err.status(), Some(404));
    assert!(err.to_string().contains("profile_not_found"));

    let err = client
        .create_session(&CreateSessionRequest {
            profile: Some("../etc".into()),
            create_profile: true,
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(err.status(), Some(400));

    let w = client
        .create_session(&CreateSessionRequest {
            profile: Some("work".into()),
            create_profile: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(w.profile, "work");
}

#[tokio::test]
async fn host_mode_and_desktop_over_http() {
    use hexactra_core::remote::HostMode;
    let url = start().await;
    let host = HostClient::new(&url, TOKEN).unwrap();
    let id = host
        .register(&RegisterHostRequest {
            name: "mini-pc".into(),
            version: "0".into(),
            host_id: None,
            viewer_url: None,
            mode: Some(HostMode::Unattended),
            desktop: true,
        })
        .await
        .unwrap()
        .host_id;
    let client = ControlClient::new(&url, TOKEN).unwrap();
    let h = &client.hosts().await.unwrap()[0];
    assert_eq!(h.mode, Some(HostMode::Unattended));
    assert!(h.desktop);

    // The wire form is snake_case.
    let raw: serde_json::Value = reqwest::Client::new()
        .get(format!("{url}/v1/hosts"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(raw["hosts"][0]["mode"], "unattended");
    assert_eq!(raw["hosts"][0]["desktop"], true);

    // An older agent's registration (no mode, no desktop) clears both.
    let old = json!({ "name": "mini-pc", "version": "0", "host_id": id });
    let r = reqwest::Client::new()
        .post(format!("{url}/v1/hosts/register"))
        .bearer_auth(TOKEN)
        .json(&old)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let h = &client.hosts().await.unwrap()[0];
    assert_eq!(h.mode, None);
    assert!(!h.desktop);
    let raw: serde_json::Value = reqwest::Client::new()
        .get(format!("{url}/v1/hosts"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(raw["hosts"][0].get("mode").is_none());

    // An unknown mode is refused.
    let r = reqwest::Client::new()
        .post(format!("{url}/v1/hosts/register"))
        .bearer_auth(TOKEN)
        .json(&json!({ "name": "x", "version": "0", "mode": "headless" }))
        .send()
        .await
        .unwrap();
    assert!(r.status().is_client_error());
}
