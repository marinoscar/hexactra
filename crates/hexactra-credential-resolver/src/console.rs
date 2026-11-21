//! The console-hosted provider (epic #579, issue #594): the built-in secrets
//! store. It has no address of its own, so the fabric CALLS BACK into the
//! console's internal release route (`<base_url>/lookup`, `/release`, `/code`,
//! and `/save` for a login the owner typed by hand, #712,
//! see `console/docs/secrets.md`, "How the fabric reaches it"). What it
//! presents is the credential the console minted for this owner when it
//! registered the provider (`sct_...`), which is the registration's access
//! token: bound to one owner, short-lived, revoked by the console.
//!
//! The rules it holds are the same as the Vault provider's:
//!
//! * TLS verification on for `https`, connect 3 s and total 8 s
//!   ([`crate::http::client`]), no cookie jar, no connection reuse and **no
//!   redirects** (a redirect would carry the credential elsewhere);
//! * `http` is accepted only on a trusted private path (loopback, a private
//!   address, or a single-label / `.internal` / `.local` name such as the
//!   compose service `api`), see [`check_console_url`]: the route is for the
//!   private network and the public proxy answers 404 for it;
//! * no body or header is ever logged and no error carries one: a failure is a
//!   [`ProviderError`] chosen from the status and the `{ "code" }` of the
//!   answer, never from a message;
//! * the value is the raw response body, read straight into a [`SecretValue`]
//!   (its buffer is wiped on drop); the credential is zeroized on drop, never
//!   in `Debug`, and refused once its `expires_at` has passed.
//!
//! Limit: the response body passes through the HTTP client's buffers, which
//! this crate cannot wipe. The Vault provider has the same exposure on its path.

use std::fmt;
use std::net::IpAddr;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use hexactra_core::remote::{ItemKind, ItemSummary};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, RETRY_AFTER};
use serde::Deserialize;
use serde_json::{json, Value};
use zeroize::Zeroizing;

use crate::{
    CodeRequest, NewLogin, Origin, OwnerId, ProviderError, ReleaseRequest, SavedLogin, SecretValue,
    SecretsProvider,
};

/// The id actions name.
pub const PROVIDER_ID: &str = "builtin";
/// The longest credential accepted.
const MAX_TOKEN: usize = 512;
/// The most a response may carry (a field, a code or a short list).
const MAX_BODY: usize = 64 * 1024;

/// Whether the console's callback address is acceptable: `https`, or `http` on
/// a trusted private path. Unlike a Vault's address, the console's is on the
/// deployment's own network (`http://api:3000` on the compose network).
pub fn check_console_url(raw: &str) -> Result<url::Url, String> {
    let u = url::Url::parse(raw).map_err(|_| "base_url is not a URL".to_string())?;
    let host = u.host().ok_or("base_url has no host")?;
    if !u.username().is_empty() || u.password().is_some() {
        return Err("base_url must not carry credentials".into());
    }
    if u.query().is_some() || u.fragment().is_some() {
        return Err("base_url must not have a query or fragment".into());
    }
    match u.scheme() {
        "https" => Ok(u),
        "http" => {
            let private = match host {
                url::Host::Domain(d) => {
                    d == "localhost"
                        || !d.contains('.')
                        || d.ends_with(".internal")
                        || d.ends_with(".local")
                }
                url::Host::Ipv4(ip) => is_private(IpAddr::V4(ip)),
                url::Host::Ipv6(ip) => is_private(IpAddr::V6(ip)),
            };
            if private {
                Ok(u)
            } else {
                Err("base_url must be https (http only on a private network)".into())
            }
        }
        _ => Err("base_url must be https (http only on a private network)".into()),
    }
}

fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.is_loopback() || v.is_private() || v.is_link_local(),
        IpAddr::V6(v) => v.is_loopback() || (v.segments()[0] & 0xfe00) == 0xfc00,
    }
}

/// The built-in store, reached through the console.
pub struct ConsoleProvider {
    client: reqwest::Client,
    base: url::Url,
    token: Zeroizing<String>,
    expires_at: Option<DateTime<Utc>>,
}

impl fmt::Debug for ConsoleProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConsoleProvider")
            .field("base", &self.base.as_str())
            .field("token", &"[secret]")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

struct Reply {
    status: u16,
    headers: HeaderMap,
    body: Zeroizing<Vec<u8>>,
}

#[derive(Deserialize)]
struct WireError {
    code: Option<String>,
}

/// The body of `save` (#712): the owner typed this login in by hand and it
/// worked. Serialized straight into a wiped buffer.
#[derive(serde::Serialize)]
struct WireNewLogin<'a> {
    owner_id: &'a str,
    name: &'a str,
    username: &'a str,
    origin: &'a str,
    purpose: &'a str,
    password: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_label: Option<&'a str>,
}

/// `{ id }` of a saved login.
#[derive(Deserialize)]
struct WireSaved {
    id: String,
}

#[derive(Deserialize)]
struct WireItems {
    items: Vec<ItemSummary>,
}

impl ConsoleProvider {
    /// `base_url` is the console's callback address including the route prefix
    /// (`http://api:3000/api/internal/secrets-store/v1`); `access_token` is the
    /// owner's `sct_` credential.
    pub fn new(
        base_url: &str,
        access_token: String,
        expires_at: Option<DateTime<Utc>>,
    ) -> Result<Self, String> {
        let token = Zeroizing::new(access_token);
        let base = check_console_url(base_url)?;
        if token.is_empty()
            || token.len() > MAX_TOKEN
            || !token.bytes().all(|b| b.is_ascii_graphic())
        {
            return Err("access_token is empty, too long or not a bearer token".into());
        }
        let client = crate::http::client().map_err(|_| "could not build the HTTP client")?;
        Ok(Self {
            client,
            base,
            token,
            expires_at,
        })
    }

    fn url(&self, route: &str) -> url::Url {
        let mut u = self.base.clone();
        let path = format!("{}/{route}", self.base.path().trim_end_matches('/'));
        u.set_path(&path);
        u
    }

    async fn post(&self, route: &str, body: Value) -> Result<Reply, ProviderError> {
        self.post_bytes(route, Zeroizing::new(body.to_string().into_bytes()))
            .await
    }

    /// Sends a body already serialized into a buffer that is wiped when the
    /// call ends (a save carries the password: it never becomes a `Value`).
    async fn post_bytes(
        &self,
        route: &str,
        body: Zeroizing<Vec<u8>>,
    ) -> Result<Reply, ProviderError> {
        if self.expires_at.is_some_and(|t| t <= Utc::now()) {
            return Err(ProviderError::Unauthorized);
        }
        let mut auth = HeaderValue::from_str(&format!("Bearer {}", self.token.as_str()))
            .map_err(|_| ProviderError::Unavailable)?;
        auth.set_sensitive(true);
        // A reqwest error can name the URL: never surface or log it.
        let mut resp = self
            .client
            .post(self.url(route))
            .header(AUTHORIZATION, auth)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.to_vec())
            .send()
            .await
            .map_err(|_| ProviderError::Unavailable)?;
        let status = resp.status().as_u16();
        let headers = resp.headers().clone();
        let mut buf: Zeroizing<Vec<u8>> = Zeroizing::new(Vec::new());
        while let Some(chunk) = resp.chunk().await.map_err(|_| ProviderError::Unavailable)? {
            if buf.len() + chunk.len() > MAX_BODY {
                return Err(ProviderError::Unavailable);
            }
            buf.extend_from_slice(&chunk);
        }
        interpret(Reply {
            status,
            headers,
            body: buf,
        })
    }
}

/// The answer, or the error its status and `code` name. Never reads `message`.
fn interpret(reply: Reply) -> Result<Reply, ProviderError> {
    if (200..300).contains(&reply.status) {
        return Ok(reply);
    }
    let code = serde_json::from_slice::<WireError>(&reply.body)
        .ok()
        .and_then(|e| e.code);
    Err(match (reply.status, code.as_deref()) {
        (401, _) => ProviderError::Unauthorized,
        (404, _) => ProviderError::NotFound,
        (429, _) => ProviderError::RateLimited {
            retry_after: retry_after(&reply.headers).unwrap_or(Duration::from_secs(30)),
        },
        (_, Some("origin_mismatch")) => ProviderError::OriginMismatch,
        (_, Some("disabled")) => ProviderError::Disabled,
        (_, Some("not_found")) => ProviderError::NotFound,
        (_, Some("rate_limited")) => ProviderError::RateLimited {
            retry_after: retry_after(&reply.headers).unwrap_or(Duration::from_secs(30)),
        },
        (_, Some("unauthorized")) => ProviderError::Unauthorized,
        (400..=499, Some("refused")) => ProviderError::Refused("refused".into()),
        (422, Some("unsupported")) => ProviderError::Refused("unsupported".into()),
        (409, Some("name_taken")) => ProviderError::Refused("name_taken".into()),
        (400..=499, _) => ProviderError::Refused("refused".into()),
        _ => ProviderError::Unavailable,
    })
}

fn retry_after(h: &HeaderMap) -> Option<Duration> {
    h.get(RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
        .map(Duration::from_secs)
}

fn kind_name(kind: ItemKind) -> &'static str {
    match kind {
        ItemKind::Login => "login",
        ItemKind::Identity => "identity",
        ItemKind::Card => "card",
    }
}

fn wire_name<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

#[async_trait]
impl SecretsProvider for ConsoleProvider {
    fn id(&self) -> &str {
        PROVIDER_ID
    }

    async fn lookup(
        &self,
        owner: &OwnerId,
        origin: &Origin,
        kind: ItemKind,
    ) -> Result<Vec<ItemSummary>, ProviderError> {
        // The built-in store holds logins only (E37.5, E37.6): it has no cards.
        if kind == ItemKind::Card {
            return Ok(Vec::new());
        }
        let body = json!({ "owner_id": owner.as_str(), "origin": origin.to_string(), "kind": kind_name(kind) });
        let reply = self.post("lookup", body).await?;
        let wire: WireItems =
            serde_json::from_slice(&reply.body).map_err(|_| ProviderError::Unavailable)?;
        Ok(wire.items)
    }

    async fn release(&self, req: ReleaseRequest) -> Result<SecretValue, ProviderError> {
        if req.purchase.is_some() {
            return Err(ProviderError::Refused("unsupported".into()));
        }
        let body = json!({
            "owner_id": req.owner.as_str(),
            "item_id": req.item_id,
            "field": wire_name(&req.field),
            "origin": req.origin.to_string(),
            "purpose": wire_name(&req.purpose),
            "run_id": req.run_id,
            "client_label": req.client_label,
        });
        let reply = self.post("release", strip_nulls(body)).await?;
        // The body IS the value: take it as it is.
        Ok(SecretValue::new(reply.body.to_vec()))
    }

    async fn one_time_code(
        &self,
        req: CodeRequest,
    ) -> Result<(SecretValue, DateTime<Utc>), ProviderError> {
        let body = json!({
            "owner_id": req.owner.as_str(),
            "item_id": req.item_id,
            "origin": req.origin.to_string(),
            "purpose": wire_name(&req.purpose),
            "run_id": req.run_id,
            "client_label": req.client_label,
        });
        let reply = self.post("code", strip_nulls(body)).await?;
        let expires_at = reply
            .headers
            .get("x-expires-at")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.with_timezone(&Utc))
            .ok_or(ProviderError::Unavailable)?;
        Ok((SecretValue::new(reply.body.to_vec()), expires_at))
    }

    /// `save` (#712): the owner's sign-in typed by hand, saved in the built-in
    /// store, bound to the page's origin. `409 { code: "name_taken" }` is
    /// [`ProviderError::NameTaken`]. The password goes from the offer's copy
    /// into one wiped buffer and the request; it is never in a `Value`.
    async fn save_login(&self, req: NewLogin) -> Result<SavedLogin, ProviderError> {
        let origin = req.origin.to_string();
        let body = req
            .password
            .expose(|pw| {
                let pw = std::str::from_utf8(pw).ok()?;
                let wire = WireNewLogin {
                    owner_id: req.owner.as_str(),
                    name: &req.name,
                    username: &req.username,
                    origin: &origin,
                    purpose: "save_login",
                    password: pw,
                    run_id: req.run_id.as_deref(),
                    client_label: req.client_label.as_deref(),
                };
                // Sized up front so the buffer never reallocates (a grown
                // buffer would leave an unwiped copy behind).
                let mut buf = Zeroizing::new(Vec::with_capacity(
                    pw.len() + req.name.len() + req.username.len() + origin.len() + 512,
                ));
                serde_json::to_writer(&mut *buf, &wire).ok()?;
                Some(buf)
            })
            .ok_or_else(|| ProviderError::Refused("invalid_request".into()))?;
        let reply = match self.post_bytes("save", body).await {
            Ok(r) => r,
            Err(ProviderError::Refused(c)) if c == "name_taken" => {
                return Err(ProviderError::NameTaken)
            }
            Err(e) => return Err(e),
        };
        let wire: WireSaved =
            serde_json::from_slice(&reply.body).map_err(|_| ProviderError::Unavailable)?;
        Ok(SavedLogin { id: wire.id })
    }
}

/// The route's schema is strict: omit absent optional fields instead of sending `null`.
fn strip_nulls(mut v: Value) -> Value {
    if let Some(o) = v.as_object_mut() {
        o.retain(|_, x| !x.is_null());
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use axum::response::Response;
    use axum::routing::post;
    use axum::Router;
    use hexactra_core::remote::{SecretField, SecretPurpose};
    use std::sync::{Arc, Mutex};

    const TOKEN: &str = "sct_canary-token-5d41402abc4b2a76b9719d911017c592";
    const PASSWORD: &str = "CANARY-builtin-password-9e107d9d372bb682";

    type Seen = Arc<Mutex<Vec<(String, Option<String>, Value)>>>;

    async fn serve() -> (String, Seen) {
        let seen: Seen = Arc::default();
        let log = seen.clone();
        let app = Router::new().route(
            "/api/internal/secrets-store/v1/{route}",
            post(
                move |axum::extract::Path(route): axum::extract::Path<String>,
                      req: Request<Body>| {
                    let log = log.clone();
                    async move {
                        let auth = req
                            .headers()
                            .get(header::AUTHORIZATION)
                            .and_then(|v| v.to_str().ok())
                            .map(str::to_string);
                        let bytes = axum::body::to_bytes(req.into_body(), 1 << 16).await.unwrap();
                        let body: Value = serde_json::from_slice(&bytes).unwrap();
                        log.lock().unwrap().push((route.clone(), auth.clone(), body.clone()));
                        if auth.as_deref() != Some(&format!("Bearer {TOKEN}")) {
                            return reply(401, json!({"code": "unauthorized"}), &[]);
                        }
                        match (route.as_str(), body["item_id"].as_str()) {
                            ("lookup", _) => reply(
                                200,
                                json!({"items": [{"id": "i-1", "name": "Shop", "username": "person-a@example.test", "origins": ["https://shop.example.test"], "match_kind": "exact", "has_code": true, "updated_at": null}]}),
                                &[],
                            ),
                            (_, Some("missing")) => reply(404, json!({"code": "not_found"}), &[]),
                            (_, Some("limited")) => reply(429, json!({"code": "rate_limited"}), &[("retry-after", "7")]),
                            ("release", _) if body["origin"] != "https://shop.example.test" => {
                                reply(403, json!({"code": "origin_mismatch"}), &[])
                            }
                            ("release", _) => raw(PASSWORD, &[]),
                            ("code", _) => raw("123456", &[("x-expires-at", "2030-01-01T00:00:30Z")]),
                            ("save", _) if body["name"] == "Taken" => reply(409, json!({"code": "name_taken"}), &[]),
                            ("save", _) => reply(201, json!({"id": "saved-1"}), &[]),
                            _ => reply(500, json!({}), &[]),
                        }
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}/api/internal/secrets-store/v1"), seen)
    }

    fn reply(status: u16, body: Value, extra: &[(&str, &str)]) -> Response {
        let mut r = Response::builder()
            .status(StatusCode::from_u16(status).unwrap())
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::CACHE_CONTROL, "no-store");
        for (k, v) in extra {
            r = r.header(*k, *v);
        }
        r.body(Body::from(body.to_string())).unwrap()
    }

    fn raw(body: &str, extra: &[(&str, &str)]) -> Response {
        let mut r = Response::builder()
            .status(200)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header(header::CACHE_CONTROL, "no-store");
        for (k, v) in extra {
            r = r.header(*k, *v);
        }
        r.body(Body::from(body.to_string())).unwrap()
    }

    fn owner() -> OwnerId {
        OwnerId::new("user-a").unwrap()
    }
    fn origin(s: &str) -> Origin {
        Origin::from_browser_url(s).unwrap()
    }
    fn release(item: &str, page: &str) -> ReleaseRequest {
        ReleaseRequest {
            owner: owner(),
            item_id: item.into(),
            field: SecretField::Password,
            origin: origin(page),
            purpose: SecretPurpose::Login,
            run_id: Some("run-1".into()),
            client_label: None,
            purchase: None,
        }
    }

    #[test]
    fn the_address_is_https_or_a_private_http_path() {
        for ok in [
            "https://console.example.test/api/internal/secrets-store/v1",
            "http://api:3000/api/internal/secrets-store/v1",
            "http://127.0.0.1:3000/x",
            "http://localhost:3000/x",
            "http://10.1.2.3:3000/x",
            "http://api.internal/x",
        ] {
            assert!(check_console_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "http://console.example.test/x",
            "http://8.8.8.8/x",
            "ftp://api/x",
            "https://user:pw@console.example.test/x",
            "https://console.example.test/x?a=1",
            "not a url",
        ] {
            assert!(check_console_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_credential_is_never_in_debug() {
        let p = ConsoleProvider::new("http://api:3000/x", TOKEN.into(), None).unwrap();
        assert!(!format!("{p:?}").contains(TOKEN));
    }

    #[tokio::test]
    async fn looks_up_and_releases_one_field_with_the_owner_credential() {
        let (base, seen) = serve().await;
        let p = ConsoleProvider::new(&base, TOKEN.into(), None).unwrap();
        let items = p
            .lookup(
                &owner(),
                &origin("https://shop.example.test"),
                ItemKind::Login,
            )
            .await
            .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "i-1");
        let v = p
            .release(release("i-1", "https://shop.example.test"))
            .await
            .unwrap();
        assert_eq!(v.expose(|b| b.to_vec()), PASSWORD.as_bytes());
        let (code, expires) = p
            .one_time_code(CodeRequest {
                owner: owner(),
                item_id: "i-1".into(),
                origin: origin("https://shop.example.test"),
                purpose: SecretPurpose::Mfa,
                run_id: None,
                client_label: None,
            })
            .await
            .unwrap();
        assert_eq!(code.expose(|b| b.to_vec()), b"123456");
        assert_eq!(expires.to_rfc3339(), "2030-01-01T00:00:30+00:00");
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 3);
        assert!(seen
            .iter()
            .all(|(_, a, _)| a.as_deref() == Some(&*format!("Bearer {TOKEN}"))));
        let rel = &seen[1].2;
        assert_eq!(rel["owner_id"], "user-a");
        assert_eq!(rel["field"], "password");
        assert_eq!(rel["purpose"], "login");
        assert_eq!(rel["run_id"], "run-1");
        assert!(rel.get("client_label").is_none());
    }

    #[tokio::test]
    async fn maps_the_answers_to_the_contracts_errors() {
        let (base, _) = serve().await;
        let p = ConsoleProvider::new(&base, TOKEN.into(), None).unwrap();
        assert_eq!(
            p.release(release("i-1", "https://evil.example.test"))
                .await
                .err(),
            Some(ProviderError::OriginMismatch)
        );
        assert_eq!(
            p.release(release("missing", "https://shop.example.test"))
                .await
                .err(),
            Some(ProviderError::NotFound)
        );
        assert_eq!(
            p.release(release("limited", "https://shop.example.test"))
                .await
                .err(),
            Some(ProviderError::RateLimited {
                retry_after: Duration::from_secs(7)
            })
        );
        let wrong = ConsoleProvider::new(&base, "sct_other".into(), None).unwrap();
        assert_eq!(
            wrong
                .release(release("i-1", "https://shop.example.test"))
                .await
                .err(),
            Some(ProviderError::Unauthorized)
        );
    }

    #[tokio::test]
    async fn an_expired_credential_is_refused_without_a_request() {
        let (base, seen) = serve().await;
        let p = ConsoleProvider::new(
            &base,
            TOKEN.into(),
            Some(Utc::now() - chrono::Duration::seconds(1)),
        )
        .unwrap();
        assert_eq!(
            p.release(release("i-1", "https://shop.example.test"))
                .await
                .err(),
            Some(ProviderError::Unauthorized)
        );
        assert!(seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_unreachable_console_is_unavailable() {
        let p = ConsoleProvider::new(
            "http://127.0.0.1:1/api/internal/secrets-store/v1",
            TOKEN.into(),
            None,
        )
        .unwrap();
        assert_eq!(
            p.release(release("i-1", "https://shop.example.test"))
                .await
                .err(),
            Some(ProviderError::Unavailable)
        );
    }

    // #712: a login the owner typed by hand, saved in the built-in store through the callback.
    #[tokio::test]
    async fn saves_a_typed_login_with_its_origin_and_maps_a_taken_name() {
        let (base, seen) = serve().await;
        let p = ConsoleProvider::new(&base, TOKEN.into(), None).unwrap();
        let login = |name: &str| NewLogin {
            owner: owner(),
            name: name.into(),
            username: "person-a@example.test".into(),
            origin: origin("https://shop.example.test"),
            password: SecretValue::from_string("CANARY-save-pw-0002".into()),
            run_id: Some("r-1".into()),
            client_label: Some("Hexactra".into()),
        };
        let saved = p.save_login(login("Shop")).await.unwrap();
        assert_eq!(saved.id, "saved-1");
        let (route, _, body) = seen.lock().unwrap().last().cloned().unwrap();
        assert_eq!(route, "save");
        assert_eq!(body["origin"], "https://shop.example.test");
        assert_eq!(body["purpose"], "save_login");
        assert_eq!(body["password"], "CANARY-save-pw-0002");
        assert_eq!(body["owner_id"], owner().as_str());
        assert_eq!(
            p.save_login(login("Taken")).await.unwrap_err(),
            ProviderError::NameTaken
        );
        // The provider never shows the password in Debug.
        assert!(!format!("{p:?}").contains("CANARY"));
    }
}
