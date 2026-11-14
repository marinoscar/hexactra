//! Handoff API over real HTTP (#189).

use std::time::Duration;

use hexactra_client::{ControlClient, HostClient};
use hexactra_control::runtime::{self, ApiState, RuntimeStore};
use hexactra_core::remote::{
    CreateHandoffRequest, CreateSessionRequest, HandoffInput, HandoffKind, HandoffOutcome,
    HandoffStatus, RegisterHostRequest, RemoteAction, RespondHandoffRequest,
};
use serde_json::json;

const TOKEN: &str = "handoff-test-token-0123456789abcd";

async fn start() -> (String, ControlClient, uuid::Uuid) {
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
    let client = ControlClient::new(&url, TOKEN).unwrap();
    let session = client
        .create_session(&CreateSessionRequest::default())
        .await
        .unwrap();
    (url, client, session.id)
}

fn code_request() -> CreateHandoffRequest {
    CreateHandoffRequest {
        kind: HandoffKind::Code,
        prompt: "Enter the 6-digit code sent to your phone".into(),
        input: HandoffInput::Secret,
        choices: vec![],
        timeout_ms: None,
        page: None,
    }
}

#[tokio::test]
async fn channel_answers_with_response_token_and_agent_claims_secret() {
    let (url, client, session) = start().await;
    let created = client
        .create_handoff(session, &code_request())
        .await
        .unwrap();
    assert_eq!(created.handoff.status, HandoffStatus::Pending);

    // Actions are paused while the handoff is open.
    let err = client
        .act(session, RemoteAction::Tabs, Some(Duration::from_secs(1)))
        .await
        .unwrap_err();
    assert_eq!(err.status(), Some(409));
    assert!(err.to_string().contains("handoff_pending"));

    // The agent waits in the background.
    let c2 = client.clone();
    let id = created.handoff.id;
    let waiter = tokio::spawn(async move { c2.handoff(id, Some(Duration::from_secs(10))).await });

    // A channel with only the response token answers (header form).
    let http = reqwest::Client::new();
    let r = http
        .post(format!("{url}{}", created.respond_path))
        .header("x-hexactra-response-token", &created.response_token)
        .json(&json!({"value": "123456", "channel": "test-bot"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let body = r.text().await.unwrap();
    assert!(
        !body.contains("123456"),
        "secret leaked in respond response"
    );

    let done = waiter.await.unwrap().unwrap();
    assert_eq!(done.status, HandoffStatus::Completed);
    let resp = done.response.unwrap();
    assert!(resp.value_withheld);
    assert_eq!(resp.channel.as_deref(), Some("test-bot"));

    assert_eq!(client.claim_handoff_secret(id).await.unwrap(), "123456");
    assert_eq!(
        client.claim_handoff_secret(id).await.unwrap_err().status(),
        Some(409)
    );

    // Token was single use.
    let r = http
        .post(format!("{url}{}", created.respond_path))
        .json(&json!({"value": "999999", "response_token": created.response_token}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);

    // Session accepts actions again (queued; no host polls, so it just times out).
    let op = client
        .act(
            session,
            RemoteAction::Tabs,
            Some(Duration::from_millis(200)),
        )
        .await
        .unwrap();
    assert_eq!(op.state, hexactra_core::remote::OperationState::TimedOut);
}

#[tokio::test]
async fn respond_requires_some_credential() {
    let (url, client, session) = start().await;
    let created = client
        .create_handoff(session, &code_request())
        .await
        .unwrap();
    let http = reqwest::Client::new();
    let r = http
        .post(format!("{url}{}", created.respond_path))
        .json(&json!({"value": "1"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
    let r = http
        .post(format!("{url}{}", created.respond_path))
        .json(&json!({"value": "1", "response_token": "not-the-token"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    // Protected routes still need the API token.
    let r = http
        .get(format!("{url}/v1/handoffs/{}", created.handoff.id))
        .header("x-hexactra-response-token", &created.response_token)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
}

#[tokio::test]
async fn html_form_flow_for_link_channels() {
    let (url, client, session) = start().await;
    let created = client
        .create_handoff(
            session,
            &CreateHandoffRequest {
                kind: HandoffKind::Confirmation,
                prompt: "Approve the purchase of <b>2 tickets</b>?".into(),
                input: HandoffInput::Choice,
                choices: vec!["Approve".into(), "Reject".into()],
                timeout_ms: None,
                page: None,
            },
        )
        .await
        .unwrap();
    let link = format!(
        "{url}{}?token={}",
        created.respond_path, created.response_token
    );
    let http = reqwest::Client::new();
    let page = http.get(&link).send().await.unwrap();
    assert_eq!(page.status(), 200);
    assert!(page
        .headers()
        .get("content-security-policy")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("default-src 'none'"));
    let html = page.text().await.unwrap();
    assert!(
        html.contains("&lt;b&gt;2 tickets&lt;/b&gt;"),
        "prompt not escaped"
    );
    assert!(html.contains(r#"<option value="Approve">"#));

    // Wrong token: no prompt disclosed.
    let bad = http
        .get(format!("{url}{}?token=nope", created.respond_path))
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 403);
    assert!(!bad.text().await.unwrap().contains("tickets"));

    let submitted = http
        .post(format!("{url}{}", created.respond_path))
        .form(&[
            ("token", created.response_token.as_str()),
            ("outcome", "completed"),
            ("value", "Approve"),
        ])
        .send()
        .await
        .unwrap();
    assert_eq!(submitted.status(), 200);
    assert!(submitted.text().await.unwrap().contains("Thanks"));
    let v = client.handoff(created.handoff.id, None).await.unwrap();
    assert_eq!(v.status, HandoffStatus::Completed);
    let resp = v.response.unwrap();
    assert_eq!(resp.value.as_deref(), Some("Approve"));
    assert_eq!(resp.channel.as_deref(), Some("web-form"));

    // The used link now says so.
    assert_eq!(http.get(&link).send().await.unwrap().status(), 403);
}

#[tokio::test]
async fn operator_can_answer_cancel_and_list() {
    let (_url, client, session) = start().await;
    let mut req = code_request();
    req.input = HandoffInput::None;
    req.kind = HandoffKind::Captcha;
    let created = client.create_handoff(session, &req).await.unwrap();
    let pending = client.handoffs(true).await.unwrap();
    assert_eq!(pending.len(), 1);
    let v = client.cancel_handoff(created.handoff.id).await.unwrap();
    assert_eq!(v.status, HandoffStatus::Cancelled);
    assert!(client.handoffs(true).await.unwrap().is_empty());

    let created = client.create_handoff(session, &req).await.unwrap();
    let v = client
        .respond_handoff(
            created.handoff.id,
            &RespondHandoffRequest {
                outcome: HandoffOutcome::Completed,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(v.status, HandoffStatus::Completed);

    // Invalid request is a 400.
    let mut bad = code_request();
    bad.prompt = String::new();
    assert_eq!(
        client
            .create_handoff(session, &bad)
            .await
            .unwrap_err()
            .status(),
        Some(400)
    );
}
