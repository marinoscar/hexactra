//! Hexactra passkeys end to end through the control plane (E47.4, #942;
//! E47.6, #944): a fake host plays the extension (it holds the page's WebAuthn
//! request and reports it with the tab's origin), the test provider keeps the
//! keys. `passkey_create` makes and keeps a key and answers the page with a
//! `none` attestation; `passkey_sign_in` answers with an ES256 assertion that
//! verifies with that key. Another site's RP ID, a payment approval, no
//! passkey and several passkeys all leave the request to the browser.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine as _;
use hexactra_client::{ControlClient, HostClient};
use hexactra_control::runtime::webhooks::Webhooks;
use hexactra_control::runtime::{self, ApiState, RuntimeStore};
use hexactra_core::remote::{
    CreateSessionRequest, OperationResult, OperationState, OperationView, RegisterHostRequest,
    RemoteAction, SecretsProviderKind,
};
use hexactra_credential_resolver::test_provider::{TestPasskey, TestProvider};
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use p256::pkcs8::DecodePrivateKey;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const TOKEN: &str = "secret-test-token-0123456789abcdef";
const OWNER: &str = "user-a";
const TAB: i64 = 7;
const PAGE: &str = "https://login.example.com/account/security";

#[derive(Clone, Default)]
struct Ext {
    /// What `webauthn_pending` reports next (the last one stays).
    pending: Arc<Mutex<VecDeque<Value>>>,
    received: Arc<Mutex<Vec<RemoteAction>>>,
}

impl Ext {
    fn will_ask(&self, request: Value) {
        *self.pending.lock().unwrap() = VecDeque::from([request]);
    }
    fn resolves(&self) -> Vec<(Option<Value>, bool)> {
        self.received
            .lock()
            .unwrap()
            .iter()
            .filter_map(|a| match a {
                RemoteAction::WebauthnResolve {
                    credential,
                    passthrough,
                    ..
                } => Some((credential.clone(), *passthrough)),
                _ => None,
            })
            .collect()
    }
    fn kinds(&self) -> Vec<&'static str> {
        self.received
            .lock()
            .unwrap()
            .iter()
            .map(|a| a.kind())
            .collect()
    }
    fn clear(&self) {
        self.received.lock().unwrap().clear();
    }
}

struct Fabric {
    client: ControlClient,
    state: ApiState,
    ext: Ext,
}

async fn start() -> Fabric {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let store = RuntimeStore::new();
    let state = ApiState::with_webhooks(store.clone(), TOKEN, Webhooks::in_memory());
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
            bluetooth: None,
        })
        .await
        .unwrap()
        .host_id;
    host.next(host_id, true, Duration::from_millis(10))
        .await
        .unwrap();
    let ext = Ext::default();
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
                        json!({"tabs": [{"id": TAB, "window_id": 1, "url": PAGE, "title": "Security", "active": true}]})
                    }
                    RemoteAction::WebauthnArm { .. } => json!({"armed": true, "tab_id": TAB}),
                    RemoteAction::WebauthnPending { .. } => {
                        let q = ext.pending.lock().unwrap();
                        json!({"request": q.front().cloned().unwrap_or(Value::Null)})
                    }
                    RemoteAction::WebauthnResolve { .. } => json!({"resolved": true}),
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
        state,
        ext,
    }
}

impl Fabric {
    fn provider(&self, p: TestProvider) -> Arc<TestProvider> {
        let p = Arc::new(p);
        self.state.secrets.register_provider(
            OWNER,
            "test",
            p.clone(),
            SecretsProviderKind::Test,
            None,
        );
        p
    }
    async fn session(&self) -> Uuid {
        self.client
            .create_session(&CreateSessionRequest {
                owner_id: Some(OWNER.into()),
                ..Default::default()
            })
            .await
            .unwrap()
            .id
    }
    async fn act(&self, s: Uuid, action: RemoteAction) -> OperationView {
        self.client
            .act(s, action, Some(Duration::from_secs(10)))
            .await
            .unwrap()
    }
}

fn sign_in() -> RemoteAction {
    RemoteAction::PasskeySignIn {
        selector: "#passkey".into(),
        tab_id: None,
        provider: None,
        run_id: Some("run-1".into()),
        client_label: None,
    }
}
fn create() -> RemoteAction {
    RemoteAction::PasskeyCreate {
        selector: "#add-passkey".into(),
        tab_id: None,
        provider: None,
        run_id: Some("run-1".into()),
        client_label: None,
    }
}
fn get_request(rp_id: &str, allow: &[&str]) -> Value {
    json!({"id": "wa-1", "kind": "get", "origin": "https://login.example.com", "rp_id": rp_id, "challenge": "Y2hhbGxlbmdlLTE", "allow_credentials": allow, "payment": false})
}
fn create_request() -> Value {
    json!({"id": "wa-2", "kind": "create", "origin": "https://login.example.com", "rp_id": "example.com", "challenge": "Y2hhbGxlbmdlLTI",
           "user": {"id": "dXNlci1oYW5kbGU", "name": "person-a@example.test"}, "algorithms": [-7, -257], "exclude_credentials": []})
}
fn failed_with(op: &OperationView, code: &str) {
    assert_eq!(op.state, OperationState::Failed, "{op:?}");
    assert!(
        op.error.as_deref().unwrap_or_default().starts_with(code),
        "{op:?}"
    );
}
fn bytes(b64: &Value) -> Vec<u8> {
    B64.decode(b64.as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn a_created_passkey_signs_in_with_a_valid_assertion() {
    let f = start().await;
    let provider = f.provider(TestProvider::empty());
    let s = f.session().await;

    f.ext.will_ask(create_request());
    let op = f.act(s, create()).await;
    assert_eq!(op.state, OperationState::Succeeded, "{op:?}");
    assert_eq!(op.result.as_ref().unwrap()["created"], true);
    assert_eq!(op.result.as_ref().unwrap()["rp_id"], "example.com");
    assert_eq!(
        f.ext.kinds(),
        vec![
            "tabs",
            "webauthn_arm",
            "click",
            "webauthn_pending",
            "webauthn_resolve"
        ]
    );
    let kept = provider.passkeys();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].rp_id, "example.com");
    assert_eq!(kept[0].user_handle, "dXNlci1oYW5kbGU");
    let (cred, passthrough) = f.ext.resolves().pop().unwrap();
    assert!(!passthrough);
    let cred = cred.unwrap();
    assert_eq!(cred["id"], kept[0].credential_id);
    let cd: Value = serde_json::from_slice(&bytes(&cred["response"]["client_data_json"])).unwrap();
    assert_eq!(
        cd,
        json!({"type": "webauthn.create", "challenge": "Y2hhbGxlbmdlLTI", "origin": "https://login.example.com", "crossOrigin": false})
    );
    let auth = bytes(&cred["response"]["authenticator_data"]);
    assert_eq!(&auth[..32], Sha256::digest(b"example.com").as_slice());
    assert_eq!(auth[32], 0x45);
    // The result and the operation never carry the key.
    let key_b64 = B64.encode(&kept[0].private_key);
    assert!(!serde_json::to_string(&op).unwrap().contains(&key_b64));

    f.ext.clear();
    f.ext
        .will_ask(get_request("example.com", &[&kept[0].credential_id]));
    let op = f.act(s, sign_in()).await;
    assert_eq!(op.state, OperationState::Succeeded, "{op:?}");
    assert_eq!(
        op.result.as_ref().unwrap(),
        &json!({"signed_in": true, "rp_id": "example.com"})
    );
    let (cred, passthrough) = f.ext.resolves().pop().unwrap();
    assert!(!passthrough);
    let r = &cred.unwrap()["response"];
    let auth = bytes(&r["authenticator_data"]);
    let cd = bytes(&r["client_data_json"]);
    assert_eq!(
        serde_json::from_slice::<Value>(&cd).unwrap()["origin"],
        "https://login.example.com"
    );
    assert_eq!(&auth[33..37], &[0, 0, 0, 1]);
    assert_eq!(r["user_handle"], "dXNlci1oYW5kbGU");
    let mut msg = auth.clone();
    msg.extend_from_slice(&Sha256::digest(&cd));
    let key = SigningKey::from_pkcs8_der(&kept[0].private_key).unwrap();
    VerifyingKey::from(&key)
        .verify(&msg, &Signature::from_der(&bytes(&r["signature"])).unwrap())
        .unwrap();
    assert_eq!(provider.passkeys()[0].sign_count, 1);
    assert!(!serde_json::to_string(&op)
        .unwrap()
        .contains("Y2hhbGxlbmdlLTE"));
}

#[tokio::test]
async fn every_refusal_leaves_the_request_to_the_browser() {
    let f = start().await;
    let key = SigningKey::random(&mut rand::rngs::OsRng);
    use p256::pkcs8::EncodePrivateKey;
    let mk = |id: &str, cred: &str| TestPasskey {
        id: id.into(),
        owner: OWNER.into(),
        rp_id: "example.com".into(),
        origin: "https://login.example.com".into(),
        credential_id: cred.into(),
        user_handle: "dQ".into(),
        user_name: id.into(),
        public_key: String::new(),
        private_key: key.to_pkcs8_der().unwrap().as_bytes().to_vec(),
        sign_count: 0,
    };
    f.provider(
        TestProvider::empty()
            .with_passkey(mk("a", "QQ"))
            .with_passkey(mk("b", "Qg")),
    );
    let s = f.session().await;
    let cases: Vec<(Value, &str)> = vec![
        // Another site's RP ID.
        (get_request("evil.com", &[]), "origin_mismatch"),
        // A payment approval (E47.6).
        (
            {
                let mut r = get_request("example.com", &["QQ"]);
                r["payment"] = json!(true);
                r
            },
            "payment_refused",
        ),
        // None of the owner's credentials is allowed.
        (get_request("example.com", &["Wg"]), "no_passkey"),
        // Both fit: the owner chooses, not the fabric.
        (get_request("example.com", &[]), "several_passkeys"),
    ];
    for (req, code) in cases {
        f.ext.clear();
        f.ext.will_ask(req);
        failed_with(&f.act(s, sign_in()).await, code);
        assert_eq!(f.ext.resolves(), vec![(None, true)], "{code}");
    }
    // The page asked nothing after the click.
    f.ext.clear();
    *f.ext.pending.lock().unwrap() = VecDeque::new();
    failed_with(&f.act(s, sign_in()).await, "no_request");
    assert!(f.ext.resolves().is_empty());
}

#[tokio::test]
async fn an_api_caller_cannot_queue_the_extension_webauthn_actions() {
    let f = start().await;
    let s = f.session().await;
    let err = f
        .client
        .act(
            s,
            RemoteAction::WebauthnResolve {
                request_id: "x".into(),
                tab_id: None,
                credential: Some(json!({})),
                passthrough: false,
            },
            Some(Duration::from_secs(2)),
        )
        .await
        .unwrap_err();
    assert!(err.to_string().contains("webauthn"), "{err}");
}
