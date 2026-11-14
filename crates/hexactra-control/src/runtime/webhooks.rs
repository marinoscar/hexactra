//! Signed outbound webhooks (#190): the channels that reach a human when a
//! handoff opens, and through which the human can answer.
//!
//! - Payloads follow the Standard Webhooks spec: headers `webhook-id`,
//!   `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256>` over
//!   `"{id}.{timestamp}.{body}"`, keyed with the base64 part of `whsec_...`.
//! - `handoff.created` carries the handoff's response token, so every
//!   subscribed channel can answer. Treat endpoints as trusted recipients.
//! - SSRF guard: `https` only, public addresses only, unless
//!   `allow_insecure` is set (then `http` and private/loopback/CGNAT targets
//!   are allowed). Link-local, multicast and unspecified addresses (cloud
//!   metadata endpoints) are always refused. The resolved address is pinned
//!   for the request, and redirects are not followed.
//! - Registry persisted to a 0600 JSON file when a path is configured.

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use chrono::{DateTime, Utc};
use hexactra_core::remote::{
    webhook_filter_matches, CreateWebhookRequest, CreatedWebhook, WebhookDelivery, WebhookView,
    WEBHOOK_EVENTS,
};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use uuid::Uuid;

use super::handoff::RuntimeEvent;
use super::store::RuntimeStore;

const MAX_WEBHOOKS: usize = 20;
const DELIVERY_LOG: usize = 50;
const DELIVERY_TIMEOUT: Duration = Duration::from_secs(10);

/// Webhook settings.
#[derive(Debug, Clone)]
pub struct WebhookConfig {
    /// Where the registry is persisted (none: memory only).
    pub file: Option<PathBuf>,
    /// External base URL of the control plane, used to build `respond.url`
    /// and `respond.form_url` in payloads.
    pub public_url: Option<String>,
    /// Allow `http` and private, loopback or CGNAT targets.
    pub allow_insecure: bool,
    /// Delay before each attempt; its length is the number of attempts.
    pub retry_schedule: Vec<Duration>,
}

impl Default for WebhookConfig {
    fn default() -> Self {
        Self {
            file: None,
            public_url: None,
            allow_insecure: false,
            retry_schedule: vec![
                Duration::ZERO,
                Duration::from_secs(5),
                Duration::from_secs(30),
                Duration::from_secs(120),
                Duration::from_secs(600),
            ],
        }
    }
}

/// Registry errors.
#[derive(Debug, thiserror::Error)]
pub enum WebhookError {
    #[error("{0}")]
    Invalid(String),
    #[error("webhook not found")]
    NotFound,
    #[error("saving webhooks: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Endpoint {
    id: Uuid,
    url: String,
    events: Vec<String>,
    #[serde(default)]
    description: Option<String>,
    secret: String,
    created_at: DateTime<Utc>,
}

impl Endpoint {
    fn view(&self) -> WebhookView {
        WebhookView {
            id: self.id,
            url: self.url.clone(),
            events: self.events.clone(),
            description: self.description.clone(),
            created_at: self.created_at,
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct Registry {
    endpoints: Vec<Endpoint>,
}

#[derive(Default)]
struct Inner {
    registry: Registry,
    deliveries: HashMap<Uuid, VecDeque<WebhookDelivery>>,
}

/// Webhook registry and dispatcher. Cheap to clone.
#[derive(Clone)]
pub struct Webhooks {
    inner: Arc<Mutex<Inner>>,
    cfg: Arc<WebhookConfig>,
}

/// Generate a Standard Webhooks secret.
pub fn generate_secret() -> String {
    use rand::RngCore;
    let mut b = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut b);
    format!(
        "whsec_{}",
        base64::engine::general_purpose::STANDARD.encode(b)
    )
}

/// Standard Webhooks signature header value for one message.
pub fn sign(
    secret: &str,
    msg_id: &str,
    timestamp: i64,
    body: &[u8],
) -> Result<String, WebhookError> {
    let key = base64::engine::general_purpose::STANDARD
        .decode(secret.strip_prefix("whsec_").unwrap_or(secret))
        .map_err(|_| WebhookError::Invalid("malformed secret".into()))?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&key)
        .map_err(|_| WebhookError::Invalid("malformed secret".into()))?;
    mac.update(msg_id.as_bytes());
    mac.update(b".");
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b".");
    mac.update(body);
    Ok(format!(
        "v1,{}",
        base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
    ))
}

/// Address classes a webhook may never reach, and those reachable only with
/// `allow_insecure`.
pub fn ip_allowed(ip: IpAddr, allow_insecure: bool) -> bool {
    let ip = match ip {
        IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(v6)),
        v4 => v4,
    };
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            if v4.is_unspecified() || v4.is_link_local() || v4.is_multicast() || v4.is_broadcast() {
                return false;
            }
            let private = v4.is_private()
                || v4.is_loopback()
                || (o[0] == 100 && (64..=127).contains(&o[1])) // CGNAT (Tailscale)
                || o[0] == 0;
            !private || allow_insecure
        }
        IpAddr::V6(v6) => {
            let seg = v6.segments();
            if v6.is_unspecified() || v6.is_multicast() || (seg[0] & 0xffc0) == 0xfe80 {
                return false;
            }
            let private = v6.is_loopback() || (seg[0] & 0xfe00) == 0xfc00;
            !private || allow_insecure
        }
    }
}

fn validate_url(raw: &str, allow_insecure: bool) -> Result<url::Url, WebhookError> {
    let u = url::Url::parse(raw.trim())
        .map_err(|e| WebhookError::Invalid(format!("invalid url: {e}")))?;
    match u.scheme() {
        "https" => {}
        "http" if allow_insecure => {}
        "http" => {
            return Err(WebhookError::Invalid(
                "webhook urls must use https (start the control plane with --webhook-allow-insecure for http on a private network)".into(),
            ))
        }
        _ => return Err(WebhookError::Invalid("webhook urls must use https".into())),
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err(WebhookError::Invalid(
            "put credentials in the receiver, not the url".into(),
        ));
    }
    if u.host_str().unwrap_or("").is_empty() {
        return Err(WebhookError::Invalid("url has no host".into()));
    }
    if raw.len() > 2048 {
        return Err(WebhookError::Invalid("url too long".into()));
    }
    Ok(u)
}

fn write_private(path: &PathBuf, contents: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    {
        use std::io::Write;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(contents)?;
        f.sync_all()?;
    }
    std::fs::rename(tmp, path)
}

impl Webhooks {
    /// Load the registry (if a file is configured) and build the dispatcher.
    pub fn load(cfg: WebhookConfig) -> Result<Self, WebhookError> {
        let registry = match &cfg.file {
            Some(f) if f.exists() => serde_json::from_slice(&std::fs::read(f)?)
                .map_err(|e| WebhookError::Invalid(format!("{}: {e}", f.display())))?,
            _ => Registry::default(),
        };
        Ok(Self {
            inner: Arc::new(Mutex::new(Inner {
                registry,
                deliveries: HashMap::new(),
            })),
            cfg: Arc::new(cfg),
        })
    }

    /// Memory-only registry with default settings.
    pub fn in_memory() -> Self {
        Self::load(WebhookConfig::default()).expect("no file to read")
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn save(&self, inner: &Inner) -> Result<(), WebhookError> {
        if let Some(f) = &self.cfg.file {
            let bytes = serde_json::to_vec_pretty(&inner.registry)
                .map_err(|e| WebhookError::Invalid(e.to_string()))?;
            write_private(f, &bytes)?;
        }
        Ok(())
    }

    pub fn add(&self, req: CreateWebhookRequest) -> Result<CreatedWebhook, WebhookError> {
        let url = validate_url(&req.url, self.cfg.allow_insecure)?;
        let events = if req.events.is_empty() {
            vec!["handoff.*".to_string()]
        } else {
            req.events
        };
        for e in &events {
            if !WEBHOOK_EVENTS.iter().any(|k| webhook_filter_matches(e, k)) {
                return Err(WebhookError::Invalid(format!(
                    "unknown event filter {e:?}; known events: {}",
                    WEBHOOK_EVENTS.join(", ")
                )));
            }
        }
        if req.description.as_deref().map(str::len).unwrap_or(0) > 200 {
            return Err(WebhookError::Invalid("description too long".into()));
        }
        let ep = Endpoint {
            id: Uuid::new_v4(),
            url: url.to_string(),
            events,
            description: req.description,
            secret: generate_secret(),
            created_at: Utc::now(),
        };
        let mut inner = self.lock();
        if inner.registry.endpoints.len() >= MAX_WEBHOOKS {
            return Err(WebhookError::Invalid(format!(
                "at most {MAX_WEBHOOKS} webhooks"
            )));
        }
        inner.registry.endpoints.push(ep.clone());
        if let Err(e) = self.save(&inner) {
            inner.registry.endpoints.pop();
            return Err(e);
        }
        tracing::info!(webhook_id = %ep.id, host = url.host_str().unwrap_or(""), "webhook added");
        Ok(CreatedWebhook {
            webhook: ep.view(),
            secret: ep.secret,
        })
    }

    pub fn list(&self) -> Vec<WebhookView> {
        self.lock()
            .registry
            .endpoints
            .iter()
            .map(Endpoint::view)
            .collect()
    }

    pub fn remove(&self, id: Uuid) -> Result<(), WebhookError> {
        let mut inner = self.lock();
        let before = inner.registry.endpoints.len();
        inner.registry.endpoints.retain(|e| e.id != id);
        if inner.registry.endpoints.len() == before {
            return Err(WebhookError::NotFound);
        }
        inner.deliveries.remove(&id);
        self.save(&inner)
    }

    pub fn deliveries(&self, id: Uuid) -> Result<Vec<WebhookDelivery>, WebhookError> {
        let inner = self.lock();
        if !inner.registry.endpoints.iter().any(|e| e.id == id) {
            return Err(WebhookError::NotFound);
        }
        Ok(inner
            .deliveries
            .get(&id)
            .map(|d| d.iter().rev().cloned().collect())
            .unwrap_or_default())
    }

    /// Build the JSON payload for a runtime event.
    pub fn payload(&self, ev: &RuntimeEvent) -> Value {
        let mut data = json!({ "handoff": ev.handoff });
        if let Some(token) = &ev.response_token {
            let path = super::handoff_api::respond_path(ev.handoff.id);
            let mut respond = json!({
                "token": token,
                "path": path,
                "method": "POST",
                "token_header": super::handoff_api::RESPONSE_TOKEN_HEADER,
            });
            if let Some(base) = &self.cfg.public_url {
                let base = base.trim_end_matches('/');
                respond["url"] = json!(format!("{base}{path}"));
                respond["form_url"] = json!(format!("{base}{path}?token={token}"));
            }
            data["respond"] = respond;
        }
        json!({
            "id": format!("evt_{}", ev.id.simple()),
            "type": ev.kind,
            "created_at": ev.created_at,
            "data": data,
        })
    }

    /// Subscribe to the store's events and deliver them until the store is dropped.
    pub fn spawn_dispatcher(&self, store: &RuntimeStore) {
        let mut rx = store.subscribe_events();
        let this = self.clone();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(ev) => {
                        let body = this.payload(&ev);
                        this.fan_out(ev.kind, body);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!(skipped = n, "webhook dispatcher lagged");
                    }
                    Err(_) => break,
                }
            }
        });
    }

    fn fan_out(&self, kind: &str, body: Value) {
        let targets: Vec<Endpoint> = self
            .lock()
            .registry
            .endpoints
            .iter()
            .filter(|e| e.events.iter().any(|f| webhook_filter_matches(f, kind)))
            .cloned()
            .collect();
        for ep in targets {
            let this = self.clone();
            let body = body.clone();
            tokio::spawn(async move { this.deliver(ep, body).await });
        }
    }

    /// Send a `webhook.test` event to one endpoint.
    pub fn send_test(&self, id: Uuid) -> Result<String, WebhookError> {
        let ep = self
            .lock()
            .registry
            .endpoints
            .iter()
            .find(|e| e.id == id)
            .cloned()
            .ok_or(WebhookError::NotFound)?;
        let event_id = format!("evt_{}", Uuid::new_v4().simple());
        let body = json!({
            "id": event_id,
            "type": "webhook.test",
            "created_at": Utc::now(),
            "data": { "webhook_id": id, "message": "Hexactra test event" },
        });
        let this = self.clone();
        tokio::spawn(async move { this.deliver(ep, body).await });
        Ok(event_id)
    }

    fn record(&self, ep: Uuid, d: WebhookDelivery) {
        let mut inner = self.lock();
        let log = inner.deliveries.entry(ep).or_default();
        log.push_back(d);
        while log.len() > DELIVERY_LOG {
            log.pop_front();
        }
    }

    async fn deliver(&self, ep: Endpoint, body: Value) {
        let event_id = body["id"].as_str().unwrap_or_default().to_string();
        let event_type = body["type"].as_str().unwrap_or_default().to_string();
        let bytes = body.to_string().into_bytes();
        let attempts = self.cfg.retry_schedule.len().max(1);
        for (i, delay) in self.cfg.retry_schedule.iter().enumerate() {
            tokio::time::sleep(*delay).await;
            // Stop if the endpoint was removed meanwhile.
            if !self.lock().registry.endpoints.iter().any(|e| e.id == ep.id) {
                return;
            }
            let attempt = i as u32 + 1;
            let result = self.attempt(&ep, &event_id, &bytes).await;
            let last = i + 1 == attempts;
            let (outcome, http_status, error) = match &result {
                Ok(code) if (200..300).contains(code) => ("succeeded", Some(*code), None),
                Ok(code) => (
                    if last { "failed" } else { "retrying" },
                    Some(*code),
                    Some(format!("receiver returned HTTP {code}")),
                ),
                Err(e) => (
                    if last { "failed" } else { "retrying" },
                    None,
                    Some(e.clone()),
                ),
            };
            tracing::info!(webhook_id = %ep.id, event = %event_type, attempt, outcome, "webhook delivery");
            self.record(
                ep.id,
                WebhookDelivery {
                    event_id: event_id.clone(),
                    event_type: event_type.clone(),
                    attempt,
                    at: Utc::now(),
                    outcome: outcome.into(),
                    http_status,
                    error,
                },
            );
            if outcome == "succeeded" {
                return;
            }
        }
    }

    async fn attempt(&self, ep: &Endpoint, event_id: &str, body: &[u8]) -> Result<u16, String> {
        let url = validate_url(&ep.url, self.cfg.allow_insecure).map_err(|e| e.to_string())?;
        let host = url.host_str().unwrap_or_default().to_string();
        let port = url.port_or_known_default().unwrap_or(443);
        let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
            .await
            .map_err(|e| format!("cannot resolve {host}: {e}"))?
            .collect();
        let addr = addrs
            .iter()
            .find(|a| ip_allowed(a.ip(), self.cfg.allow_insecure))
            .copied()
            .ok_or_else(|| format!("{host} resolves only to addresses webhooks may not reach"))?;
        let ts = Utc::now().timestamp();
        let sig = sign(&ep.secret, event_id, ts, body).map_err(|e| e.to_string())?;
        let client = reqwest::Client::builder()
            .timeout(DELIVERY_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .resolve(&host, addr)
            .no_proxy()
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client
            .post(url)
            .header("content-type", "application/json")
            .header(
                "user-agent",
                concat!("hexactra-webhooks/", env!("CARGO_PKG_VERSION")),
            )
            .header("webhook-id", event_id)
            .header("webhook-timestamp", ts.to_string())
            .header("webhook-signature", sig)
            .body(body.to_vec())
            .send()
            .await
            .map_err(|e| format!("delivery failed: {e}"))?;
        Ok(resp.status().as_u16())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_webhooks_test_vector() {
        // Public example from the Standard Webhooks specification (not a
        // real credential). The key is given without its "whsec_" prefix,
        // which `sign` also accepts.
        let sig = sign(
            "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
            "msg_p5jXN8AQM9LWM0D4loKWxJek",
            1614265330,
            br#"{"test": 2432232314}"#,
        )
        .unwrap();
        assert_eq!(sig, "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
    }

    #[test]
    fn address_policy() {
        let p = |s: &str| s.parse::<IpAddr>().unwrap();
        // Always refused.
        for ip in [
            "169.254.169.254",
            "0.0.0.0",
            "224.0.0.1",
            "fe80::1",
            "::",
            "::ffff:169.254.169.254",
        ] {
            assert!(!ip_allowed(p(ip), true), "{ip}");
        }
        // Private: only with allow_insecure.
        for ip in [
            "127.0.0.1",
            "10.0.0.5",
            "192.168.1.10",
            "100.101.102.103",
            "::1",
            "fd00::1",
        ] {
            assert!(!ip_allowed(p(ip), false), "{ip}");
            assert!(ip_allowed(p(ip), true), "{ip}");
        }
        assert!(ip_allowed(p("93.184.216.34"), false));
    }

    #[test]
    fn url_policy() {
        assert!(validate_url("https://hooks.example.test/x", false).is_ok());
        assert!(validate_url("http://hooks.example.test/x", false).is_err());
        assert!(validate_url("http://127.0.0.1:5678/x", true).is_ok());
        assert!(validate_url("https://user:pw@hooks.example.test", false).is_err());
        assert!(validate_url("ftp://hooks.example.test", true).is_err());
    }

    #[test]
    fn registry_validates_and_persists_privately() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sub/webhooks.json");
        let cfg = WebhookConfig {
            file: Some(file.clone()),
            ..Default::default()
        };
        let w = Webhooks::load(cfg.clone()).unwrap();
        assert!(w
            .add(CreateWebhookRequest {
                url: "https://a.example.test/h".into(),
                events: vec!["nope.*".into()],
                description: None,
            })
            .is_err());
        let created = w
            .add(CreateWebhookRequest {
                url: "https://a.example.test/h".into(),
                ..Default::default()
            })
            .unwrap();
        assert!(created.secret.starts_with("whsec_"));
        assert_eq!(created.webhook.events, vec!["handoff.*"]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        // Reload keeps it; the list never shows the secret.
        let w2 = Webhooks::load(cfg).unwrap();
        assert_eq!(w2.list().len(), 1);
        assert!(!serde_json::to_string(&w2.list())
            .unwrap()
            .contains("whsec_"));
        w2.remove(created.webhook.id).unwrap();
        assert!(w2.remove(created.webhook.id).is_err());
    }
}
