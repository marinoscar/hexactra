//! Webhooks as handoff channels, over real HTTP (#190).
//!
//! A local receiver plays the role of a channel (chat bot, automation): it
//! verifies the Standard Webhooks signature, fails its first delivery to
//! exercise retries, and answers the handoff using only what the payload
//! carries.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{body::Bytes, http::HeaderMap, http::StatusCode, routing::post, Router};
use hexactra_client::{ControlClient, HostClient};
use hexactra_control::runtime::webhooks::{sign, WebhookConfig, Webhooks};
use hexactra_control::runtime::{self, ApiState, RuntimeStore};
use hexactra_core::remote::{
    CreateHandoffRequest, CreateSessionRequest, CreateWebhookRequest, HandoffInput, HandoffKind,
    HandoffStatus, RegisterHostRequest,
};
use serde_json::{json, Value};

const TOKEN: &str = "webhook-test-token-0123456789abcd";

#[derive(Default)]
struct Received {
    events: Vec<Value>,
    calls: usize,
}

/// Start a receiver; returns its URL and the shared record.
async fn receiver(secret: Arc<Mutex<String>>) -> (String, Arc<Mutex<Received>>) {
    let rec = Arc::new(Mutex::new(Received::default()));
    let r2 = rec.clone();
    let app = Router::new().route(
        "/hook",
        post(move |headers: HeaderMap, body: Bytes| {
            let rec = r2.clone();
            let secret = secret.clone();
            async move {
                let id = headers["webhook-id"].to_str().unwrap().to_string();
                let ts: i64 = headers["webhook-timestamp"]
                    .to_str()
                    .unwrap()
                    .parse()
                    .unwrap();
                let sig = headers["webhook-signature"].to_str().unwrap().to_string();
                let expected = sign(&secret.lock().unwrap(), &id, ts, &body).unwrap();
                assert_eq!(sig, expected, "bad webhook signature");
                let mut r = rec.lock().unwrap();
                r.calls += 1;
                if r.calls == 1 {
                    // First delivery fails: the dispatcher must retry.
                    return StatusCode::INTERNAL_SERVER_ERROR;
                }
                r.events.push(serde_json::from_slice(&body).unwrap());
                StatusCode::NO_CONTENT
            }
        }),
    );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/hook", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (url, rec)
}

async fn start(allow_insecure: bool) -> (String, ControlClient, uuid::Uuid) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let webhooks = Webhooks::load(WebhookConfig {
        file: None,
        public_url: Some(url.clone()),
        allow_insecure,
        retry_schedule: vec![
            Duration::ZERO,
            Duration::from_millis(50),
            Duration::from_millis(50),
        ],
    })
    .unwrap();
    tokio::spawn(runtime::serve(
        listener,
        ApiState::with_webhooks(RuntimeStore::new(), TOKEN, webhooks),
        std::future::pending(),
    ));
    let host = HostClient::new(&url, TOKEN).unwrap();
    let hid = host
        .register(&RegisterHostRequest {
            name: "h".into(),
            version: "0".into(),
            host_id: None,
            viewer_url: None,
        })
        .await
        .unwrap()
        .host_id;
    host.next(hid, true, Duration::from_millis(10))
        .await
        .unwrap();
    let client = ControlClient::new(&url, TOKEN).unwrap();
    let session = client
        .create_session(&CreateSessionRequest::default())
        .await
        .unwrap();
    (url, client, session.id)
}

async fn wait_for<T>(mut f: impl FnMut() -> Option<T>) -> T {
    for _ in 0..200 {
        if let Some(v) = f() {
            return v;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out");
}

#[tokio::test]
async fn webhook_channel_receives_signed_event_and_answers_handoff() {
    let (_url, client, session) = start(true).await;
    let secret = Arc::new(Mutex::new(String::new()));
    let (hook_url, rec) = receiver(secret.clone()).await;

    let created = client
        .add_webhook(&CreateWebhookRequest {
            url: hook_url.clone(),
            events: vec!["handoff.*".into()],
            description: Some("test channel".into()),
        })
        .await
        .unwrap();
    *secret.lock().unwrap() = created.secret.clone();
    assert!(!serde_json::to_string(&client.webhooks().await.unwrap())
        .unwrap()
        .contains("whsec_"));

    let h = client
        .create_handoff(
            session,
            &CreateHandoffRequest {
                kind: HandoffKind::Code,
                prompt: "Enter the code".into(),
                input: HandoffInput::Secret,
                choices: vec![],
                timeout_ms: None,
                page: None,
            },
        )
        .await
        .unwrap();

    // The channel gets handoff.created (after one failed attempt).
    let event = wait_for(|| rec.lock().unwrap().events.first().cloned()).await;
    assert_eq!(event["type"], "handoff.created");
    assert_eq!(event["data"]["handoff"]["id"], h.handoff.id.to_string());
    let respond = &event["data"]["respond"];
    assert!(respond["form_url"].as_str().unwrap().contains("?token="));

    // The channel answers using only the payload.
    let r = reqwest::Client::new()
        .post(respond["url"].as_str().unwrap())
        .json(&json!({
            "value": "424242",
            "channel": "test-channel",
            "response_token": respond["token"],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);

    let done = client
        .handoff(h.handoff.id, Some(Duration::from_secs(5)))
        .await
        .unwrap();
    assert_eq!(done.status, HandoffStatus::Completed);
    assert_eq!(
        done.response.unwrap().channel.as_deref(),
        Some("test-channel")
    );
    assert_eq!(
        client.claim_handoff_secret(h.handoff.id).await.unwrap(),
        "424242"
    );

    // handoff.resolved follows, without the secret and without a token.
    let resolved = wait_for(|| {
        rec.lock()
            .unwrap()
            .events
            .iter()
            .find(|e| e["type"] == "handoff.resolved")
            .cloned()
    })
    .await;
    let text = resolved.to_string();
    assert!(!text.contains("424242"));
    assert!(resolved["data"].get("respond").is_none());

    // Delivery log shows the retry and the successes.
    let log = client.webhook_deliveries(created.webhook.id).await.unwrap();
    assert!(log
        .iter()
        .any(|d| d.outcome == "retrying" && d.http_status == Some(500)));
    assert!(log.iter().any(|d| d.outcome == "succeeded"));

    // Test events and removal.
    client.test_webhook(created.webhook.id).await.unwrap();
    wait_for(|| {
        rec.lock()
            .unwrap()
            .events
            .iter()
            .any(|e| e["type"] == "webhook.test")
            .then_some(())
    })
    .await;
    client.remove_webhook(created.webhook.id).await.unwrap();
    assert!(client.webhooks().await.unwrap().is_empty());
}

#[tokio::test]
async fn insecure_targets_are_refused_by_default() {
    let (_url, client, _session) = start(false).await;
    let err = client
        .add_webhook(&CreateWebhookRequest {
            url: "http://127.0.0.1:9/hook".into(),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(err.status(), Some(400));
    // https to a loopback address is accepted at registration but never
    // delivered: the resolved address is private.
    let created = client
        .add_webhook(&CreateWebhookRequest {
            url: "https://localhost:9/hook".into(),
            events: vec!["*".into()],
            description: None,
        })
        .await
        .unwrap();
    client.test_webhook(created.webhook.id).await.unwrap();
    let log = wait_for_log(&client, created.webhook.id).await;
    assert!(log[0].error.as_deref().unwrap().contains("may not reach"));
}

async fn wait_for_log(
    client: &ControlClient,
    id: uuid::Uuid,
) -> Vec<hexactra_core::remote::WebhookDelivery> {
    for _ in 0..200 {
        let log = client.webhook_deliveries(id).await.unwrap();
        if log.iter().any(|d| d.outcome == "failed") {
            return log;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("no failed delivery recorded");
}
