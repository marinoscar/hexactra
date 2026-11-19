//! A fake Vault for tests (E37.2, #591): a small HTTP server that serves the
//! agent credential API (`/api/agent/v1`) the way marinoscar/vault's
//! `docs/agent-credential-api.md` documents it (contract 1.2, beta), so the
//! Vault provider and the control plane's end-to-end tests run against real
//! HTTP. It mirrors the console's `test/support/fake-vault.ts` for the routes
//! the fabric calls (`whoami`, `credentials`, `fill`, `totp`); the OAuth
//! endpoints are the console's business and are not served here.
//!
//! What it implements: the deployment kill switch (`403 AGENT_ACCESS_DISABLED`),
//! scopes (`403` with `WWW-Authenticate: Bearer error="insufficient_scope"`), a
//! revoked token (`401`), per-login opt-in with ONE identical `404`, exact
//! origin binding (`403 ORIGIN_MISMATCH`; a site-only match is listed but
//! never fillable), `429 RATE_LIMITED` with `Retry-After`, and
//! `Cache-Control: no-store` on every response. Its answers carry an unknown
//! extra field and a `message` that must never be branched on.
//!
//! It holds only invented data (`Person A`, `*.example.test`) and canary
//! values, records what it was asked (never a value) and is compiled only for
//! this crate's tests and the `test-provider` feature.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderValue, Request, StatusCode};
use axum::response::Response;
use axum::Router;
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};

use crate::{MatchKind, Origin};

/// The shop login: one exact origin, an authenticator.
pub const SHOP_ID: &str = "7f1c2e9a-0000-4000-8000-000000000001";
pub const SHOP_ORIGIN: &str = "https://app.example.test";
pub const SHOP_USERNAME: &str = "person-a@example.test";
pub const SHOP_PASSWORD: &str = "CANARY-vault-shop-password-5d41402abc4b2a76";
/// Two logins on one origin: a lookup returns both, a person must choose.
pub const FORUM_ID_1: &str = "7f1c2e9a-0000-4000-8000-000000000002";
pub const FORUM_ID_2: &str = "7f1c2e9a-0000-4000-8000-000000000003";
pub const FORUM_ORIGIN: &str = "https://forum.example.test";
/// A login its owner has not opened to agents: indistinguishable from a
/// missing one.
pub const CLOSED_ID: &str = "7f1c2e9a-0000-4000-8000-000000000004";
/// The scopes the console asks for.
pub const SCOPES_READ_FILL: [&str; 2] = ["vault:items_read", "vault:items_fill"];
/// Logins plus identity details (contract 1.1).
pub const SCOPES_WITH_IDENTITY: [&str; 4] = [
    "vault:items_read",
    "vault:items_fill",
    "vault:identity_read",
    "vault:identity_fill",
];
/// The fake's identity item: a date of birth and an ID number (sensitive,
/// allowed only on [`IDENTITY_ALLOWED_ORIGIN`]) and a name, a city and a
/// country (not sensitive). Values are canaries.
pub const IDENTITY_ID: &str = "7f1c2e9a-0000-4000-8000-0000000000a1";
pub const IDENTITY_CLOSED_ID: &str = "7f1c2e9a-0000-4000-8000-0000000000a2";
pub const IDENTITY_ALLOWED_ORIGIN: &str = "https://forms.example.test";
pub const IDENTITY_FULL_NAME: &str = "Person A Canary-Vault-Name";
pub const IDENTITY_DOB: &str = "1985-11-02";
pub const IDENTITY_ID_NUMBER: &str = "CANARY-VAULT-ID-8844-1203";
pub const IDENTITY_CITY: &str = "Exampleton";
pub const IDENTITY_COUNTRY: &str = "Canada";

/// Logins plus cards (contract 1.1): what the console asks with the card consent.
pub const SCOPES_WITH_CARDS: [&str; 4] = [
    "vault:items_read",
    "vault:items_fill",
    "vault:cards_read",
    "vault:cards_fill",
];
/// The fake's saved card (E37.7): a well-known test number, with a grant for
/// [`CARD_MERCHANT`] up to 500.00 USD, one allowed payment frame and no
/// security code. Values are the published test card; nothing real.
pub const CARD_ID: &str = "7f1c2e9a-0000-4000-8000-0000000000c1";
/// A second card, granted for the same merchant with the security code and a
/// small limit.
pub const CARD_2_ID: &str = "7f1c2e9a-0000-4000-8000-0000000000c2";
/// A card its owner has not opened to agents.
pub const CARD_CLOSED_ID: &str = "7f1c2e9a-0000-4000-8000-0000000000c3";
pub const CARD_MERCHANT: &str = "https://shop.example.test";
pub const CARD_FRAME: &str = "https://pay.processor.example.test";
pub const CARD_NUMBER: &str = "4242424242424242";
pub const CARD_EXP_MONTH: &str = "09";
pub const CARD_EXP_YEAR: &str = "2031";
pub const CARD_HOLDER: &str = "Person A";
pub const CARD_POSTAL: &str = "K1A 0B1";
pub const CARD_CVV: &str = "CANARY-CVV-737";
pub const CARD_2_NUMBER: &str = "5555555555554444";
pub const CARD_2_CVV: &str = "CANARY-CVV-4821";

/// One merchant grant of a fake card.
#[derive(Debug, Clone)]
pub struct FakeGrant {
    pub merchant_origin: String,
    pub frame_origins: Vec<String>,
    pub max_amount: f64,
    pub currency: String,
    pub include_security_code: bool,
    pub expired: bool,
    /// At most this many `number` releases per day (a period limit).
    pub max_releases_per_day: Option<u32>,
}

/// One card of the fake (contract 1.1).
#[derive(Debug, Clone)]
pub struct FakeCard {
    pub id: String,
    pub name: String,
    pub brand: String,
    pub open: bool,
    pub number: String,
    pub exp_month: String,
    pub exp_year: String,
    pub holder: String,
    pub postal: String,
    pub cvv: String,
    pub grants: Vec<FakeGrant>,
    /// `number` releases so far today (all grants).
    pub releases: u32,
}

/// One login of the fake.
#[derive(Debug, Clone)]
pub struct FakeLogin {
    pub id: String,
    pub name: String,
    pub username: String,
    pub password: String,
    pub origins: Vec<String>,
    pub open: bool,
    pub has_totp: bool,
}

/// One identity item of the fake (contract 1.1).
#[derive(Debug, Clone)]
pub struct FakeIdentity {
    pub id: String,
    pub name: String,
    pub open: bool,
    /// Where its sensitive fields may be typed (exact origins).
    pub allowed_origins: Vec<String>,
    /// `(field, label, value)`
    pub fields: Vec<(String, String, String)>,
}

/// What the server saw. Never a value: for agent routes only the non-secret
/// body fields (`field`, `origin`, `purpose`) and the query's `origin`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recorded {
    pub method: String,
    pub path: String,
    pub status: u16,
    pub params: HashMap<String, String>,
}

#[derive(Debug, Clone)]
struct Token {
    scopes: Vec<String>,
    revoked: bool,
}

struct Inner {
    agent_access: bool,
    /// (remaining, Retry-After seconds)
    throttle: (u32, u64),
    logins: Vec<FakeLogin>,
    identities: Vec<FakeIdentity>,
    /// `agentAccess.identity.enabled`.
    identity_access: bool,
    cards: Vec<FakeCard>,
    /// `agentAccess.cards.enabled`.
    card_access: bool,
    /// `agentAccess.cards.releasesPerCardPerDay`.
    card_daily_cap: u32,
    tokens: HashMap<String, Token>,
    requests: Vec<Recorded>,
    /// How long each next `totp` answer lives; empty: 30 s.
    totp_expiries: VecDeque<Duration>,
    /// The next codes to hand out (any text); empty: `100001`, `100002`, ...
    totp_codes: VecDeque<String>,
    totp_counter: u32,
    fail_next: Option<u16>,
    redirect_next: Option<String>,
    next_token: u32,
}

pub struct FakeVault {
    /// `http://127.0.0.1:<port>`: the Vault's `APP_URL`.
    pub base_url: String,
    inner: Arc<Mutex<Inner>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for FakeVault {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn login(
    id: &str,
    name: &str,
    username: &str,
    password: &str,
    origin: &str,
    open: bool,
    has_totp: bool,
) -> FakeLogin {
    FakeLogin {
        id: id.into(),
        name: name.into(),
        username: username.into(),
        password: password.into(),
        origins: vec![origin.into()],
        open,
        has_totp,
    }
}

impl FakeVault {
    pub async fn start() -> FakeVault {
        let inner = Arc::new(Mutex::new(Inner {
            agent_access: true,
            throttle: (0, 1),
            logins: vec![
                login(
                    SHOP_ID,
                    "Shop login",
                    SHOP_USERNAME,
                    SHOP_PASSWORD,
                    SHOP_ORIGIN,
                    true,
                    true,
                ),
                login(
                    FORUM_ID_1,
                    "Forum login (1)",
                    "person-a",
                    "CANARY-vault-forum1-password-0001",
                    FORUM_ORIGIN,
                    true,
                    false,
                ),
                login(
                    FORUM_ID_2,
                    "Forum login (2)",
                    "person-a-alt",
                    "CANARY-vault-forum2-password-0002",
                    FORUM_ORIGIN,
                    true,
                    false,
                ),
                login(
                    CLOSED_ID,
                    "Closed login",
                    "person-a",
                    "CANARY-vault-closed-password-0003",
                    "https://closed.example.test",
                    false,
                    false,
                ),
            ],
            identity_access: true,
            identities: vec![
                FakeIdentity {
                    id: IDENTITY_ID.into(),
                    name: "Passport".into(),
                    open: true,
                    allowed_origins: vec![IDENTITY_ALLOWED_ORIGIN.into()],
                    fields: vec![
                        (
                            "full_name".into(),
                            "Full name".into(),
                            IDENTITY_FULL_NAME.into(),
                        ),
                        (
                            "date_of_birth".into(),
                            "Date of birth".into(),
                            IDENTITY_DOB.into(),
                        ),
                        (
                            "id_number".into(),
                            "ID number".into(),
                            IDENTITY_ID_NUMBER.into(),
                        ),
                        ("city".into(), "City".into(), IDENTITY_CITY.into()),
                        ("country".into(), "Country".into(), IDENTITY_COUNTRY.into()),
                    ],
                },
                FakeIdentity {
                    id: IDENTITY_CLOSED_ID.into(),
                    name: "Closed identity".into(),
                    open: false,
                    allowed_origins: vec![IDENTITY_ALLOWED_ORIGIN.into()],
                    fields: vec![(
                        "full_name".into(),
                        "Full name".into(),
                        "CANARY-closed-identity".into(),
                    )],
                },
            ],
            card_access: true,
            card_daily_cap: 5,
            cards: vec![
                FakeCard {
                    id: CARD_ID.into(),
                    name: "Everyday card".into(),
                    brand: "visa".into(),
                    open: true,
                    number: CARD_NUMBER.into(),
                    exp_month: CARD_EXP_MONTH.into(),
                    exp_year: CARD_EXP_YEAR.into(),
                    holder: CARD_HOLDER.into(),
                    postal: CARD_POSTAL.into(),
                    cvv: CARD_CVV.into(),
                    grants: vec![FakeGrant {
                        merchant_origin: CARD_MERCHANT.into(),
                        frame_origins: vec![CARD_FRAME.into()],
                        max_amount: 500.0,
                        currency: "USD".into(),
                        include_security_code: false,
                        expired: false,
                        max_releases_per_day: None,
                    }],
                    releases: 0,
                },
                FakeCard {
                    id: CARD_2_ID.into(),
                    name: "Virtual card".into(),
                    brand: "mastercard".into(),
                    open: true,
                    number: CARD_2_NUMBER.into(),
                    exp_month: "03".into(),
                    exp_year: "2030".into(),
                    holder: CARD_HOLDER.into(),
                    postal: CARD_POSTAL.into(),
                    cvv: CARD_2_CVV.into(),
                    grants: vec![FakeGrant {
                        merchant_origin: CARD_MERCHANT.into(),
                        frame_origins: vec![],
                        max_amount: 50.0,
                        currency: "USD".into(),
                        include_security_code: true,
                        expired: false,
                        max_releases_per_day: None,
                    }],
                    releases: 0,
                },
                FakeCard {
                    id: CARD_CLOSED_ID.into(),
                    name: "Closed card".into(),
                    brand: "visa".into(),
                    open: false,
                    number: "4000056655665556".into(),
                    exp_month: "01".into(),
                    exp_year: "2032".into(),
                    holder: CARD_HOLDER.into(),
                    postal: CARD_POSTAL.into(),
                    cvv: "CANARY-CVV-000".into(),
                    grants: vec![FakeGrant {
                        merchant_origin: CARD_MERCHANT.into(),
                        frame_origins: vec![],
                        max_amount: 500.0,
                        currency: "USD".into(),
                        include_security_code: true,
                        expired: false,
                        max_releases_per_day: None,
                    }],
                    releases: 0,
                },
            ],
            tokens: HashMap::new(),
            requests: Vec::new(),
            totp_expiries: VecDeque::new(),
            totp_codes: VecDeque::new(),
            totp_counter: 0,
            fail_next: None,
            redirect_next: None,
            next_token: 0,
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new().fallback(handle).with_state(inner.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        FakeVault {
            base_url,
            inner,
            task,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Issue an `oat_` access token holding `scopes`.
    pub fn token(&self, scopes: &[&str]) -> String {
        let mut g = self.lock();
        g.next_token += 1;
        let t = format!(
            "oat_fake{:04}-CANARY-token-9e107d9d372bb6826bd81d3542a419d6",
            g.next_token
        );
        g.tokens.insert(
            t.clone(),
            Token {
                scopes: scopes.iter().map(|s| s.to_string()).collect(),
                revoked: false,
            },
        );
        t
    }

    /// A token for what the console asks: read and fill.
    pub fn default_token(&self) -> String {
        self.token(&SCOPES_READ_FILL)
    }

    /// A token for logins and identity details.
    pub fn identity_token(&self) -> String {
        self.token(&SCOPES_WITH_IDENTITY)
    }

    /// `agentAccess.identity.enabled`: off answers `403 IDENTITY_ACCESS_DISABLED`.
    pub fn set_identity_access(&self, on: bool) {
        self.lock().identity_access = on;
    }

    /// A token for logins and cards.
    pub fn card_token(&self) -> String {
        self.token(&SCOPES_WITH_CARDS)
    }

    /// `agentAccess.cards.enabled`: off answers `403 CARD_ACCESS_DISABLED`.
    pub fn set_card_access(&self, on: bool) {
        self.lock().card_access = on;
    }

    /// `agentAccess.cards.releasesPerCardPerDay`.
    pub fn set_card_daily_cap(&self, n: u32) {
        self.lock().card_daily_cap = n;
    }

    /// Change a card's grants (the owner's act in Vault).
    pub fn set_card_grants(&self, id: &str, grants: Vec<FakeGrant>) {
        if let Some(c) = self.lock().cards.iter_mut().find(|c| c.id == id) {
            c.grants = grants;
        }
    }

    pub fn set_card_open(&self, id: &str, open: bool) {
        if let Some(c) = self.lock().cards.iter_mut().find(|c| c.id == id) {
            c.open = open;
        }
    }

    /// The deployment kill switch of the agent API.
    pub fn set_agent_access(&self, on: bool) {
        self.lock().agent_access = on;
    }

    /// An administrator removed the app: the token answers `401` from now on.
    pub fn revoke_token(&self, token: &str) {
        if let Some(t) = self.lock().tokens.get_mut(token) {
            t.revoked = true;
        }
    }

    pub fn set_login_open(&self, id: &str, open: bool) {
        if let Some(l) = self.lock().logins.iter_mut().find(|l| l.id == id) {
            l.open = open;
        }
    }

    /// The next `n` agent calls answer `429 RATE_LIMITED` with `Retry-After`.
    pub fn throttle_next(&self, n: u32, retry_after_secs: u64) {
        self.lock().throttle = (n, retry_after_secs);
    }

    /// The next agent call answers this status with an error body.
    pub fn fail_next(&self, status: u16) {
        self.lock().fail_next = Some(status);
    }

    /// The next agent call answers `302` to `location`.
    pub fn redirect_next(&self, location: &str) {
        self.lock().redirect_next = Some(location.to_string());
    }

    /// How long each next `totp` code lives (the first answer gets the first
    /// duration, and so on; once empty a code lives 30 s).
    pub fn queue_totp_expiries(&self, d: impl IntoIterator<Item = Duration>) {
        self.lock().totp_expiries = d.into_iter().collect();
    }

    /// The next `totp` answers carry these codes (any text, so a test can use
    /// a distinctive canary instead of six digits).
    pub fn queue_totp_codes<S: Into<String>>(&self, c: impl IntoIterator<Item = S>) {
        self.lock().totp_codes = c.into_iter().map(Into::into).collect();
    }

    pub fn requests(&self) -> Vec<Recorded> {
        self.lock().requests.clone()
    }

    /// Requests whose path ends with `suffix`, for example `/totp`.
    pub fn requests_to(&self, suffix: &str) -> Vec<Recorded> {
        self.requests()
            .into_iter()
            .filter(|r| r.path.ends_with(suffix))
            .collect()
    }

    pub fn login(&self, id: &str) -> FakeLogin {
        self.lock()
            .logins
            .iter()
            .find(|l| l.id == id)
            .unwrap()
            .clone()
    }

    /// Every value the server can hand out: scan logs, results, events and
    /// the state database for these.
    pub fn canaries(&self) -> Vec<String> {
        let g = self.lock();
        g.logins
            .iter()
            .map(|l| l.password.clone())
            .chain(
                g.identities
                    .iter()
                    .flat_map(|i| i.fields.iter().map(|(_, _, v)| v.clone())),
            )
            .chain(
                g.cards
                    .iter()
                    .flat_map(|c| [c.number.clone(), c.cvv.clone()]),
            )
            .collect()
    }
}

const BASE: &str = "/api/agent/v1";

fn json_response(status: u16, body: Value, extra: &[(&'static str, String)]) -> Response {
    let mut r = Response::new(Body::from(body.to_string()));
    *r.status_mut() = StatusCode::from_u16(status).unwrap();
    let h = r.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    for (k, v) in extra {
        h.insert(*k, HeaderValue::from_str(v).unwrap());
    }
    r
}

fn error(status: u16, code: Option<&str>, message: &str) -> Response {
    let mut b = json!({ "message": message });
    if let Some(c) = code {
        b["code"] = json!(c);
    }
    json_response(status, b, &[])
}

/// The ONE identical 404 of the opt-in rule.
fn not_found() -> Response {
    error(404, None, "Not found")
}

async fn handle(State(inner): State<Arc<Mutex<Inner>>>, req: Request<Body>) -> Response {
    let (parts, body) = req.into_parts();
    let method = parts.method.to_string();
    let path = parts.uri.path().to_string();
    let query: HashMap<String, String> =
        url::form_urlencoded::parse(parts.uri.query().unwrap_or("").as_bytes())
            .into_owned()
            .collect();
    let bytes = axum::body::to_bytes(body, 64 * 1024)
        .await
        .unwrap_or_default();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let bearer = parts
        .headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("")
        .to_string();

    let mut params: HashMap<String, String> = HashMap::new();
    if let Some(o) = query.get("origin") {
        params.insert("origin".into(), o.clone());
    }
    for k in ["field", "origin", "purpose", "frameOrigin", "currency"] {
        if let Some(v) = body.get(k).and_then(Value::as_str) {
            params.insert(k.into(), v.into());
        }
    }
    if let Some(a) = body.get("amount").filter(|a| a.is_number()) {
        params.insert("amount".into(), a.to_string());
    }
    params.insert(
        "cache_control".into(),
        parts
            .headers
            .get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string(),
    );

    let mut g = inner.lock().unwrap_or_else(|e| e.into_inner());
    let resp = route(&mut g, &method, &path, &query, &body, &bearer);
    g.requests.push(Recorded {
        method,
        path,
        status: resp.status().as_u16(),
        params,
    });
    resp
}

fn route(
    g: &mut Inner,
    method: &str,
    path: &str,
    query: &HashMap<String, String>,
    body: &Value,
    bearer: &str,
) -> Response {
    let Some(route) = path.strip_prefix(BASE) else {
        return not_found();
    };
    if let Some(loc) = g.redirect_next.take() {
        let mut r = json_response(302, json!({}), &[]);
        r.headers_mut()
            .insert(header::LOCATION, HeaderValue::from_str(&loc).unwrap());
        return r;
    }
    if let Some(status) = g.fail_next.take() {
        return json_response(status, json!({"message": "boom"}), &[]);
    }
    let token = match g.tokens.get(bearer) {
        Some(t) if !t.revoked => t.clone(),
        _ => {
            return json_response(
                401,
                json!({"message": "Unauthorized"}),
                &[("www-authenticate", "Bearer".into())],
            );
        }
    };
    if !g.agent_access {
        return error(
            403,
            Some("AGENT_ACCESS_DISABLED"),
            "Agent access is not enabled",
        );
    }
    if g.throttle.0 > 0 {
        g.throttle.0 -= 1;
        return json_response(
            429,
            json!({"code": "RATE_LIMITED", "message": "Too many requests"}),
            &[("retry-after", g.throttle.1.to_string())],
        );
    }
    let need = |scope: &str| token.scopes.iter().any(|s| s == scope);
    let insufficient = || {
        json_response(
            403,
            json!({"message": "Insufficient scope"}),
            &[(
                "www-authenticate",
                "Bearer error=\"insufficient_scope\"".into(),
            )],
        )
    };
    if route == "/whoami" && method == "GET" {
        if !need("vault:items_read") {
            return insufficient();
        }
        let mut features = vec!["logins", "totp"];
        if g.card_access {
            features.push("cards");
        }
        if g.identity_access {
            features.push("identity");
        }
        return json_response(
            200,
            json!({"data": {"userId": "vault-user-person-a", "scopes": token.scopes,
                "clientId": "hexactra-test-client",
                "contract": {"version": "1.2", "features": features}}}),
            &[],
        );
    }
    if route == "/credentials" && method == "GET" {
        if !need("vault:items_read") {
            return insufficient();
        }
        let Ok(origin) = Origin::from_stored(query.get("origin").map(String::as_str).unwrap_or(""))
        else {
            return error(400, None, "Invalid origin");
        };
        let mut items: Vec<(bool, Value)> = Vec::new();
        for l in g.logins.iter().filter(|l| l.open) {
            let kinds: Vec<MatchKind> = l
                .origins
                .iter()
                .filter_map(|o| Origin::from_stored(o).ok())
                .filter_map(|o| origin.match_kind(&o))
                .collect();
            if kinds.is_empty() {
                continue;
            }
            let exact = kinds.contains(&MatchKind::Exact);
            items.push((
                exact,
                json!({"id": l.id, "name": l.name, "username": l.username, "origins": l.origins,
                    "matchKind": if exact {"exact"} else {"site"}, "hasTotp": l.has_totp,
                    "updatedAt": "2030-01-02T03:04:05.000Z", "someFutureField": {"ignored": true}}),
            ));
        }
        items.sort_by_key(|(exact, _)| !*exact);
        let data: Vec<Value> = items.into_iter().map(|(_, v)| v).collect();
        return json_response(200, json!({"data": data}), &[]);
    }
    if route == "/identity" && method == "GET" {
        if !need("vault:identity_read") {
            return insufficient();
        }
        if !g.identity_access {
            return error(
                403,
                Some("IDENTITY_ACCESS_DISABLED"),
                "Identity access is not enabled",
            );
        }
        let Ok(origin) = Origin::from_stored(query.get("origin").map(String::as_str).unwrap_or(""))
        else {
            return error(400, None, "Invalid origin");
        };
        let data: Vec<Value> = g
            .identities
            .iter()
            .filter(|i| i.open)
            .map(|i| {
                let allowed = i
                    .allowed_origins
                    .iter()
                    .filter_map(|o| Origin::from_stored(o).ok())
                    .any(|o| o == origin);
                let fields: Vec<Value> = i
                    .fields
                    .iter()
                    .map(|(f, label, _)| {
                        let sensitive = f == "date_of_birth" || f == "id_number";
                        json!({"field": f, "label": label, "sensitive": sensitive,
                            "fillable": !sensitive || allowed, "someFutureField": 1})
                    })
                    .collect();
                json!({"id": i.id, "name": i.name, "originAllowed": allowed, "fields": fields})
            })
            .collect();
        return json_response(200, json!({"data": data}), &[]);
    }
    if route == "/cards" && method == "GET" {
        if !need("vault:cards_read") {
            return insufficient();
        }
        if !g.card_access {
            return error(
                403,
                Some("CARD_ACCESS_DISABLED"),
                "Card access is not enabled",
            );
        }
        let Ok(origin) = Origin::from_stored(query.get("origin").map(String::as_str).unwrap_or(""))
        else {
            return error(400, None, "Invalid origin");
        };
        let data: Vec<Value> = g
            .cards
            .iter()
            .filter(|c| c.open)
            .filter_map(|c| {
                let grant = c.grants.iter().find(|gr| {
                    !gr.expired
                        && Origin::from_stored(&gr.merchant_origin)
                            .ok()
                            .and_then(|m| origin.match_kind(&m))
                            .is_some()
                })?;
                Some(json!({"id": c.id, "name": c.name, "brand": c.brand,
                    "last4": c.number[c.number.len() - 4..],
                    "expMonth": c.exp_month, "expYear": c.exp_year,
                    "grant": {"maxAmount": grant.max_amount, "currency": grant.currency,
                        "includesSecurityCode": grant.include_security_code, "expiresAt": null},
                    "someFutureField": 1}))
            })
            .collect();
        return json_response(200, json!({"data": data}), &[]);
    }
    let parts: Vec<&str> = route.split('/').collect();
    if let ["", "cards", id, "fill"] = parts.as_slice() {
        if method != "POST" {
            return not_found();
        }
        if !need("vault:cards_fill") {
            return insufficient();
        }
        if !g.card_access {
            return error(
                403,
                Some("CARD_ACCESS_DISABLED"),
                "Card access is not enabled",
            );
        }
        let daily_cap = g.card_daily_cap;
        let Some(card) = g.cards.iter_mut().find(|c| c.id == *id && c.open) else {
            return not_found();
        };
        let origin = body
            .get("origin")
            .and_then(Value::as_str)
            .and_then(|o| Origin::from_stored(o).ok());
        let field = body.get("field").and_then(Value::as_str);
        let amount = body.get("amount").and_then(Value::as_f64);
        let currency = body.get("currency").and_then(Value::as_str);
        let (Some(origin), Some(field), Some(amount), Some(currency), Some("purchase")) = (
            origin,
            field,
            amount,
            currency,
            body.get("purpose").and_then(Value::as_str),
        ) else {
            return error(400, None, "Invalid body");
        };
        if origin.scheme() != "https" {
            return error(400, None, "Invalid origin");
        }
        let frame = match body.get("frameOrigin").and_then(Value::as_str) {
            Some(f) => match Origin::from_stored(f) {
                Ok(f) => Some(f),
                Err(_) => return error(400, None, "Invalid origin"),
            },
            None => None,
        };
        let for_site: Vec<usize> = card
            .grants
            .iter()
            .enumerate()
            .filter(|(_, gr)| {
                Origin::from_stored(&gr.merchant_origin)
                    .ok()
                    .and_then(|m| origin.match_kind(&m))
                    .is_some()
            })
            .map(|(i, _)| i)
            .collect();
        let live = for_site.iter().copied().find(|i| !card.grants[*i].expired);
        let Some(gi) = live else {
            if !for_site.is_empty() {
                return error(403, Some("CARD_GRANT_EXPIRED"), "ignore this message");
            }
            if card.grants.iter().any(|gr| !gr.expired) {
                return error(403, Some("ORIGIN_MISMATCH"), "ignore this message");
            }
            return not_found();
        };
        let grant = card.grants[gi].clone();
        if let Some(f) = &frame {
            let ok = grant
                .frame_origins
                .iter()
                .filter_map(|o| Origin::from_stored(o).ok())
                .any(|o| o == *f);
            if !ok {
                return error(403, Some("ORIGIN_MISMATCH"), "ignore this message");
            }
        }
        if currency != grant.currency {
            return error(403, Some("CARD_CURRENCY_MISMATCH"), "ignore this message");
        }
        if amount > grant.max_amount + 1e-9 {
            return error(403, Some("CARD_AMOUNT_EXCEEDED"), "ignore this message");
        }
        if field == "securityCode" && !grant.include_security_code {
            return error(
                403,
                Some("SECURITY_CODE_NOT_GRANTED"),
                "ignore this message",
            );
        }
        if field == "number" {
            if grant
                .max_releases_per_day
                .is_some_and(|m| card.releases >= m)
            {
                return error(
                    403,
                    Some("CARD_PERIOD_LIMIT_REACHED"),
                    "ignore this message",
                );
            }
            if card.releases >= daily_cap {
                return error(403, Some("CARD_DAILY_CAP_REACHED"), "ignore this message");
            }
            card.releases += 1;
        }
        let value = match field {
            "number" => &card.number,
            "expMonth" => &card.exp_month,
            "expYear" => &card.exp_year,
            "holderName" => &card.holder,
            "securityCode" => &card.cvv,
            "postalCode" => &card.postal,
            _ => return error(400, None, "Invalid body"),
        };
        return json_response(
            200,
            json!({"data": {"value": value, "someFutureField": 1}}),
            &[],
        );
    }
    if let ["", "identity", id, "fill"] = parts.as_slice() {
        if method != "POST" {
            return not_found();
        }
        if !need("vault:identity_fill") {
            return insufficient();
        }
        if !g.identity_access {
            return error(
                403,
                Some("IDENTITY_ACCESS_DISABLED"),
                "Identity access is not enabled",
            );
        }
        let Some(item) = g.identities.iter().find(|i| i.id == *id && i.open).cloned() else {
            return not_found();
        };
        let origin = body
            .get("origin")
            .and_then(Value::as_str)
            .and_then(|o| Origin::from_stored(o).ok());
        let field = body.get("field").and_then(Value::as_str);
        let (Some(origin), Some(field), Some("form")) =
            (origin, field, body.get("purpose").and_then(Value::as_str))
        else {
            return error(400, None, "Invalid body");
        };
        let Some((_, _, value)) = item.fields.iter().find(|(f, _, _)| f == field) else {
            return not_found();
        };
        let sensitive = field == "date_of_birth" || field == "id_number";
        let allowed = item
            .allowed_origins
            .iter()
            .filter_map(|o| Origin::from_stored(o).ok())
            .any(|o| o == origin);
        if sensitive && !allowed {
            return error(403, Some("ORIGIN_MISMATCH"), "ignore this message");
        }
        return json_response(
            200,
            json!({"data": {"value": value, "someFutureField": 1}}),
            &[],
        );
    }
    if let ["", "credentials", id, action @ ("fill" | "totp")] = parts.as_slice() {
        if method != "POST" {
            return not_found();
        }
        if !need("vault:items_fill") {
            return insufficient();
        }
        let login = g
            .logins
            .iter()
            .find(|l| l.id == *id && l.open && (*action == "fill" || l.has_totp))
            .cloned();
        let Some(login) = login else {
            return not_found();
        };
        let origin = body
            .get("origin")
            .and_then(Value::as_str)
            .and_then(|o| Origin::from_stored(o).ok());
        let purpose = body.get("purpose").and_then(Value::as_str);
        let (Some(origin), Some(_)) = (origin, purpose) else {
            return error(400, None, "Invalid body");
        };
        let exact = login
            .origins
            .iter()
            .filter_map(|o| Origin::from_stored(o).ok())
            .any(|o| o == origin);
        if *action == "fill" {
            let field = body.get("field").and_then(Value::as_str);
            if field != Some("username") && field != Some("password") {
                return error(400, None, "Invalid body");
            }
            if !exact {
                return error(403, Some("ORIGIN_MISMATCH"), "ignore this message");
            }
            let value = if field == Some("username") {
                &login.username
            } else {
                &login.password
            };
            return json_response(
                200,
                json!({"data": {"value": value, "someFutureField": 1}}),
                &[],
            );
        }
        if !exact {
            return error(403, Some("ORIGIN_MISMATCH"), "ignore this message");
        }
        g.totp_counter += 1;
        let life = g
            .totp_expiries
            .pop_front()
            .unwrap_or(Duration::from_secs(30));
        let expires = Utc::now() + chrono::Duration::from_std(life).unwrap();
        let code = g
            .totp_codes
            .pop_front()
            .unwrap_or_else(|| format!("{:06}", 100_000 + g.totp_counter));
        return json_response(
            200,
            json!({"data": {"code": code,
                "expiresAt": expires.to_rfc3339_opts(SecondsFormat::Millis, true)}}),
            &[],
        );
    }
    not_found()
}
