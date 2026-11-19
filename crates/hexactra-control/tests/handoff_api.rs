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
    let (url, client, session, _) = start_with_service().await;
    (url, client, session)
}

/// Also returns a service token named "console".
async fn start_with_service() -> (String, ControlClient, uuid::Uuid, String) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let state = ApiState::new(RuntimeStore::new(), TOKEN);
    let (_, service_token) = state.credentials.create_service_token("console").unwrap();
    tokio::spawn(runtime::serve(listener, state, std::future::pending()));
    let host = HostClient::new(&url, TOKEN).unwrap();
    let id = host
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
    host.next(id, true, Duration::from_millis(10))
        .await
        .unwrap();
    let client = ControlClient::new(&url, TOKEN).unwrap();
    let session = client
        .create_session(&CreateSessionRequest::default())
        .await
        .unwrap();
    (url, client, session.id, service_token)
}

fn code_request() -> CreateHandoffRequest {
    CreateHandoffRequest {
        kind: HandoffKind::Code,
        prompt: "Enter the 6-digit code sent to your phone".into(),
        input: HandoffInput::Secret,
        choices: vec![],
        constraints: Default::default(),
        confirm_label: None,
        deny_label: None,
        risk: None,
        timeout_ms: None,
        page: None,
        remember: None,
        offer_save: false,
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
                constraints: Default::default(),
                confirm_label: None,
                deny_label: None,
                risk: None,
                timeout_ms: None,
                page: None,
                remember: None,
                offer_save: false,
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
    assert!(html.contains(r#"<input type="radio" name="value" value="Approve" required>"#));

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

fn request(input: &str, extra: serde_json::Value) -> CreateHandoffRequest {
    let mut v = json!({"kind": "other", "prompt": "A question", "input": input});
    v.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    serde_json::from_value(v).unwrap()
}

/// POST a JSON answer; returns (status, body).
async fn answer(
    url: &str,
    path: &str,
    bearer: Option<&str>,
    body: serde_json::Value,
) -> (u16, serde_json::Value) {
    let mut r = reqwest::Client::new()
        .post(format!("{url}{path}"))
        .json(&body);
    if let Some(b) = bearer {
        r = r.bearer_auth(b);
    }
    let r = r.send().await.unwrap();
    let status = r.status().as_u16();
    (status, r.json().await.unwrap_or_default())
}

#[tokio::test]
async fn every_input_type_is_created_and_answered() {
    let (url, client, session) = start().await;
    let cases = [
        (
            request(
                "text",
                json!({"constraints": {"pattern": "[A-Z]{3}", "max_length": 3, "multiline": false}}),
            ),
            json!({"value": "abc"}),
            json!({"value": "ABC"}),
            json!({"value": "ABC"}),
        ),
        (
            request(
                "choice",
                json!({"choices": ["Yes, continue", {"id": "stop", "label": "Stop", "description": "End the task"}]}),
            ),
            json!({"value": "Stop"}),
            json!({"value": "stop"}),
            json!({"value": "stop"}),
        ),
        (
            request(
                "multi_choice",
                json!({"choices": ["a", "b", "c"], "constraints": {"min_selections": 2}}),
            ),
            json!({"values": ["a"]}),
            json!({"values": ["a", "c"]}),
            json!({"values": ["a", "c"]}),
        ),
        (
            request(
                "number",
                json!({"constraints": {"min": 1, "max": 9, "step": 0.5, "unit": "kg"}}),
            ),
            json!({"value": "9.5"}),
            json!({"value": "2.50"}),
            json!({"value": "2.5"}),
        ),
        (
            request(
                "confirm",
                json!({"confirm_label": "Pay", "deny_label": "Don't", "risk": "low"}),
            ),
            json!({"value": "yes"}),
            json!({"value": "deny"}),
            json!({"value": "deny"}),
        ),
        (
            request("takeover", json!({})),
            json!({"value": "done"}),
            json!({}),
            json!({}),
        ),
        (
            request("none", json!({})),
            json!({"values": ["x"]}),
            json!({}),
            json!({}),
        ),
    ];
    for (req, bad, good, expect) in cases {
        let input = req.input;
        let created = client.create_handoff(session, &req).await.unwrap();
        let (status, body) = answer(&url, &created.respond_path, Some(TOKEN), bad).await;
        assert_eq!(status, 400, "{input:?}: {body}");
        let (status, body) = answer(&url, &created.respond_path, Some(TOKEN), good).await;
        assert_eq!(status, 200, "{input:?}: {body}");
        assert_eq!(body["status"], "completed");
        let resp = &body["response"];
        assert_eq!(resp["outcome"], "completed", "{input:?}");
        assert_eq!(resp["by"], "operator");
        assert!(resp["answered_at"].is_string());
        assert_eq!(resp.get("value"), expect.get("value"), "{input:?}");
        assert_eq!(resp.get("values"), expect.get("values"), "{input:?}");
    }
    // The view returns choices as objects, confirm settings and constraints.
    let created = client
        .create_handoff(
            session,
            &request("confirm", json!({"confirm_label": "Pay"})),
        )
        .await
        .unwrap();
    let v = serde_json::to_value(&created.handoff).unwrap();
    assert_eq!(v["risk"], "high");
    assert_eq!(v["confirm_label"], "Pay");
    client.cancel_handoff(created.handoff.id).await.unwrap();

    // Invalid questions are 400s.
    for bad in [
        request("number", json!({"constraints": {"step": 0}})),
        request("text", json!({"constraints": {"pattern": "("}})),
        request("text", json!({"constraints": {"min": 1}})),
        request("choice", json!({"choices": [{"id": "a b", "label": "A"}]})),
        request("multi_choice", json!({"choices": ["a", "a"]})),
        request("text", json!({"risk": "high"})),
    ] {
        assert_eq!(
            client
                .create_handoff(session, &bad)
                .await
                .unwrap_err()
                .status(),
            Some(400),
            "{bad:?}"
        );
    }
}

#[tokio::test]
async fn response_records_who_answered() {
    let (url, client, session, service) = start_with_service().await;
    let ask = || request("text", json!({}));

    // Operator, with and without answered_by.
    let c = client.create_handoff(session, &ask()).await.unwrap();
    let (_, b) = answer(&url, &c.respond_path, Some(TOKEN), json!({"value": "x"})).await;
    assert_eq!(b["response"]["by"], "operator");
    let c = client.create_handoff(session, &ask()).await.unwrap();
    let (_, b) = answer(
        &url,
        &c.respond_path,
        Some(TOKEN),
        json!({"value": "x", "answered_by": "user:7"}),
    )
    .await;
    assert_eq!(b["response"]["by"], "user:7");

    // Service token, with and without answered_by.
    let c = client.create_handoff(session, &ask()).await.unwrap();
    let (s, b) = answer(&url, &c.respond_path, Some(&service), json!({"value": "x"})).await;
    assert_eq!(s, 200, "{b}");
    assert_eq!(b["response"]["by"], "service:console");
    let c = client.create_handoff(session, &ask()).await.unwrap();
    let (s, _) = answer(
        &url,
        &c.respond_path,
        Some(&service),
        json!({"value": "x", "answered_by": "u".repeat(129)}),
    )
    .await;
    assert_eq!(s, 400);
    let (_, b) = answer(
        &url,
        &c.respond_path,
        Some(&service),
        json!({"value": "x", "answered_by": "user:alice"}),
    )
    .await;
    assert_eq!(b["response"]["by"], "user:alice");

    // A response-token holder cannot claim an identity.
    let c = client.create_handoff(session, &ask()).await.unwrap();
    let (_, b) = answer(
        &url,
        &c.respond_path,
        None,
        json!({"value": "x", "answered_by": "user:mallory", "response_token": c.response_token}),
    )
    .await;
    assert_eq!(b["response"]["by"], "token");

    // Cancelling is outcome "cancelled"; via the cancel route by a service.
    let c = client.create_handoff(session, &ask()).await.unwrap();
    let (_, b) = answer(
        &url,
        &c.respond_path,
        Some(&service),
        json!({"outcome": "cancelled"}),
    )
    .await;
    assert_eq!(b["status"], "cancelled");
    assert_eq!(b["response"]["outcome"], "cancelled");
    assert_eq!(b["response"]["by"], "service:console");
    let c = client.create_handoff(session, &ask()).await.unwrap();
    let r = reqwest::Client::new()
        .post(format!("{url}/v1/handoffs/{}/cancel", c.handoff.id))
        .bearer_auth(&service)
        .send()
        .await
        .unwrap();
    let b: serde_json::Value = r.json().await.unwrap();
    assert_eq!(b["response"]["by"], "service:console");
    assert_eq!(b["response"]["outcome"], "cancelled");
}

#[tokio::test]
async fn html_form_renders_every_input_type() {
    let (url, client, session) = start().await;
    let http = reqwest::Client::new();
    let cases: [(CreateHandoffRequest, &[&str]); 8] = [
        (
            request(
                "text",
                json!({"constraints": {"pattern": "[0-9]+", "max_length": 12}}),
            ),
            &[r#"pattern="[0-9]+""#, r#"maxlength="12""#],
        ),
        (
            request("text", json!({"constraints": {"multiline": true}})),
            &[r#"<textarea name="value""#],
        ),
        (request("secret", json!({})), &[r#"type="password""#]),
        (
            request(
                "choice",
                json!({"choices": [{"id": "a", "label": "<A>", "description": "first"}]}),
            ),
            &[
                r#"type="radio" name="value" value="a""#,
                "&lt;A&gt;",
                "first",
            ],
        ),
        (
            request(
                "multi_choice",
                json!({"choices": ["x", "y"], "constraints": {"max_selections": 1}}),
            ),
            &[r#"type="checkbox" name="values" value="x""#, "Choose 1"],
        ),
        (
            request(
                "number",
                json!({"constraints": {"min": 0, "max": 5, "step": 0.5, "unit": "kg"}}),
            ),
            &[
                r#"type="number""#,
                r#"min="0""#,
                r#"max="5""#,
                r#"step="0.5""#,
                "(kg)",
            ],
        ),
        (
            request("confirm", json!({"confirm_label": "Pay now"})),
            &[
                r#"name="value" value="approve" class=danger>Pay now"#,
                r#"value="deny">Deny"#,
            ],
        ),
        (
            request("takeover", json!({})),
            &[r#"value="completed">Done"#, "Take over the browser"],
        ),
    ];
    for (req, needles) in cases {
        let c = client.create_handoff(session, &req).await.unwrap();
        let html = http
            .get(format!(
                "{url}{}?token={}",
                c.respond_path, c.response_token
            ))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(!html.contains("<script"));
        for n in needles {
            assert!(html.contains(n), "{:?}: missing {n} in {html}", req.input);
        }
        client.cancel_handoff(c.handoff.id).await.unwrap();
    }

    // A number field without a step accepts decimals.
    let c = client
        .create_handoff(session, &request("number", json!({})))
        .await
        .unwrap();
    let html = http
        .get(format!(
            "{url}{}?token={}",
            c.respond_path, c.response_token
        ))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(html.contains(r#"step="any""#));
    client.cancel_handoff(c.handoff.id).await.unwrap();
}

// #527: the fallback answer page asks for a sign-in in one form, with the
// site's "remember me" ticked by default.
#[tokio::test]
async fn html_form_asks_for_a_sign_in_and_the_remember_choice() {
    let (url, client, session) = start().await;
    let http = reqwest::Client::new();
    let page = |c: &hexactra_core::remote::CreateHandoffResponse| {
        format!("{url}{}?token={}", c.respond_path, c.response_token)
    };
    let c = client
        .create_handoff(
            session,
            &request(
                "credentials",
                json!({"remember": {"label": "Keep me <signed> in"}}),
            ),
        )
        .await
        .unwrap();
    let html = http
        .get(page(&c))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    for n in [
        r#"name="value" required"#,
        r#"autocomplete="username""#,
        r#"name="secret" type="password""#,
        r#"autocomplete="new-password""#,
        r#"<input type="hidden" name="remember" value="false">"#,
        r#"name="remember" value="true" checked"#,
        "Keep me &lt;signed&gt; in",
    ] {
        assert!(html.contains(n), "missing {n} in {html}");
    }
    assert!(!html.contains("<script"));

    // Unticked: the browser sends only the hidden `false`.
    let body = format!(
        "token={}&value=oscar&secret=x9-424243&remember=false&outcome=completed",
        c.response_token
    );
    let r = http
        .post(format!("{url}{}", c.respond_path))
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let read = client.handoff(c.handoff.id, None).await.unwrap();
    let resp = read.response.clone().unwrap();
    assert_eq!(resp.value.as_deref(), Some("oscar"));
    assert!(resp.value_withheld);
    assert_eq!(resp.remember, Some(false));
    assert!(!serde_json::to_string(&read).unwrap().contains("x9-424243"));

    // Ticked: both fields arrive, and `true` wins.
    let c = client
        .create_handoff(
            session,
            &request("credentials", json!({"remember": {"label": "Remember me"}})),
        )
        .await
        .unwrap();
    let body = format!(
        "token={}&value=oscar&secret=x9-424243&remember=false&remember=true&outcome=completed",
        c.response_token
    );
    http.post(format!("{url}{}", c.respond_path))
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .unwrap();
    let resp = client
        .handoff(c.handoff.id, None)
        .await
        .unwrap()
        .response
        .unwrap();
    assert_eq!(resp.remember, Some(true));
}

#[tokio::test]
async fn html_form_posts_multi_choice_and_confirm() {
    let (url, client, session) = start().await;
    let http = reqwest::Client::new();
    let c = client
        .create_handoff(
            session,
            &request("multi_choice", json!({"choices": ["a", "b", "c"]})),
        )
        .await
        .unwrap();
    // Repeated keys, as a browser sends checked boxes.
    let body = format!(
        "token={}&values=a&values=c&outcome=completed",
        c.response_token
    );
    let r = http
        .post(format!("{url}{}", c.respond_path))
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert!(r.text().await.unwrap().contains("Thanks"));
    let resp = client
        .handoff(c.handoff.id, None)
        .await
        .unwrap()
        .response
        .unwrap();
    assert_eq!(resp.values, Some(vec!["a".to_string(), "c".to_string()]));
    assert_eq!(resp.by.as_deref(), Some("token"));
    assert_eq!(resp.channel.as_deref(), Some("web-form"));

    // Nothing checked violates the default minimum of one.
    let c = client
        .create_handoff(
            session,
            &request("multi_choice", json!({"choices": ["a", "b"]})),
        )
        .await
        .unwrap();
    let r = http
        .post(format!("{url}{}", c.respond_path))
        .form(&[
            ("token", c.response_token.as_str()),
            ("outcome", "completed"),
        ])
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);
    client.cancel_handoff(c.handoff.id).await.unwrap();

    // Confirm: the pressed button carries the value.
    let c = client
        .create_handoff(session, &request("confirm", json!({})))
        .await
        .unwrap();
    let r = http
        .post(format!("{url}{}", c.respond_path))
        .form(&[("token", c.response_token.as_str()), ("value", "deny")])
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let v = client.handoff(c.handoff.id, None).await.unwrap();
    assert_eq!(v.status, HandoffStatus::Completed);
    assert_eq!(v.response.unwrap().value.as_deref(), Some("deny"));
}
