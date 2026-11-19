//! Secrets providers (epic #579, issue #590): the registry of an owner's
//! providers and the three actions that use them.
//!
//! * `secrets_lookup`: which items the owner's provider offers for the page.
//! * `type_from_provider`: one field of one item, typed into the page.
//! * `type_code_from_provider`: a one-time code, typed into the page.
//!
//! The control plane answers these itself. It reads the tab's top-level
//! origin from the extension (a `tabs` operation) at that moment, so the model
//! never names an origin, pins every later step to that tab, asks the provider
//! with that origin, re-reads the origin once more right before typing, and
//! only then queues a `type` (or `type_keys`) action with `sensitive: true`:
//! the existing redaction path hands the real text to the host and reports
//! `[secret]` everywhere else.
//!
//! A value lives in a [`SecretValue`] and then in the store's zeroizing
//! operation entry, nowhere else: never in a log line, span, event, operation
//! result or error message, never in the state database (the registry, like
//! the operations, is not persisted). Every path ends by dropping them.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use hexactra_core::remote::{
    provider_error_codes as code, ItemKind, OperationState, OperationView, ProviderTypedResult,
    RegisterSecretsProviderRequest, RemoteAction, SecretField, SecretPurpose, SecretsLookupResult,
    SecretsProviderKind, SecretsProviderView, ViewportPoint,
};
use hexactra_credential_resolver::{
    CodeRequest, Origin, OwnerId, ProviderError, ReleaseRequest, SecretValue, SecretsProvider,
};
use serde_json::{json, Value};
use tokio::time::Instant;
use uuid::Uuid;
use zeroize::Zeroize;

use super::api::ApiState;
use super::events::EventLog;
use super::store::{RuntimeStore, StoreError};

/// The failure code of a provider action whose time ran out.
const TIMED_OUT: &str = "timed_out";
/// Longest host error text copied into a failure (it never holds the value).
const MAX_HOST_ERROR: usize = 200;

// ---------------------------------------------------------------- registry

struct Registered {
    provider: Arc<dyn SecretsProvider>,
    kind: SecretsProviderKind,
    base_url: Option<String>,
    registered_at: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
}

/// Why a registration was refused.
#[derive(Debug, PartialEq, Eq)]
pub enum RegisterError {
    /// The request is not valid (HTTP 400).
    Invalid(String),
    /// The provider kind is not implemented here (HTTP 501).
    Unsupported(String),
}

/// What an action fails with: a code from
/// [`hexactra_core::remote::provider_error_codes`] and a message with no
/// value in it.
#[derive(Debug)]
struct Fail {
    code: &'static str,
    message: String,
}

impl Fail {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// The operation's `error`: `<code>: <message>`.
    fn text(&self) -> String {
        format!("{}: {}", self.code, self.message)
    }
}

fn provider_fail(e: ProviderError) -> Fail {
    Fail::new(e.code(), e.to_string())
}

fn store_fail(e: StoreError) -> Fail {
    let code = match &e {
        StoreError::TakeoverActive(_) => "takeover_active",
        StoreError::HandoffPending(_) => "handoff_pending",
        StoreError::NotFound(_) => "not_found",
        _ => "conflict",
    };
    Fail::new(code, e.to_string())
}

/// An owner's registered secrets providers, by owner and provider id. Memory
/// only: tokens are Secret Material and never reach the state database.
#[derive(Clone, Default)]
pub struct SecretsProviders {
    inner: Arc<Mutex<HashMap<(String, String), Registered>>>,
}

impl SecretsProviders {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<(String, String), Registered>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Register (or replace) the provider `provider_id` of `owner_id` from a
    /// client's request.
    pub fn register(
        &self,
        owner_id: &str,
        provider_id: &str,
        mut req: RegisterSecretsProviderRequest,
    ) -> Result<SecretsProviderView, RegisterError> {
        OwnerId::new(owner_id).map_err(RegisterError::Invalid)?;
        if !hexactra_core::remote::valid_provider_id(provider_id) {
            return Err(RegisterError::Invalid(
                "provider must be 1-64 characters: lowercase letters, digits, '-' and '_'".into(),
            ));
        }
        if req.access_token.as_deref().map(str::len).unwrap_or(0) > 8_192 {
            return Err(RegisterError::Invalid(
                "access_token longer than 8192 characters".into(),
            ));
        }
        if req.expires_at.is_some_and(|t| t <= Utc::now()) {
            return Err(RegisterError::Invalid("expires_at is in the past".into()));
        }
        if let Some(u) = &req.base_url {
            // A Vault's address must be https (http only on loopback); the
            // console's callback address is on the deployment's own network
            // and may be plain http on a private path (`http://api:3000`).
            let checked = if req.kind == SecretsProviderKind::Console {
                hexactra_credential_resolver::console::check_console_url(u)
            } else {
                hexactra_credential_resolver::http::check_base_url(u)
            };
            checked.map(|_| ()).map_err(RegisterError::Invalid)?;
        }
        let provider = build_provider(&req);
        // The provider now holds the token (zeroized on drop); wipe the
        // request's copy whatever the outcome.
        if let Some(t) = req.access_token.as_mut() {
            t.zeroize();
        }
        Ok(self.insert(owner_id, provider_id, provider?, &req))
    }

    /// Register a ready provider object (tests and embedders).
    pub fn register_provider(
        &self,
        owner_id: &str,
        provider_id: &str,
        provider: Arc<dyn SecretsProvider>,
        kind: SecretsProviderKind,
        expires_at: Option<DateTime<Utc>>,
    ) -> SecretsProviderView {
        self.insert(
            owner_id,
            provider_id,
            provider,
            &RegisterSecretsProviderRequest {
                kind,
                base_url: None,
                access_token: None,
                expires_at,
                settings: None,
            },
        )
    }

    fn insert(
        &self,
        owner_id: &str,
        provider_id: &str,
        provider: Arc<dyn SecretsProvider>,
        req: &RegisterSecretsProviderRequest,
    ) -> SecretsProviderView {
        let now = Utc::now();
        let reg = Registered {
            provider,
            kind: req.kind,
            base_url: req.base_url.clone(),
            registered_at: now,
            expires_at: req.expires_at,
        };
        let view = view_of(owner_id, provider_id, &reg);
        self.lock()
            .insert((owner_id.to_string(), provider_id.to_string()), reg);
        view
    }

    /// Drop a registration (and with it the provider's token). Whether there
    /// was one.
    pub fn remove(&self, owner_id: &str, provider_id: &str) -> bool {
        self.lock()
            .remove(&(owner_id.to_string(), provider_id.to_string()))
            .is_some()
    }

    /// An owner's live registrations, oldest first; expired ones are dropped.
    pub fn list(&self, owner_id: &str) -> Vec<SecretsProviderView> {
        let mut g = self.lock();
        let now = Utc::now();
        g.retain(|_, r| r.expires_at.is_none_or(|t| t > now));
        let mut v: Vec<_> = g
            .iter()
            .filter(|((o, _), _)| o == owner_id)
            .map(|((o, p), r)| view_of(o, p, r))
            .collect();
        v.sort_by_key(|x| (x.registered_at, x.provider.clone()));
        v
    }

    fn resolve(
        &self,
        owner: Option<&str>,
        wanted: Option<&str>,
    ) -> Result<(String, Arc<dyn SecretsProvider>), Fail> {
        let Some(owner) = owner else {
            return Err(Fail::new(
                code::NO_PROVIDER,
                "the session has no owner, so no secrets provider applies",
            ));
        };
        let mut g = self.lock();
        let now = Utc::now();
        g.retain(|_, r| r.expires_at.is_none_or(|t| t > now));
        let mut mine: Vec<(&String, &Registered)> = g
            .iter()
            .filter(|((o, _), _)| o == owner)
            .map(|((_, p), r)| (p, r))
            .collect();
        let chosen = match wanted {
            Some(w) => mine.iter().find(|(p, _)| p.as_str() == w).copied(),
            None if mine.len() > 1 => {
                return Err(Fail::new(
                    code::PROVIDER_REQUIRED,
                    "the owner has several secrets providers: name one",
                ))
            }
            None => mine.pop(),
        };
        chosen
            .map(|(p, r)| (p.clone(), r.provider.clone()))
            .ok_or_else(|| {
                Fail::new(
                    code::NO_PROVIDER,
                    "the owner has no such secrets provider registered (or its registration expired)",
                )
            })
    }
}

fn view_of(owner_id: &str, provider_id: &str, r: &Registered) -> SecretsProviderView {
    SecretsProviderView {
        owner_id: owner_id.to_string(),
        provider: provider_id.to_string(),
        kind: r.kind,
        base_url: r.base_url.clone(),
        registered_at: r.registered_at,
        expires_at: r.expires_at,
    }
}

/// Build the provider a registration names. `vault` is the remote Vault
/// (E37.2, #591): it needs the Vault's `APP_URL`, the short-lived `oat_`
/// access token the console minted and when that token stops working (the
/// registration is dropped then, and the token with it). `console` arrives
/// with E37.5.
fn build_provider(
    req: &RegisterSecretsProviderRequest,
) -> Result<Arc<dyn SecretsProvider>, RegisterError> {
    match req.kind {
        SecretsProviderKind::Test => {
            #[cfg(any(test, feature = "test-provider"))]
            {
                let p = hexactra_credential_resolver::test_provider::TestProvider::from_settings(
                    req.settings.as_ref(),
                )
                .map_err(RegisterError::Invalid)?;
                Ok(Arc::new(p))
            }
            #[cfg(not(any(test, feature = "test-provider")))]
            {
                Err(RegisterError::Unsupported(
                    "the test provider is not compiled into this build".into(),
                ))
            }
        }
        SecretsProviderKind::Vault => {
            let missing =
                |what: &str| RegisterError::Invalid(format!("a vault provider needs {what}"));
            let base_url = req.base_url.as_deref().ok_or_else(|| missing("base_url"))?;
            let token = req
                .access_token
                .clone()
                .ok_or_else(|| missing("access_token"))?;
            let expires_at = req.expires_at.ok_or_else(|| missing("expires_at"))?;
            let p =
                hexactra_credential_resolver::VaultProvider::new(base_url, token, Some(expires_at))
                    .map_err(RegisterError::Invalid)?;
            Ok(Arc::new(p))
        }
        SecretsProviderKind::Console => {
            let missing =
                |what: &str| RegisterError::Invalid(format!("a console provider needs {what}"));
            let base_url = req.base_url.as_deref().ok_or_else(|| missing("base_url"))?;
            let token = req
                .access_token
                .clone()
                .ok_or_else(|| missing("access_token"))?;
            let expires_at = req.expires_at.ok_or_else(|| missing("expires_at"))?;
            let p = hexactra_credential_resolver::ConsoleProvider::new(
                base_url,
                token,
                Some(expires_at),
            )
            .map_err(RegisterError::Invalid)?;
            Ok(Arc::new(p))
        }
    }
}

// ------------------------------------------------------------------ audit

/// What the audit event of one action says: who, which run, which provider,
/// item, field, origin and purpose, and how it ended. Never the value.
struct Audit {
    event: &'static str,
    owner_id: Option<String>,
    session_id: Uuid,
    op_id: Uuid,
    run_id: Option<String>,
    client_label: Option<String>,
    provider: Option<String>,
    item_id: Option<String>,
    field: Option<&'static str>,
    origin: Option<String>,
    purpose: Option<&'static str>,
    kind: Option<ItemKind>,
    count: Option<usize>,
    /// The provider handed a value over (it may still not have been typed).
    released: bool,
}

impl Audit {
    fn emit(&self, log: &EventLog, outcome: &str) {
        log.emit(
            self.event,
            json!({
                "owner_id": self.owner_id,
                "session_id": self.session_id,
                "op_id": self.op_id,
                "run_id": self.run_id,
                "client_label": self.client_label,
                "provider": self.provider,
                "item_id": self.item_id,
                "field": self.field,
                "origin": self.origin,
                "purpose": self.purpose,
                "kind": self.kind,
                "count": self.count,
                "released": self.released,
                "outcome": outcome,
            }),
        );
    }
}

// -------------------------------------------------------------- the actions

/// Where the value comes from.
enum Source {
    Field {
        field: SecretField,
        purpose: SecretPurpose,
    },
    Code,
}

/// Where it goes.
struct Target {
    selector: Option<String>,
    point: Option<ViewportPoint>,
    clear: bool,
    submit: bool,
}

struct Run {
    store: RuntimeStore,
    providers: SecretsProviders,
    session_id: Uuid,
    owner: Option<String>,
    deadline: Instant,
    audit: Audit,
}

fn clip(s: &str) -> String {
    s.chars().take(MAX_HOST_ERROR).collect()
}

/// A secret's bytes as the text a `type` action carries. The bytes are copied
/// once, straight into the string the store takes over and zeroizes; a value
/// that is not UTF-8 is wiped and refused.
fn secret_text(v: &SecretValue) -> Option<String> {
    v.expose(|b| match String::from_utf8(b.to_vec()) {
        Ok(s) => Some(s),
        Err(e) => {
            let mut bytes = e.into_bytes();
            bytes.zeroize();
            None
        }
    })
}

impl Run {
    fn remaining(&self) -> Result<Duration, Fail> {
        let left = self.deadline.saturating_duration_since(Instant::now());
        if left < Duration::from_millis(50) {
            return Err(Fail::new(TIMED_OUT, "the action ran out of time"));
        }
        Ok(left)
    }

    /// Queue an action on the session's host and wait for it.
    async fn op(
        &self,
        action: RemoteAction,
        fail_code: &'static str,
    ) -> Result<OperationView, Fail> {
        let left = self.remaining()?;
        let (view, rx) = self
            .store
            .enqueue_with(self.session_id, action, left, false)
            .map_err(store_fail)?;
        let done = self
            .store
            .wait_for(view.id, rx, left, true)
            .await
            .map_err(store_fail)?;
        match done.state {
            OperationState::Succeeded => Ok(done),
            OperationState::TimedOut => Err(Fail::new(
                TIMED_OUT,
                clip(
                    done.error
                        .as_deref()
                        .unwrap_or("the browser did not answer in time"),
                ),
            )),
            _ => Err(Fail::new(
                fail_code,
                clip(
                    done.error
                        .as_deref()
                        .unwrap_or("the browser could not do it"),
                ),
            )),
        }
    }

    /// The top-level origin of the tab the session acts on, as the browser
    /// reports it right now, and that tab's id. A `tab_id` pins the tab;
    /// otherwise it is the active tab of the focused window.
    async fn read_origin(&self, tab_id: Option<i64>) -> Result<(Origin, i64), Fail> {
        let done = self
            .op(RemoteAction::Tabs, code::ORIGIN_UNAVAILABLE)
            .await?;
        let tabs = done
            .result
            .as_ref()
            .and_then(|r| r.get("tabs"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        // The listing holds every tab's URL and title: it was read for one
        // origin, so it does not stay readable.
        self.store.discard_result(done.id);
        let id_of = |t: &Value| t.get("id").and_then(Value::as_i64);
        let tab = match tab_id {
            Some(want) => tabs.iter().find(|t| id_of(t) == Some(want)),
            None => {
                let active: Vec<&Value> = tabs
                    .iter()
                    .filter(|t| t.get("active").and_then(Value::as_bool) == Some(true))
                    .collect();
                let focused: Vec<&&Value> = active
                    .iter()
                    .filter(|t| t.get("last_focused").and_then(Value::as_bool) == Some(true))
                    .collect();
                match (focused.len(), active.len()) {
                    (1, _) => Some(*focused[0]),
                    (_, 1) => Some(active[0]),
                    (_, 0) => None,
                    _ => {
                        return Err(Fail::new(
                            code::ORIGIN_UNAVAILABLE,
                            "several windows have an active tab and none is known to be focused: name a tab_id",
                        ))
                    }
                }
            }
        }
        .ok_or_else(|| Fail::new(code::ORIGIN_UNAVAILABLE, "no such tab"))?;
        let id =
            id_of(tab).ok_or_else(|| Fail::new(code::ORIGIN_UNAVAILABLE, "the tab has no id"))?;
        let url = tab.get("url").and_then(Value::as_str).unwrap_or_default();
        // The URL is not echoed: it can carry tokens.
        let origin = Origin::from_browser_url(url).map_err(|e| {
            Fail::new(
                code::ORIGIN_UNAVAILABLE,
                format!("the page's origin cannot be used: {e}"),
            )
        })?;
        Ok((origin, id))
    }

    /// A target point must not land in a frame of another origin.
    async fn check_point(&self, tab: i64, p: ViewportPoint) -> Result<(), Fail> {
        // x and y are integers (validated), so nothing page-controlled is
        // spliced into the script.
        let script = format!(
            "(()=>{{const e=document.elementFromPoint({x},{y});if(!e)return {{found:false}};\
             const t=e.tagName;const f=t==='IFRAME'||t==='FRAME'||t==='OBJECT'||t==='EMBED';\
             let same=true;if(f){{try{{same=!!e.contentDocument&&e.contentDocument.location.origin===location.origin}}catch(_){{same=false}}}}\
             return {{found:true,frame:f,same_origin:same}}}})()",
            x = p.x,
            y = p.y
        );
        let done = self
            .op(
                RemoteAction::Evaluate {
                    script,
                    await_promise: false,
                    tab_id: Some(tab),
                },
                code::TYPING_FAILED,
            )
            .await?;
        let v = done
            .result
            .as_ref()
            .and_then(|r| r.get("value"))
            .cloned()
            .unwrap_or(Value::Null);
        self.store.discard_result(done.id);
        if v.get("found").and_then(Value::as_bool) != Some(true) {
            return Err(Fail::new(
                code::TYPING_FAILED,
                "there is no element at that point",
            ));
        }
        if v.get("frame").and_then(Value::as_bool) == Some(true)
            && v.get("same_origin").and_then(Value::as_bool) != Some(true)
        {
            return Err(Fail::new(
                code::CROSS_ORIGIN_FRAME,
                "the point is in a frame of another origin; values are not typed into it",
            ));
        }
        Ok(())
    }

    async fn lookup(
        &mut self,
        kind: ItemKind,
        provider: Option<String>,
        tab_id: Option<i64>,
    ) -> Result<Value, Fail> {
        let owner = self.owner.clone();
        let (pid, provider) = self
            .providers
            .resolve(owner.as_deref(), provider.as_deref())?;
        self.audit.provider = Some(pid.clone());
        let (origin, _tab) = self.read_origin(tab_id).await?;
        self.audit.origin = Some(origin.to_string());
        let owner_id =
            OwnerId::new(owner.unwrap_or_default()).map_err(|m| Fail::new(code::NO_PROVIDER, m))?;
        let left = self.remaining()?;
        let items = tokio::time::timeout(left, provider.lookup(&owner_id, &origin, kind))
            .await
            .map_err(|_| provider_fail(ProviderError::Unavailable))?
            .map_err(provider_fail)?;
        self.audit.count = Some(items.len());
        Ok(json!(SecretsLookupResult {
            origin: origin.to_string(),
            provider: pid,
            items,
        }))
    }

    #[allow(clippy::too_many_arguments)]
    async fn type_value(
        &mut self,
        item_id: String,
        source: Source,
        target: Target,
        provider: Option<String>,
        tab_id: Option<i64>,
    ) -> Result<Value, Fail> {
        let owner = self.owner.clone();
        let (pid, provider) = self
            .providers
            .resolve(owner.as_deref(), provider.as_deref())?;
        self.audit.provider = Some(pid);
        let owner_id =
            OwnerId::new(owner.unwrap_or_default()).map_err(|m| Fail::new(code::NO_PROVIDER, m))?;

        // 1. Where are we? Read the origin now, and pin the tab.
        let (origin, tab) = self.read_origin(tab_id).await?;
        self.audit.origin = Some(origin.to_string());
        if let Some(p) = target.point {
            self.check_point(tab, p).await?;
        }

        // 2. From here until typing ends no picture may be taken.
        let _no_pictures = self.store.secret_guard(self.session_id);

        // 3. Ask the provider, bound to that origin.
        let left = self.remaining()?;
        let (value, expires_at) = match &source {
            Source::Field { field, purpose } => {
                let req = ReleaseRequest {
                    owner: owner_id,
                    item_id,
                    field: *field,
                    origin: origin.clone(),
                    purpose: *purpose,
                    run_id: self.audit.run_id.clone(),
                    client_label: self.audit.client_label.clone(),
                };
                let v = tokio::time::timeout(left, provider.release(req))
                    .await
                    .map_err(|_| provider_fail(ProviderError::Unavailable))?
                    .map_err(provider_fail)?;
                (v, None)
            }
            Source::Code => {
                let req = CodeRequest {
                    owner: owner_id,
                    item_id,
                    origin: origin.clone(),
                    purpose: SecretPurpose::Mfa,
                    run_id: self.audit.run_id.clone(),
                    client_label: self.audit.client_label.clone(),
                };
                let (v, exp) = tokio::time::timeout(left, provider.one_time_code(req))
                    .await
                    .map_err(|_| provider_fail(ProviderError::Unavailable))?
                    .map_err(provider_fail)?;
                (v, Some(exp))
            }
        };
        self.audit.released = true;

        // 4. The page may have moved while the provider answered: read the
        //    origin again and type only if it is the one the value is for.
        let (again, _) = self.read_origin(Some(tab)).await?;
        if again != origin {
            return Err(Fail::new(
                code::ORIGIN_MISMATCH,
                "the page navigated while the value was fetched; nothing was typed",
            ));
        }

        // 5. Type it with trusted input; the store holds the text apart from
        //    the operation (which shows `[secret]`) and zeroizes it.
        self.type_into(&value, &target, tab).await?;
        drop(value);
        Ok(json!(ProviderTypedResult {
            typed: true,
            expires_at,
        }))
    }

    async fn type_into(&self, value: &SecretValue, target: &Target, tab: i64) -> Result<(), Fail> {
        let text = || {
            secret_text(value)
                .ok_or_else(|| Fail::new(code::TYPING_FAILED, "the value is not text"))
        };
        if let Some(selector) = &target.selector {
            self.op(
                RemoteAction::Type {
                    selector: selector.clone(),
                    text: text()?,
                    clear: target.clear,
                    submit: target.submit,
                    sensitive: true,
                    tab_id: Some(tab),
                },
                code::TYPING_FAILED,
            )
            .await?;
            return Ok(());
        }
        let Some(p) = target.point else {
            return Err(Fail::new(code::TYPING_FAILED, "no target"));
        };
        let tab_id = Some(tab);
        self.op(
            RemoteAction::ClickAt {
                x: p.x,
                y: p.y,
                button: Default::default(),
                click_count: None,
                modifiers: Vec::new(),
                tab_id,
            },
            code::TYPING_FAILED,
        )
        .await?;
        if target.clear {
            for (key, modifiers) in [("a", vec!["ctrl".to_string()]), ("Backspace", Vec::new())] {
                self.op(
                    RemoteAction::Key {
                        key: key.into(),
                        modifiers,
                        tab_id,
                    },
                    code::TYPING_FAILED,
                )
                .await?;
            }
        }
        self.op(
            RemoteAction::TypeKeys {
                text: text()?,
                sensitive: true,
                tab_id,
            },
            code::TYPING_FAILED,
        )
        .await?;
        if target.submit {
            self.op(
                RemoteAction::Key {
                    key: "Enter".into(),
                    modifiers: Vec::new(),
                    tab_id,
                },
                code::TYPING_FAILED,
            )
            .await?;
        }
        Ok(())
    }
}

/// Run one provider action to its end and report how it went.
async fn execute(mut run: Run, action: RemoteAction) -> (Run, Result<Value, Fail>) {
    let result = match action {
        RemoteAction::SecretsLookup {
            kind,
            provider,
            tab_id,
            ..
        } => run.lookup(kind, provider, tab_id).await,
        RemoteAction::TypeFromProvider {
            item_id,
            field,
            selector,
            point,
            purpose,
            clear,
            submit,
            provider,
            tab_id,
            ..
        } => {
            run.audit.item_id = Some(item_id.clone());
            run.audit.field = Some(field.as_str());
            run.audit.purpose = Some(purpose.as_str());
            run.type_value(
                item_id,
                Source::Field { field, purpose },
                Target {
                    selector,
                    point,
                    clear,
                    submit,
                },
                provider,
                tab_id,
            )
            .await
        }
        RemoteAction::TypeCodeFromProvider {
            item_id,
            selector,
            point,
            clear,
            submit,
            provider,
            tab_id,
            ..
        } => {
            run.audit.item_id = Some(item_id.clone());
            run.audit.field = Some("one_time_code");
            run.audit.purpose = Some(SecretPurpose::Mfa.as_str());
            run.type_value(
                item_id,
                Source::Code,
                Target {
                    selector,
                    point,
                    clear,
                    submit,
                },
                provider,
                tab_id,
            )
            .await
        }
        _ => Err(Fail::new("internal", "not a provider action")),
    };
    (run, result)
}

/// Start a provider action: check the session like any action (a `404`,
/// `409 takeover_active` or `409 handoff_pending` is returned to the caller),
/// then run it in the background. Returns the operation as it starts and a
/// handle that yields it once finished.
pub(super) fn start(
    state: &ApiState,
    session_id: Uuid,
    action: RemoteAction,
    timeout: Duration,
) -> Result<(OperationView, tokio::task::JoinHandle<OperationView>), StoreError> {
    let owner = state.store.session_owner(session_id)?;
    let op = state
        .store
        .begin_internal(session_id, action.clone(), timeout)?;
    let (run_id, client_label, kind_event) = match &action {
        RemoteAction::SecretsLookup {
            run_id,
            client_label,
            ..
        } => (run_id.clone(), client_label.clone(), "secrets.lookup"),
        RemoteAction::TypeFromProvider {
            run_id,
            client_label,
            ..
        }
        | RemoteAction::TypeCodeFromProvider {
            run_id,
            client_label,
            ..
        } => (run_id.clone(), client_label.clone(), "secrets.release"),
        _ => (None, None, "secrets.release"),
    };
    let kind = match &action {
        RemoteAction::SecretsLookup { kind, .. } => Some(*kind),
        _ => None,
    };
    let run = Run {
        store: state.store.clone(),
        providers: state.secrets.clone(),
        session_id,
        owner: owner.clone(),
        deadline: Instant::now() + timeout,
        audit: Audit {
            event: kind_event,
            owner_id: owner,
            session_id,
            op_id: op.id,
            run_id,
            client_label,
            provider: None,
            item_id: None,
            field: None,
            origin: None,
            purpose: None,
            kind,
            count: None,
            released: false,
        },
    };
    let store = state.store.clone();
    let op_id = op.id;
    let started = op.clone();
    // Two tasks: a panic in the inner one still ends the operation, and a
    // caller that goes away does not cancel it half way through a typing.
    let handle = tokio::spawn(async move {
        let worker = tokio::spawn(execute(run, action));
        let outcome = match worker.await {
            Ok((run, result)) => {
                run.audit.emit(
                    &run.store.log,
                    match &result {
                        Ok(_) if run.audit.event == "secrets.release" => "typed",
                        Ok(_) => "ok",
                        Err(f) => f.code,
                    },
                );
                result.map_err(|f| f.text())
            }
            Err(_) => Err(Fail::new("internal", "the provider action failed unexpectedly").text()),
        };
        store.finish_internal(op_id, outcome).unwrap_or(started)
    });
    Ok((op, handle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use hexactra_credential_resolver::test_provider::TestProvider;

    fn test_req() -> RegisterSecretsProviderRequest {
        RegisterSecretsProviderRequest {
            kind: SecretsProviderKind::Test,
            base_url: None,
            access_token: Some("token-canary-not-logged".into()),
            expires_at: None,
            settings: None,
        }
    }

    #[test]
    fn registrations_are_per_owner_and_never_show_a_token() {
        let r = SecretsProviders::default();
        let v = r.register("user-a", "test", test_req()).unwrap();
        assert_eq!(
            (v.owner_id.as_str(), v.provider.as_str()),
            ("user-a", "test")
        );
        assert!(!serde_json::to_string(&v).unwrap().contains("token-canary"));
        assert!(!format!("{:?}", test_req()).contains("token-canary"));
        assert_eq!(r.list("user-a").len(), 1);
        assert!(r.list("user-b").is_empty());
        assert!(r.resolve(Some("user-a"), None).is_ok());
        assert_eq!(
            r.resolve(Some("user-b"), None).err().unwrap().code,
            code::NO_PROVIDER
        );
        assert_eq!(r.resolve(None, None).err().unwrap().code, code::NO_PROVIDER);
        assert!(r.remove("user-a", "test"));
        assert!(!r.remove("user-a", "test"));
        assert_eq!(
            r.resolve(Some("user-a"), None).err().unwrap().code,
            code::NO_PROVIDER
        );
    }

    #[test]
    fn several_providers_need_a_name() {
        let r = SecretsProviders::default();
        for id in ["test", "other"] {
            r.register_provider(
                "user-a",
                id,
                Arc::new(TestProvider::with_fixture()),
                SecretsProviderKind::Test,
                None,
            );
        }
        assert_eq!(
            r.resolve(Some("user-a"), None).err().unwrap().code,
            code::PROVIDER_REQUIRED
        );
        assert_eq!(r.resolve(Some("user-a"), Some("other")).unwrap().0, "other");
        assert_eq!(
            r.resolve(Some("user-a"), Some("nope")).err().unwrap().code,
            code::NO_PROVIDER
        );
    }

    #[test]
    fn invalid_and_unsupported_registrations() {
        let r = SecretsProviders::default();
        assert!(matches!(
            r.register("", "test", test_req()),
            Err(RegisterError::Invalid(_))
        ));
        assert!(matches!(
            r.register("user-a", "Bad Id", test_req()),
            Err(RegisterError::Invalid(_))
        ));
        let mut past = test_req();
        past.expires_at = Some(Utc::now() - chrono::Duration::seconds(1));
        assert!(matches!(
            r.register("user-a", "test", past),
            Err(RegisterError::Invalid(_))
        ));
        let mut bad_url = test_req();
        bad_url.base_url = Some("http://vault.example.test".into());
        assert!(matches!(
            r.register("user-a", "test", bad_url),
            Err(RegisterError::Invalid(_))
        ));
        // A console provider needs its callback address, credential and expiry (E37.5).
        let mut console = test_req();
        console.kind = SecretsProviderKind::Console;
        assert!(matches!(
            r.register("user-a", "builtin", console),
            Err(RegisterError::Invalid(_))
        ));
        let console_ok = || RegisterSecretsProviderRequest {
            kind: SecretsProviderKind::Console,
            base_url: Some("http://api:3000/api/internal/secrets-store/v1".into()),
            access_token: Some("sct_canary-token-not-logged".into()),
            expires_at: Some(Utc::now() + chrono::Duration::minutes(5)),
            settings: None,
        };
        let v = r.register("user-a", "builtin", console_ok()).unwrap();
        assert_eq!(v.kind, SecretsProviderKind::Console);
        assert!(!serde_json::to_string(&v).unwrap().contains("canary-token"));
        let mut public_http = console_ok();
        public_http.base_url = Some("http://console.example.test/x".into());
        assert!(matches!(
            r.register("user-b", "builtin", public_http),
            Err(RegisterError::Invalid(_))
        ));
    }

    #[test]
    fn a_vault_registration_needs_url_token_and_expiry_and_keeps_no_copy() {
        let r = SecretsProviders::default();
        let good = || RegisterSecretsProviderRequest {
            kind: SecretsProviderKind::Vault,
            base_url: Some("https://vault.example.test".into()),
            access_token: Some("oat_canary-token-not-logged".into()),
            expires_at: Some(Utc::now() + chrono::Duration::minutes(5)),
            settings: None,
        };
        let v = r.register("user-a", "vault", good()).unwrap();
        assert_eq!(v.kind, SecretsProviderKind::Vault);
        assert_eq!(v.base_url.as_deref(), Some("https://vault.example.test"));
        assert!(!serde_json::to_string(&v).unwrap().contains("canary-token"));
        assert_eq!(r.resolve(Some("user-a"), None).unwrap().0, "vault");
        // Registering again replaces the provider (and so its token).
        r.register("user-a", "vault", good()).unwrap();
        assert_eq!(r.list("user-a").len(), 1);
        for broken in [
            |q: &mut RegisterSecretsProviderRequest| q.base_url = None,
            |q: &mut RegisterSecretsProviderRequest| q.access_token = None,
            |q: &mut RegisterSecretsProviderRequest| q.expires_at = None,
            |q: &mut RegisterSecretsProviderRequest| {
                q.base_url = Some("http://vault.example.test".into())
            },
            |q: &mut RegisterSecretsProviderRequest| {
                q.base_url = Some("https://10.0.0.1@evil.test".into())
            },
            |q: &mut RegisterSecretsProviderRequest| q.access_token = Some("has space".into()),
        ] {
            let mut q = good();
            broken(&mut q);
            assert!(matches!(
                r.register("user-b", "vault", q),
                Err(RegisterError::Invalid(_))
            ));
        }
        assert!(r.list("user-b").is_empty());
    }

    #[test]
    fn an_expired_registration_is_gone() {
        let r = SecretsProviders::default();
        r.register_provider(
            "user-a",
            "test",
            Arc::new(TestProvider::with_fixture()),
            SecretsProviderKind::Test,
            Some(Utc::now() - chrono::Duration::seconds(1)),
        );
        assert!(r.list("user-a").is_empty());
        assert_eq!(
            r.resolve(Some("user-a"), None).err().unwrap().code,
            code::NO_PROVIDER
        );
    }

    #[test]
    fn secret_text_wipes_what_is_not_text() {
        assert_eq!(
            secret_text(&SecretValue::new(b"plain".to_vec())).as_deref(),
            Some("plain")
        );
        assert!(secret_text(&SecretValue::new(vec![0xff, 0xfe, 0x00])).is_none());
    }
}
