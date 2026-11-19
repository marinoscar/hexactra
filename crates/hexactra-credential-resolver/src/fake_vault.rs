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
        self.lock()
            .logins
            .iter()
            .map(|l| l.password.clone())
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
    for k in ["field", "origin", "purpose"] {
        if let Some(v) = body.get(k).and_then(Value::as_str) {
            params.insert(k.into(), v.into());
        }
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
        return json_response(
            200,
            json!({"data": {"userId": "vault-user-person-a", "scopes": token.scopes,
                "clientId": "hexactra-test-client",
                "contract": {"version": "1.2", "features": ["logins", "totp"]}}}),
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
    let parts: Vec<&str> = route.split('/').collect();
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
