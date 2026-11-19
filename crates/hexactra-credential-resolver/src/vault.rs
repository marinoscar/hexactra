//! The remote Vault provider (epic #579, issue #591): looks up the owner's
//! opened logins for the page on screen and releases a username, a password
//! or a one-time code through Vault's agent credential API.
//!
//! The wire shapes below mirror marinoscar/vault `docs/agent-credential-api.md`
//! (blob `ca2fec94`, **contract 1.2, beta**, plus the `save_login` purpose of
//! **contract 1.3**): `GET /whoami`, `GET /credentials?origin=`, `POST
//! /credentials` (saving a login), `POST /credentials/{id}/fill` and `POST
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
use hexactra_core::remote::{
    CardGrantSummary, CardSummary, FieldSummary, ItemKind, ItemSummary, MatchKind, SecretField,
    SecretPurpose,
};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, RETRY_AFTER, WWW_AUTHENTICATE};
use serde::Deserialize;
use serde_json::{json, Value};
use zeroize::{Zeroize, Zeroizing};

use crate::{
    CodeRequest, NewLogin, Origin, OwnerId, ProviderError, ReleaseRequest, SavedLogin, SecretValue,
    SecretsProvider,
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

/// One entry of `GET /identity` (contract 1.1): an opened identity item and,
/// per field, a label and two flags. Never a value.
#[derive(Deserialize)]
struct WireIdentity {
    id: String,
    name: String,
    #[serde(default, rename = "originAllowed")]
    origin_allowed: bool,
    #[serde(default)]
    fields: Vec<WireIdentityField>,
}

#[derive(Deserialize)]
struct WireIdentityField {
    field: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    sensitive: bool,
    #[serde(default)]
    fillable: bool,
}

/// One entry of `GET /cards` (contract 1.1): an opened card with a live
/// merchant grant for the asked merchant. Never a number or a code.
#[derive(Deserialize)]
struct WireCard {
    id: String,
    name: String,
    #[serde(default)]
    brand: Option<String>,
    #[serde(default)]
    last4: Option<String>,
    #[serde(default, rename = "expMonth")]
    exp_month: Option<String>,
    #[serde(default, rename = "expYear")]
    exp_year: Option<String>,
    grant: WireCardGrant,
}

#[derive(Deserialize)]
struct WireCardGrant {
    #[serde(rename = "maxAmount")]
    max_amount: f64,
    currency: String,
    #[serde(default, rename = "includesSecurityCode")]
    includes_security_code: bool,
    #[serde(default, rename = "expiresAt")]
    expires_at: Option<String>,
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

/// The body of `POST /credentials` for a saved login (contract 1.3). Borrows
/// everything; the password's bytes are the caller's.
#[derive(serde::Serialize)]
struct WireNewLogin<'a> {
    name: &'a str,
    username: &'a str,
    origin: &'a str,
    purpose: &'a str,
    password: &'a str,
}

/// `201 { data: { id, ... } }` of `POST /credentials`: only the id is read.
#[derive(Deserialize)]
struct WireCreated {
    id: String,
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
        let bytes = body.map(|b| Zeroizing::new(b.to_string().into_bytes()));
        self.request_bytes(post, url, bytes).await
    }

    /// [`Self::request`] with a body that is already bytes, wiped when the
    /// call is over (a body that carries a password is built this way).
    async fn request_bytes(
        &self,
        post: bool,
        url: url::Url,
        body: Option<Zeroizing<Vec<u8>>>,
    ) -> Result<Zeroizing<Vec<u8>>, ProviderError> {
        if self.expires_at.is_some_and(|t| t <= Utc::now()) {
            return Err(ProviderError::Unauthorized);
        }
        let mut waited = false;
        loop {
            let reply = self
                .send_once(post, url.clone(), body.as_ref().map(|b| b.as_slice()))
                .await?;
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
        body: Option<&[u8]>,
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
                .body(b.to_vec());
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

    /// `GET /identity` (E37.6): the owner's opened identity items with, per
    /// field, a label and whether it is sensitive and usable on this origin.
    /// Vault does not filter by origin here: an item is listed whatever the
    /// page, and `originAllowed` says whether this page is on its allowed list
    /// (`match_kind: exact`). A field this build does not know is skipped.
    async fn lookup_identity(&self, origin: &Origin) -> Result<Vec<ItemSummary>, ProviderError> {
        let mut url = self.url(&["identity"]);
        url.query_pairs_mut()
            .append_pair("origin", &origin.to_string());
        let bytes = self.request(false, url, None).await?;
        let wire: Envelope<Vec<WireIdentity>> =
            serde_json::from_slice(&bytes).map_err(|_| ProviderError::Unavailable)?;
        let mut items: Vec<ItemSummary> = wire
            .data
            .into_iter()
            .map(|i| ItemSummary {
                id: i.id,
                name: i.name,
                username: None,
                origins: Vec::new(),
                match_kind: if i.origin_allowed {
                    MatchKind::Exact
                } else {
                    MatchKind::Site
                },
                has_code: false,
                updated_at: None,
                fields: i
                    .fields
                    .into_iter()
                    .filter_map(|f| {
                        let key = identity_field(&f.field)?;
                        Some(FieldSummary {
                            key,
                            label: clean_label(&f.label, key),
                            sensitive: f.sensitive,
                            // Never usable beyond what Vault says: a sensitive
                            // field off the allowed list is not.
                            usable_here: f.fillable && (!f.sensitive || i.origin_allowed),
                        })
                    })
                    .collect(),
                card: None,
            })
            .collect();
        items.sort_by_key(|i| i.match_kind != MatchKind::Exact);
        Ok(items)
    }

    /// `POST /identity/{id}/fill`: one identity field, bound to the origin,
    /// purpose `form`. Vault enforces the allowed-origins list for a sensitive
    /// field (`403 ORIGIN_MISMATCH`).
    async fn release_identity(&self, req: ReleaseRequest) -> Result<SecretValue, ProviderError> {
        if req.purpose != SecretPurpose::Form {
            return Err(ProviderError::Refused("unsupported_purpose".into()));
        }
        let id = path_id(&req.item_id)?;
        let url = self.url(&["identity", id, "fill"]);
        let body = json!({ "field": req.field.as_str(), "origin": req.origin.to_string(), "purpose": "form" });
        let bytes = self.request(true, url, Some(body)).await?;
        let wire: Envelope<WireFill> =
            serde_json::from_slice(&bytes).map_err(|_| ProviderError::Unavailable)?;
        Ok(SecretValue::from_string(wire.data.value))
    }

    /// `GET /cards?origin=` (E37.7): the owner's opened cards that hold a live
    /// merchant grant for the page's merchant (matched by registrable domain on
    /// Vault's side). Never a number or a code. A brand, the last four digits
    /// and the expiry are cleaned to what they should be before they go on:
    /// a `last4` that is not at most four digits is dropped, so a provider
    /// bug can never put more of a number on the wire.
    async fn lookup_cards(&self, origin: &Origin) -> Result<Vec<ItemSummary>, ProviderError> {
        let mut url = self.url(&["cards"]);
        url.query_pairs_mut()
            .append_pair("origin", &origin.to_string());
        let bytes = self.request(false, url, None).await?;
        let wire: Envelope<Vec<WireCard>> =
            serde_json::from_slice(&bytes).map_err(|_| ProviderError::Unavailable)?;
        Ok(wire
            .data
            .into_iter()
            .map(|c| ItemSummary {
                id: c.id,
                name: clean_label(&c.name, SecretField::CardNumber),
                username: None,
                origins: Vec::new(),
                // The provider matched the merchant to a live grant.
                match_kind: MatchKind::Exact,
                has_code: false,
                updated_at: None,
                fields: Vec::new(),
                card: Some(CardSummary {
                    brand: c.brand.as_deref().and_then(clean_brand),
                    last4: c.last4.as_deref().and_then(|v| digits_up_to(v, 4)),
                    exp_month: c.exp_month.as_deref().and_then(|v| digits_up_to(v, 2)),
                    exp_year: c.exp_year.as_deref().and_then(|v| digits_up_to(v, 4)),
                    grant: Some(CardGrantSummary {
                        max_amount: format!("{:.2}", c.grant.max_amount),
                        currency: c.grant.currency.to_ascii_uppercase(),
                        includes_security_code: c.grant.includes_security_code,
                        expires_at: c
                            .grant
                            .expires_at
                            .and_then(|t| DateTime::parse_from_rfc3339(&t).ok())
                            .map(|t| t.with_timezone(&Utc)),
                    }),
                }),
            })
            .collect())
    }

    /// `POST /cards/{id}/fill` (E37.7): one card field, bound to the merchant's
    /// top-level origin, the embedded payment frame's origin when there is
    /// one, the purchase's amount and currency, purpose `purchase`. Vault
    /// checks the grant (merchant, frame, currency, amount, security code,
    /// period limit and daily cap) and answers a `403 CARD_*` code for each.
    async fn release_card(&self, req: ReleaseRequest) -> Result<SecretValue, ProviderError> {
        let Some(purchase) = req.purchase.as_ref() else {
            return Err(ProviderError::Refused("unsupported_purpose".into()));
        };
        if req.purpose != SecretPurpose::Purchase {
            return Err(ProviderError::Refused("unsupported_purpose".into()));
        }
        let field = match req.field {
            SecretField::CardNumber => "number",
            SecretField::ExpMonth => "expMonth",
            SecretField::ExpYear => "expYear",
            SecretField::HolderName => "holderName",
            SecretField::SecurityCode => "securityCode",
            SecretField::PostalCode => "postalCode",
            _ => return Err(ProviderError::Refused("unsupported_field".into())),
        };
        let amount: f64 = purchase
            .amount
            .parse()
            .map_err(|_| ProviderError::Refused("invalid_request".into()))?;
        let id = path_id(&req.item_id)?;
        let url = self.url(&["cards", id, "fill"]);
        let mut body = json!({
            "field": field,
            "origin": req.origin.to_string(),
            "amount": amount,
            "currency": purchase.currency,
            "purpose": "purchase",
        });
        if let Some(f) = &purchase.frame_origin {
            body["frameOrigin"] = json!(f.to_string());
        }
        let bytes = self.request(true, url, Some(body)).await?;
        let wire: Envelope<WireFill> =
            serde_json::from_slice(&bytes).map_err(|_| ProviderError::Unavailable)?;
        Ok(SecretValue::from_string(wire.data.value))
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
        match kind {
            ItemKind::Login => {}
            ItemKind::Identity => return self.lookup_identity(origin).await,
            ItemKind::Card => return self.lookup_cards(origin).await,
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
                    fields: Vec::new(),
                    card: None,
                })
            })
            .collect();
        // Exact matches first (stable: Vault's order within each kind).
        items.sort_by_key(|i| i.match_kind != MatchKind::Exact);
        Ok(items)
    }

    async fn release(&self, req: ReleaseRequest) -> Result<SecretValue, ProviderError> {
        if req.purchase.is_some() || req.purpose == SecretPurpose::Purchase {
            return self.release_card(req).await;
        }
        if is_identity_field(req.field) {
            return self.release_identity(req).await;
        }
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

    /// `POST /credentials` with `purpose: "save_login"` (contract 1.3, scope
    /// `vault:items_write`): the owner typed this login in by hand and it
    /// worked. The body is built straight into a buffer that is wiped when
    /// the call ends; a `409` (the name is taken) is [`ProviderError::NameTaken`],
    /// a Vault older than 1.3 answers `400` for the unknown purpose and that
    /// is a plain refusal (`invalid_request`).
    async fn save_login(&self, req: NewLogin) -> Result<SavedLogin, ProviderError> {
        let origin = req.origin.to_string();
        let body = req
            .password
            .expose(|pw| {
                let pw = std::str::from_utf8(pw).ok()?;
                let wire = WireNewLogin {
                    name: &req.name,
                    username: &req.username,
                    origin: &origin,
                    purpose: "save_login",
                    password: pw,
                };
                // Sized up front so the buffer never reallocates (a grown
                // buffer would leave an unwiped copy behind).
                let mut buf = Zeroizing::new(Vec::with_capacity(
                    pw.len() + req.name.len() + req.username.len() + origin.len() + 256,
                ));
                serde_json::to_writer(&mut *buf, &wire).ok()?;
                Some(buf)
            })
            .ok_or_else(|| ProviderError::Refused("invalid_request".into()))?;
        let url = self.url(&["credentials"]);
        let bytes = match self.request_bytes(true, url, Some(body)).await {
            Ok(b) => b,
            // 409 on a create is the name being taken.
            Err(ProviderError::Refused(c)) if c == "conflict" => {
                return Err(ProviderError::NameTaken)
            }
            Err(e) => return Err(e),
        };
        let wire: Envelope<WireCreated> =
            serde_json::from_slice(&bytes).map_err(|_| ProviderError::Unavailable)?;
        Ok(SavedLogin { id: wire.data.id })
    }
}

// ------------------------------------------------------------- identity fields

/// The fields of Vault's `Identity` type an agent may ask for
/// (`AGENT_IDENTITY_FIELDS`).
fn is_identity_field(f: SecretField) -> bool {
    matches!(
        f,
        SecretField::FullName
            | SecretField::DateOfBirth
            | SecretField::IdType
            | SecretField::IdNumber
            | SecretField::IdIssuingCountry
            | SecretField::AddressLine1
            | SecretField::AddressLine2
            | SecretField::City
            | SecretField::Region
            | SecretField::PostalCode
            | SecretField::Country
            | SecretField::Phone
            | SecretField::Email
    )
}

/// A wire field name as an identity field; `None` for anything else (a field
/// a later contract adds is skipped, as the stability rules ask).
fn identity_field(name: &str) -> Option<SecretField> {
    let f: SecretField = serde_json::from_value(Value::String(name.to_string())).ok()?;
    is_identity_field(f).then_some(f)
}

/// A label as the model may read it: one line, no control characters, at most
/// 80 characters; the field's own name when Vault sent nothing usable.
fn clean_label(label: &str, key: SecretField) -> String {
    let one_line: String = label
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let clipped: String = one_line.chars().take(80).collect();
    if clipped.is_empty() {
        key.as_str().replace('_', " ")
    } else {
        clipped
    }
}

/// A card brand as the model may read it: letters, digits, spaces and `-`,
/// at most 30 characters; `None` when nothing usable is left.
fn clean_brand(brand: &str) -> Option<String> {
    let cleaned: String = brand
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '-'))
        .take(30)
        .collect::<String>()
        .trim()
        .to_string();
    (!cleaned.is_empty()).then_some(cleaned)
}

/// `v` when it is one to `max` ASCII digits, else `None`. Guards the only
/// part of a number a lookup may carry (the last four digits) and the expiry.
fn digits_up_to(v: &str, max: usize) -> Option<String> {
    let t = v.trim();
    (!t.is_empty() && t.len() <= max && t.bytes().all(|b| b.is_ascii_digit()))
        .then(|| t.to_string())
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
            purchase: None,
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
        // A login's token holds no card scope: cards are refused for it.
        assert_eq!(
            p.lookup(
                &owner(),
                &origin("https://app.example.test/"),
                ItemKind::Card
            )
            .await
            .err()
            .unwrap(),
            ProviderError::Refused("insufficient_scope".into())
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

    fn form(item: &str, field: SecretField, o: &str) -> ReleaseRequest {
        ReleaseRequest {
            purpose: SecretPurpose::Form,
            ..release(item, field, o)
        }
    }

    #[tokio::test]
    async fn identity_lookup_lists_labels_and_flags_for_the_page_and_never_a_value() {
        let fake = FakeVault::start().await;
        let p = VaultProvider::new(&fake.base_url, fake.identity_token(), None).unwrap();
        // On the item's allowed origin every field is usable.
        let on = p
            .lookup(
                &owner(),
                &origin(IDENTITY_ALLOWED_ORIGIN),
                ItemKind::Identity,
            )
            .await
            .unwrap();
        // The closed item is not listed (Vault's opt-in).
        assert_eq!(on.len(), 1);
        let i = &on[0];
        assert_eq!((i.id.as_str(), i.name.as_str()), (IDENTITY_ID, "Passport"));
        assert_eq!(i.match_kind, MatchKind::Exact);
        assert!(i.username.is_none() && !i.has_code);
        assert_eq!(i.fields.len(), 5);
        assert!(i.fields.iter().all(|f| f.usable_here));
        // Elsewhere the sensitive ones are listed but not usable.
        let off = p
            .lookup(
                &owner(),
                &origin("https://other.example.test"),
                ItemKind::Identity,
            )
            .await
            .unwrap();
        assert_eq!(off[0].match_kind, MatchKind::Site);
        let f = |k: SecretField| off[0].fields.iter().find(|f| f.key == k).unwrap().clone();
        assert!(f(SecretField::DateOfBirth).sensitive && !f(SecretField::DateOfBirth).usable_here);
        assert!(f(SecretField::IdNumber).sensitive && !f(SecretField::IdNumber).usable_here);
        assert_eq!(f(SecretField::DateOfBirth).label, "Date of birth");
        assert!(!f(SecretField::FullName).sensitive && f(SecretField::FullName).usable_here);
        assert!(f(SecretField::City).usable_here);
        // Never a value, never a length.
        let json = serde_json::to_string(&(on, off)).unwrap();
        for canary in fake.canaries() {
            assert!(!json.contains(&canary));
        }
        // The lookup asked for the page's origin, as the logins' does.
        let seen = fake.requests_to("/identity");
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].params["origin"], IDENTITY_ALLOWED_ORIGIN);
        // Cards need their own scope (E37.7): this token has none.
        assert_eq!(
            p.lookup(&owner(), &origin(IDENTITY_ALLOWED_ORIGIN), ItemKind::Card)
                .await
                .err(),
            Some(ProviderError::Refused("insufficient_scope".into()))
        );
    }

    #[tokio::test]
    async fn identity_fill_is_one_field_bound_to_the_origin_and_the_form_purpose() {
        let fake = FakeVault::start().await;
        let p = VaultProvider::new(&fake.base_url, fake.identity_token(), None).unwrap();
        // Not sensitive: any origin.
        let v = p
            .release(form(
                IDENTITY_ID,
                SecretField::FullName,
                "https://other.example.test",
            ))
            .await
            .unwrap();
        assert_eq!(text(&v), IDENTITY_FULL_NAME);
        // Sensitive: the allowed exact origin.
        let v = p
            .release(form(
                IDENTITY_ID,
                SecretField::IdNumber,
                IDENTITY_ALLOWED_ORIGIN,
            ))
            .await
            .unwrap();
        assert_eq!(text(&v), IDENTITY_ID_NUMBER);
        // Elsewhere: refused, and never retried.
        let before = fake.requests_to("/fill").len();
        assert_eq!(
            p.release(form(
                IDENTITY_ID,
                SecretField::DateOfBirth,
                "https://other.example.test"
            ))
            .await
            .err(),
            Some(ProviderError::OriginMismatch)
        );
        assert_eq!(fake.requests_to("/fill").len(), before + 1);
        // An empty field and a closed item are the identical not found.
        for (id, field) in [
            (IDENTITY_ID, SecretField::Phone),
            (IDENTITY_CLOSED_ID, SecretField::FullName),
            ("not-an-item", SecretField::FullName),
        ] {
            assert_eq!(
                p.release(form(id, field, IDENTITY_ALLOWED_ORIGIN))
                    .await
                    .err(),
                Some(ProviderError::NotFound)
            );
        }
        // Identity is only released for the form purpose.
        assert_eq!(
            p.release(release(
                IDENTITY_ID,
                SecretField::City,
                IDENTITY_ALLOWED_ORIGIN
            ))
            .await
            .err(),
            Some(ProviderError::Refused("unsupported_purpose".into()))
        );
        // The request carried the field, the origin and the purpose, never a value.
        let r = &fake.requests_to("/fill")[0];
        assert_eq!(r.path, format!("/api/agent/v1/identity/{IDENTITY_ID}/fill"));
        assert_eq!(r.params["field"], "full_name");
        assert_eq!(r.params["purpose"], "form");
    }

    #[tokio::test]
    async fn identity_needs_its_scope_and_its_switch() {
        let fake = FakeVault::start().await;
        // The logins' token has no identity scope.
        let logins = VaultProvider::new(&fake.base_url, fake.default_token(), None).unwrap();
        assert_eq!(
            logins
                .lookup(
                    &owner(),
                    &origin(IDENTITY_ALLOWED_ORIGIN),
                    ItemKind::Identity
                )
                .await
                .err(),
            Some(ProviderError::Refused("insufficient_scope".into()))
        );
        assert_eq!(
            logins
                .release(form(
                    IDENTITY_ID,
                    SecretField::City,
                    IDENTITY_ALLOWED_ORIGIN
                ))
                .await
                .err(),
            Some(ProviderError::Refused("insufficient_scope".into()))
        );
        // The deployment's identity switch is off: its own code, not "the vault is off".
        let p = VaultProvider::new(&fake.base_url, fake.identity_token(), None).unwrap();
        fake.set_identity_access(false);
        assert_eq!(
            p.lookup(
                &owner(),
                &origin(IDENTITY_ALLOWED_ORIGIN),
                ItemKind::Identity
            )
            .await
            .err(),
            Some(ProviderError::Refused("identity_access_disabled".into()))
        );
        // Logins still work.
        assert!(p
            .lookup(&owner(), &origin(SHOP_ORIGIN), ItemKind::Login)
            .await
            .is_ok());
    }

    #[test]
    fn identity_fields_and_labels_are_cleaned() {
        assert_eq!(
            identity_field("date_of_birth"),
            Some(SecretField::DateOfBirth)
        );
        // Logins' and cards' fields, and anything unknown, are not identity fields.
        for f in ["password", "card_number", "nope", ""] {
            assert_eq!(identity_field(f), None, "{f}");
        }
        assert_eq!(
            clean_label("  Date \n of\tbirth ", SecretField::DateOfBirth),
            "Date of birth"
        );
        assert_eq!(clean_label("", SecretField::IdNumber), "id number");
        assert_eq!(clean_label("\u{7}\u{1b}", SecretField::City), "city");
        assert_eq!(clean_label(&"x".repeat(200), SecretField::City).len(), 80);
    }

    // ------------------------------------------------------------ cards (E37.7)

    fn pay(
        item: &str,
        field: SecretField,
        o: &str,
        amount: &str,
        frame: Option<&str>,
    ) -> ReleaseRequest {
        ReleaseRequest {
            purpose: SecretPurpose::Purchase,
            purchase: Some(crate::PurchaseContext {
                amount: amount.into(),
                currency: "USD".into(),
                frame_origin: frame.map(origin),
            }),
            ..release(item, field, o)
        }
    }

    #[tokio::test]
    async fn card_lookup_lists_only_opened_cards_with_a_grant_for_the_merchant() {
        let fake = FakeVault::start().await;
        let p = VaultProvider::new(&fake.base_url, fake.card_token(), None).unwrap();
        // A checkout on another subdomain of the merchant matches by site.
        let on = p
            .lookup(
                &owner(),
                &origin("https://checkout.shop.example.test"),
                ItemKind::Card,
            )
            .await
            .unwrap();
        // The closed card is not listed (Vault's opt-in).
        assert_eq!(on.len(), 2);
        let c = on.iter().find(|i| i.id == CARD_ID).unwrap();
        let card = c.card.as_ref().unwrap();
        assert_eq!(card.brand.as_deref(), Some("visa"));
        assert_eq!(card.last4.as_deref(), Some("4242"));
        assert_eq!(card.exp_month.as_deref(), Some(CARD_EXP_MONTH));
        let g = card.grant.as_ref().unwrap();
        assert_eq!(
            (g.max_amount.as_str(), g.currency.as_str()),
            ("500.00", "USD")
        );
        assert!(!g.includes_security_code);
        assert!(
            on.iter()
                .find(|i| i.id == CARD_2_ID)
                .unwrap()
                .card
                .as_ref()
                .unwrap()
                .grant
                .as_ref()
                .unwrap()
                .includes_security_code
        );
        // No grant for this merchant: nothing is listed.
        let none = p
            .lookup(
                &owner(),
                &origin("https://other-merchant.test"),
                ItemKind::Card,
            )
            .await
            .unwrap();
        assert!(none.is_empty());
        // Never a number, a security code or the rest of the number.
        let json = serde_json::to_string(&on).unwrap();
        for canary in fake.canaries() {
            assert!(!json.contains(&canary), "{canary}");
        }
        assert!(!json.contains("4242424242"));
        let seen = fake.requests_to("/cards");
        assert_eq!(
            seen[0].params["origin"],
            "https://checkout.shop.example.test"
        );
    }

    #[test]
    fn a_card_summary_carries_at_most_four_digits_of_a_number() {
        assert_eq!(digits_up_to("4242", 4).as_deref(), Some("4242"));
        for bad in ["4242424242424242", "42a2", "", " ", "12345"] {
            assert_eq!(digits_up_to(bad, 4), None, "{bad}");
        }
        assert_eq!(
            clean_brand("  visa<script> ").as_deref(),
            Some("visascript")
        );
        assert_eq!(clean_brand("\n\u{7}"), None);
    }

    #[tokio::test]
    async fn card_fill_is_one_field_with_the_merchant_frame_amount_and_currency() {
        let fake = FakeVault::start().await;
        let p = VaultProvider::new(&fake.base_url, fake.card_token(), None).unwrap();
        let v = p
            .release(pay(
                CARD_ID,
                SecretField::CardNumber,
                CARD_MERCHANT,
                "42.50",
                Some(CARD_FRAME),
            ))
            .await
            .unwrap();
        assert_eq!(text(&v), CARD_NUMBER);
        let r = fake.requests_to("/fill").pop().unwrap();
        assert_eq!(r.path, format!("/api/agent/v1/cards/{CARD_ID}/fill"));
        for (k, want) in [
            ("field", "number"),
            ("origin", CARD_MERCHANT),
            ("frameOrigin", CARD_FRAME),
            ("amount", "42.5"),
            ("currency", "USD"),
            ("purpose", "purchase"),
        ] {
            assert_eq!(r.params[k], want, "{k}");
        }
        // The other parts: names mapped to the contract's.
        for (f, want) in [
            (SecretField::ExpMonth, CARD_EXP_MONTH),
            (SecretField::ExpYear, CARD_EXP_YEAR),
            (SecretField::HolderName, CARD_HOLDER),
            (SecretField::PostalCode, CARD_POSTAL),
        ] {
            let v = p
                .release(pay(CARD_ID, f, CARD_MERCHANT, "10", None))
                .await
                .unwrap();
            assert_eq!(text(&v), want);
        }
        let last = fake.requests_to("/fill").pop().unwrap();
        assert_eq!(last.params["field"], "postalCode");
        assert!(!last.params.contains_key("frameOrigin"));
        // Not a card field, and not a purchase.
        assert_eq!(
            p.release(pay(
                CARD_ID,
                SecretField::Password,
                CARD_MERCHANT,
                "10",
                None
            ))
            .await
            .err(),
            Some(ProviderError::Refused("unsupported_field".into()))
        );
        assert_eq!(
            p.release(release(CARD_ID, SecretField::CardNumber, CARD_MERCHANT))
                .await
                .err(),
            Some(ProviderError::Refused("unsupported_field".into()))
        );
        let mut no_context = pay(CARD_ID, SecretField::CardNumber, CARD_MERCHANT, "10", None);
        no_context.purchase = None;
        assert_eq!(
            p.release(no_context).await.err(),
            Some(ProviderError::Refused("unsupported_purpose".into()))
        );
    }

    #[tokio::test]
    async fn card_fill_refusals_keep_their_codes() {
        let fake = FakeVault::start().await;
        let p = VaultProvider::new(&fake.base_url, fake.card_token(), None).unwrap();
        let refused = |r: Result<SecretValue, ProviderError>| r.err().unwrap();
        // Amount over the grant, wrong currency, security code not granted.
        assert_eq!(
            refused(
                p.release(pay(
                    CARD_ID,
                    SecretField::CardNumber,
                    CARD_MERCHANT,
                    "500.01",
                    None
                ))
                .await
            ),
            ProviderError::Refused("card_amount_exceeded".into())
        );
        let mut euro = pay(CARD_ID, SecretField::CardNumber, CARD_MERCHANT, "10", None);
        euro.purchase.as_mut().unwrap().currency = "EUR".into();
        assert_eq!(
            refused(p.release(euro).await),
            ProviderError::Refused("card_currency_mismatch".into())
        );
        assert_eq!(
            refused(
                p.release(pay(
                    CARD_ID,
                    SecretField::SecurityCode,
                    CARD_MERCHANT,
                    "10",
                    None
                ))
                .await
            ),
            ProviderError::Refused("security_code_not_granted".into())
        );
        // With the grant's flag the code is released.
        let v = p
            .release(pay(
                CARD_2_ID,
                SecretField::SecurityCode,
                CARD_MERCHANT,
                "10",
                None,
            ))
            .await
            .unwrap();
        assert_eq!(text(&v), CARD_2_CVV);
        // A wrong merchant (the card is granted elsewhere) and a wrong frame.
        assert_eq!(
            refused(
                p.release(pay(
                    CARD_ID,
                    SecretField::CardNumber,
                    "https://other-merchant.test",
                    "10",
                    None
                ))
                .await
            ),
            ProviderError::OriginMismatch
        );
        assert_eq!(
            refused(
                p.release(pay(
                    CARD_ID,
                    SecretField::CardNumber,
                    CARD_MERCHANT,
                    "10",
                    Some("https://evil.example.test")
                ))
                .await
            ),
            ProviderError::OriginMismatch
        );
        // A closed card and a missing one are the identical not found.
        for id in [
            CARD_CLOSED_ID,
            "7f1c2e9a-0000-4000-8000-0000000000ff",
            "not-a-card",
        ] {
            assert_eq!(
                refused(
                    p.release(pay(id, SecretField::CardNumber, CARD_MERCHANT, "10", None))
                        .await
                ),
                ProviderError::NotFound
            );
        }
        // An expired grant, the card's daily cap.
        fake.set_card_grants(
            CARD_2_ID,
            vec![FakeGrant {
                merchant_origin: CARD_MERCHANT.into(),
                frame_origins: vec![],
                max_amount: 50.0,
                currency: "USD".into(),
                include_security_code: true,
                expired: true,
                max_releases_per_day: None,
            }],
        );
        assert_eq!(
            refused(
                p.release(pay(
                    CARD_2_ID,
                    SecretField::CardNumber,
                    CARD_MERCHANT,
                    "10",
                    None
                ))
                .await
            ),
            ProviderError::Refused("card_grant_expired".into())
        );
        fake.set_card_daily_cap(1);
        p.release(pay(
            CARD_ID,
            SecretField::CardNumber,
            CARD_MERCHANT,
            "10",
            None,
        ))
        .await
        .unwrap();
        assert_eq!(
            refused(
                p.release(pay(
                    CARD_ID,
                    SecretField::CardNumber,
                    CARD_MERCHANT,
                    "10",
                    None
                ))
                .await
            ),
            ProviderError::Refused("card_daily_cap_reached".into())
        );
        // The codes the fabric reports.
        use hexactra_core::remote::provider_error_codes as c;
        for (e, code) in [
            ("card_amount_exceeded", c::AMOUNT_EXCEEDED),
            ("card_currency_mismatch", c::CURRENCY_MISMATCH),
            ("security_code_not_granted", c::SECURITY_CODE_NOT_GRANTED),
            ("card_grant_expired", c::GRANT_EXPIRED),
            ("card_period_limit_reached", c::LIMIT_REACHED),
            ("card_daily_cap_reached", c::LIMIT_REACHED),
            ("card_access_disabled", c::CARDS_DISABLED),
            ("something_else", c::REFUSED),
        ] {
            assert_eq!(ProviderError::Refused(e.into()).code(), code, "{e}");
        }
    }

    #[tokio::test]
    async fn cards_need_their_scope_and_their_switch() {
        let fake = FakeVault::start().await;
        let logins = VaultProvider::new(&fake.base_url, fake.default_token(), None).unwrap();
        assert_eq!(
            logins
                .lookup(&owner(), &origin(CARD_MERCHANT), ItemKind::Card)
                .await
                .err(),
            Some(ProviderError::Refused("insufficient_scope".into()))
        );
        assert_eq!(
            logins
                .release(pay(
                    CARD_ID,
                    SecretField::CardNumber,
                    CARD_MERCHANT,
                    "10",
                    None
                ))
                .await
                .err(),
            Some(ProviderError::Refused("insufficient_scope".into()))
        );
        let p = VaultProvider::new(&fake.base_url, fake.card_token(), None).unwrap();
        fake.set_card_access(false);
        assert_eq!(
            p.lookup(&owner(), &origin(CARD_MERCHANT), ItemKind::Card)
                .await
                .err(),
            Some(ProviderError::Refused("card_access_disabled".into()))
        );
        // Logins still work.
        assert!(p
            .lookup(&owner(), &origin(SHOP_ORIGIN), ItemKind::Login)
            .await
            .is_ok());
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

    fn new_login(name: &str, password: &str) -> NewLogin {
        NewLogin {
            owner: owner(),
            name: name.into(),
            username: "person-a@example.test".into(),
            origin: origin("https://signin.example.test"),
            password: SecretValue::from_string(password.into()),
            run_id: Some("run-1".into()),
            client_label: Some("Hexactra".into()),
        }
    }

    // Contract 1.3: the owner's own login, saved with purpose `save_login` and the typed password.
    #[tokio::test]
    async fn save_login_creates_the_login_with_the_purpose_and_the_typed_password() {
        let fake = FakeVault::start().await;
        let p = VaultProvider::new(&fake.base_url, fake.write_token(), None).unwrap();
        let saved = p
            .save_login(new_login("Example sign-in", "CANARY-save-pw-0001"))
            .await
            .unwrap();
        let in_vault = fake.login_named("Example sign-in").expect("created");
        assert_eq!(in_vault.id, saved.id);
        assert_eq!(in_vault.password, "CANARY-save-pw-0001");
        assert_eq!(in_vault.username, "person-a@example.test");
        assert_eq!(
            in_vault.origins,
            vec!["https://signin.example.test".to_string()]
        );
        // Opened to agents (as every create is): the next lookup for that page finds it, exactly.
        let items = p
            .lookup(
                &owner(),
                &origin("https://signin.example.test"),
                ItemKind::Login,
            )
            .await
            .unwrap();
        assert!(items
            .iter()
            .any(|i| i.id == saved.id && i.match_kind == MatchKind::Exact));
        let creates = fake.requests_to("/credentials");
        let post = creates.iter().find(|r| r.method == "POST").unwrap();
        assert_eq!(post.status, 201);
        assert_eq!(post.params["purpose"], "save_login");
        assert_eq!(post.params["origin"], "https://signin.example.test");
        assert_eq!(post.params["cache_control"], "no-store");
    }

    #[tokio::test]
    async fn a_taken_name_is_name_taken_and_a_missing_scope_is_a_refusal() {
        let fake = FakeVault::start().await;
        let p = VaultProvider::new(&fake.base_url, fake.write_token(), None).unwrap();
        // The seeded "Shop login" exists: a 409 with no code.
        assert_eq!(
            p.save_login(new_login("Shop login", "pw-1"))
                .await
                .unwrap_err(),
            ProviderError::NameTaken
        );
        assert_eq!(ProviderError::NameTaken.code(), "name_taken");
        // Another name works afterwards.
        assert!(p
            .save_login(new_login("Shop login 2", "pw-2"))
            .await
            .is_ok());

        // A grant without `vault:items_write`.
        let read_only = VaultProvider::new(&fake.base_url, fake.default_token(), None).unwrap();
        assert_eq!(
            read_only
                .save_login(new_login("Nope", "pw-3"))
                .await
                .unwrap_err(),
            ProviderError::Refused("insufficient_scope".into())
        );
        assert!(fake.login_named("Nope").is_none());
        // Kill switch, revoked token, expired registration.
        fake.set_agent_access(false);
        assert_eq!(
            p.save_login(new_login("Off", "pw-4")).await.unwrap_err(),
            ProviderError::Disabled
        );
        fake.set_agent_access(true);
        let t = fake.write_token();
        let revoked = VaultProvider::new(&fake.base_url, t.clone(), None).unwrap();
        fake.revoke_token(&t);
        assert_eq!(
            revoked
                .save_login(new_login("Gone", "pw-5"))
                .await
                .unwrap_err(),
            ProviderError::Unauthorized
        );
        let expired = VaultProvider::new(
            &fake.base_url,
            fake.write_token(),
            Some(Utc::now() - chrono::Duration::seconds(1)),
        )
        .unwrap();
        let before = fake.requests().len();
        assert_eq!(
            expired
                .save_login(new_login("Late", "pw-6"))
                .await
                .unwrap_err(),
            ProviderError::Unauthorized
        );
        assert_eq!(
            fake.requests().len(),
            before,
            "no call with an expired token"
        );
    }

    #[tokio::test]
    async fn a_vault_older_than_contract_1_3_refuses_the_purpose_and_the_default_provider_cannot_save(
    ) {
        // Vault 1.2 answers 400 for the unknown purpose: a plain refusal the console words.
        let fake = FakeVault::start().await;
        fake.fail_next(400);
        let p = VaultProvider::new(&fake.base_url, fake.write_token(), None).unwrap();
        assert_eq!(
            p.save_login(new_login("Old", "pw")).await.unwrap_err(),
            ProviderError::Refused("invalid_request".into())
        );
        // The trait's default: no provider saves unless it says so.
        struct Plain;
        #[async_trait]
        impl SecretsProvider for Plain {
            fn id(&self) -> &str {
                "plain"
            }
            async fn lookup(
                &self,
                _: &OwnerId,
                _: &Origin,
                _: ItemKind,
            ) -> Result<Vec<ItemSummary>, ProviderError> {
                Ok(vec![])
            }
            async fn release(&self, _: ReleaseRequest) -> Result<SecretValue, ProviderError> {
                Err(ProviderError::NotFound)
            }
            async fn one_time_code(
                &self,
                _: CodeRequest,
            ) -> Result<(SecretValue, DateTime<Utc>), ProviderError> {
                Err(ProviderError::NotFound)
            }
        }
        assert_eq!(
            Plain.save_login(new_login("x", "pw")).await.unwrap_err(),
            ProviderError::Unsupported
        );
        assert_eq!(ProviderError::Unsupported.code(), "unsupported");
    }

    #[tokio::test]
    async fn whoami_of_the_fake_speaks_contract_1_3() {
        // The fake is the conformance double of the guide: contract 1.3 lists `save_login` after `totp` and before `cards` and `identity`.
        let fake = FakeVault::start().await;
        let r = reqwest::Client::new()
            .get(format!("{}/api/agent/v1/whoami", fake.base_url))
            .bearer_auth(fake.default_token())
            .send()
            .await
            .unwrap();
        let v: Value = serde_json::from_slice(&r.bytes().await.unwrap()).unwrap();
        assert_eq!(v["data"]["contract"]["version"], "1.3");
        assert_eq!(
            v["data"]["contract"]["features"],
            json!(["logins", "totp", "save_login", "cards", "identity"])
        );
    }
}
