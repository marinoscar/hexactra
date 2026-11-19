//! Secrets providers and the fabric path (#590), over real HTTP: the fabric
//! asks the session owner's provider for a value, types it with trusted input
//! and wipes it; nothing else ever holds it.
//!
//! The browser is a fake extension: it answers `tabs` with a scripted URL,
//! `evaluate` with a scripted frame probe, and records every action it
//! receives, which is the only place the typed value may appear.

use std::collections::VecDeque;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use hexactra_client::{ControlClient, HostClient};
use hexactra_control::runtime::persist::StateDb;
use hexactra_control::runtime::secrets::SecretsProviders;
use hexactra_control::runtime::webhooks::Webhooks;
use hexactra_control::runtime::{self, ApiState, RuntimeStore};
use hexactra_core::remote::{
    CardField, CreateSessionRequest, ItemKind, OperationResult, OperationState, OperationView,
    RegisterHostRequest, RemoteAction, SecretField, SecretPurpose, SecretsProviderKind, SelectPart,
    ViewportPoint, REDACTED_TEXT,
};
use hexactra_credential_resolver::test_provider::{
    TestItem, TestProvider, FIXTURE_CARD_2_ID, FIXTURE_CARD_CVV, FIXTURE_CARD_EXP_MONTH,
    FIXTURE_CARD_EXP_YEAR, FIXTURE_CARD_HOLDER, FIXTURE_CARD_ID, FIXTURE_CARD_NUMBER,
    FIXTURE_CARD_POSTAL, FIXTURE_CITY, FIXTURE_CODE, FIXTURE_COUNTRY, FIXTURE_DOB,
    FIXTURE_FULL_NAME, FIXTURE_IDENTITY_ID, FIXTURE_ID_NUMBER, FIXTURE_ITEM_ID, FIXTURE_MERCHANT,
    FIXTURE_ORIGIN, FIXTURE_PASSWORD, FIXTURE_PAY_FRAME, FIXTURE_SITE_ITEM_ID, FIXTURE_USERNAME,
};
use hexactra_credential_resolver::ProviderError;
use serde_json::{json, Value};
use tracing_subscriber::fmt::format::FmtSpan;
use uuid::Uuid;

const TOKEN: &str = "secret-test-token-0123456789abcdef";
const OWNER: &str = "user-a";
const TAB: i64 = 7;

// ------------------------------------------------------------------ helpers

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

/// The browser: scripted tab URLs and frame probe, everything it receives.
#[derive(Clone)]
struct Ext {
    /// The URL `tabs` reports; each call pops the next one while more than
    /// one is left, so a test can navigate between two reads.
    urls: Arc<Mutex<VecDeque<String>>>,
    /// What the frame probe (`evaluate`) answers.
    frame: Arc<Mutex<Value>>,
    received: Arc<Mutex<Vec<RemoteAction>>>,
    /// While set, `type` and `type_keys` wait before answering.
    hold: Arc<AtomicBool>,
    /// What the options probe of `select_from_provider` answers.
    select: Arc<Mutex<Value>>,
    /// What the next card-target probes answer (the last one stays), instead
    /// of `frame`; empty: `frame`.
    card_probe: Arc<Mutex<VecDeque<Value>>>,
    /// What the next password-target probes answer (the last one stays); empty:
    /// a password field.
    password_probe: Arc<Mutex<VecDeque<Value>>>,
    /// The `type` and `type_keys` actions the fake extension carried out: its
    /// origin guard (E37.10) passed. Anything it refused is in `refused`.
    typed_ok: Arc<Mutex<Vec<RemoteAction>>>,
    refused: Arc<Mutex<Vec<RemoteAction>>>,
}

/// `scheme://host[:port]` of a URL, as the extension's guard compares them.
fn origin_of(url: &str) -> String {
    let (scheme, rest) = url.split_once("://").unwrap_or(("", url));
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    format!("{scheme}://{host}")
}

impl Ext {
    /// The typing actions the browser carried out (not those its origin guard
    /// refused).
    fn typed(&self) -> Vec<RemoteAction> {
        self.typed_ok.lock().unwrap().clone()
    }

    fn refused(&self) -> Vec<RemoteAction> {
        self.refused.lock().unwrap().clone()
    }

    fn kinds(&self) -> Vec<&'static str> {
        self.received
            .lock()
            .unwrap()
            .iter()
            .map(|a| a.kind())
            .collect()
    }

    fn goto(&self, urls: &[&str]) {
        *self.urls.lock().unwrap() = urls.iter().map(|u| u.to_string()).collect();
    }
}

struct Fabric {
    url: String,
    store: RuntimeStore,
    state: ApiState,
    client: ControlClient,
    host: HostClient,
    host_id: Uuid,
    ext: Ext,
}

async fn start_with(webhooks: Webhooks) -> Fabric {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let store = RuntimeStore::new();
    let state = ApiState::with_webhooks(store.clone(), TOKEN, webhooks);
    tokio::spawn(runtime::serve(
        listener,
        state.clone(),
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
    let ext = Ext {
        urls: Arc::new(Mutex::new(VecDeque::from([
            FIXTURE_ORIGIN.to_string() + "/signin"
        ]))),
        frame: Arc::new(Mutex::new(
            json!({"found": true, "frame": false, "same_origin": true}),
        )),
        received: Default::default(),
        hold: Default::default(),
        select: Arc::new(Mutex::new(
            json!({"found": true, "select": true, "options": []}),
        )),
        card_probe: Default::default(),
        password_probe: Default::default(),
        typed_ok: Default::default(),
        refused: Default::default(),
    };
    {
        let (host, ext) = (host.clone(), ext.clone());
        tokio::spawn(async move {
            loop {
                let Ok(Some(op)) = host.next(host_id, true, Duration::from_millis(100)).await
                else {
                    continue;
                };
                ext.received.lock().unwrap().push(op.action.clone());
                let result = match &op.action {
                    RemoteAction::Tabs => {
                        let url = {
                            let mut q = ext.urls.lock().unwrap();
                            if q.len() > 1 {
                                q.pop_front().unwrap()
                            } else {
                                q.front().cloned().unwrap_or_default()
                            }
                        };
                        json!({"tabs": [
                            {"id": 3, "window_id": 2, "url": "https://other.example.test/", "title": "other", "active": false},
                            {"id": TAB, "window_id": 1, "url": url, "title": "page", "active": true},
                        ]})
                    }
                    // The choose step of `select_from_provider`.
                    RemoteAction::Evaluate { script, .. } if script.contains("selectedIndex=") => {
                        json!({"value": {"ok": true}})
                    }
                    // The options probe of `select_from_provider`.
                    RemoteAction::Evaluate { script, .. } if script.contains("e.options") => {
                        json!({"value": ext.select.lock().unwrap().clone()})
                    }
                    // The probe of `type_card_field`: what is at the target.
                    RemoteAction::Evaluate { script, .. }
                        if script.contains("hexactra:card-target")
                            && !ext.card_probe.lock().unwrap().is_empty() =>
                    {
                        let mut q = ext.card_probe.lock().unwrap();
                        let v = if q.len() > 1 {
                            q.pop_front().unwrap()
                        } else {
                            q.front().cloned().unwrap()
                        };
                        json!({"value": v})
                    }
                    // The probe of a login's password target (E37.10).
                    RemoteAction::Evaluate { script, .. }
                        if script.contains("hexactra:password-target") =>
                    {
                        let mut q = ext.password_probe.lock().unwrap();
                        let v = match q.len() {
                            0 => json!({"found": true, "password": true}),
                            1 => q.front().cloned().unwrap(),
                            _ => q.pop_front().unwrap(),
                        };
                        json!({"value": v})
                    }
                    RemoteAction::Evaluate { .. } => {
                        json!({"value": ext.frame.lock().unwrap().clone()})
                    }
                    RemoteAction::Type { expect_origin, .. }
                    | RemoteAction::TypeKeys { expect_origin, .. } => {
                        // The real extension's guard: the tab's top-level
                        // origin at the moment of typing.
                        let now = ext
                            .urls
                            .lock()
                            .unwrap()
                            .front()
                            .cloned()
                            .unwrap_or_default();
                        if expect_origin
                            .as_deref()
                            .is_some_and(|want| want != origin_of(&now))
                        {
                            ext.refused.lock().unwrap().push(op.action.clone());
                            let _ = host
                                .report(
                                    host_id,
                                    op.id,
                                    &OperationResult {
                                        navigation_blocked: Vec::new(),
                                        ok: false,
                                        result: None,
                                        error: Some(
                                            "origin_mismatch: the tab is no longer on the page the value was released for; nothing was typed"
                                                .into(),
                                        ),
                                    },
                                )
                                .await;
                            continue;
                        }
                        ext.typed_ok.lock().unwrap().push(op.action.clone());
                        while ext.hold.load(Ordering::SeqCst) {
                            tokio::time::sleep(Duration::from_millis(10)).await;
                        }
                        json!({})
                    }
                    _ => json!({}),
                };
                let _ = host
                    .report(
                        host_id,
                        op.id,
                        &OperationResult {
                            navigation_blocked: Vec::new(),
                            ok: true,
                            result: Some(result),
                            error: None,
                        },
                    )
                    .await;
            }
        });
    }
    Fabric {
        client: ControlClient::new(&url, TOKEN).unwrap(),
        url,
        store,
        state,
        host,
        host_id,
        ext,
    }
}

async fn start() -> Fabric {
    start_with(Webhooks::in_memory()).await
}

impl Fabric {
    /// Register the fixture provider for `OWNER` over HTTP.
    async fn register_test(&self, settings: Value) -> reqwest::Response {
        self.put_provider(
            OWNER,
            "test",
            json!({"kind": "test", "access_token": "token-registered", "settings": settings}),
        )
        .await
    }

    async fn put_provider(&self, owner: &str, provider: &str, body: Value) -> reqwest::Response {
        reqwest::Client::new()
            .put(format!(
                "{}/v1/secrets-providers/{owner}/{provider}",
                self.url
            ))
            .bearer_auth(TOKEN)
            .json(&body)
            .send()
            .await
            .unwrap()
    }

    async fn session(&self, owner: Option<&str>) -> Uuid {
        self.client
            .create_session(&CreateSessionRequest {
                owner_id: owner.map(Into::into),
                ..Default::default()
            })
            .await
            .unwrap()
            .id
    }

    async fn act(&self, session: Uuid, action: RemoteAction) -> OperationView {
        self.client
            .act(session, action, Some(Duration::from_secs(10)))
            .await
            .unwrap()
    }

    fn events(&self, kind: &str) -> Vec<Value> {
        self.store
            .log
            .recent()
            .into_iter()
            .filter(|e| e.kind == kind)
            .map(|e| e.data)
            .collect()
    }
}

fn lookup() -> RemoteAction {
    RemoteAction::SecretsLookup {
        kind: ItemKind::Login,
        provider: None,
        run_id: Some("run-1".into()),
        client_label: Some("Console".into()),
        tab_id: None,
    }
}

fn type_from(item: &str, field: SecretField, selector: &str) -> RemoteAction {
    RemoteAction::TypeFromProvider {
        item_id: item.into(),
        field,
        selector: Some(selector.into()),
        point: None,
        purpose: SecretPurpose::Login,
        clear: true,
        submit: false,
        provider: None,
        run_id: Some("run-1".into()),
        client_label: Some("Console".into()),
        tab_id: None,
    }
}

fn type_code(item: &str, selector: &str) -> RemoteAction {
    RemoteAction::TypeCodeFromProvider {
        item_id: item.into(),
        selector: Some(selector.into()),
        point: None,
        clear: false,
        submit: true,
        provider: None,
        run_id: Some("run-1".into()),
        client_label: Some("Console".into()),
        tab_id: None,
    }
}

fn failed_with(op: &OperationView, code: &str) {
    assert_eq!(op.state, OperationState::Failed, "{op:?}");
    let e = op.error.as_deref().unwrap_or_default();
    assert!(
        e.starts_with(&format!("{code}: ")),
        "expected {code}, got {e:?}"
    );
}

fn text_of(v: &impl serde::Serialize) -> String {
    serde_json::to_string(v).unwrap()
}

// -------------------------------------------------------------------- tests

#[tokio::test]
async fn the_registration_resource_never_returns_or_keeps_a_token() {
    let f = start().await;
    let r = f.register_test(json!({})).await;
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()["cache-control"], "no-store");
    let body = r.text().await.unwrap();
    assert!(!body.contains("token-registered"), "{body}");
    let v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        (
            v["owner_id"].as_str(),
            v["provider"].as_str(),
            v["kind"].as_str()
        ),
        (Some(OWNER), Some("test"), Some("test"))
    );

    let list = reqwest::Client::new()
        .get(format!("{}/v1/secrets-providers/{OWNER}", f.url))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(list.status(), 200);
    let list = list.text().await.unwrap();
    assert!(list.contains("\"provider\":\"test\"") && !list.contains("token-registered"));

    // Bad input, kinds that do not exist yet, and no token.
    assert_eq!(
        f.put_provider(OWNER, "Bad Id", json!({"kind": "test"}))
            .await
            .status(),
        400
    );
    assert_eq!(
        f.put_provider(
            OWNER,
            "test",
            json!({"kind": "test", "base_url": "http://vault.example.test"})
        )
        .await
        .status(),
        400
    );
    // The console-hosted provider needs its callback address, credential and expiry.
    assert_eq!(
        f.put_provider(OWNER, "builtin", json!({"kind": "console"}))
            .await
            .status(),
        400
    );
    // A public plain-http callback address is refused (it is for the private network).
    assert_eq!(
        f.put_provider(
            OWNER,
            "builtin",
            json!({"kind": "console", "base_url": "http://console.example.test/x", "access_token": "sct_t", "expires_at": "2099-01-01T00:00:00Z"})
        )
        .await
        .status(),
        400
    );
    // A Vault needs its address, a token and an expiry.
    assert_eq!(
        f.put_provider(
            OWNER,
            "vault",
            json!({"kind": "vault", "base_url": "https://vault.example.test", "access_token": "t"})
        )
        .await
        .status(),
        400
    );
    assert_eq!(
        reqwest::Client::new()
            .put(format!("{}/v1/secrets-providers/{OWNER}/test", f.url))
            .json(&json!({"kind": "test"}))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );

    // Removing is idempotent, and the provider is gone.
    for _ in 0..2 {
        let d = reqwest::Client::new()
            .delete(format!("{}/v1/secrets-providers/{OWNER}/test", f.url))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap();
        assert_eq!(d.status(), 204);
    }
    let s = f.session(Some(OWNER)).await;
    failed_with(&f.act(s, lookup()).await, "no_provider");
}

#[tokio::test]
async fn lookup_returns_summaries_only() {
    let f = start().await;
    assert_eq!(f.register_test(json!({})).await.status(), 200);
    let s = f.session(Some(OWNER)).await;
    let op = f.act(s, lookup()).await;
    assert_eq!(op.state, OperationState::Succeeded, "{op:?}");
    let r = op.result.clone().unwrap();
    assert_eq!(r["origin"], FIXTURE_ORIGIN);
    assert_eq!(r["provider"], "test");
    let items = r["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(
        (items[0]["id"].as_str(), items[0]["match_kind"].as_str()),
        (Some(FIXTURE_ITEM_ID), Some("exact"))
    );
    assert_eq!(items[0]["username"], FIXTURE_USERNAME);
    assert_eq!(items[0]["has_code"], true);
    assert_eq!(
        (items[1]["id"].as_str(), items[1]["match_kind"].as_str()),
        (Some(FIXTURE_SITE_ITEM_ID), Some("site"))
    );
    let shown = text_of(&op);
    assert!(
        !shown.contains(FIXTURE_PASSWORD) && !shown.contains(FIXTURE_CODE),
        "{shown}"
    );
    // The tab listing read for the origin does not stay readable.
    let tabs_ops: Vec<_> = f
        .events("operation.succeeded")
        .into_iter()
        .filter(|e| e["kind"] == "tabs")
        .collect();
    assert!(!tabs_ops.is_empty());
    let probe = f
        .client
        .operation(tabs_ops[0]["op_id"].as_str().unwrap().parse().unwrap())
        .await
        .unwrap();
    assert!(probe.result.is_none(), "{probe:?}");
    // Only the lookup reached the provider: no value was released. A login's
    // lookup also notes the password inputs now on the page (E37.10), so a
    // "show password" toggle later does not hide them.
    assert_eq!(f.ext.kinds(), vec!["tabs", "evaluate"]);
    assert!(f.ext.received.lock().unwrap().iter().any(|a| matches!(
        a,
        RemoteAction::Evaluate { script, .. } if script.contains("hexactra:password-mark")
            && !script.contains(FIXTURE_PASSWORD)
    )));
}

#[tokio::test]
async fn type_from_provider_types_the_value_and_reports_none() {
    let f = start().await;
    f.register_test(json!({})).await;
    let s = f.session(Some(OWNER)).await;
    let op = f
        .act(s, type_from(FIXTURE_ITEM_ID, SecretField::Password, "#pw"))
        .await;
    assert_eq!(op.state, OperationState::Succeeded, "{op:?}");
    assert_eq!(op.result, Some(json!({"typed": true})));

    // The browser got a trusted `type`, pinned to the tab the origin came from.
    assert_eq!(
        f.ext.typed(),
        vec![RemoteAction::Type {
            selector: "#pw".into(),
            text: FIXTURE_PASSWORD.into(),
            clear: true,
            submit: false,
            sensitive: true,
            expect_origin: Some(FIXTURE_ORIGIN.into()),
            tab_id: Some(TAB),
        }]
    );
    // The origin was read twice (before the release and right before typing),
    // and the password field checked each time.
    assert_eq!(
        f.ext.kinds(),
        vec!["tabs", "evaluate", "tabs", "evaluate", "type"]
    );

    // The operation, and the operation of the typing step, show no value.
    for what in [
        text_of(&op),
        text_of(&f.client.operation(op.id).await.unwrap()),
    ] {
        assert!(!what.contains(FIXTURE_PASSWORD), "{what}");
    }
    let typing = f
        .events("operation.succeeded")
        .into_iter()
        .find(|e| e["kind"] == "type")
        .unwrap();
    let typing = f
        .client
        .operation(typing["op_id"].as_str().unwrap().parse().unwrap())
        .await
        .unwrap();
    assert!(text_of(&typing).contains(REDACTED_TEXT));
    assert!(!text_of(&typing).contains(FIXTURE_PASSWORD));
}

#[tokio::test]
async fn type_code_from_provider_types_a_fresh_code() {
    let f = start().await;
    f.register_test(json!({})).await;
    let s = f.session(Some(OWNER)).await;
    let op = f.act(s, type_code(FIXTURE_ITEM_ID, "#otp")).await;
    assert_eq!(op.state, OperationState::Succeeded, "{op:?}");
    let r = op.result.clone().unwrap();
    assert_eq!(r["typed"], true);
    assert!(r["expires_at"].is_string());
    assert!(!text_of(&op).contains(FIXTURE_CODE));
    assert_eq!(
        f.ext.typed(),
        vec![RemoteAction::Type {
            selector: "#otp".into(),
            text: FIXTURE_CODE.into(),
            clear: false,
            submit: true,
            sensitive: true,
            expect_origin: Some(FIXTURE_ORIGIN.into()),
            tab_id: Some(TAB),
        }]
    );
    // An item without a code is "not found", as in Vault.
    f.ext.goto(&["https://app.example.test/"]);
    failed_with(
        &f.act(s, type_code(FIXTURE_SITE_ITEM_ID, "#otp")).await,
        "not_found",
    );
}

#[tokio::test]
async fn a_page_on_another_origin_gets_nothing() {
    let f = start().await;
    f.register_test(json!({})).await;
    let s = f.session(Some(OWNER)).await;

    // Looked up on the login page, then the tab navigated to a look-alike
    // before typing: the provider is asked with the origin read at that moment.
    assert_eq!(f.act(s, lookup()).await.state, OperationState::Succeeded);
    f.ext.goto(&["https://login.example.test.evil.test/signin"]);
    let op = f
        .act(s, type_from(FIXTURE_ITEM_ID, SecretField::Password, "#pw"))
        .await;
    failed_with(&op, "origin_mismatch");
    // A site match is not enough either.
    f.ext.goto(&["https://app.example.test/"]);
    failed_with(
        &f.act(s, type_from(FIXTURE_ITEM_ID, SecretField::Password, "#pw"))
            .await,
        "origin_mismatch",
    );
    assert!(
        f.ext.typed().is_empty(),
        "nothing may be typed: {:?}",
        f.ext.typed()
    );

    // The tab moves after the provider answered: caught by the second read,
    // the value is dropped and nothing is typed.
    f.ext.goto(&[
        &format!("{FIXTURE_ORIGIN}/signin"),
        "https://evil.example.test/",
    ]);
    let op = f
        .act(s, type_from(FIXTURE_ITEM_ID, SecretField::Password, "#pw"))
        .await;
    failed_with(&op, "origin_mismatch");
    assert!(f.ext.typed().is_empty());
    let ev = f.events("secrets.release");
    assert_eq!(ev.last().unwrap()["outcome"], "origin_mismatch");
    assert_eq!(ev.last().unwrap()["released"], true);

    // A page that is not https (or loopback http) has no origin to bind to.
    f.ext.goto(&["chrome://settings/passwords"]);
    failed_with(
        &f.act(s, type_from(FIXTURE_ITEM_ID, SecretField::Password, "#pw"))
            .await,
        "origin_unavailable",
    );
}

#[tokio::test]
async fn the_browser_refuses_to_type_when_the_tab_moved_after_the_last_origin_read() {
    let f = start().await;
    f.register_test(json!({})).await;
    let s = f.session(Some(OWNER)).await;
    let moved = [
        &format!("{FIXTURE_ORIGIN}/signin"),
        &format!("{FIXTURE_ORIGIN}/signin"),
        "https://evil.example.test/",
    ];

    // The fabric's two origin reads both say the saved origin; the tab then
    // navigates before the browser types. The `type` carries the origin the
    // value was released for, the extension compares it with the tab's URL at
    // that moment and types nothing.
    f.ext.goto(&moved);
    let op = f
        .act(s, type_from(FIXTURE_ITEM_ID, SecretField::Password, "#pw"))
        .await;
    failed_with(&op, "origin_mismatch");
    assert!(f.ext.typed().is_empty(), "{:?}", f.ext.typed());
    let refused = f.ext.refused();
    assert!(matches!(
        refused.as_slice(),
        [RemoteAction::Type { expect_origin: Some(o), sensitive: true, .. }] if o == FIXTURE_ORIGIN
    ));
    let ev = f.events("secrets.release");
    assert_eq!(ev.last().unwrap()["outcome"], "origin_mismatch");
    assert_eq!(ev.last().unwrap()["released"], true);
    assert!(!text_of(&op).contains(FIXTURE_PASSWORD));

    // The same for a code, and for keystrokes at a point (`type_keys`).
    f.ext.goto(&moved);
    failed_with(
        &f.act(s, type_code(FIXTURE_ITEM_ID, "#otp")).await,
        "origin_mismatch",
    );
    f.ext.goto(&moved);
    let by_point = RemoteAction::TypeFromProvider {
        item_id: FIXTURE_ITEM_ID.into(),
        field: SecretField::Password,
        selector: None,
        point: Some(ViewportPoint { x: 120, y: 340 }),
        purpose: SecretPurpose::Login,
        clear: false,
        submit: true,
        provider: None,
        run_id: None,
        client_label: None,
        tab_id: Some(TAB),
    };
    let op = f.act(s, by_point).await;
    failed_with(&op, "origin_mismatch");
    assert!(f.ext.typed().is_empty(), "{:?}", f.ext.typed());
    assert!(f
        .ext
        .refused()
        .iter()
        .any(|a| matches!(a, RemoteAction::TypeKeys { expect_origin: Some(o), .. } if o == FIXTURE_ORIGIN)));
    // Submit (Enter) is never pressed after a refused typing.
    assert_eq!(f.ext.kinds().last(), Some(&"type_keys"));

    // Back on the page it is for, the same call types.
    f.ext.goto(&[&format!("{FIXTURE_ORIGIN}/signin")]);
    let op = f
        .act(s, type_from(FIXTURE_ITEM_ID, SecretField::Password, "#pw"))
        .await;
    assert_eq!(op.state, OperationState::Succeeded, "{op:?}");
    assert_eq!(f.ext.typed().len(), 1);
}

#[tokio::test]
async fn a_login_password_is_typed_only_into_a_password_field() {
    let f = start().await;
    f.register_test(json!({})).await;
    let s = f.session(Some(OWNER)).await;
    let probes = || {
        f.ext
            .received
            .lock()
            .unwrap()
            .iter()
            .filter(|a| matches!(a, RemoteAction::Evaluate { script, .. } if script.contains("hexactra:password-target")))
            .count()
    };

    // The model names a plain text box (a comment, a profile field, a search
    // box): refused before the provider is asked, and the run is told why.
    *f.ext.password_probe.lock().unwrap() = [json!({"found": true, "password": false})].into();
    let op = f
        .act(
            s,
            type_from(FIXTURE_ITEM_ID, SecretField::Password, "#comment"),
        )
        .await;
    failed_with(&op, "target_not_password");
    assert!(f.ext.typed().is_empty() && f.ext.refused().is_empty());
    let ev = f.events("secrets.release");
    assert_eq!(ev.last().unwrap()["outcome"], "target_not_password");
    assert_eq!(ev.last().unwrap()["released"], false);
    assert!(!text_of(&op).contains(FIXTURE_PASSWORD));
    // The same for a point.
    let by_point = RemoteAction::TypeFromProvider {
        item_id: FIXTURE_ITEM_ID.into(),
        field: SecretField::Password,
        selector: None,
        point: Some(ViewportPoint { x: 12, y: 34 }),
        purpose: SecretPurpose::Login,
        clear: false,
        submit: false,
        provider: None,
        run_id: None,
        client_label: None,
        tab_id: Some(TAB),
    };
    failed_with(&f.act(s, by_point).await, "target_not_password");
    assert!(!f.ext.kinds().contains(&"click_at"));
    assert!(f.ext.typed().is_empty());

    // A username (or any other field) goes into a text box: no password probe.
    let before = probes();
    let op = f
        .act(
            s,
            type_from(FIXTURE_ITEM_ID, SecretField::Username, "#user"),
        )
        .await;
    assert_eq!(op.state, OperationState::Succeeded, "{op:?}");
    assert_eq!(probes(), before);

    // A password input, or a text input the page shows as a password through a
    // "show password" toggle (the probe says so), gets the password.
    f.ext.password_probe.lock().unwrap().clear();
    let op = f
        .act(s, type_from(FIXTURE_ITEM_ID, SecretField::Password, "#pw"))
        .await;
    assert_eq!(op.state, OperationState::Succeeded, "{op:?}");
    assert!(f.ext.typed().iter().any(
        |a| matches!(a, RemoteAction::Type { selector, text, .. } if selector == "#pw" && text == FIXTURE_PASSWORD)
    ));

    // No element: a typing failure, not a verdict.
    *f.ext.password_probe.lock().unwrap() = [json!({"found": false})].into();
    failed_with(
        &f.act(
            s,
            type_from(FIXTURE_ITEM_ID, SecretField::Password, "#nope"),
        )
        .await,
        "typing_failed",
    );

    // The page swaps the field for a text box while the provider answers: the
    // check is made again before typing and the value is dropped.
    let typed_before = f.ext.typed().len();
    *f.ext.password_probe.lock().unwrap() = [
        json!({"found": true, "password": true}),
        json!({"found": true, "password": false}),
    ]
    .into();
    let op = f
        .act(s, type_from(FIXTURE_ITEM_ID, SecretField::Password, "#pw"))
        .await;
    failed_with(&op, "target_not_password");
    assert_eq!(f.ext.typed().len(), typed_before);
    let ev = f.events("secrets.release");
    assert_eq!(ev.last().unwrap()["outcome"], "target_not_password");
    assert_eq!(ev.last().unwrap()["released"], true);
}

#[tokio::test]
async fn point_targets_refuse_frames_of_another_origin() {
    let f = start().await;
    f.register_test(json!({})).await;
    let s = f.session(Some(OWNER)).await;
    let by_point = |clear: bool, submit: bool| RemoteAction::TypeFromProvider {
        item_id: FIXTURE_ITEM_ID.into(),
        field: SecretField::Password,
        selector: None,
        point: Some(ViewportPoint { x: 120, y: 340 }),
        purpose: SecretPurpose::Login,
        clear,
        submit,
        provider: None,
        run_id: None,
        client_label: None,
        tab_id: Some(TAB),
    };

    // The point is inside a cross-origin frame: refused before the value is fetched.
    *f.ext.frame.lock().unwrap() = json!({"found": true, "frame": true, "same_origin": false});
    failed_with(
        &f.act(s, by_point(false, false)).await,
        "cross_origin_frame",
    );
    assert!(f.ext.typed().is_empty());
    assert!(!f.ext.kinds().contains(&"click_at"));
    assert!(f.events("secrets.release").last().unwrap()["released"] == false);

    // Nothing at the point.
    *f.ext.frame.lock().unwrap() = json!({"found": false});
    failed_with(&f.act(s, by_point(false, false)).await, "typing_failed");

    // A same-origin frame, or the top document, is fine: click, wipe, type, submit.
    *f.ext.frame.lock().unwrap() = json!({"found": true, "frame": true, "same_origin": true});
    let op = f.act(s, by_point(true, true)).await;
    assert_eq!(op.state, OperationState::Succeeded, "{op:?}");
    let kinds = f.ext.kinds();
    // Re-read the origin, re-check the password field, click, wipe, type, submit.
    let tail: Vec<&str> = kinds[kinds.len() - 7..].to_vec();
    assert_eq!(
        tail,
        [
            "tabs",
            "evaluate",
            "click_at",
            "key",
            "key",
            "type_keys",
            "key"
        ]
    );
    assert_eq!(
        f.ext.typed(),
        vec![RemoteAction::TypeKeys {
            text: FIXTURE_PASSWORD.into(),
            sensitive: true,
            expect_origin: Some(FIXTURE_ORIGIN.into()),
            tab_id: Some(TAB),
        }]
    );
    assert!(!text_of(&op).contains(FIXTURE_PASSWORD));
}

#[tokio::test]
async fn takeover_and_owners_are_respected() {
    let f = start().await;
    f.register_test(json!({})).await;
    let s = f.session(Some(OWNER)).await;

    // Another owner's session has no provider; neither has one without an owner.
    let other = f.session(Some("user-b")).await;
    failed_with(&f.act(other, lookup()).await, "no_provider");
    failed_with(
        &f.act(
            other,
            type_from(FIXTURE_ITEM_ID, SecretField::Password, "#pw"),
        )
        .await,
        "no_provider",
    );
    let none = f.session(None).await;
    failed_with(&f.act(none, lookup()).await, "no_provider");
    assert!(f.ext.typed().is_empty());

    // While a person holds the desktop every provider action is refused at
    // the door, like any other action.
    let t = reqwest::Client::new()
        .post(format!("{}/v1/hosts/{}/takeover", f.url, f.host_id))
        .bearer_auth(TOKEN)
        .json(&json!({"actor": {"user_id": "person-a"}, "ttl_s": 60}))
        .send()
        .await
        .unwrap();
    assert_eq!(t.status(), 201);
    for action in [
        lookup(),
        type_from(FIXTURE_ITEM_ID, SecretField::Password, "#pw"),
        type_code(FIXTURE_ITEM_ID, "#otp"),
    ] {
        let err = f
            .client
            .act(s, action, Some(Duration::from_secs(2)))
            .await
            .unwrap_err();
        assert_eq!(err.status(), Some(409));
        assert!(err.to_string().contains("takeover_active"), "{err}");
    }
    assert!(f.ext.typed().is_empty());
}

#[tokio::test]
async fn provider_failures_map_to_their_codes() {
    let f = start().await;
    let s = f.session(Some(OWNER)).await;
    for (mode, code) in [
        ("unavailable", "unavailable"),
        ("rate_limited", "rate_limited"),
        ("disabled", "disabled"),
        ("unauthorized", "unauthorized"),
    ] {
        assert_eq!(f.register_test(json!({"mode": mode})).await.status(), 200);
        failed_with(&f.act(s, lookup()).await, code);
        failed_with(
            &f.act(s, type_from(FIXTURE_ITEM_ID, SecretField::Password, "#pw"))
                .await,
            code,
        );
        failed_with(&f.act(s, type_code(FIXTURE_ITEM_ID, "#otp")).await, code);
    }
    let op = {
        f.register_test(json!({"mode": "rate_limited"})).await;
        f.act(s, lookup()).await
    };
    assert!(op.error.unwrap().contains("retry in 7 s"));
    assert!(f.ext.typed().is_empty());

    // An unknown item and an unsupported field.
    f.register_test(json!({})).await;
    failed_with(
        &f.act(s, type_from("nope", SecretField::Password, "#pw"))
            .await,
        "not_found",
    );
    failed_with(
        &f.act(
            s,
            type_from(FIXTURE_ITEM_ID, SecretField::CardNumber, "#pw"),
        )
        .await,
        "refused",
    );
    // The provider named does not exist.
    let mut named = type_from(FIXTURE_ITEM_ID, SecretField::Password, "#pw");
    if let RemoteAction::TypeFromProvider { provider, .. } = &mut named {
        *provider = Some("vault".into());
    }
    failed_with(&f.act(s, named).await, "no_provider");
    assert!(f.ext.typed().is_empty());
}

#[tokio::test]
async fn a_failed_typing_is_reported_without_the_value() {
    // A host that cannot type (no such element) fails the action.
    let f = start().await;
    f.register_test(json!({})).await;
    let s = f.session(Some(OWNER)).await;
    f.state.secrets.remove(OWNER, "test");
    let provider = Arc::new(TestProvider::with_fixture());
    f.state.secrets.register_provider(
        OWNER,
        "test",
        provider.clone(),
        SecretsProviderKind::Test,
        None,
    );
    // Make the fake browser fail the typing step by pinning a missing tab.
    let mut a = type_from(FIXTURE_ITEM_ID, SecretField::Password, "#pw");
    if let RemoteAction::TypeFromProvider { tab_id, .. } = &mut a {
        *tab_id = Some(999);
    }
    failed_with(&f.act(s, a).await, "origin_unavailable");
    // The provider was never asked for a value.
    assert!(provider.calls().iter().all(|c| c.op != "release"));
}

#[tokio::test]
async fn no_screenshot_while_a_secret_is_being_typed() {
    let f = start().await;
    f.register_test(json!({})).await;
    let s = f.session(Some(OWNER)).await;
    f.ext.hold.store(true, Ordering::SeqCst);
    let typing = {
        let (client, action) = (
            f.client.clone(),
            type_from(FIXTURE_ITEM_ID, SecretField::Password, "#pw"),
        );
        tokio::spawn(async move { client.act(s, action, Some(Duration::from_secs(10))).await })
    };
    for _ in 0..200 {
        if !f.ext.typed().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(!f.ext.typed().is_empty(), "the typing never started");

    // The value is out of the provider and not yet typed: no picture.
    for shot in [
        RemoteAction::Screenshot {
            marks: false,
            mask: false,
            tab_id: None,
        },
        RemoteAction::Screenshot {
            marks: false,
            mask: true,
            tab_id: None,
        },
        RemoteAction::DesktopScreenshot,
    ] {
        let err = f
            .client
            .act(s, shot, Some(Duration::from_secs(1)))
            .await
            .unwrap_err();
        assert_eq!(err.status(), Some(409), "{err}");
        assert!(err.to_string().contains("no screenshot"), "{err}");
    }
    f.ext.hold.store(false, Ordering::SeqCst);
    let done = typing.await.unwrap().unwrap();
    assert_eq!(done.state, OperationState::Succeeded);
    // After the typing a picture is allowed again.
    let shot = f
        .client
        .act(
            s,
            RemoteAction::Screenshot {
                marks: false,
                mask: true,
                tab_id: None,
            },
            Some(Duration::from_secs(5)),
        )
        .await
        .unwrap();
    assert_eq!(shot.state, OperationState::Succeeded, "{shot:?}");
}

#[tokio::test]
async fn the_host_cannot_report_a_provider_operation() {
    let f = start().await;
    f.register_test(json!({})).await;
    let s = f.session(Some(OWNER)).await;
    // Hold the origin read so the operation stays open, then try to report it.
    let r = reqwest::Client::new()
        .post(format!("{}/v1/sessions/{s}/actions?async=true", f.url))
        .bearer_auth(TOKEN)
        .json(&json!({"action": {"type": "secrets_lookup"}}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 202);
    let op: OperationView = r.json().await.unwrap();
    assert_eq!(op.action.kind(), "secrets_lookup");
    let err = f
        .host
        .report(
            f.host_id,
            op.id,
            &OperationResult {
                navigation_blocked: Vec::new(),
                ok: true,
                result: Some(
                    json!({"origin": "https://evil.test", "provider": "test", "items": []}),
                ),
                error: None,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(err.status(), Some(404), "{err}");
    // It finishes on its own.
    for _ in 0..200 {
        if f.client.operation(op.id).await.unwrap().state.is_terminal() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(
        f.client.operation(op.id).await.unwrap().state,
        OperationState::Succeeded
    );
}

#[tokio::test]
async fn lookups_and_releases_leave_audit_events_without_a_value() {
    let f = start().await;
    f.register_test(json!({})).await;
    let s = f.session(Some(OWNER)).await;
    f.act(s, lookup()).await;
    f.act(s, type_from(FIXTURE_ITEM_ID, SecretField::Password, "#pw"))
        .await;
    f.act(s, type_code(FIXTURE_ITEM_ID, "#otp")).await;
    f.ext.goto(&["https://evil.example.test/"]);
    f.act(s, type_from(FIXTURE_ITEM_ID, SecretField::Username, "#u"))
        .await;

    let lookups = f.events("secrets.lookup");
    assert_eq!(lookups.len(), 1);
    let l = &lookups[0];
    assert_eq!(l["owner_id"], OWNER);
    assert_eq!(l["session_id"], s.to_string());
    assert_eq!(l["run_id"], "run-1");
    assert_eq!(l["provider"], "test");
    assert_eq!(l["origin"], FIXTURE_ORIGIN);
    assert_eq!(l["kind"], "login");
    assert_eq!(l["count"], 2);
    assert_eq!(l["outcome"], "ok");

    let releases = f.events("secrets.release");
    assert_eq!(releases.len(), 3);
    let r = &releases[0];
    assert_eq!(r["owner_id"], OWNER);
    assert_eq!(r["run_id"], "run-1");
    assert_eq!(r["client_label"], "Console");
    assert_eq!(r["provider"], "test");
    assert_eq!(r["item_id"], FIXTURE_ITEM_ID);
    assert_eq!(r["field"], "password");
    assert_eq!(r["origin"], FIXTURE_ORIGIN);
    assert_eq!(r["purpose"], "login");
    assert_eq!(r["outcome"], "typed");
    assert_eq!(r["released"], true);
    assert_eq!(releases[1]["field"], "one_time_code");
    assert_eq!(releases[1]["purpose"], "mfa");
    // A refusal is audited too, with the origin it was refused for.
    assert_eq!(releases[2]["outcome"], "origin_mismatch");
    assert_eq!(releases[2]["origin"], "https://evil.example.test");
    assert_eq!(releases[2]["released"], false);
    let all = text_of(&f.events("secrets.release")) + &text_of(&lookups);
    for v in [FIXTURE_PASSWORD, FIXTURE_CODE] {
        assert!(!all.contains(v), "{all}");
    }
    // The registration is audited without its token.
    let reg = f.events("secrets.provider_registered");
    assert_eq!(reg.len(), 1);
    assert!(!text_of(&reg).contains("token-registered"));
}

// ------------------------------------------------------- identity (E37.6)

fn lookup_identity() -> RemoteAction {
    RemoteAction::SecretsLookup {
        kind: ItemKind::Identity,
        provider: None,
        run_id: Some("run-1".into()),
        client_label: Some("Console".into()),
        tab_id: None,
    }
}

fn form_from(field: SecretField, selector: &str) -> RemoteAction {
    match type_from(FIXTURE_IDENTITY_ID, field, selector) {
        RemoteAction::TypeFromProvider {
            item_id,
            field,
            selector,
            point,
            clear,
            submit,
            provider,
            run_id,
            client_label,
            tab_id,
            ..
        } => RemoteAction::TypeFromProvider {
            item_id,
            field,
            selector,
            point,
            purpose: SecretPurpose::Form,
            clear,
            submit,
            provider,
            run_id,
            client_label,
            tab_id,
        },
        _ => unreachable!(),
    }
}

fn select_from(field: SecretField, part: Option<SelectPart>, selector: &str) -> RemoteAction {
    RemoteAction::SelectFromProvider {
        item_id: FIXTURE_IDENTITY_ID.into(),
        field,
        selector: selector.into(),
        part,
        provider: None,
        run_id: Some("run-1".into()),
        client_label: Some("Console".into()),
        tab_id: None,
    }
}

fn options(list: &[(&str, &str)]) -> Value {
    json!({"found": true, "select": true, "options": list.iter().map(|(v, t)| json!({"v": v, "t": t})).collect::<Vec<_>>()})
}

const IDENTITY_VALUES: [&str; 5] = [
    FIXTURE_FULL_NAME,
    FIXTURE_DOB,
    FIXTURE_ID_NUMBER,
    FIXTURE_COUNTRY,
    FIXTURE_CITY,
];

#[tokio::test]
async fn identity_lookup_returns_labels_and_flags_only() {
    let f = start().await;
    f.register_test(json!({})).await;
    let s = f.session(Some(OWNER)).await;
    // On the item's allowed origin every field is usable here.
    let op = f.act(s, lookup_identity()).await;
    assert_eq!(op.state, OperationState::Succeeded, "{op:?}");
    let item = &op.result.as_ref().unwrap()["items"][0];
    assert_eq!(item["id"], FIXTURE_IDENTITY_ID);
    assert_eq!(item["name"], "Passport");
    assert_eq!(item["match_kind"], "exact");
    let dob = item["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["key"] == "date_of_birth")
        .unwrap();
    assert_eq!(
        dob,
        &json!({"key": "date_of_birth", "label": "Date of birth", "sensitive": true, "usable_here": true})
    );
    // Elsewhere the sensitive fields are listed and not usable.
    f.ext.goto(&["https://other.example.test/form"]);
    let op = f.act(s, lookup_identity()).await;
    let fields = op.result.as_ref().unwrap()["items"][0]["fields"].clone();
    let usable = |k: &str| {
        fields
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["key"] == k)
            .unwrap()["usable_here"]
            .as_bool()
            .unwrap()
    };
    assert!(usable("full_name") && usable("city") && usable("country"));
    assert!(!usable("date_of_birth") && !usable("id_number"));
    // No value, no length, anywhere a caller can read.
    for what in [
        text_of(&op),
        text_of(&f.client.operation(op.id).await.unwrap()),
    ] {
        for v in IDENTITY_VALUES {
            assert!(!what.contains(v), "{what}");
        }
    }
    assert_eq!(f.ext.kinds(), vec!["tabs", "tabs"]);
}

#[tokio::test]
async fn a_non_sensitive_field_types_on_any_site_a_sensitive_one_only_on_its_allowed_origin() {
    let f = start().await;
    f.register_test(json!({})).await;
    let s = f.session(Some(OWNER)).await;

    // Not sensitive: another site is fine.
    f.ext.goto(&["https://other.example.test/form"]);
    let op = f.act(s, form_from(SecretField::FullName, "#name")).await;
    assert_eq!(op.state, OperationState::Succeeded, "{op:?}");
    assert_eq!(op.result, Some(json!({"typed": true})));
    assert_eq!(
        f.ext.typed(),
        vec![RemoteAction::Type {
            selector: "#name".into(),
            text: FIXTURE_FULL_NAME.into(),
            clear: true,
            submit: false,
            sensitive: true,
            expect_origin: Some("https://other.example.test".into()),
            tab_id: Some(TAB),
        }]
    );
    // Sensitive on that site: the provider refuses, and nothing more is typed.
    let before = f.ext.typed().len();
    failed_with(
        &f.act(s, form_from(SecretField::IdNumber, "#id")).await,
        "origin_mismatch",
    );
    assert_eq!(f.ext.typed().len(), before);
    // A look-alike of the allowed origin is another origin.
    f.ext.goto(&["https://login.example.test.evil.test/"]);
    failed_with(
        &f.act(s, form_from(SecretField::DateOfBirth, "#dob")).await,
        "origin_mismatch",
    );
    // On the allowed origin it is typed.
    f.ext.goto(&[&format!("{FIXTURE_ORIGIN}/form")]);
    let op = f.act(s, form_from(SecretField::IdNumber, "#id")).await;
    assert_eq!(op.state, OperationState::Succeeded, "{op:?}");
    assert!(f.ext.typed().iter().any(
        |a| matches!(a, RemoteAction::Type { text, selector, .. } if text == FIXTURE_ID_NUMBER && selector == "#id")
    ));
    // Whatever the outcome, no operation shows a value.
    for v in IDENTITY_VALUES {
        assert!(!text_of(&op).contains(v));
    }
    // The audit trail says which field went where, never the value.
    let releases = f.events("secrets.release");
    assert_eq!(releases.len(), 4);
    assert_eq!(releases[0]["purpose"], "form");
    assert_eq!(releases[0]["field"], "full_name");
    assert_eq!(releases[1]["outcome"], "origin_mismatch");
    assert_eq!(releases[3]["field"], "id_number");
    assert_eq!(releases[3]["outcome"], "typed");
    for v in IDENTITY_VALUES {
        assert!(!text_of(&releases).contains(v));
    }
}

#[tokio::test]
async fn a_sensitive_field_is_never_typed_into_an_http_page() {
    let f = start().await;
    // A provider whose item allows a loopback http origin: the provider would
    // release it; the fabric still refuses to type it there.
    let mut item = TestProvider::fixture_identity();
    item.allowed_origins = vec!["http://127.0.0.1:8080".into()];
    f.state.secrets.register_provider(
        OWNER,
        "test",
        Arc::new(TestProvider::empty().with_identity(item)),
        SecretsProviderKind::Test,
        None,
    );
    let s = f.session(Some(OWNER)).await;
    f.ext.goto(&["http://127.0.0.1:8080/form"]);
    for field in [SecretField::IdNumber, SecretField::DateOfBirth] {
        failed_with(&f.act(s, form_from(field, "#x")).await, "insecure_origin");
    }
    // The same page takes a non-sensitive field.
    let op = f.act(s, form_from(SecretField::City, "#city")).await;
    assert_eq!(op.state, OperationState::Succeeded, "{op:?}");
    assert_eq!(f.ext.typed().len(), 1);
    // A select is refused the same way, and the provider was never asked
    // for the sensitive value.
    failed_with(
        &f.act(
            s,
            select_from(SecretField::DateOfBirth, Some(SelectPart::Month), "#m"),
        )
        .await,
        "insecure_origin",
    );
}

#[tokio::test]
async fn select_from_provider_picks_the_matching_option_and_returns_no_value() {
    let f = start().await;
    f.register_test(json!({})).await;
    let s = f.session(Some(OWNER)).await;
    f.ext.goto(&[&format!("{FIXTURE_ORIGIN}/form")]);

    // A country (not sensitive): matched by the option's text.
    *f.ext.select.lock().unwrap() =
        options(&[("", "Choose..."), ("us", "United States"), ("ca", "Canada")]);
    let op = f
        .act(s, select_from(SecretField::Country, None, "#country"))
        .await;
    assert_eq!(op.state, OperationState::Succeeded, "{op:?}");
    assert_eq!(op.result, Some(json!({"selected": true})));
    let chosen: Vec<String> = f
        .ext
        .received
        .lock()
        .unwrap()
        .iter()
        .filter_map(|a| match a {
            RemoteAction::Evaluate { script, .. } if script.contains("selectedIndex=") => {
                Some(script.clone())
            }
            _ => None,
        })
        .collect();
    assert_eq!(chosen.len(), 1);
    assert!(chosen[0].contains("selectedIndex=2"), "{}", chosen[0]);
    assert!(chosen[0].contains("\"#country\""));

    // A date of birth split in three selects (1990-03-27): day, month, year.
    for (part, selector, list, want) in [
        (
            SelectPart::Day,
            "#d",
            options(&[("", "Day"), ("26", "26"), ("27", "27")]),
            2,
        ),
        (
            SelectPart::Month,
            "#m",
            options(&[
                ("", "Month"),
                ("1", "January"),
                ("2", "February"),
                ("3", "March"),
            ]),
            3,
        ),
        (
            SelectPart::Year,
            "#y",
            options(&[("", "Year"), ("1989", "1989"), ("1990", "1990")]),
            2,
        ),
    ] {
        *f.ext.select.lock().unwrap() = list;
        let op = f
            .act(
                s,
                select_from(SecretField::DateOfBirth, Some(part), selector),
            )
            .await;
        assert_eq!(
            op.result,
            Some(json!({"selected": true})),
            "{part:?} {op:?}"
        );
        let script = f
            .ext
            .received
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find_map(|a| match a {
                RemoteAction::Evaluate { script, .. } if script.contains("selectedIndex=") => {
                    Some(script.clone())
                }
                _ => None,
            })
            .unwrap();
        assert!(
            script.contains(&format!("selectedIndex={want}")),
            "{part:?} {script}"
        );
        for v in IDENTITY_VALUES {
            assert!(!text_of(&op).contains(v));
        }
    }
    // Nothing was typed: a select is chosen, not typed.
    assert!(f.ext.typed().is_empty());
    // The audit event says which field, never which option or the value.
    let sel = f.events("secrets.release");
    assert_eq!(sel.len(), 4);
    assert_eq!(sel[0]["field"], "country");
    assert_eq!(sel[0]["outcome"], "selected");
    assert_eq!(sel[0]["purpose"], "form");
    for v in IDENTITY_VALUES {
        assert!(!text_of(&sel).contains(v));
    }
}

#[tokio::test]
async fn select_from_provider_fails_cleanly_when_nothing_matches() {
    let f = start().await;
    f.register_test(json!({})).await;
    let s = f.session(Some(OWNER)).await;
    f.ext.goto(&[&format!("{FIXTURE_ORIGIN}/form")]);
    // No option is the value.
    *f.ext.select.lock().unwrap() = options(&[("us", "United States"), ("fr", "France")]);
    let op = f
        .act(s, select_from(SecretField::Country, None, "#c"))
        .await;
    failed_with(&op, "no_option");
    assert!(!text_of(&op).contains(FIXTURE_COUNTRY));
    // Not a select element.
    *f.ext.select.lock().unwrap() = json!({"found": true, "select": false});
    failed_with(
        &f.act(s, select_from(SecretField::Country, None, "#c"))
            .await,
        "no_option",
    );
    // No such element.
    *f.ext.select.lock().unwrap() = json!({"found": false});
    failed_with(
        &f.act(s, select_from(SecretField::Country, None, "#c"))
            .await,
        "typing_failed",
    );
    // A page that navigated while the value was fetched is not touched.
    *f.ext.select.lock().unwrap() = options(&[("ca", "Canada")]);
    f.ext.goto(&[
        &format!("{FIXTURE_ORIGIN}/form"),
        "https://evil.example.test/",
    ]);
    let before = f.ext.kinds().iter().filter(|k| **k == "evaluate").count();
    let op = f
        .act(s, select_from(SecretField::Country, None, "#c"))
        .await;
    failed_with(&op, "origin_mismatch");
    // Only the options probe ran; no option was chosen.
    let evals = f.ext.kinds().iter().filter(|k| **k == "evaluate").count();
    assert_eq!(evals - before, 1);
    // A provider refusal for the origin leaves the page alone too.
    f.ext.goto(&["https://other.example.test/form"]);
    let before = f.ext.kinds().iter().filter(|k| **k == "evaluate").count();
    *f.ext.select.lock().unwrap() = options(&[("1990", "1990")]);
    failed_with(
        &f.act(
            s,
            select_from(SecretField::DateOfBirth, Some(SelectPart::Year), "#y"),
        )
        .await,
        "origin_mismatch",
    );
    assert_eq!(
        f.ext.kinds().iter().filter(|k| **k == "evaluate").count() - before,
        1
    );
}

#[tokio::test]
async fn identity_values_reach_nothing_but_the_browser() {
    let f = start().await;
    f.register_test(json!({})).await;
    let s = f.session(Some(OWNER)).await;
    f.ext.goto(&[&format!("{FIXTURE_ORIGIN}/form")]);
    *f.ext.select.lock().unwrap() = options(&[("1990", "1990")]);
    let mut ops = vec![f.act(s, lookup_identity()).await];
    for (field, sel) in [
        (SecretField::FullName, "#n"),
        (SecretField::IdNumber, "#i"),
        (SecretField::City, "#c"),
    ] {
        ops.push(f.act(s, form_from(field, sel)).await);
    }
    ops.push(
        f.act(
            s,
            select_from(SecretField::DateOfBirth, Some(SelectPart::Year), "#y"),
        )
        .await,
    );
    assert!(
        ops.iter().all(|o| o.state == OperationState::Succeeded),
        "{ops:?}"
    );
    // Positive control: the browser did receive values.
    assert!(text_of(&f.ext.typed()).contains(FIXTURE_ID_NUMBER));
    let mut shown = vec![
        text_of(&ops),
        text_of(&f.events("secrets.release")),
        text_of(&f.events("secrets.lookup")),
    ];
    let mut seen = std::collections::HashSet::new();
    for e in f.store.log.recent() {
        if let Some(id) = e.data.get("op_id").and_then(Value::as_str) {
            if seen.insert(id.to_string()) {
                shown.push(text_of(
                    &f.client.operation(id.parse().unwrap()).await.unwrap(),
                ));
            }
        }
    }
    // The typed `type` operations show `[secret]`; the select's scripts hold an index, not a value.
    for what in &shown {
        for v in IDENTITY_VALUES {
            assert!(!what.contains(v), "{v} leaks in {what}");
        }
    }
}

// ------------------------------------------------------------ canary scan

/// Values only the providers know. If any of them shows up anywhere but the
/// browser's received action, the path leaks.
const CANARY_PASSWORD: &str = "cnry-pw-5d41402abc4b2a76b9719d911017c592";
const CANARY_CODE: &str = "cnry-otp-7b774effe4a349c6dd82ad4f4f21d34c";
const CANARY_TOKEN: &str = "cnry-token-098f6bcd4621d373cade4e832627b4f6";

#[tokio::test]
async fn canary_scan_over_logs_state_results_and_events() {
    let logs = LogBuf::default();
    tracing_subscriber::fmt()
        .with_writer(logs.clone())
        .with_max_level(tracing::Level::DEBUG)
        .with_span_events(FmtSpan::FULL)
        .with_ansi(false)
        .init();

    let f = start().await;

    // Register over HTTP (the token is a canary too), then replace the
    // provider by one holding canary values.
    let r = f
        .put_provider(OWNER, "test", json!({"kind": "test", "access_token": CANARY_TOKEN, "expires_at": "2999-01-01T00:00:00Z"}))
        .await;
    assert_eq!(r.status(), 200);
    assert!(!r.text().await.unwrap().contains(CANARY_TOKEN));
    let provider = Arc::new(TestProvider::empty().with_item(TestItem {
        id: "canary-item".into(),
        name: "Canary login".into(),
        username: "canary-user@example.test".into(),
        password: CANARY_PASSWORD.into(),
        code: Some(CANARY_CODE.into()),
        origins: vec![FIXTURE_ORIGIN.into()],
    }));
    f.state.secrets.register_provider(
        OWNER,
        "test",
        provider.clone(),
        SecretsProviderKind::Test,
        None,
    );

    // A scripted session: look up, type the username, the password and a
    // code, submit, fail once, end.
    let s = f.session(Some(OWNER)).await;
    let mut ops = Vec::new();
    ops.push(f.act(s, lookup()).await);
    ops.push(
        f.act(s, type_from("canary-item", SecretField::Password, "#pw"))
            .await,
    );
    ops.push(f.act(s, type_code("canary-item", "#otp")).await);
    f.ext.goto(&["https://login.example.test.evil.test/"]);
    ops.push(
        f.act(s, type_from("canary-item", SecretField::Password, "#pw"))
            .await,
    );
    f.ext.goto(&[&format!("{FIXTURE_ORIGIN}/")]);
    *f.ext.frame.lock().unwrap() = json!({"found": true, "frame": false, "same_origin": true});
    ops.push(
        f.act(
            s,
            RemoteAction::TypeFromProvider {
                item_id: "canary-item".into(),
                field: SecretField::Password,
                selector: None,
                point: Some(ViewportPoint { x: 10, y: 10 }),
                purpose: SecretPurpose::Login,
                clear: true,
                submit: true,
                provider: None,
                run_id: None,
                client_label: None,
                tab_id: None,
            },
        )
        .await,
    );
    provider.set_failure(Some(ProviderError::Unavailable));
    ops.push(
        f.act(s, type_from("canary-item", SecretField::Password, "#pw"))
            .await,
    );
    f.client.end_session(s).await.unwrap();

    // The browser is the one place the values reached.
    let typed = f.ext.typed();
    assert!(typed
        .iter()
        .any(|a| matches!(a, RemoteAction::Type { text, .. } if text == CANARY_PASSWORD)));
    assert!(typed
        .iter()
        .any(|a| matches!(a, RemoteAction::Type { text, .. } if text == CANARY_CODE)));
    assert!(typed
        .iter()
        .any(|a| matches!(a, RemoteAction::TypeKeys { text, .. } if text == CANARY_PASSWORD)));
    assert_eq!(
        ops.iter()
            .filter(|o| o.state == OperationState::Succeeded)
            .count(),
        4
    );
    // Positive control: the scan below does find a value where it is.
    assert!(text_of(&typed).contains(CANARY_PASSWORD));

    // Every operation the fabric knows, as a caller reads it.
    let mut results = vec![text_of(&ops)];
    let mut seen = std::collections::HashSet::new();
    for e in f.store.log.recent() {
        if let Some(id) = e.data.get("op_id").and_then(Value::as_str) {
            if seen.insert(id.to_string()) {
                results.push(text_of(
                    &f.client.operation(id.parse().unwrap()).await.unwrap(),
                ));
            }
        }
    }
    assert!(
        seen.len() > 12,
        "too few operations were read: {}",
        seen.len()
    );
    results.push(text_of(&f.client.sessions().await.unwrap()));

    // The state database (and its WAL), after a save.
    let dir = tempfile::tempdir().unwrap();
    let db = StateDb::open(&dir.path().join("state.db")).unwrap();
    db.flush(&f.store, &f.state.credentials);
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir.path()).unwrap() {
        files.push((entry.unwrap().path(), ()));
    }
    assert!(!files.is_empty());

    let events = text_of(&f.store.log.recent());
    assert!(
        events.contains("secrets.release"),
        "events were not captured"
    );
    let logs = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    assert!(
        logs.contains("provider action started"),
        "logs were not captured"
    );

    for canary in [CANARY_PASSWORD, CANARY_CODE, CANARY_TOKEN] {
        for (what, text) in [("events", &events), ("logs", &logs)] {
            assert!(!text.contains(canary), "{what} leak {canary}");
        }
        for r in &results {
            assert!(
                !r.contains(canary),
                "an operation or session leaks {canary}: {r}"
            );
        }
        for (path, _) in &files {
            let bytes = std::fs::read(path).unwrap();
            assert!(
                !bytes.windows(canary.len()).any(|w| w == canary.as_bytes()),
                "{} leaks {canary}",
                path.display()
            );
        }
    }
    // The provider saw owners, origins and fields, never a value to log.
    assert!(provider
        .calls()
        .iter()
        .any(|c| c.op == "release" && c.field == Some("password")));
}

// ------------------------------------------------------------ cards (E37.7)

const SHOP_PAGE: &str = "https://checkout.shop.example.test/pay";

fn lookup_cards() -> RemoteAction {
    RemoteAction::SecretsLookup {
        kind: ItemKind::Card,
        provider: None,
        run_id: Some("run-1".into()),
        client_label: Some("Console".into()),
        tab_id: None,
    }
}

/// One card field, typed into a selector (or a point), for a purchase.
fn card_field(
    item: &str,
    field: CardField,
    selector: Option<&str>,
    point: Option<ViewportPoint>,
    amount: &str,
) -> RemoteAction {
    RemoteAction::TypeCardField {
        item_id: item.into(),
        field,
        selector: selector.map(Into::into),
        point,
        amount: amount.into(),
        currency: "USD".into(),
        clear: true,
        provider: None,
        run_id: Some("run-1".into()),
        client_label: Some("Console".into()),
        tab_id: None,
    }
}

fn card_by_selector(field: CardField, selector: &str) -> RemoteAction {
    card_field(FIXTURE_CARD_ID, field, Some(selector), None, "42.50")
}

fn card_by_point(field: CardField, x: i64, y: i64) -> RemoteAction {
    card_field(
        FIXTURE_CARD_ID,
        field,
        None,
        Some(ViewportPoint { x, y }),
        "42.50",
    )
}

const CARD_VALUES: [&str; 6] = [
    FIXTURE_CARD_NUMBER,
    FIXTURE_CARD_CVV,
    FIXTURE_CARD_EXP_MONTH,
    FIXTURE_CARD_EXP_YEAR,
    FIXTURE_CARD_HOLDER,
    FIXTURE_CARD_POSTAL,
];

fn typed_texts(f: &Fabric) -> Vec<String> {
    f.ext
        .typed()
        .into_iter()
        .map(|a| match a {
            RemoteAction::Type { text, .. } | RemoteAction::TypeKeys { text, .. } => text,
            other => panic!("{other:?}"),
        })
        .collect()
}

#[tokio::test]
async fn card_lookup_lists_brand_last_four_and_the_grant_never_a_number() {
    let f = start().await;
    f.register_test(json!({})).await;
    let s = f.session(Some(OWNER)).await;
    f.ext.goto(&[SHOP_PAGE]);
    let op = f.act(s, lookup_cards()).await;
    assert_eq!(op.state, OperationState::Succeeded, "{op:?}");
    let r = op.result.clone().unwrap();
    let items = r["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    let card = &items[0]["card"];
    assert_eq!(card["last4"], "4242");
    assert_eq!(card["brand"], "visa");
    assert_eq!(card["grant"]["max_amount"], "500.00");
    assert_eq!(card["grant"]["includes_security_code"], true);
    for v in [FIXTURE_CARD_NUMBER, FIXTURE_CARD_CVV] {
        assert!(!text_of(&op).contains(v));
    }
    // A merchant with no grant lists nothing.
    f.ext.goto(&["https://elsewhere.test/pay"]);
    let none = f.act(s, lookup_cards()).await;
    assert_eq!(none.result.unwrap()["items"], json!([]));
}

#[tokio::test]
async fn card_fields_are_typed_in_order_with_the_security_code_last() {
    let f = start().await;
    f.register_test(json!({})).await;
    let s = f.session(Some(OWNER)).await;
    f.ext.goto(&[SHOP_PAGE]);
    // The order the console's tool follows: number, expiry, holder, postal code, security code last.
    let steps = [
        (CardField::Number, "#cc-number"),
        (CardField::Expiry, "#cc-exp"),
        (CardField::HolderName, "#cc-name"),
        (CardField::PostalCode, "#zip"),
        (CardField::SecurityCode, "#cc-csc"),
    ];
    let mut ops = Vec::new();
    for (field, selector) in steps {
        let op = f.act(s, card_by_selector(field, selector)).await;
        assert_eq!(op.state, OperationState::Succeeded, "{field:?}: {op:?}");
        assert_eq!(op.result, Some(json!({"typed": true})), "{field:?}");
        ops.push(op);
    }
    // The browser got trusted `type`s, in that order; the combined expiry is MM/YY.
    assert_eq!(
        typed_texts(&f),
        vec![
            FIXTURE_CARD_NUMBER.to_string(),
            "09/31".into(),
            FIXTURE_CARD_HOLDER.into(),
            FIXTURE_CARD_POSTAL.into(),
            FIXTURE_CARD_CVV.into(),
        ]
    );
    assert!(f.ext.typed().iter().all(|a| matches!(
        a,
        RemoteAction::Type {
            sensitive: true,
            submit: false,
            ..
        }
    )));
    // The provider was asked for one field each, with the purchase; the code was asked for last.
    let provider_fields: Vec<_> = f
        .events("secrets.release")
        .iter()
        .map(|e| e["field"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        provider_fields,
        [
            "number",
            "expiry",
            "holder_name",
            "postal_code",
            "security_code"
        ]
    );
    for e in f.events("secrets.release") {
        assert_eq!(e["amount"], "42.50");
        assert_eq!(e["currency"], "USD");
        assert_eq!(e["purpose"], "purchase");
        assert_eq!(e["outcome"], "typed");
        assert_eq!(e["origin"], "https://checkout.shop.example.test");
        assert_eq!(e["frame_origin"], Value::Null);
    }
    // No value in any operation or event; the typing steps show [secret].
    let mut shown = vec![text_of(&ops), text_of(&f.store.log.recent())];
    let mut seen = std::collections::HashSet::new();
    for e in f.store.log.recent() {
        if let Some(id) = e.data.get("op_id").and_then(Value::as_str) {
            if seen.insert(id.to_string()) {
                shown.push(text_of(
                    &f.client.operation(id.parse().unwrap()).await.unwrap(),
                ));
            }
        }
    }
    for what in &shown {
        for v in [FIXTURE_CARD_NUMBER, FIXTURE_CARD_CVV, "09/31"] {
            assert!(!what.contains(v), "{v} leaks in {what}");
        }
    }
    // Pictures are allowed again once typing ended.
    let shot = f
        .act(
            s,
            RemoteAction::Screenshot {
                marks: false,
                mask: true,
                tab_id: None,
            },
        )
        .await;
    assert_eq!(shot.state, OperationState::Succeeded);
}

#[tokio::test]
async fn a_cross_origin_payment_frame_is_typed_by_coordinates_and_its_origin_reported() {
    let f = start().await;
    f.register_test(json!({})).await;
    let s = f.session(Some(OWNER)).await;
    f.ext.goto(&[SHOP_PAGE]);
    let frame = |src: &str| json!({"found": true, "frame": true, "same_origin": false, "src": src});
    *f.ext.frame.lock().unwrap() = frame(&format!("{FIXTURE_PAY_FRAME}/elements?session=abc"));

    let op = f.act(s, card_by_point(CardField::Number, 300, 480)).await;
    assert_eq!(op.state, OperationState::Succeeded, "{op:?}");
    assert_eq!(
        op.result,
        Some(json!({"typed": true, "frame_origin": FIXTURE_PAY_FRAME}))
    );
    // Typed through coordinates: a click and keystrokes, no script in the frame.
    let kinds = f.ext.kinds();
    for k in ["click_at", "type_keys"] {
        assert!(kinds.contains(&k), "{k} in {kinds:?}");
    }
    assert!(f.ext.typed().iter().all(|a| matches!(
        a,
        RemoteAction::TypeKeys {
            sensitive: true,
            ..
        }
    )));
    // The merchant is the top-level origin; the frame is reported on its own.
    let e = f.events("secrets.release").pop().unwrap();
    assert_eq!(e["origin"], "https://checkout.shop.example.test");
    assert_eq!(e["frame_origin"], FIXTURE_PAY_FRAME);
    assert!(!text_of(&op).contains(FIXTURE_CARD_NUMBER));

    // A frame whose origin the fabric cannot determine is refused before any value is fetched.
    let typed_before = f.ext.typed().len();
    for src in [
        "",
        "about:blank",
        "data:text/html,x",
        "http://pay.processor.example.test/x",
        "not a url",
    ] {
        *f.ext.frame.lock().unwrap() = frame(src);
        let op = f
            .act(s, card_by_point(CardField::SecurityCode, 300, 520))
            .await;
        failed_with(&op, "frame_unknown");
        assert_eq!(
            f.events("secrets.release").last().unwrap()["released"],
            false,
            "{src}"
        );
    }
    assert_eq!(f.ext.typed().len(), typed_before);

    // A frame the grant does not list: the provider refuses; nothing is typed.
    *f.ext.frame.lock().unwrap() = frame("https://evil.example.test/steal");
    failed_with(
        &f.act(s, card_by_point(CardField::Number, 300, 480)).await,
        "origin_mismatch",
    );
    assert_eq!(f.ext.typed().len(), typed_before);

    // A selector may not name a frame element; the point inside it is the way.
    *f.ext.frame.lock().unwrap() = frame(FIXTURE_PAY_FRAME);
    failed_with(
        &f.act(s, card_by_selector(CardField::Number, "iframe"))
            .await,
        "typing_failed",
    );
    // Nothing at the point.
    *f.ext.frame.lock().unwrap() = json!({"found": false});
    failed_with(
        &f.act(s, card_by_point(CardField::Number, 1, 1)).await,
        "typing_failed",
    );
    assert_eq!(f.ext.typed().len(), typed_before);
}

#[tokio::test]
async fn the_target_is_read_again_after_the_provider_answers() {
    let f = start().await;
    f.register_test(json!({})).await;
    let s = f.session(Some(OWNER)).await;
    f.ext.goto(&[SHOP_PAGE]);
    // The frame under the point is the processor's at first and another origin a moment later.
    let frame = |src: &str| json!({"found": true, "frame": true, "same_origin": false, "src": src});
    *f.ext.card_probe.lock().unwrap() = VecDeque::from([
        frame(FIXTURE_PAY_FRAME),
        frame("https://evil.example.test/x"),
    ]);
    failed_with(
        &f.act(s, card_by_point(CardField::Number, 300, 480)).await,
        "origin_mismatch",
    );
    assert!(f.ext.typed().is_empty());
    assert_eq!(
        f.events("secrets.release").last().unwrap()["released"],
        true
    );

    // The page navigates between the two reads: refused as well.
    f.ext.card_probe.lock().unwrap().clear();
    f.ext.goto(&[SHOP_PAGE, "https://evil.example.test/"]);
    failed_with(
        &f.act(s, card_by_selector(CardField::Number, "#cc")).await,
        "origin_mismatch",
    );
    assert!(f.ext.typed().is_empty());
}

#[tokio::test]
async fn a_card_is_not_typed_into_an_http_page_and_the_grant_is_enforced() {
    let f = start().await;
    f.register_test(json!({})).await;
    let s = f.session(Some(OWNER)).await;
    let provider_calls = || -> usize {
        f.events("secrets.release")
            .iter()
            .filter(|e| e["released"] == true)
            .count()
    };

    // http: refused whatever the provider says, before any value is fetched.
    f.ext.goto(&["http://127.0.0.1:8080/pay"]);
    failed_with(
        &f.act(s, card_by_selector(CardField::Number, "#cc")).await,
        "insecure_origin",
    );
    assert_eq!(provider_calls(), 0);

    f.ext.goto(&[SHOP_PAGE]);
    // More than the grant allows, the wrong currency, a code the grant does not include, an unknown card.
    let mut over = card_by_selector(CardField::Number, "#cc");
    if let RemoteAction::TypeCardField { amount, .. } = &mut over {
        *amount = "500.01".into();
    }
    failed_with(&f.act(s, over).await, "amount_exceeded");
    let mut euro = card_by_selector(CardField::Number, "#cc");
    if let RemoteAction::TypeCardField { currency, .. } = &mut euro {
        *currency = "EUR".into();
    }
    failed_with(&f.act(s, euro).await, "currency_mismatch");
    failed_with(
        &f.act(
            s,
            card_field(
                FIXTURE_CARD_2_ID,
                CardField::SecurityCode,
                Some("#csc"),
                None,
                "5",
            ),
        )
        .await,
        "security_code_not_granted",
    );
    failed_with(
        &f.act(
            s,
            card_field("no-such-card", CardField::Number, Some("#cc"), None, "5"),
        )
        .await,
        "not_found",
    );
    // Another merchant (the card is granted elsewhere only).
    f.ext.goto(&["https://elsewhere.test/pay"]);
    failed_with(
        &f.act(s, card_by_selector(CardField::Number, "#cc")).await,
        "origin_mismatch",
    );
    assert!(f.ext.typed().is_empty());

    // `type_from_provider` never types a card: it has no purchase.
    f.ext.goto(&[SHOP_PAGE]);
    let by_login_path = RemoteAction::TypeFromProvider {
        item_id: FIXTURE_CARD_ID.into(),
        field: SecretField::CardNumber,
        selector: Some("#cc".into()),
        point: None,
        purpose: SecretPurpose::Purchase,
        clear: true,
        submit: false,
        provider: None,
        run_id: None,
        client_label: None,
        tab_id: None,
    };
    failed_with(&f.act(s, by_login_path).await, "refused");
    assert!(f.ext.typed().is_empty());
    let _ = FIXTURE_MERCHANT;
}

#[tokio::test]
async fn no_screenshot_while_a_card_is_being_typed() {
    let f = start().await;
    f.register_test(json!({})).await;
    let s = f.session(Some(OWNER)).await;
    f.ext.goto(&[SHOP_PAGE]);
    f.ext.hold.store(true, Ordering::SeqCst);
    let typing = {
        let (client, action) = (f.client.clone(), card_by_selector(CardField::Number, "#cc"));
        tokio::spawn(async move { client.act(s, action, Some(Duration::from_secs(10))).await })
    };
    for _ in 0..200 {
        if !f.ext.typed().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(!f.ext.typed().is_empty(), "the typing never started");
    for mask in [false, true] {
        let err = f
            .client
            .act(
                s,
                RemoteAction::Screenshot {
                    marks: false,
                    mask,
                    tab_id: None,
                },
                Some(Duration::from_secs(1)),
            )
            .await
            .unwrap_err();
        assert_eq!(err.status(), Some(409), "{err}");
    }
    f.ext.hold.store(false, Ordering::SeqCst);
    assert_eq!(
        typing.await.unwrap().unwrap().state,
        OperationState::Succeeded
    );
}

#[tokio::test]
async fn card_values_reach_nothing_but_the_browser() {
    let f = start().await;
    f.register_test(json!({})).await;
    let s = f.session(Some(OWNER)).await;
    f.ext.goto(&[SHOP_PAGE]);
    let mut ops = vec![f.act(s, lookup_cards()).await];
    for (field, sel) in [
        (CardField::Number, "#n"),
        (CardField::Expiry, "#e"),
        (CardField::HolderName, "#h"),
        (CardField::SecurityCode, "#c"),
    ] {
        ops.push(f.act(s, card_by_selector(field, sel)).await);
    }
    // A refusal too.
    ops.push(
        f.act(
            s,
            card_field(FIXTURE_CARD_ID, CardField::Number, Some("#n"), None, "9999"),
        )
        .await,
    );
    f.client.end_session(s).await.unwrap();
    // Positive control: the browser did receive them.
    let typed = text_of(&f.ext.typed());
    for v in [FIXTURE_CARD_NUMBER, FIXTURE_CARD_CVV] {
        assert!(typed.contains(v), "{v} was not typed");
    }
    let mut shown = vec![
        text_of(&ops),
        text_of(&f.store.log.recent()),
        text_of(&f.client.sessions().await.unwrap()),
    ];
    let mut seen = std::collections::HashSet::new();
    for e in f.store.log.recent() {
        if let Some(id) = e.data.get("op_id").and_then(Value::as_str) {
            if seen.insert(id.to_string()) {
                shown.push(text_of(
                    &f.client.operation(id.parse().unwrap()).await.unwrap(),
                ));
            }
        }
    }
    // The state database after a save.
    let dir = tempfile::tempdir().unwrap();
    let db = StateDb::open(&dir.path().join("state.db")).unwrap();
    db.flush(&f.store, &f.state.credentials);
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir.path()).unwrap() {
        files.push(entry.unwrap().path());
    }
    assert!(!files.is_empty());
    for v in CARD_VALUES.iter().take(2).chain(["09/31"].iter()) {
        for what in &shown {
            assert!(!what.contains(v), "{v} leaks in {what}");
        }
        for path in &files {
            let bytes = std::fs::read(path).unwrap();
            assert!(
                !bytes.windows(v.len()).any(|w| w == v.as_bytes()),
                "{} leaks {v}",
                path.display()
            );
        }
    }
}

#[test]
fn the_registry_is_a_plain_value() {
    // The registry can be built and shared without a server.
    let r = SecretsProviders::default();
    assert!(r.list("nobody").is_empty());
}

// ------------------------------------------------------------- the Vault

/// The remote Vault provider (#591) through the whole fabric path: a real
/// HTTP fake of Vault's agent credential API, a real control plane and a
/// fake extension that records what it is asked to type.
mod vault_provider {
    use super::*;
    use hexactra_credential_resolver::fake_vault::{
        FakeVault, CLOSED_ID, FORUM_ID_1, SHOP_ID, SHOP_ORIGIN, SHOP_PASSWORD, SHOP_USERNAME,
    };

    const SHOP_PAGE: &str = "https://app.example.test/signin";

    impl Fabric {
        /// What the console does: hand the owner's Vault to the fabric with a
        /// short-lived access token.
        async fn register_vault(&self, vault: &FakeVault, token: &str) -> reqwest::Response {
            self.register_vault_until(vault, token, "2999-01-01T00:00:00Z")
                .await
        }

        async fn register_vault_until(
            &self,
            vault: &FakeVault,
            token: &str,
            expires_at: &str,
        ) -> reqwest::Response {
            self.put_provider(
                OWNER,
                "vault",
                json!({"kind": "vault", "base_url": vault.base_url, "access_token": token, "expires_at": expires_at}),
            )
            .await
        }
    }

    async fn ready() -> (Fabric, FakeVault, String, Uuid) {
        let f = start().await;
        let vault = FakeVault::start().await;
        let token = vault.default_token();
        let r = f.register_vault(&vault, &token).await;
        assert_eq!(r.status(), 200, "{}", r.text().await.unwrap());
        f.ext.goto(&[SHOP_PAGE]);
        let s = f.session(Some(OWNER)).await;
        (f, vault, token, s)
    }

    #[tokio::test]
    async fn a_login_is_looked_up_and_typed_and_no_result_holds_a_value() {
        let (f, vault, token, s) = ready().await;
        vault.queue_totp_codes(["482913"]);

        // Registration answers without the token.
        let list = reqwest::Client::new()
            .get(format!("{}/v1/secrets-providers/{OWNER}", f.url))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(
            list.contains("\"kind\":\"vault\"") && !list.contains(&token),
            "{list}"
        );

        // Lookup: the shop login is the exact match; summaries only.
        let op = f.act(s, lookup()).await;
        assert_eq!(op.state, OperationState::Succeeded, "{op:?}");
        let r = op.result.clone().unwrap();
        assert_eq!(r["provider"], "vault");
        assert_eq!(r["origin"], SHOP_ORIGIN);
        let items = r["items"].as_array().unwrap();
        assert_eq!(items[0]["id"], SHOP_ID);
        assert_eq!(items[0]["match_kind"], "exact");
        assert_eq!(items[0]["username"], SHOP_USERNAME);
        assert_eq!(items[0]["has_code"], true);
        assert!(items[1..].iter().all(|i| i["match_kind"] == "site"));

        // Username, password and a code are typed.
        let user = f
            .act(s, type_from(SHOP_ID, SecretField::Username, "#user"))
            .await;
        let pw = f
            .act(s, type_from(SHOP_ID, SecretField::Password, "#pw"))
            .await;
        let code = f.act(s, type_code(SHOP_ID, "#otp")).await;
        for op in [&user, &pw, &code] {
            assert_eq!(op.state, OperationState::Succeeded, "{op:?}");
        }
        assert_eq!(user.result, Some(json!({"typed": true})));
        assert_eq!(code.result.as_ref().unwrap()["typed"], true);
        assert!(code.result.as_ref().unwrap()["expires_at"].is_string());
        let typed = |selector: &str, text: &str, clear: bool, submit: bool| RemoteAction::Type {
            selector: selector.into(),
            text: text.into(),
            clear,
            submit,
            sensitive: true,
            expect_origin: Some(SHOP_ORIGIN.into()),
            tab_id: Some(TAB),
        };
        assert_eq!(
            f.ext.typed(),
            vec![
                typed("#user", SHOP_USERNAME, true, false),
                typed("#pw", SHOP_PASSWORD, true, false),
                typed("#otp", "482913", false, true),
            ]
        );
        // No operation result, as a caller reads it, holds a value or the token.
        for op in [&user, &pw, &code] {
            for shown in [
                text_of(op),
                text_of(&f.client.operation(op.id).await.unwrap()),
            ] {
                for v in [SHOP_PASSWORD, "482913", token.as_str()] {
                    assert!(!shown.contains(v), "{v} in {shown}");
                }
            }
        }

        // Vault was asked for one field per call, with the page's own origin
        // and the purpose; the audit trail has no value.
        let fills = vault.requests_to("/fill");
        assert_eq!(fills.len(), 2);
        assert_eq!(fills[0].params["field"], "username");
        assert_eq!(fills[1].params["field"], "password");
        assert!(fills.iter().all(|r| r.params["origin"] == SHOP_ORIGIN
            && r.params["purpose"] == "login"
            && r.status == 200));
        let totp = vault.requests_to("/totp");
        assert_eq!((totp.len(), totp[0].params["purpose"].as_str()), (1, "mfa"));
        let all = text_of(&f.events("secrets.release")) + &text_of(&f.events("secrets.lookup"));
        for v in [SHOP_PASSWORD, "482913", token.as_str()] {
            assert!(!all.contains(v), "{all}");
        }
        let releases = f.events("secrets.release");
        assert_eq!(releases.len(), 3);
        assert_eq!(releases[1]["provider"], "vault");
        assert_eq!(releases[1]["outcome"], "typed");
    }

    #[tokio::test]
    async fn vault_refusals_map_to_codes_and_nothing_is_typed() {
        let (f, vault, token, s) = ready().await;

        // A page on a sibling subdomain: a site match is not fillable, and a
        // mismatch is not retried.
        f.ext.goto(&["https://login.example.test/"]);
        failed_with(
            &f.act(s, type_from(SHOP_ID, SecretField::Password, "#pw"))
                .await,
            "origin_mismatch",
        );
        assert_eq!(vault.requests_to("/fill").len(), 1);
        failed_with(
            &f.act(s, type_code(SHOP_ID, "#otp")).await,
            "origin_mismatch",
        );
        assert_eq!(vault.requests_to("/totp").len(), 1);
        f.ext.goto(&[SHOP_PAGE]);

        // Closed, missing and no-authenticator are one `not_found`.
        failed_with(
            &f.act(s, type_from(CLOSED_ID, SecretField::Password, "#pw"))
                .await,
            "not_found",
        );
        failed_with(
            &f.act(
                s,
                type_from(
                    "7f1c2e9a-0000-4000-8000-0000000000ff",
                    SecretField::Password,
                    "#pw",
                ),
            )
            .await,
            "not_found",
        );
        f.ext.goto(&["https://forum.example.test/"]);
        failed_with(&f.act(s, type_code(FORUM_ID_1, "#otp")).await, "not_found");
        f.ext.goto(&[SHOP_PAGE]);

        // A short rate limit is waited out once; a long one fails.
        vault.throttle_next(1, 1);
        let ok = f
            .act(s, type_from(SHOP_ID, SecretField::Username, "#user"))
            .await;
        assert_eq!(ok.state, OperationState::Succeeded, "{ok:?}");
        vault.throttle_next(1, 60);
        let limited = f
            .act(s, type_from(SHOP_ID, SecretField::Username, "#user"))
            .await;
        failed_with(&limited, "rate_limited");
        assert!(limited.error.unwrap().contains("60"));

        // Vault down, kill switch off, token revoked.
        vault.fail_next(503);
        failed_with(
            &f.act(s, type_from(SHOP_ID, SecretField::Password, "#pw"))
                .await,
            "unavailable",
        );
        vault.set_agent_access(false);
        failed_with(&f.act(s, lookup()).await, "disabled");
        failed_with(
            &f.act(s, type_from(SHOP_ID, SecretField::Password, "#pw"))
                .await,
            "disabled",
        );
        vault.set_agent_access(true);
        vault.revoke_token(&token);
        failed_with(
            &f.act(s, type_from(SHOP_ID, SecretField::Password, "#pw"))
                .await,
            "unauthorized",
        );
        failed_with(&f.act(s, lookup()).await, "unauthorized");

        // Only the one successful username was ever typed.
        assert_eq!(f.ext.typed().len(), 1);
        // A read-only token cannot fill (scope), and says so with a short code.
        let read_only = vault.token(&["vault:items_read"]);
        assert_eq!(f.register_vault(&vault, &read_only).await.status(), 200);
        assert_eq!(f.act(s, lookup()).await.state, OperationState::Succeeded);
        let refused = f
            .act(s, type_from(SHOP_ID, SecretField::Password, "#pw"))
            .await;
        failed_with(&refused, "refused");
        assert!(refused.error.unwrap().contains("insufficient_scope"));
        assert_eq!(f.ext.typed().len(), 1);
    }

    #[tokio::test]
    async fn a_new_registration_replaces_the_token_and_expiry_drops_it() {
        let f = start().await;
        let vault = FakeVault::start().await;
        f.ext.goto(&[SHOP_PAGE]);
        let s = f.session(Some(OWNER)).await;
        let old = vault.default_token();
        assert_eq!(f.register_vault(&vault, &old).await.status(), 200);
        assert_eq!(f.act(s, lookup()).await.state, OperationState::Succeeded);

        // The console replaces the token before expiry; the old one is dead.
        vault.revoke_token(&old);
        let fresh = vault.default_token();
        assert_eq!(f.register_vault(&vault, &fresh).await.status(), 200);
        assert_eq!(f.state.secrets.list(OWNER).len(), 1);
        assert_eq!(f.act(s, lookup()).await.state, OperationState::Succeeded);
        let calls = vault.requests().len();

        // A registration with a short expiry disappears; nothing is called.
        let soon = (chrono::Utc::now() + chrono::Duration::milliseconds(800)).to_rfc3339();
        assert_eq!(
            f.register_vault_until(&vault, &fresh, &soon).await.status(),
            200
        );
        assert_eq!(f.act(s, lookup()).await.state, OperationState::Succeeded);
        tokio::time::sleep(Duration::from_millis(1000)).await;
        failed_with(&f.act(s, lookup()).await, "no_provider");
        assert!(f.state.secrets.list(OWNER).is_empty());
        assert_eq!(vault.requests().len(), calls + 1);

        // Disconnecting drops it too.
        assert_eq!(f.register_vault(&vault, &fresh).await.status(), 200);
        assert!(f.state.secrets.remove(OWNER, "vault"));
        failed_with(&f.act(s, lookup()).await, "no_provider");
    }

    #[tokio::test]
    async fn another_owner_does_not_reach_the_vault() {
        let (f, vault, _token, _s) = ready().await;
        let other = f.session(Some("user-b")).await;
        failed_with(&f.act(other, lookup()).await, "no_provider");
        let none = f.session(None).await;
        failed_with(&f.act(none, lookup()).await, "no_provider");
        assert!(vault.requests().is_empty());
    }

    #[tokio::test]
    async fn the_canary_scan_passes_with_the_vault_provider() {
        const CODE: &str = "cnry-vault-otp-3a7bd3e2360a3d29eea436fcfb7e44c7";
        let logs = LogBuf::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(logs.clone())
            .with_max_level(tracing::Level::DEBUG)
            .with_span_events(FmtSpan::FULL)
            .with_ansi(false)
            .finish();
        // This test's runtime is current-thread: the server, the store and
        // the provider's HTTP calls all run under this default.
        let _guard = tracing::subscriber::set_default(subscriber);

        let (f, vault, token, s) = ready().await;
        vault.queue_totp_codes([CODE]);
        let canaries: Vec<String> = vault
            .canaries()
            .into_iter()
            .chain([CODE.to_string(), token.clone()])
            .collect();

        // A scripted session: look up, type the username, the password and a
        // code, then fail in the ways Vault can.
        let mut ops = vec![f.act(s, lookup()).await];
        ops.push(
            f.act(s, type_from(SHOP_ID, SecretField::Username, "#user"))
                .await,
        );
        ops.push(
            f.act(s, type_from(SHOP_ID, SecretField::Password, "#pw"))
                .await,
        );
        ops.push(f.act(s, type_code(SHOP_ID, "#otp")).await);
        ops.push(
            f.act(
                s,
                RemoteAction::TypeFromProvider {
                    item_id: SHOP_ID.into(),
                    field: SecretField::Password,
                    selector: None,
                    point: Some(ViewportPoint { x: 10, y: 10 }),
                    purpose: SecretPurpose::Login,
                    clear: true,
                    submit: true,
                    provider: None,
                    run_id: None,
                    client_label: None,
                    tab_id: None,
                },
            )
            .await,
        );
        f.ext.goto(&["https://login.example.test/"]);
        ops.push(
            f.act(s, type_from(SHOP_ID, SecretField::Password, "#pw"))
                .await,
        );
        f.ext.goto(&[SHOP_PAGE]);
        vault.set_agent_access(false);
        ops.push(
            f.act(s, type_from(SHOP_ID, SecretField::Password, "#pw"))
                .await,
        );
        vault.set_agent_access(true);
        vault.revoke_token(&token);
        ops.push(
            f.act(s, type_from(SHOP_ID, SecretField::Password, "#pw"))
                .await,
        );
        f.client.end_session(s).await.unwrap();

        // The browser is the one place the values reached.
        let typed = f.ext.typed();
        for want in [SHOP_PASSWORD, CODE, SHOP_USERNAME] {
            assert!(
                typed.iter().any(|a| matches!(a,
                    RemoteAction::Type { text, .. } | RemoteAction::TypeKeys { text, .. }
                        if text == want)),
                "{want} was not typed"
            );
        }
        assert!(text_of(&typed).contains(SHOP_PASSWORD), "positive control");
        assert_eq!(
            ops.iter()
                .filter(|o| o.state == OperationState::Succeeded)
                .count(),
            5
        );

        // Every operation the fabric knows, as a caller reads it.
        let mut results = vec![text_of(&ops)];
        let mut seen = std::collections::HashSet::new();
        for e in f.store.log.recent() {
            if let Some(id) = e.data.get("op_id").and_then(Value::as_str) {
                if seen.insert(id.to_string()) {
                    results.push(text_of(
                        &f.client.operation(id.parse().unwrap()).await.unwrap(),
                    ));
                }
            }
        }
        assert!(
            seen.len() > 12,
            "too few operations were read: {}",
            seen.len()
        );
        results.push(text_of(&f.client.sessions().await.unwrap()));
        let listed = reqwest::Client::new()
            .get(format!("{}/v1/secrets-providers/{OWNER}", f.url))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        results.push(listed);

        // The state database (and its WAL), after a save.
        let dir = tempfile::tempdir().unwrap();
        let db = StateDb::open(&dir.path().join("state.db")).unwrap();
        db.flush(&f.store, &f.state.credentials);
        let files: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        assert!(!files.is_empty());

        let events = text_of(&f.store.log.recent());
        assert!(
            events.contains("secrets.release"),
            "events were not captured"
        );
        let logs = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
        assert!(
            logs.contains("provider action started"),
            "logs were not captured"
        );

        for canary in &canaries {
            for (what, text) in [("events", &events), ("logs", &logs)] {
                assert!(!text.contains(canary.as_str()), "{what} leak {canary}");
            }
            for r in &results {
                assert!(
                    !r.contains(canary.as_str()),
                    "an operation, session or registration leaks {canary}: {r}"
                );
            }
            for path in &files {
                let bytes = std::fs::read(path).unwrap();
                assert!(
                    !bytes.windows(canary.len()).any(|w| w == canary.as_bytes()),
                    "{} leaks {canary}",
                    path.display()
                );
            }
        }
        // Vault was reached with the registered token and nothing leaked it.
        assert!(vault.requests().len() >= 5);
    }

    #[tokio::test]
    async fn a_card_is_looked_up_and_typed_through_vault_with_the_purchase_and_no_value_anywhere() {
        use hexactra_credential_resolver::fake_vault::{
            CARD_CVV, CARD_FRAME, CARD_ID, CARD_NUMBER,
        };
        let f = start().await;
        let vault = FakeVault::start().await;
        let token = vault.card_token();
        assert_eq!(f.register_vault(&vault, &token).await.status(), 200);
        let s = f.session(Some(OWNER)).await;
        f.ext.goto(&["https://checkout.shop.example.test/pay"]);

        let look = f.act(s, lookup_cards()).await;
        assert_eq!(look.state, OperationState::Succeeded, "{look:?}");
        let ids: Vec<_> = look.result.as_ref().unwrap()["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["id"].as_str().unwrap().to_string())
            .collect();
        assert!(
            ids.contains(&CARD_ID.to_string()) && ids.len() == 2,
            "{ids:?}"
        );

        // The number into a processor frame by coordinates, the expiry and the holder by selector.
        *f.ext.frame.lock().unwrap() = json!({"found": true, "frame": true, "same_origin": false, "src": format!("{CARD_FRAME}/elements")});
        let number = f
            .act(
                s,
                card_field(
                    CARD_ID,
                    CardField::Number,
                    None,
                    Some(ViewportPoint { x: 5, y: 6 }),
                    "42.50",
                ),
            )
            .await;
        assert_eq!(
            number.result,
            Some(json!({"typed": true, "frame_origin": CARD_FRAME})),
            "{number:?}"
        );
        *f.ext.frame.lock().unwrap() = json!({"found": true, "frame": false, "same_origin": true});
        let expiry = f
            .act(
                s,
                card_field(CARD_ID, CardField::Expiry, Some("#exp"), None, "42.50"),
            )
            .await;
        assert_eq!(expiry.state, OperationState::Succeeded, "{expiry:?}");
        // The grant has no security code: refused with its own code, nothing typed.
        failed_with(
            &f.act(
                s,
                card_field(
                    CARD_ID,
                    CardField::SecurityCode,
                    Some("#csc"),
                    None,
                    "42.50",
                ),
            )
            .await,
            "security_code_not_granted",
        );
        // Over the grant.
        failed_with(
            &f.act(
                s,
                card_field(CARD_ID, CardField::Number, Some("#n"), None, "500.01"),
            )
            .await,
            "amount_exceeded",
        );
        // What Vault was asked: merchant, frame, amount, currency, purpose, one field per call.
        let fills = vault.requests_to("/fill");
        assert_eq!(fills[0].params["field"], "number");
        assert_eq!(
            fills[0].params["origin"],
            "https://checkout.shop.example.test"
        );
        assert_eq!(fills[0].params["frameOrigin"], CARD_FRAME);
        assert_eq!(fills[0].params["amount"], "42.5");
        assert_eq!(fills[0].params["purpose"], "purchase");
        assert!(!fills[1].params.contains_key("frameOrigin"));
        assert_eq!(
            fills
                .iter()
                .map(|r| r.params["field"].as_str())
                .collect::<Vec<_>>(),
            ["number", "expMonth", "expYear", "securityCode", "number"]
        );
        assert_eq!(
            typed_texts(&f),
            vec![CARD_NUMBER.to_string(), "09/31".into()]
        );
        // No result, event or log carries a value.
        let shown = [
            text_of(&look),
            text_of(&number),
            text_of(&expiry),
            text_of(&f.store.log.recent()),
        ];
        for what in &shown {
            for v in [CARD_NUMBER, CARD_CVV, "09/31"] {
                assert!(!what.contains(v), "{v} leaks in {what}");
            }
        }
        assert!(!text_of(&f.store.log.recent()).contains(&token));
    }

    #[tokio::test]
    async fn identity_details_are_looked_up_and_typed_through_vault_with_no_value_anywhere() {
        use hexactra_credential_resolver::fake_vault::{
            IDENTITY_ALLOWED_ORIGIN, IDENTITY_DOB, IDENTITY_FULL_NAME, IDENTITY_ID,
            IDENTITY_ID_NUMBER,
        };
        let f = start().await;
        let vault = FakeVault::start().await;
        let token = vault.identity_token();
        assert_eq!(f.register_vault(&vault, &token).await.status(), 200);
        let s = f.session(Some(OWNER)).await;
        f.ext.goto(&[&format!("{IDENTITY_ALLOWED_ORIGIN}/apply")]);

        let look = f.act(s, lookup_identity()).await;
        assert_eq!(look.state, OperationState::Succeeded, "{look:?}");
        let item = &look.result.as_ref().unwrap()["items"][0];
        assert_eq!(
            (item["id"].as_str(), item["match_kind"].as_str()),
            (Some(IDENTITY_ID), Some("exact"))
        );
        assert_eq!(item["fields"].as_array().unwrap().len(), 5);

        let field = |item: &str, field, selector: &str| match form_from(field, selector) {
            RemoteAction::TypeFromProvider {
                field,
                selector,
                point,
                clear,
                submit,
                provider,
                run_id,
                client_label,
                tab_id,
                ..
            } => RemoteAction::TypeFromProvider {
                item_id: item.into(),
                field,
                selector,
                point,
                purpose: SecretPurpose::Form,
                clear,
                submit,
                provider,
                run_id,
                client_label,
                tab_id,
            },
            _ => unreachable!(),
        };
        let name = f
            .act(s, field(IDENTITY_ID, SecretField::FullName, "#name"))
            .await;
        let id = f
            .act(s, field(IDENTITY_ID, SecretField::IdNumber, "#id"))
            .await;
        assert_eq!(name.result, Some(json!({"typed": true})), "{name:?}");
        assert_eq!(id.result, Some(json!({"typed": true})), "{id:?}");
        // Date of birth chosen from a year select.
        *f.ext.select.lock().unwrap() = options(&[("1984", "1984"), ("1985", "1985")]);
        let dob = f
            .act(
                s,
                RemoteAction::SelectFromProvider {
                    item_id: IDENTITY_ID.into(),
                    field: SecretField::DateOfBirth,
                    selector: "#y".into(),
                    part: Some(SelectPart::Year),
                    provider: None,
                    run_id: None,
                    client_label: None,
                    tab_id: None,
                },
            )
            .await;
        assert_eq!(dob.result, Some(json!({"selected": true})), "{dob:?}");

        // On another site the allowed list refuses the sensitive field, at Vault.
        f.ext.goto(&["https://other.example.test/apply"]);
        failed_with(
            &f.act(s, field(IDENTITY_ID, SecretField::IdNumber, "#id"))
                .await,
            "origin_mismatch",
        );
        let ok = f
            .act(s, field(IDENTITY_ID, SecretField::FullName, "#name"))
            .await;
        assert_eq!(ok.state, OperationState::Succeeded, "{ok:?}");
        // A token without the identity scope is refused with its own reason.
        let narrow = vault.default_token();
        assert_eq!(f.register_vault(&vault, &narrow).await.status(), 200);
        let refused = f.act(s, lookup_identity()).await;
        failed_with(&refused, "refused");
        assert!(refused
            .error
            .as_deref()
            .unwrap()
            .contains("insufficient_scope"));

        // The browser got the values; nothing a caller or a log reads did.
        assert!(text_of(&f.ext.typed()).contains(IDENTITY_ID_NUMBER));
        let events = text_of(&f.store.log.recent());
        for canary in [
            IDENTITY_FULL_NAME,
            IDENTITY_DOB,
            IDENTITY_ID_NUMBER,
            token.as_str(),
        ] {
            assert!(!events.contains(canary), "events leak {canary}");
            for op in [&look, &name, &id, &dob, &ok, &refused] {
                assert!(!text_of(op).contains(canary), "{canary} leaks in {op:?}");
            }
        }
        // Vault saw the field, the origin and the purpose `form`.
        let fills = vault.requests_to("/fill");
        assert!(fills
            .iter()
            .all(|r| r.path.contains("/identity/") && r.params["purpose"] == "form"));
    }
}
