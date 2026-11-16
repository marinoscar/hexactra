//! `GET /v1/events` over real HTTP (#212).

use std::time::Duration;

use futures_util::StreamExt;
use hexactra_client::{ControlClient, HostClient};
use hexactra_control::runtime::{self, ApiState, RuntimeStore};
use hexactra_core::remote::{
    CreateHandoffRequest, CreateSessionRequest, HandoffInput, HandoffKind, RegisterHostRequest,
    RemoteAction,
};
use serde_json::Value;

const TOKEN: &str = "events-test-token-0123456789abcdef";

async fn start() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(runtime::serve(
        listener,
        ApiState::new(RuntimeStore::new(), TOKEN),
        std::future::pending(),
    ));
    url
}

/// Minimal SSE reader: yields (id, event, data) until `n` events or timeout.
async fn read_events(
    url: &str,
    query: &str,
    last_event_id: Option<&str>,
    n: usize,
) -> Vec<(Option<String>, String, Value)> {
    let mut req = reqwest::Client::new()
        .get(format!("{url}/v1/events{query}"))
        .bearer_auth(TOKEN);
    if let Some(id) = last_event_id {
        req = req.header("last-event-id", id);
    }
    let resp = req.send().await.unwrap();
    assert_eq!(resp.status(), 200);
    assert!(resp.headers()["content-type"]
        .to_str()
        .unwrap()
        .starts_with("text/event-stream"));
    let mut body = resp.bytes_stream();
    let mut buf = String::new();
    let mut out = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while out.len() < n {
        let chunk = tokio::time::timeout_at(deadline, body.next())
            .await
            .expect("timed out waiting for events")
            .unwrap()
            .unwrap();
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(i) = buf.find("\n\n") {
            let block: String = buf.drain(..i + 2).collect();
            let (mut id, mut ev, mut data) = (None, String::from("message"), String::new());
            for line in block.lines() {
                if let Some(v) = line.strip_prefix("id:") {
                    id = Some(v.trim().to_string());
                } else if let Some(v) = line.strip_prefix("event:") {
                    ev = v.trim().to_string();
                } else if let Some(v) = line.strip_prefix("data:") {
                    data.push_str(v.trim());
                }
            }
            if !data.is_empty() {
                out.push((id, ev, serde_json::from_str(&data).unwrap()));
            }
        }
    }
    out
}

#[tokio::test]
async fn stream_replay_filter_and_scope() {
    let url = start().await;
    let host = HostClient::new(&url, TOKEN).unwrap();
    let hid = host
        .register(&RegisterHostRequest {
            name: "h".into(),
            version: "0".into(),
            host_id: None,
            viewer_url: None,
            mode: None,
            desktop: false,
        })
        .await
        .unwrap()
        .host_id;
    host.next(hid, true, Duration::from_millis(10))
        .await
        .unwrap();
    let client = ControlClient::new(&url, TOKEN).unwrap();

    // Live: start listening, then act.
    let u = url.clone();
    let live = tokio::spawn(async move { read_events(&u, "", None, 3).await });
    tokio::time::sleep(Duration::from_millis(200)).await;
    let session = client
        .create_session(&CreateSessionRequest::default())
        .await
        .unwrap();
    // A type action whose text must never appear in events.
    let _ = client
        .act(
            session.id,
            RemoteAction::Type {
                selector: "#secret-field".into(),
                text: "hunter2-typed-text".into(),
                clear: false,
                submit: false,
                sensitive: false,
                tab_id: None,
            },
            Some(Duration::from_millis(300)),
        )
        .await
        .unwrap();
    let got = live.await.unwrap();
    let kinds: Vec<&str> = got.iter().map(|(_, k, _)| k.as_str()).collect();
    assert_eq!(
        kinds,
        vec!["session.created", "operation.queued", "operation.timed_out"]
    );
    let all = serde_json::to_string(&got.iter().map(|g| &g.2).collect::<Vec<_>>()).unwrap();
    assert!(!all.contains("hunter2-typed-text") && !all.contains("#secret-field"));
    assert_eq!(got[1].2["data"]["kind"], "type");

    // Resume: everything after the first event's id, from the replay buffer.
    let first_id = got[0].0.clone().unwrap();
    let replayed = read_events(&url, "", Some(&first_id), 2).await;
    assert_eq!(replayed[0].1, "operation.queued");
    assert!(
        replayed[0].0.as_ref().unwrap().parse::<u64>().unwrap() > first_id.parse::<u64>().unwrap()
    );

    // A seq from a previous process gets a reset.
    let reset = read_events(&url, "?after=999999", None, 1).await;
    assert_eq!(reset[0].1, "reset");

    // Type filter: only handoff events, content-free (no prompt).
    let u = url.clone();
    let filtered = tokio::spawn(async move { read_events(&u, "?types=handoff.*", None, 1).await });
    tokio::time::sleep(Duration::from_millis(200)).await;
    client
        .create_handoff(
            session.id,
            &CreateHandoffRequest {
                kind: HandoffKind::Code,
                prompt: "Enter the code sent to +1 555 0100".into(),
                input: HandoffInput::Secret,
                choices: vec![],
                constraints: Default::default(),
                confirm_label: None,
                deny_label: None,
                risk: None,
                timeout_ms: None,
                page: None,
            },
        )
        .await
        .unwrap();
    let f = filtered.await.unwrap();
    assert_eq!(f[0].1, "handoff.created");
    assert_eq!(f[0].2["data"]["input"], "secret");
    assert!(!f[0].2.to_string().contains("555 0100"));

    // Host credentials cannot read the stream.
    let e = client.create_enrollment(None, None).await.unwrap();
    let enrolled = HostClient::enroll(&url, e["enrollment_token"].as_str().unwrap(), "x", "0")
        .await
        .unwrap();
    let r = reqwest::Client::new()
        .get(format!("{url}/v1/events"))
        .bearer_auth(&enrolled.host_token)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
}
