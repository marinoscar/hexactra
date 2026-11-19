//! Saving the sign-in the owner typed by hand (E37.4b), over real HTTP.
//!
//! A `credentials` handoff created with `offer_save` keeps its password in the
//! control plane's memory after a `type_secret` action types it. The owner's
//! provider (the fake Vault, contract 1.3) is then asked to save the login with
//! purpose `save_login`, from that copy: the caller never holds the password,
//! the answer never carries it, and nothing it reads, logs or stores does.

use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use hexactra_client::{ControlClient, HostClient};
use hexactra_control::runtime::{self, ApiState, RuntimeStore};
use hexactra_core::remote::{
    CreateHandoffRequest, CreateSessionRequest, HandoffInput, HandoffKind, OperationState,
    RegisterHostRequest, RemoteAction,
};
use hexactra_credential_resolver::fake_vault::FakeVault;
use serde_json::{json, Value};
use uuid::Uuid;

const TOKEN: &str = "secret-test-token-0123456789abcdef";
const OWNER: &str = "user-a";
const USERNAME: &str = "person-a@example.test";
const PASSWORD: &str = "CANARY-typed-by-hand-password-7c1d9e";
const ORIGIN: &str = "https://signin.example.test";

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

struct Fabric {
    url: String,
    store: RuntimeStore,
    client: ControlClient,
    vault: FakeVault,
    /// What the fake host was asked to do.
    received: Arc<Mutex<Vec<RemoteAction>>>,
}

async fn start() -> Fabric {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let store = RuntimeStore::new();
    let state = ApiState::with_webhooks(
        store.clone(),
        TOKEN,
        hexactra_control::runtime::webhooks::Webhooks::in_memory(),
    );
    tokio::spawn(runtime::serve(listener, state, std::future::pending()));
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
    let received: Arc<Mutex<Vec<RemoteAction>>> = Default::default();
    {
        let (host, received) = (host.clone(), received.clone());
        tokio::spawn(async move {
            loop {
                let Ok(Some(op)) = host.next(host_id, true, Duration::from_millis(100)).await
                else {
                    continue;
                };
                received.lock().unwrap().push(op.action.clone());
                host.report(
                    host_id,
                    op.id,
                    &hexactra_core::remote::OperationResult {
                        navigation_blocked: Vec::new(),
                        ok: true,
                        result: Some(json!({})),
                        error: None,
                    },
                )
                .await
                .unwrap();
            }
        });
    }
    let vault = FakeVault::start().await;
    let f = Fabric {
        client: ControlClient::new(&url, TOKEN).unwrap(),
        url,
        store,
        vault,
        received,
    };
    f.register_vault(&f.vault.write_token()).await;
    f
}

impl Fabric {
    async fn register_vault(&self, access_token: &str) {
        let r = reqwest::Client::new()
            .put(format!("{}/v1/secrets-providers/{OWNER}/vault", self.url))
            .bearer_auth(TOKEN)
            .json(&json!({
                "kind": "vault",
                "base_url": self.vault.base_url,
                "access_token": access_token,
                "expires_at": "2099-01-01T00:00:00Z",
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200, "{:?}", r.text().await);
    }

    async fn session(&self, owner: &str) -> Uuid {
        self.client
            .create_session(&CreateSessionRequest {
                owner_id: Some(owner.into()),
                ..Default::default()
            })
            .await
            .unwrap()
            .id
    }

    /// A sign-in the owner answered with the typed password, then typed by the agent: the
    /// handoff's id.
    async fn signed_in(&self, session: Uuid, offer_save: bool) -> Uuid {
        let mut req = CreateHandoffRequest::new(
            HandoffKind::Login,
            "Sign in to Example",
            HandoffInput::Credentials,
        );
        req.offer_save = offer_save;
        let created = self.client.create_handoff(session, &req).await.unwrap();
        let r = reqwest::Client::new()
            .post(format!("{}{}", self.url, created.respond_path))
            .json(&json!({
                "value": USERNAME,
                "secret": PASSWORD,
                "response_token": created.response_token,
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        let op = self
            .client
            .act(
                session,
                RemoteAction::TypeSecret {
                    handoff_id: created.handoff.id,
                    selector: "#password".into(),
                    clear: true,
                    submit: false,
                    tab_id: None,
                },
                Some(Duration::from_secs(10)),
            )
            .await
            .unwrap();
        assert_eq!(op.state, OperationState::Succeeded);
        created.handoff.id
    }

    async fn save(&self, owner: &str, handoff: Uuid, name: &str) -> (u16, Value) {
        let r = reqwest::Client::new()
            .post(format!(
                "{}/v1/secrets-providers/{owner}/vault/save-login",
                self.url
            ))
            .bearer_auth(TOKEN)
            .json(
                &json!({"handoff_id": handoff, "name": name, "origin": ORIGIN, "run_id": "run-1"}),
            )
            .send()
            .await
            .unwrap();
        let status = r.status().as_u16();
        assert_eq!(r.headers()["cache-control"], "no-store");
        let text = r.text().await.unwrap();
        assert!(
            !text.contains(PASSWORD),
            "the answer carries the password: {text}"
        );
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
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

#[tokio::test]
async fn the_password_goes_from_the_fabric_to_the_provider_once_and_nowhere_else() {
    let logs = LogBuf::default();
    let _ = tracing_subscriber::fmt()
        .with_writer(logs.clone())
        .with_max_level(tracing::Level::DEBUG)
        .with_ansi(false)
        .try_init();
    let f = start().await;
    let session = f.session(OWNER).await;
    let hid = f.signed_in(session, true).await;

    let (status, body) = f.save(OWNER, hid, "Example sign-in").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["saved"], true);
    let item_id = body["item_id"].as_str().unwrap().to_string();

    // The provider got the login with the purpose of contract 1.3 and the typed password.
    let saved = f
        .vault
        .login_named("Example sign-in")
        .expect("saved in the vault");
    assert_eq!(saved.password, PASSWORD);
    assert_eq!(saved.username, USERNAME);
    assert_eq!(saved.origins, vec![ORIGIN.to_string()]);
    assert_eq!(saved.id, item_id);
    let creates: Vec<_> = f
        .vault
        .requests()
        .into_iter()
        .filter(|r| r.method == "POST" && r.path.ends_with("/credentials"))
        .collect();
    assert_eq!(creates.len(), 1);
    assert_eq!(creates[0].status, 201);
    assert_eq!(creates[0].params["purpose"], "save_login");
    assert_eq!(creates[0].params["origin"], ORIGIN);

    // It was used: asking again is "too late", and the host only ever saw the typing.
    let (status, body) = f.save(OWNER, hid, "Another name").await;
    assert_eq!(
        (status, body["error"].as_str()),
        (409, Some("secret_unavailable"))
    );
    assert!(f.vault.login_named("Another name").is_none());

    // The audit event names the purpose, the field kind and the outcome; never a value.
    let events = f.events("secrets.release");
    let save = events
        .iter()
        .find(|e| e["purpose"] == "save_login" && e["outcome"] == "saved")
        .expect("a saved event");
    assert_eq!(save["field"], "password");
    assert_eq!(save["provider"], "vault");
    assert_eq!(save["owner_id"], OWNER);
    assert_eq!(save["run_id"], "run-1");
    // Read the handoff first: a log line is written while it is served, and the buffer's lock
    // must not be held across it.
    let handoff_view = serde_json::to_string(&f.client.handoff(hid, None).await.unwrap()).unwrap();
    let log_text = String::from_utf8_lossy(&logs.0.lock().unwrap()).into_owned();
    for (what, text) in [
        (
            "events",
            serde_json::to_string(&f.store.log.recent()).unwrap(),
        ),
        ("logs", log_text),
        ("handoff view", handoff_view),
        (
            "the vault's request record",
            serde_json::to_string(
                &f.vault
                    .requests()
                    .iter()
                    .map(|r| format!("{r:?}"))
                    .collect::<Vec<_>>(),
            )
            .unwrap(),
        ),
    ] {
        assert!(!text.contains(PASSWORD), "{what} leaks the password");
        assert!(
            !text.contains(USERNAME) || what == "handoff view",
            "{what} leaks the username"
        );
    }
}

#[tokio::test]
async fn the_offer_survives_a_taken_name_and_the_end_of_the_session() {
    let f = start().await;
    let session = f.session(OWNER).await;
    let hid = f.signed_in(session, true).await;

    // The name is taken: the same answer Vault gives, and the password stays.
    let (status, body) = f.save(OWNER, hid, "Shop login").await;
    assert_eq!((status, body["error"].as_str()), (409, Some("name_taken")));

    // The run ends before the owner decides: the offer lives on.
    f.client.end_session(session).await.unwrap();
    let (status, body) = f.save(OWNER, hid, "Example sign-in").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        f.vault.login_named("Example sign-in").unwrap().password,
        PASSWORD
    );
}

#[tokio::test]
async fn only_an_offered_handoff_of_the_owner_can_be_saved() {
    let f = start().await;
    let session = f.session(OWNER).await;
    // Not created with `offer_save`: the password is gone once typed.
    let plain = f.signed_in(session, false).await;
    let (status, body) = f.save(OWNER, plain, "Plain").await;
    assert_eq!((status, body["error"].as_str()), (404, Some("not_found")));

    // Another owner's handoff is not found (and that owner has no provider registered).
    let hid = f.signed_in(session, true).await;
    let (status, _) = f.save("user-b", hid, "Not yours").await;
    assert_eq!(status, 404);
    // Still there for its owner.
    assert_eq!(f.save(OWNER, hid, "Mine").await.0, 200);

    // Unknown handoffs and bad bodies.
    assert_eq!(f.save(OWNER, Uuid::new_v4(), "Nothing").await.0, 404);
    let bad = reqwest::Client::new()
        .post(format!(
            "{}/v1/secrets-providers/{OWNER}/vault/save-login",
            f.url
        ))
        .bearer_auth(TOKEN)
        .json(&json!({"handoff_id": hid, "name": "  ", "origin": ORIGIN}))
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 400);
    // A client route: no token, no save.
    let anon = reqwest::Client::new()
        .post(format!(
            "{}/v1/secrets-providers/{OWNER}/vault/save-login",
            f.url
        ))
        .json(&json!({"handoff_id": hid, "name": "x", "origin": ORIGIN}))
        .send()
        .await
        .unwrap();
    assert_eq!(anon.status(), 401);
}

#[tokio::test]
async fn provider_failures_keep_their_codes_and_leave_the_offer() {
    let f = start().await;
    let session = f.session(OWNER).await;
    let hid = f.signed_in(session, true).await;

    // A grant without the write scope: the vault refuses, the owner may reconnect and retry.
    f.register_vault(&f.vault.token(&["vault:items_read", "vault:items_fill"]))
        .await;
    let (status, body) = f.save(OWNER, hid, "No scope").await;
    assert_eq!((status, body["error"].as_str()), (422, Some("refused")));

    // The Vault's kill switch.
    f.register_vault(&f.vault.write_token()).await;
    f.vault.set_agent_access(false);
    let (status, body) = f.save(OWNER, hid, "Switched off").await;
    assert_eq!((status, body["error"].as_str()), (422, Some("disabled")));
    f.vault.set_agent_access(true);

    // Unreachable.
    f.vault.fail_next(500);
    let (status, body) = f.save(OWNER, hid, "Down").await;
    assert_eq!((status, body["error"].as_str()), (502, Some("unavailable")));

    // A revoked token.
    let token = f.vault.write_token();
    f.register_vault(&token).await;
    f.vault.revoke_token(&token);
    let (status, body) = f.save(OWNER, hid, "Revoked").await;
    assert_eq!(
        (status, body["error"].as_str()),
        (502, Some("unauthorized"))
    );

    // After all that the password is still held: a working registration saves it.
    f.register_vault(&f.vault.write_token()).await;
    let (status, body) = f.save(OWNER, hid, "Finally").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(f.vault.login_named("Finally").unwrap().password, PASSWORD);
    // Of everything that failed, nothing was created.
    for name in ["No scope", "Switched off", "Down", "Revoked"] {
        assert!(f.vault.login_named(name).is_none(), "{name}");
    }
    // The host was only ever asked to type.
    assert!(f
        .received
        .lock()
        .unwrap()
        .iter()
        .all(|a| !matches!(a, RemoteAction::TypeFromProvider { .. })));
}

#[tokio::test]
async fn a_provider_that_cannot_save_says_so() {
    let f = start().await;
    let session = f.session(OWNER).await;
    let hid = f.signed_in(session, true).await;
    // The fixture provider has no create route.
    let r = reqwest::Client::new()
        .put(format!("{}/v1/secrets-providers/{OWNER}/test", f.url))
        .bearer_auth(TOKEN)
        .json(&json!({"kind": "test", "access_token": "t", "settings": {}}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let r = reqwest::Client::new()
        .post(format!(
            "{}/v1/secrets-providers/{OWNER}/test/save-login",
            f.url
        ))
        .bearer_auth(TOKEN)
        .json(&json!({"handoff_id": hid, "name": "x", "origin": ORIGIN}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 422);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["error"], "unsupported");
    // And the offer is still there for the provider that can.
    assert_eq!(f.save(OWNER, hid, "Still here").await.0, 200);
}

#[tokio::test]
async fn offer_save_is_only_for_a_sign_in() {
    let f = start().await;
    let session = f.session(OWNER).await;
    let mut req = CreateHandoffRequest::new(HandoffKind::Code, "A code", HandoffInput::Secret);
    req.offer_save = true;
    let err = f.client.create_handoff(session, &req).await.unwrap_err();
    assert_eq!(err.status(), Some(400));
}
