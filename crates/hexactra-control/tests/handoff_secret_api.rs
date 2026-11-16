//! Secrets typed by the fabric, never returned to callers (#287), over real
//! HTTP: a person answers a `secret` handoff with the response token, the
//! agent sends `type_secret`, and only the host-bound command carries the
//! value. The operation view, the handoff view, the event log, webhook
//! payloads and the control plane's logs never do.

use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{body::Bytes, http::StatusCode, routing::post, Router};
use hexactra_client::{ControlClient, HostClient};
use hexactra_control::runtime::events::Replay;
use hexactra_control::runtime::webhooks::{WebhookConfig, Webhooks};
use hexactra_control::runtime::{self, ApiState, RuntimeStore};
use hexactra_core::remote::{
    CreateHandoffRequest, CreateSessionRequest, CreateWebhookRequest, HandoffInput, HandoffKind,
    HandoffStatus, OperationResult, OperationState, RegisterHostRequest, RemoteAction,
    REDACTED_TEXT,
};
use serde_json::{json, Value};
use uuid::Uuid;

const TOKEN: &str = "secret-test-token-0123456789abcdef";
const SECRET: &str = "424242-unique-otp";

/// Everything the control plane logs, captured for the leak check.
#[derive(Clone, Default)]
struct LogBuf(Arc<Mutex<Vec<u8>>>);

impl Write for LogBuf {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBuf {
    type Writer = LogBuf;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

/// A channel endpoint that records every webhook body.
async fn receiver() -> (String, Arc<Mutex<Vec<Value>>>) {
    let rec = Arc::new(Mutex::new(Vec::new()));
    let r2 = rec.clone();
    let app = Router::new().route(
        "/hook",
        post(move |body: Bytes| {
            let rec = r2.clone();
            async move {
                rec.lock()
                    .unwrap()
                    .push(serde_json::from_slice(&body).unwrap());
                StatusCode::NO_CONTENT
            }
        }),
    );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/hook", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (url, rec)
}

struct Fabric {
    url: String,
    store: RuntimeStore,
    client: ControlClient,
    host: HostClient,
    host_id: Uuid,
}

async fn start() -> Fabric {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let webhooks = Webhooks::load(WebhookConfig {
        file: None,
        public_url: Some(url.clone()),
        allow_insecure: true,
        retry_schedule: vec![Duration::ZERO],
    })
    .unwrap();
    let store = RuntimeStore::new();
    tokio::spawn(runtime::serve(
        listener,
        ApiState::with_webhooks(store.clone(), TOKEN, webhooks),
        std::future::pending(),
    ));
    let host = HostClient::new(&url, TOKEN).unwrap();
    let host_id = host
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
    host.next(host_id, true, Duration::from_millis(10))
        .await
        .unwrap();
    Fabric {
        client: ControlClient::new(&url, TOKEN).unwrap(),
        url,
        store,
        host,
        host_id,
    }
}

fn code_request() -> CreateHandoffRequest {
    CreateHandoffRequest::new(
        HandoffKind::Code,
        "Enter the code sent to your phone",
        HandoffInput::Secret,
    )
}

fn type_secret(handoff_id: Uuid) -> RemoteAction {
    RemoteAction::TypeSecret {
        handoff_id,
        selector: "#otp".into(),
        clear: true,
        submit: true,
        tab_id: None,
    }
}

async fn wait_until(mut f: impl FnMut() -> bool) {
    for _ in 0..200 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out");
}

#[tokio::test]
async fn type_secret_types_the_answer_without_returning_it() {
    let logs = LogBuf::default();
    tracing_subscriber::fmt()
        .with_writer(logs.clone())
        .with_max_level(tracing::Level::DEBUG)
        .with_ansi(false)
        .init();

    let f = start().await;
    let (hook_url, hooks) = receiver().await;
    f.client
        .add_webhook(&CreateWebhookRequest {
            url: hook_url,
            events: vec!["*".into()],
            description: None,
        })
        .await
        .unwrap();
    let session = f
        .client
        .create_session(&CreateSessionRequest::default())
        .await
        .unwrap()
        .id;
    let created = f
        .client
        .create_handoff(session, &code_request())
        .await
        .unwrap();
    let hid = created.handoff.id;

    // Typing the secret before the person answers is refused.
    let err = f
        .client
        .act(session, type_secret(hid), Some(Duration::from_secs(1)))
        .await
        .unwrap_err();
    assert_eq!(err.status(), Some(409));

    // The person answers with only the response token.
    let r = reqwest::Client::new()
        .post(format!("{}{}", f.url, created.respond_path))
        .json(&json!({"value": SECRET, "response_token": created.response_token}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert!(!r.text().await.unwrap().contains(SECRET));
    let view = f.client.handoff(hid, None).await.unwrap();
    assert_eq!(view.status, HandoffStatus::Completed);
    assert!(view.response.as_ref().unwrap().value_withheld);

    // The agent asks the fabric to type it; a fake host runs the action.
    let host = f.host.clone();
    let host_id = f.host_id;
    let runner = tokio::spawn(async move {
        let op = host
            .next(host_id, true, Duration::from_secs(5))
            .await
            .unwrap()
            .expect("an operation");
        host.report(
            host_id,
            op.id,
            &OperationResult {
                ok: true,
                result: Some(json!({})),
                error: None,
            },
        )
        .await
        .unwrap();
        op
    });
    let op = f
        .client
        .act(session, type_secret(hid), Some(Duration::from_secs(10)))
        .await
        .unwrap();
    assert_eq!(op.state, OperationState::Succeeded);

    // Only the host-bound command carries the value, as a plain `type`.
    let dispatched = runner.await.unwrap();
    assert_eq!(
        dispatched.action,
        RemoteAction::Type {
            selector: "#otp".into(),
            text: SECRET.into(),
            clear: true,
            submit: true,
            sensitive: true,
            tab_id: None,
        }
    );

    // The value was used once.
    let err = f
        .client
        .act(session, type_secret(hid), Some(Duration::from_secs(1)))
        .await
        .unwrap_err();
    assert_eq!(err.status(), Some(409));
    assert!(err.to_string().contains("secret_unavailable"), "{err}");
    let err = f.client.claim_handoff_secret(hid).await.unwrap_err();
    assert_eq!(err.status(), Some(409));

    // Another session cannot use this session's handoff.
    let other = f
        .client
        .create_session(&CreateSessionRequest::default())
        .await
        .unwrap()
        .id;
    let err = f
        .client
        .act(other, type_secret(hid), Some(Duration::from_secs(1)))
        .await
        .unwrap_err();
    assert_eq!(err.status(), Some(422));
    assert!(err.to_string().contains("handoff_wrong_session"), "{err}");
    let err = f
        .client
        .act(
            session,
            type_secret(Uuid::new_v4()),
            Some(Duration::from_secs(1)),
        )
        .await
        .unwrap_err();
    assert_eq!(err.status(), Some(404));

    // Nothing a caller can read carries the value.
    let read = |v: &dyn erased::Ser| v.json();
    let op_view = f.client.operation(op.id).await.unwrap();
    assert!(serde_json::to_string(&op_view)
        .unwrap()
        .contains("type_secret"));
    for (what, text) in [
        ("operation result", read(&op)),
        ("operation view", read(&op_view)),
        (
            "handoff view",
            read(&f.client.handoff(hid, None).await.unwrap()),
        ),
        (
            "handoff list",
            read(&f.client.handoffs(false).await.unwrap()),
        ),
    ] {
        assert!(!text.contains(SECRET), "{what} leaks the secret: {text}");
    }
    let Replay::Events(events) = f.store.log.subscribe_from(Some(0)).1 else {
        panic!("event gap");
    };
    let events = serde_json::to_string(&events).unwrap();
    assert!(!events.contains(SECRET), "event log leaks: {events}");
    assert!(events.contains("handoff.secret_used"));

    wait_until(|| {
        hooks
            .lock()
            .unwrap()
            .iter()
            .any(|e| e["type"] == "handoff.resolved")
    })
    .await;
    let hooks = serde_json::to_string(&*hooks.lock().unwrap()).unwrap();
    assert!(!hooks.contains(SECRET), "webhooks leak: {hooks}");

    let logs = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    assert!(logs.contains("operation queued"), "logs were not captured");
    assert!(!logs.contains(SECRET), "logs leak: {logs}");
}

#[tokio::test]
async fn sensitive_type_text_is_reported_as_redacted() {
    let f = start().await;
    let session = f
        .client
        .create_session(&CreateSessionRequest::default())
        .await
        .unwrap()
        .id;
    let op = f
        .client
        .act(
            session,
            RemoteAction::Type {
                selector: "#pw".into(),
                text: "hunter2-sensitive".into(),
                clear: false,
                submit: false,
                sensitive: true,
                tab_id: None,
            },
            Some(Duration::from_millis(200)),
        )
        .await
        .unwrap();
    // No host picked it up: it timed out and its text was dropped.
    assert_eq!(op.state, OperationState::TimedOut);
    let shown = serde_json::to_string(&f.client.operation(op.id).await.unwrap()).unwrap();
    assert!(!shown.contains("hunter2-sensitive"));
    assert!(shown.contains(REDACTED_TEXT));
}

/// Serialize anything for the leak checks.
mod erased {
    pub trait Ser {
        fn json(&self) -> String;
    }
    impl<T: serde::Serialize> Ser for T {
        fn json(&self) -> String {
            serde_json::to_string(self).unwrap()
        }
    }
}
