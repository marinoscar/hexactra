//! Screenshot artifacts by handle over real HTTP (#214).

use std::time::Duration;

use base64::Engine;
use hexactra_client::{ControlClient, HostClient};
use hexactra_control::runtime::artifacts::ArtifactStore;
use hexactra_control::runtime::{self, ApiState, RuntimeStore};
use hexactra_core::remote::{
    ActionRequest, CreateSessionRequest, OperationResult, OperationView, RegisterHostRequest,
    RemoteAction,
};
use serde_json::json;

const TOKEN: &str = "operator-token-0123456789abcdefgh";

async fn start(ttl: Duration) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let mut store = RuntimeStore::new();
    store.artifacts = ArtifactStore::new(ttl, 1024 * 1024);
    tokio::spawn(runtime::serve(
        listener,
        ApiState::new(store, TOKEN),
        std::future::pending(),
    ));
    url
}

/// A host that answers every screenshot with fixed bytes.
async fn fake_host(url: &str, bytes: &'static [u8]) {
    let host = HostClient::new(url, TOKEN).unwrap();
    let id = host
        .register(&RegisterHostRequest {
            name: "h".into(),
            version: "0".into(),
            host_id: None,
            viewer_url: None,
        })
        .await
        .unwrap()
        .host_id;
    host.next(id, true, Duration::from_millis(10))
        .await
        .unwrap();
    tokio::spawn(async move {
        loop {
            if let Ok(Some(op)) = host.next(id, true, Duration::from_secs(5)).await {
                let data = base64::engine::general_purpose::STANDARD.encode(bytes);
                host.report(
                    id,
                    op.id,
                    &OperationResult {
                        ok: true,
                        result: Some(json!({ "mime": "image/jpeg", "data": data })),
                        error: None,
                    },
                )
                .await
                .unwrap();
            }
        }
    });
}

async fn shoot(url: &str, session: uuid::Uuid, inline: bool) -> OperationView {
    reqwest::Client::new()
        .post(format!("{url}/v1/sessions/{session}/actions"))
        .bearer_auth(TOKEN)
        .json(&ActionRequest {
            action: RemoteAction::Screenshot { tab_id: None },
            timeout_ms: Some(5_000),
            inline_artifacts: inline,
        })
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[tokio::test]
async fn screenshots_come_back_as_handles_that_expire() {
    let url = start(Duration::from_millis(800)).await;
    fake_host(&url, b"\xff\xd8jpeg-bytes").await;
    let client = ControlClient::new(&url, TOKEN).unwrap();
    let s = client
        .create_session(&CreateSessionRequest::default())
        .await
        .unwrap();

    let op = shoot(&url, s.id, false).await;
    let r = op.result.unwrap();
    assert!(r.get("data").is_none(), "no inline bytes by default: {r}");
    assert_eq!(r["size"], 12);
    assert_eq!(r["mime"], "image/jpeg");
    let id: uuid::Uuid = r["artifact_id"].as_str().unwrap().parse().unwrap();
    let (mime, bytes) = client.artifact(id).await.unwrap();
    assert_eq!(
        (mime.as_str(), bytes.as_slice()),
        ("image/jpeg", &b"\xff\xd8jpeg-bytes"[..])
    );
    assert_eq!(client.screenshot_bytes(&r).await.unwrap().1, bytes);

    // Fetching needs a client token.
    let anon = reqwest::get(format!("{url}/v1/artifacts/{id}"))
        .await
        .unwrap();
    assert_eq!(anon.status(), 401);

    // Migration flag: inline data as well.
    let inline = shoot(&url, s.id, true).await.result.unwrap();
    assert!(inline["data"].as_str().is_some());
    assert!(inline["artifact_id"].as_str().is_some());

    tokio::time::sleep(Duration::from_millis(900)).await;
    assert_eq!(client.artifact(id).await.unwrap_err().status(), Some(404));
}
