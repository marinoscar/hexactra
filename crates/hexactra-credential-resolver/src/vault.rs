//! The remote Vault provider (epic #579, issue #591): looks up the owner's
//! opened logins for the page on screen and releases a username, a password
//! or a one-time code through Vault's agent credential API.
//!
//! The wire shapes below mirror marinoscar/vault `docs/agent-credential-api.md`
//! (blob `ca2fec94`, **contract 1.2, beta**): `GET /whoami`, `GET
//! /credentials?origin=`, `POST /credentials/{id}/fill` and `POST
//! /credentials/{id}/totp` under `/api/agent/v1`. The contract package
//! `@marinoscar/vault-contract/agent` is deliberately not a dependency; a
//! response's unknown fields are ignored and nothing branches on `message`.
//!
//! The rules it holds (Vault's "Holding a value", issue #591):
//!
//! * TLS verification on, connect 3 s and total 10 s ([`crate::http::client`]),
//!   no cookie jar, no connection reuse, **no redirects** (a `3xx` is a
//!   failure: it would carry the bearer token to another host);
//! * no body or header is ever logged, and no error carries one: failures are
//!   a [`ProviderError`] chosen from the status and Vault's `code` only;
//! * nothing is cached; every call is a fresh request;
//! * the access token lives in this struct only: zeroized on drop, never in a
//!   `Debug`, never in the state database, and refused (`Unauthorized`) once
//!   its `expires_at` has passed;
//! * a value is parsed straight into a [`SecretValue`]; the response buffer
//!   is wiped.
//!
//! Error mapping (never on `message` text): `401` -> `Unauthorized`; `403
//! AGENT_ACCESS_DISABLED` -> `Disabled`; `403 ORIGIN_MISMATCH` ->
//! `OriginMismatch` (**never retried**); a `403` for a missing scope
//! (`WWW-Authenticate: ... insufficient_scope`) -> `Refused("insufficient_scope")`;
//! `404` -> `NotFound`; `429` -> `RateLimited` after waiting once if
//! `Retry-After` is short; a network failure, a timeout, a `3xx`, a `5xx` or
//! an answer that cannot be read -> `Unavailable`.

use std::fmt;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use hexactra_core::remote::{ItemKind, ItemSummary, MatchKind, SecretField, SecretPurpose};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, RETRY_AFTER, WWW_AUTHENTICATE};
use serde::Deserialize;
use serde_json::{json, Value};
use zeroize::{Zeroize, Zeroizing};

use crate::{
    CodeRequest, Origin, OwnerId, ProviderError, ReleaseRequest, SecretValue, SecretsProvider,
};

/// Where the agent API lives under Vault's `APP_URL`.
pub const AGENT_API_PATH: &str = "/api/agent/v1";
/// The id actions name.
pub const PROVIDER_ID: &str = "vault";
/// A `429` with a `Retry-After` up to this long is waited out once; a longer
/// one fails to the caller's fallback.
pub const MAX_RETRY_WAIT: Duration = Duration::from_secs(5);
/// A one-time code with fewer than this left is dropped and a fresh one is
/// fetched once the next period starts.
pub const MIN_CODE_LIFETIME: Duration = Duration::from_secs(5);
/// How long past a code's `expiresAt` the wait for the next period goes.
const NEXT_PERIOD_MARGIN: Duration = Duration::from_millis(250);
/// The longest the wait for the next period lasts.
const MAX_NEXT_PERIOD_WAIT: Duration = Duration::from_secs(6);
/// What a `429` without a usable `Retry-After` is reported as.
const DEFAULT_RETRY_AFTER: Duration = Duration::from_secs(30);
/// The longest response read: a lookup holds a few summaries.
const MAX_BODY: usize = 1024 * 1024;
/// The longest access token accepted.
const MAX_TOKEN: usize = 8192;

// ------------------------------------------------------------ wire shapes

#[derive(Deserialize)]
struct Envelope<T> {
    data: T,
}

/// One entry of `GET /credentials`.
#[derive(Deserialize)]
struct WireCredential {
    id: String,
    name: String,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    origins: Vec<String>,
    #[serde(rename = "matchKind")]
    match_kind: String,
    #[serde(default, rename = "hasTotp")]
    has_totp: bool,
    #[serde(default, rename = "updatedAt")]
    updated_at: Option<String>,
}

/// `POST .../fill`: the one secret field. No `Debug`.
#[derive(Deserialize)]
struct WireFill {
    value: String,
}

/// `POST .../totp`: the one secret field and when it stops working. No `Debug`.
#[derive(Deserialize)]
struct WireTotp {
    code: String,
    #[serde(rename = "expiresAt")]
    expires_at: String,
}

/// An error body: only Vault's machine `code` is read, never `message`.
#[derive(Deserialize)]
struct WireError {
    #[serde(default)]
    code: Option<String>,
}

// -------------------------------------------------------------- the provider

/// A Vault the owner connected, reached with a short-lived access token the
/// console minted. Built per registration; replaced (and the old token
/// wiped) when the console registers a fresh token.
pub struct VaultProvider {
    client: reqwest::Client,
    base: url::Url,
    token: Zeroizing<String>,
    expires_at: Option<DateTime<Utc>>,
}

impl fmt::Debug for VaultProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("VaultProvider")
            .field("base", &self.base.as_str())
            .field("token", &"[secret]")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

/// What one HTTP exchange came back with; the body is wiped on drop.
struct Reply {
    status: u16,
    headers: HeaderMap,
    body: Zeroizing<Vec<u8>>,
}

impl VaultProvider {
    /// `base_url` is the Vault's `APP_URL` (`https`, or `http` on loopback);
    /// `/api/agent/v1` is appended. `access_token` is the `oat_` token.
    pub fn new(
        base_url: &str,
        access_token: String,
        expires_at: Option<DateTime<Utc>>,
    ) -> Result<Self, String> {
        let token = Zeroizing::new(access_token);
        let base = crate::http::check_base_url(base_url)?;
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

    fn url(&self, segments: &[&str]) -> url::Url {
        let mut u = self.base.clone();
        let prefix = self.base.path().trim_end_matches('/').to_string();
        let mut path = format!("{prefix}{AGENT_API_PATH}");
        for s in segments {
            path.push('/');
            path.push_str(s);
        }
        u.set_path(&path);
        u
    }

    /// One request, with the `429` rule: wait once if `Retry-After` is short.
    async fn request(
        &self,
        post: bool,
        url: url::Url,
        body: Option<Value>,
    ) -> Result<Zeroizing<Vec<u8>>, ProviderError> {
        if self.expires_at.is_some_and(|t| t <= Utc::now()) {
            return Err(ProviderError::Unauthorized);
        }
        let mut waited = false;
        loop {
            let reply = self.send_once(post, url.clone(), body.as_ref()).await?;
            if reply.status == 429 && !waited {
                if let Some(d) = retry_after(&reply.headers).filter(|d| *d <= MAX_RETRY_WAIT) {
                    waited = true;
                    tokio::time::sleep(d).await;
                    continue;
                }
            }
            return interpret(reply);
        }
    }

    async fn send_once(
        &self,
        post: bool,
        url: url::Url,
        body: Option<&Value>,
    ) -> Result<Reply, ProviderError> {
        let mut auth = HeaderValue::from_str(&format!("Bearer {}", self.token.as_str()))
            .map_err(|_| ProviderError::Unavailable)?;
        auth.set_sensitive(true);
        let mut req = if post {
            self.client.post(url)
        } else {
            self.client.get(url)
        }
        .header(AUTHORIZATION, auth)
        .header(reqwest::header::ACCEPT, "application/json");
        if let Some(b) = body {
            req = req
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(b.to_string());
        }
        // A reqwest error can name the URL (an origin in a query): never
        // surface or log it, only that the call did not work.
        let mut resp = req.send().await.map_err(|_| ProviderError::Unavailable)?;
        let status = resp.status().as_u16();
        let headers = resp.headers().clone();
        let mut buf: Zeroizing<Vec<u8>> = Zeroizing::new(Vec::new());
        while let Some(chunk) = resp.chunk().await.map_err(|_| ProviderError::Unavailable)? {
            if buf.len() + chunk.len() > MAX_BODY {
                return Err(ProviderError::Unavailable);
            }
            buf.extend_from_slice(&chunk);
        }
        Ok(Reply {
            status,
            headers,
            body: buf,
        })
    }

    /// `POST .../totp` once.
    async fn fetch_code(
        &self,
        req: &CodeRequest,
    ) -> Result<(SecretValue, DateTime<Utc>), ProviderError> {
        let id = path_id(&req.item_id)?;
        let url = self.url(&["credentials", id, "totp"]);
        let body = json!({ "origin": req.origin.to_string(), "purpose": "mfa" });
        let bytes = self.request(true, url, Some(body)).await?;
        let wire: Envelope<WireTotp> =
            serde_json::from_slice(&bytes).map_err(|_| ProviderError::Unavailable)?;
        let expires_at = DateTime::parse_from_rfc3339(&wire.data.expires_at)
            .map_err(|_| ProviderError::Unavailable)?
            .with_timezone(&Utc);
        Ok((SecretValue::from_string(wire.data.code), expires_at))
    }
}

#[async_trait]
impl SecretsProvider for VaultProvider {
    fn id(&self) -> &str {
        PROVIDER_ID
    }

    async fn lookup(
        &self,
        _owner: &OwnerId,
        origin: &Origin,
        kind: ItemKind,
    ) -> Result<Vec<ItemSummary>, ProviderError> {
        if kind != ItemKind::Login {
            return Err(ProviderError::Refused("unsupported_kind".into()));
        }
        let mut url = self.url(&["credentials"]);
        url.query_pairs_mut()
            .append_pair("origin", &origin.to_string());
        let bytes = self.request(false, url, None).await?;
        let wire: Envelope<Vec<WireCredential>> =
            serde_json::from_slice(&bytes).map_err(|_| ProviderError::Unavailable)?;
        let mut items: Vec<ItemSummary> = wire
            .data
            .into_iter()
            .filter_map(|c| {
                // An enum value this build does not know is skipped, as the
                // contract's stability rules ask.
                let match_kind = match c.match_kind.as_str() {
                    "exact" => MatchKind::Exact,
                    "site" => MatchKind::Site,
                    _ => return None,
                };
                Some(ItemSummary {
                    id: c.id,
                    name: c.name,
                    username: c.username,
                    origins: c.origins,
                    match_kind,
                    has_code: c.has_totp,
                    updated_at: c
                        .updated_at
                        .and_then(|t| DateTime::parse_from_rfc3339(&t).ok())
                        .map(|t| t.with_timezone(&Utc)),
                })
            })
            .collect();
        // Exact matches first (stable: Vault's order within each kind).
        items.sort_by_key(|i| i.match_kind != MatchKind::Exact);
        Ok(items)
    }

    async fn release(&self, req: ReleaseRequest) -> Result<SecretValue, ProviderError> {
        let field = match req.field {
            SecretField::Username => "username",
            SecretField::Password => "password",
            _ => return Err(ProviderError::Refused("unsupported_field".into())),
        };
        let purpose = match req.purpose {
            SecretPurpose::Login => "login",
            SecretPurpose::Signup => "signup",
            SecretPurpose::PasswordChange => "password_change",
            SecretPurpose::Mfa => "mfa",
            // Vault's login purposes are the four above.
            _ => return Err(ProviderError::Refused("unsupported_purpose".into())),
        };
        let id = path_id(&req.item_id)?;
        let url = self.url(&["credentials", id, "fill"]);
        let body = json!({ "field": field, "origin": req.origin.to_string(), "purpose": purpose });
        let bytes = self.request(true, url, Some(body)).await?;
        let wire: Envelope<WireFill> =
            serde_json::from_slice(&bytes).map_err(|_| ProviderError::Unavailable)?;
        Ok(SecretValue::from_string(wire.data.value))
    }

    async fn one_time_code(
        &self,
        req: CodeRequest,
    ) -> Result<(SecretValue, DateTime<Utc>), ProviderError> {
        let (code, expires_at) = self.fetch_code(&req).await?;
        let left = (expires_at - Utc::now()).to_std().unwrap_or(Duration::ZERO);
        if left >= MIN_CODE_LIFETIME {
            return Ok((code, expires_at));
        }
        // Too little time to type it: drop (wipe) it, wait for the next
        // period and fetch again, once.
        drop(code);
        tokio::time::sleep((left + NEXT_PERIOD_MARGIN).min(MAX_NEXT_PERIOD_WAIT)).await;
        self.fetch_code(&req).await
    }
}

// ------------------------------------------------------------- error mapping

/// An item id as a path segment: Vault's ids are UUIDs. Anything else cannot
/// be an item, so it is the identical "no such item".
fn path_id(id: &str) -> Result<&str, ProviderError> {
    let ok = !id.is_empty()
        && id.len() <= 128
        && id != "."
        && id != ".."
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~'));
    if ok {
        Ok(id)
    } else {
        Err(ProviderError::NotFound)
    }
}

/// `Retry-After` in whole seconds (Vault sends seconds).
fn retry_after(h: &HeaderMap) -> Option<Duration> {
    h.get(RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
        .map(Duration::from_secs)
}

/// A Vault `code` as a short lower-case machine string, or `None` when it is
/// not one (a value that is not plain machine text is not repeated).
fn machine_code(code: &str) -> Option<String> {
    let ok = !code.is_empty()
        && code.len() <= 64
        && code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
    ok.then(|| code.to_ascii_lowercase())
}

/// Turn a reply into its body, or the [`ProviderError`] it stands for.
fn interpret(reply: Reply) -> Result<Zeroizing<Vec<u8>>, ProviderError> {
    let Reply {
        status,
        headers,
        mut body,
    } = reply;
    if (200..300).contains(&status) {
        return Ok(body);
    }
    let code = serde_json::from_slice::<WireError>(&body)
        .ok()
        .and_then(|e| e.code);
    body.zeroize();
    Err(map_error(
        status,
        code.as_deref(),
        headers
            .get(WWW_AUTHENTICATE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.contains("insufficient_scope")),
        retry_after(&headers),
    ))
}

/// The status/`code` table of the module docs. Pure, so a test can run every
/// row.
pub fn map_error(
    status: u16,
    code: Option<&str>,
    insufficient_scope: bool,
    retry_after: Option<Duration>,
) -> ProviderError {
    match status {
        401 => ProviderError::Unauthorized,
        403 => match code {
            Some("AGENT_ACCESS_DISABLED") => ProviderError::Disabled,
            Some("ORIGIN_MISMATCH") => ProviderError::OriginMismatch,
            _ if insufficient_scope => ProviderError::Refused("insufficient_scope".into()),
            Some(c) => {
                ProviderError::Refused(machine_code(c).unwrap_or_else(|| "forbidden".into()))
            }
            None => ProviderError::Refused("forbidden".into()),
        },
        404 => ProviderError::NotFound,
        429 => ProviderError::RateLimited {
            retry_after: retry_after.unwrap_or(DEFAULT_RETRY_AFTER),
        },
        400 => ProviderError::Refused("invalid_request".into()),
        409 => ProviderError::Refused("conflict".into()),
        // Redirects, server errors and anything this build does not expect
        // are "could not use the answer".
        s if (300..400).contains(&s) || s >= 500 => ProviderError::Unavailable,
        s => ProviderError::Refused(format!("http_{s}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake_vault::*;

    fn origin(u: &str) -> Origin {
        Origin::from_browser_url(u).unwrap()
    }

    fn owner() -> OwnerId {
        OwnerId::new("user-a").unwrap()
    }

    async fn setup() -> (FakeVault, VaultProvider, String) {
        let fake = FakeVault::start().await;
        let token = fake.default_token();
        let p = VaultProvider::new(&fake.base_url, token.clone(), None).unwrap();
        (fake, p, token)
    }

    fn release(item: &str, field: SecretField, o: &str) -> ReleaseRequest {
        ReleaseRequest {
            owner: owner(),
            item_id: item.into(),
            field,
            origin: origin(o),
            purpose: SecretPurpose::Login,
            run_id: Some("run-1".into()),
            client_label: Some("Console".into()),
        }
    }

    fn code_req(item: &str, o: &str) -> CodeRequest {
        CodeRequest {
            owner: owner(),
            item_id: item.into(),
            origin: origin(o),
            purpose: SecretPurpose::Mfa,
            run_id: None,
            client_label: None,
        }
    }

    fn text(v: &SecretValue) -> String {
        v.expose(|b| String::from_utf8(b.to_vec()).unwrap())
    }

    #[tokio::test]
    async fn lookup_lists_exact_matches_first_and_never_a_value() {
        let (fake, p, _) = setup().await;
        // The page is on the shop's origin: its login is the exact match and
        // comes first; the forum logins share the registrable domain (site
        // matches, listed for information).
        let items = p
            .lookup(
                &owner(),
                &origin("https://app.example.test/signin"),
                ItemKind::Login,
            )
            .await
            .unwrap();
        assert_eq!(items.len(), 3);
        assert!(items[1..].iter().all(|i| i.match_kind == MatchKind::Site));
        let i = &items[0];
        assert_eq!(
            (i.id.as_str(), i.name.as_str(), i.username.as_deref()),
            (SHOP_ID, "Shop login", Some(SHOP_USERNAME))
        );
        assert_eq!(i.match_kind, MatchKind::Exact);
        assert!(i.has_code);
        assert_eq!(i.origins, vec![SHOP_ORIGIN.to_string()]);
        assert!(i.updated_at.is_some());
        let shown = format!("{items:?}");
        for c in fake.canaries() {
            assert!(!shown.contains(&c));
        }
        // The request carried the origin the fabric read, a no-store header and no body.
        let r = &fake.requests()[0];
        assert_eq!(
            (r.method.as_str(), r.path.as_str()),
            ("GET", "/api/agent/v1/credentials")
        );
        assert_eq!(r.params["origin"], "https://app.example.test");
        assert_eq!(r.params["cache_control"], "no-store");

        // Two logins on one origin: both come back first, exact (a person
        // must choose); the shop's login follows as a site match.
        let items = p
            .lookup(
                &owner(),
                &origin("https://forum.example.test/"),
                ItemKind::Login,
            )
            .await
            .unwrap();
        assert_eq!(items.len(), 3);
        assert!(items[..2].iter().all(|i| i.match_kind == MatchKind::Exact));
        assert_eq!(items[2].match_kind, MatchKind::Site);

        // A sibling subdomain is a site match, listed, never exact; the
        // closed login is not listed at all.
        let items = p
            .lookup(
                &owner(),
                &origin("https://login.example.test/"),
                ItemKind::Login,
            )
            .await
            .unwrap();
        assert!(items.iter().all(|i| i.match_kind == MatchKind::Site));
        assert_eq!(items.len(), 3);
        assert!(!items.iter().any(|i| i.id == CLOSED_ID));

        // An origin Vault has nothing for is an empty list, not an error.
        assert!(p
            .lookup(
                &owner(),
                &origin("https://nothing.example.org/"),
                ItemKind::Login
            )
            .await
            .unwrap()
            .is_empty());
        // Cards and identity are not this provider's.
        assert_eq!(
            p.lookup(
                &owner(),
                &origin("https://app.example.test/"),
                ItemKind::Card
            )
            .await
            .err()
            .unwrap(),
            ProviderError::Refused("unsupported_kind".into())
        );
    }

    #[tokio::test]
    async fn fill_returns_one_field_bound_to_the_origin() {
        let (fake, p, _) = setup().await;
        let u = p
            .release(release(
                SHOP_ID,
                SecretField::Username,
                "https://app.example.test/x",
            ))
            .await
            .unwrap();
        assert_eq!(text(&u), SHOP_USERNAME);
        let pw = p
            .release(release(
                SHOP_ID,
                SecretField::Password,
                "https://app.example.test/",
            ))
            .await
            .unwrap();
        assert_eq!(text(&pw), SHOP_PASSWORD);
        // One field per call, with the field, origin and purpose Vault asks for.
        let fills = fake.requests_to("/fill");
        assert_eq!(fills.len(), 2);
        assert_eq!(fills[0].params["field"], "username");
        assert_eq!(fills[1].params["field"], "password");
        for f in &fills {
            assert_eq!(f.params["origin"], "https://app.example.test");
            assert_eq!(f.params["purpose"], "login");
            assert_eq!(f.method, "POST");
        }
        // Fields and purposes a login has no meaning for are refused locally.
        assert_eq!(
            p.release(release(
                SHOP_ID,
                SecretField::CardNumber,
                "https://app.example.test/"
            ))
            .await
            .err()
            .unwrap(),
            ProviderError::Refused("unsupported_field".into())
        );
        let mut purchase = release(SHOP_ID, SecretField::Password, "https://app.example.test/");
        purchase.purpose = SecretPurpose::Purchase;
        assert_eq!(
            p.release(purchase).await.err().unwrap(),
            ProviderError::Refused("unsupported_purpose".into())
        );
        assert_eq!(fake.requests_to("/fill").len(), 2);
    }

    #[tokio::test]
    async fn an_origin_mismatch_is_never_retried_and_a_site_match_is_not_fillable() {
        let (fake, p, _) = setup().await;
        // The shop login is for app.example.test; the page is a sibling.
        let e = p
            .release(release(
                SHOP_ID,
                SecretField::Password,
                "https://login.example.test/",
            ))
            .await
            .err()
            .unwrap();
        assert_eq!(e, ProviderError::OriginMismatch);
        assert_eq!(
            fake.requests_to("/fill").len(),
            1,
            "a mismatch must not be retried"
        );
        // Nor a code.
        let e = p
            .one_time_code(code_req(SHOP_ID, "https://evil.example.test/"))
            .await
            .err()
            .unwrap();
        assert_eq!(e, ProviderError::OriginMismatch);
        assert_eq!(fake.requests_to("/totp").len(), 1);
    }

    #[tokio::test]
    async fn the_code_is_fetched_with_its_expiry() {
        let (fake, p, _) = setup().await;
        let before = Utc::now();
        let (code, exp) = p
            .one_time_code(code_req(SHOP_ID, "https://app.example.test/"))
            .await
            .unwrap();
        assert_eq!(text(&code), "100001");
        assert!(exp > before + chrono::Duration::seconds(20));
        let r = &fake.requests_to("/totp")[0];
        assert_eq!(r.params["purpose"], "mfa");
        assert_eq!(r.params["origin"], "https://app.example.test");
        assert_eq!(fake.requests_to("/totp").len(), 1);
    }

    #[tokio::test]
    async fn a_code_about_to_expire_is_replaced_by_the_next_one() {
        let (fake, p, _) = setup().await;
        // First answer lives 1 s (< 5 s left); the next one a full period.
        fake.queue_totp_expiries([Duration::from_secs(1), Duration::from_secs(30)]);
        let started = std::time::Instant::now();
        let (code, exp) = p
            .one_time_code(code_req(SHOP_ID, "https://app.example.test/"))
            .await
            .unwrap();
        assert_eq!(text(&code), "100002", "the first code was not used");
        assert!(exp > Utc::now() + chrono::Duration::seconds(20));
        assert_eq!(fake.requests_to("/totp").len(), 2);
        // It waited for the next period instead of typing a dying code.
        assert!(
            started.elapsed() >= Duration::from_millis(1000),
            "{:?}",
            started.elapsed()
        );
        assert!(started.elapsed() < Duration::from_secs(5));

        // A code with exactly enough time left is used as is.
        fake.queue_totp_expiries([Duration::from_secs(10)]);
        let (code, _) = p
            .one_time_code(code_req(SHOP_ID, "https://app.example.test/"))
            .await
            .unwrap();
        assert_eq!(text(&code), "100003");
        assert_eq!(fake.requests_to("/totp").len(), 3);
    }

    #[tokio::test]
    async fn the_identical_not_found() {
        let (_fake, p, _) = setup().await;
        // Closed, missing and a login without an authenticator: one answer.
        for id in [
            CLOSED_ID,
            "7f1c2e9a-0000-4000-8000-0000000000ff",
            "../etc/passwd",
            "",
        ] {
            let e = p
                .release(release(
                    id,
                    SecretField::Password,
                    "https://app.example.test/",
                ))
                .await
                .err()
                .unwrap();
            assert_eq!(e, ProviderError::NotFound, "{id}");
        }
        let e = p
            .one_time_code(code_req(FORUM_ID_1, "https://forum.example.test/"))
            .await
            .err()
            .unwrap();
        assert_eq!(e, ProviderError::NotFound);
    }

    #[tokio::test]
    async fn the_kill_switch_a_revoked_token_and_a_missing_scope() {
        let (fake, p, token) = setup().await;
        let o = origin("https://app.example.test/");

        fake.set_agent_access(false);
        for e in [
            p.lookup(&owner(), &o, ItemKind::Login).await.err().unwrap(),
            p.release(release(
                SHOP_ID,
                SecretField::Password,
                "https://app.example.test/",
            ))
            .await
            .err()
            .unwrap(),
        ] {
            assert_eq!(e, ProviderError::Disabled);
        }
        fake.set_agent_access(true);

        // Read-only token: lookup works, fill is `Refused`.
        let read_only =
            VaultProvider::new(&fake.base_url, fake.token(&["vault:items_read"]), None).unwrap();
        assert!(read_only
            .lookup(&owner(), &o, ItemKind::Login)
            .await
            .is_ok());
        assert_eq!(
            read_only
                .release(release(
                    SHOP_ID,
                    SecretField::Password,
                    "https://app.example.test/"
                ))
                .await
                .err()
                .unwrap(),
            ProviderError::Refused("insufficient_scope".into())
        );

        fake.revoke_token(&token);
        assert_eq!(
            p.lookup(&owner(), &o, ItemKind::Login).await.err().unwrap(),
            ProviderError::Unauthorized
        );
        let unknown = VaultProvider::new(&fake.base_url, "oat_never-issued".into(), None).unwrap();
        assert_eq!(
            unknown
                .lookup(&owner(), &o, ItemKind::Login)
                .await
                .err()
                .unwrap(),
            ProviderError::Unauthorized
        );
    }

    #[tokio::test]
    async fn rate_limits_wait_once_when_short() {
        let (fake, p, _) = setup().await;
        let o = origin("https://app.example.test/");
        // One 429 with Retry-After 1: waited, then answered.
        fake.throttle_next(1, 1);
        let started = std::time::Instant::now();
        assert_eq!(
            p.lookup(&owner(), &o, ItemKind::Login).await.unwrap().len(),
            3
        );
        assert!(started.elapsed() >= Duration::from_millis(900));
        assert_eq!(fake.requests().len(), 2);

        // Two in a row: one wait only, then the error.
        fake.throttle_next(2, 1);
        let e = p.lookup(&owner(), &o, ItemKind::Login).await.err().unwrap();
        assert_eq!(
            e,
            ProviderError::RateLimited {
                retry_after: Duration::from_secs(1)
            }
        );
        assert_eq!(fake.requests().len(), 4);

        // A long Retry-After is not waited for.
        fake.throttle_next(1, 60);
        let started = std::time::Instant::now();
        let e = p.lookup(&owner(), &o, ItemKind::Login).await.err().unwrap();
        assert_eq!(
            e,
            ProviderError::RateLimited {
                retry_after: Duration::from_secs(60)
            }
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(fake.requests().len(), 5);
    }

    #[tokio::test]
    async fn network_failures_and_server_errors_are_unavailable() {
        let (fake, p, _) = setup().await;
        let o = origin("https://app.example.test/");
        for status in [500u16, 502, 503] {
            fake.fail_next(status);
            assert_eq!(
                p.lookup(&owner(), &o, ItemKind::Login).await.err().unwrap(),
                ProviderError::Unavailable,
                "{status}"
            );
        }
        // Nothing listens: Unavailable, not a panic and not a hang.
        let url = fake.base_url.clone();
        let token = fake.default_token();
        drop(fake);
        tokio::time::sleep(Duration::from_millis(50)).await;
        let gone = VaultProvider::new(&url, token, None).unwrap();
        assert_eq!(
            gone.lookup(&owner(), &o, ItemKind::Login)
                .await
                .err()
                .unwrap(),
            ProviderError::Unavailable
        );
    }

    #[tokio::test]
    async fn a_redirect_is_a_failure_and_is_not_followed() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        let (fake, p, _) = setup().await;
        let hits = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let elsewhere = listener.local_addr().unwrap();
        let h = hits.clone();
        tokio::spawn(async move {
            while listener.accept().await.is_ok() {
                h.fetch_add(1, Ordering::SeqCst);
            }
        });
        fake.redirect_next(&format!("http://{elsewhere}/steal"));
        let e = p
            .lookup(
                &owner(),
                &origin("https://app.example.test/"),
                ItemKind::Login,
            )
            .await
            .err()
            .unwrap();
        assert_eq!(e, ProviderError::Unavailable);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(hits.load(Ordering::SeqCst), 0, "the redirect was followed");
    }

    #[tokio::test]
    async fn an_expired_token_is_refused_without_a_call() {
        let fake = FakeVault::start().await;
        let p = VaultProvider::new(
            &fake.base_url,
            fake.default_token(),
            Some(Utc::now() - chrono::Duration::seconds(1)),
        )
        .unwrap();
        assert_eq!(
            p.lookup(
                &owner(),
                &origin("https://app.example.test/"),
                ItemKind::Login
            )
            .await
            .err()
            .unwrap(),
            ProviderError::Unauthorized
        );
        assert!(fake.requests().is_empty());
    }

    #[test]
    fn the_status_table() {
        let s = Duration::from_secs(7);
        let cases: Vec<(u16, Option<&str>, bool, ProviderError)> = vec![
            (401, None, false, ProviderError::Unauthorized),
            (
                401,
                Some("ORIGIN_MISMATCH"),
                false,
                ProviderError::Unauthorized,
            ),
            (
                403,
                Some("AGENT_ACCESS_DISABLED"),
                false,
                ProviderError::Disabled,
            ),
            (
                403,
                Some("ORIGIN_MISMATCH"),
                false,
                ProviderError::OriginMismatch,
            ),
            (
                403,
                None,
                true,
                ProviderError::Refused("insufficient_scope".into()),
            ),
            (
                403,
                Some("AGENT_CREDENTIAL_REQUIRED"),
                false,
                ProviderError::Refused("agent_credential_required".into()),
            ),
            (
                403,
                Some("not a machine code!"),
                false,
                ProviderError::Refused("forbidden".into()),
            ),
            (403, None, false, ProviderError::Refused("forbidden".into())),
            (404, None, false, ProviderError::NotFound),
            (
                429,
                Some("RATE_LIMITED"),
                false,
                ProviderError::RateLimited { retry_after: s },
            ),
            (
                400,
                None,
                false,
                ProviderError::Refused("invalid_request".into()),
            ),
            (409, None, false, ProviderError::Refused("conflict".into())),
            (302, None, false, ProviderError::Unavailable),
            (500, None, false, ProviderError::Unavailable),
            (503, None, false, ProviderError::Unavailable),
            (418, None, false, ProviderError::Refused("http_418".into())),
        ];
        for (status, code, scope, want) in cases {
            assert_eq!(
                map_error(status, code, scope, Some(s)),
                want,
                "{status} {code:?}"
            );
        }
        // Without a Retry-After a 429 is reported with a default.
        assert_eq!(
            map_error(429, None, false, None),
            ProviderError::RateLimited {
                retry_after: DEFAULT_RETRY_AFTER
            }
        );
        // The message never decides: a 403 with an Origin-mismatch-sounding
        // message and no code is a plain refusal (the helper takes no message).
        assert_eq!(
            interpret(Reply {
                status: 403,
                headers: HeaderMap::new(),
                body: Zeroizing::new(br#"{"message":"Origin mismatch"}"#.to_vec())
            })
            .err()
            .unwrap(),
            ProviderError::Refused("forbidden".into())
        );
    }

    #[test]
    fn the_token_and_base_url_are_checked_and_never_shown() {
        const TOKEN: &str = "oat_canary-token-5d41402abc4b2a76b9719d911017c592";
        let p = VaultProvider::new("https://vault.example.test", TOKEN.into(), None).unwrap();
        assert!(!format!("{p:?}").contains(TOKEN));
        assert!(format!("{p:?}").contains("[secret]"));
        let url = p.url(&["credentials", "abc", "fill"]);
        assert_eq!(
            url.as_str(),
            "https://vault.example.test/api/agent/v1/credentials/abc/fill"
        );
        // A Vault mounted under a path keeps it.
        let p =
            VaultProvider::new("https://vault.example.test/prefix/", TOKEN.into(), None).unwrap();
        assert_eq!(p.url(&["whoami"]).path(), "/prefix/api/agent/v1/whoami");

        for bad in [
            "http://vault.example.test",
            "https://u:p@vault.example.test",
            "ftp://x",
            "nope",
        ] {
            assert!(
                VaultProvider::new(bad, TOKEN.into(), None).is_err(),
                "{bad}"
            );
        }
        assert!(VaultProvider::new("http://127.0.0.1:9", TOKEN.into(), None).is_ok());
        for bad in ["", "has space", "line\nbreak", &"x".repeat(MAX_TOKEN + 1)] {
            assert!(VaultProvider::new("https://vault.example.test", bad.into(), None).is_err());
        }
        // No error text carries the token.
        let e = VaultProvider::new("nope", TOKEN.into(), None).unwrap_err();
        assert!(!e.contains(TOKEN));
    }

    #[tokio::test]
    async fn an_error_never_carries_the_token_or_a_value() {
        let (fake, p, token) = setup().await;
        let mut shown = Vec::new();
        shown.push(
            p.release(release(
                CLOSED_ID,
                SecretField::Password,
                "https://app.example.test/",
            ))
            .await
            .err()
            .unwrap(),
        );
        shown.push(
            p.release(release(
                SHOP_ID,
                SecretField::Password,
                "https://evil.example.test/",
            ))
            .await
            .err()
            .unwrap(),
        );
        fake.set_agent_access(false);
        shown.push(
            p.lookup(
                &owner(),
                &origin("https://app.example.test/"),
                ItemKind::Login,
            )
            .await
            .err()
            .unwrap(),
        );
        for e in shown {
            let s = format!("{e} {e:?}");
            assert!(!s.contains(&token) && !s.contains("example.test"), "{s}");
            for c in fake.canaries() {
                assert!(!s.contains(&c));
            }
        }
    }
}
