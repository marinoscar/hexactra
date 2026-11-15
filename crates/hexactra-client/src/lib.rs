//! Client for the Hexactra control plane `/v1` API.
//!
//! [`ControlClient`] is used by people and agents (CLI, MCP, SDKs);
//! [`HostClient`] is used by the host agent that owns a browser.

use std::time::Duration;

use hexactra_core::remote::{
    ActionRequest, ApiError, ClaimedHandoffValue, CreateHandoffRequest, CreateHandoffResponse,
    CreateSessionRequest, CreateWebhookRequest, CreatedWebhook, HandoffView, HostCommandRequest,
    HostCommandView, HostView, HostWork, OperationResult, OperationView, RegisterHostRequest,
    RegisterHostResponse, RemoteAction, RespondHandoffRequest, SessionView, WebhookDelivery,
    WebhookView,
};
use reqwest::{Method, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

/// Client errors.
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("invalid control plane URL: {0}")]
    Url(String),
    #[error("cannot reach control plane: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("{status}: {code}: {message}")]
    Api {
        status: u16,
        code: String,
        message: String,
    },
    #[error("invalid response: {0}")]
    Decode(String),
}

impl ClientError {
    /// HTTP status of an API error, if any.
    pub fn status(&self) -> Option<u16> {
        match self {
            ClientError::Api { status, .. } => Some(*status),
            _ => None,
        }
    }
}

pub type Result<T> = std::result::Result<T, ClientError>;

#[derive(Clone)]
struct Http {
    base: Url,
    token: String,
    http: reqwest::Client,
}

impl Http {
    fn new(base_url: &str, token: &str, request_timeout: Duration) -> Result<Self> {
        let mut base = Url::parse(base_url).map_err(|e| ClientError::Url(e.to_string()))?;
        if !matches!(base.scheme(), "http" | "https") {
            return Err(ClientError::Url("scheme must be http or https".into()));
        }
        if !base.path().ends_with('/') {
            let p = format!("{}/", base.path());
            base.set_path(&p);
        }
        let http = reqwest::Client::builder()
            .timeout(request_timeout)
            .build()?;
        Ok(Self {
            base,
            token: token.trim().to_string(),
            http,
        })
    }

    fn url(&self, path: &str) -> Result<Url> {
        self.base
            .join(path.trim_start_matches('/'))
            .map_err(|e| ClientError::Url(e.to_string()))
    }

    async fn send<B: Serialize>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
        timeout: Option<Duration>,
    ) -> Result<reqwest::Response> {
        let mut req = self.http.request(method, self.url(path)?);
        if !self.token.is_empty() {
            req = req.bearer_auth(&self.token);
        }
        if let Some(b) = body {
            req = req.json(b);
        }
        if let Some(t) = timeout {
            req = req.timeout(t);
        }
        let resp = req.send().await?;
        if resp.status().is_success() {
            return Ok(resp);
        }
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        let (code, message) = match serde_json::from_str::<ApiError>(&text) {
            Ok(e) => (e.error, e.message),
            Err(_) => ("http_error".to_string(), text),
        };
        Err(ClientError::Api {
            status,
            code,
            message,
        })
    }

    async fn json<B: Serialize, T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
        timeout: Option<Duration>,
    ) -> Result<T> {
        Ok(self.send(method, path, body, timeout).await?.json().await?)
    }
}

const NO_BODY: Option<&()> = None;

#[derive(Deserialize)]
struct Sessions {
    sessions: Vec<SessionView>,
}

#[derive(Deserialize)]
struct Hosts {
    hosts: Vec<HostView>,
}

/// Client for people and agents driving a browser.
#[derive(Clone)]
pub struct ControlClient {
    http: Http,
}

impl ControlClient {
    /// `base_url` e.g. `http://127.0.0.1:8787`.
    pub fn new(base_url: &str, token: &str) -> Result<Self> {
        Ok(Self {
            http: Http::new(base_url, token, Duration::from_secs(30))?,
        })
    }

    /// `GET /v1/health` (no auth needed, but the token is sent anyway).
    pub async fn health(&self) -> Result<serde_json::Value> {
        self.http
            .json(Method::GET, "v1/health", NO_BODY, None)
            .await
    }

    pub async fn hosts(&self) -> Result<Vec<HostView>> {
        let h: Hosts = self
            .http
            .json(Method::GET, "v1/hosts", NO_BODY, None)
            .await?;
        Ok(h.hosts)
    }

    pub async fn sessions(&self) -> Result<Vec<SessionView>> {
        let s: Sessions = self
            .http
            .json(Method::GET, "v1/sessions", NO_BODY, None)
            .await?;
        Ok(s.sessions)
    }

    /// Run a host command (#213) and wait for its result (bounded by the
    /// request's timeout).
    pub async fn host_command(
        &self,
        host_id: Uuid,
        req: &HostCommandRequest,
    ) -> Result<HostCommandView> {
        let wait = Duration::from_millis(
            req.timeout_ms
                .unwrap_or(hexactra_core::remote::DEFAULT_HOST_COMMAND_TIMEOUT_MS),
        ) + Duration::from_secs(10);
        self.http
            .json(
                Method::POST,
                &format!("v1/hosts/{host_id}/commands"),
                Some(req),
                Some(wait),
            )
            .await
    }

    /// Recent commands for a host, newest first.
    pub async fn host_commands(&self, host_id: Uuid) -> Result<Vec<HostCommandView>> {
        #[derive(Deserialize)]
        struct List {
            commands: Vec<HostCommandView>,
        }
        let l: List = self
            .http
            .json(
                Method::GET,
                &format!("v1/hosts/{host_id}/commands"),
                NO_BODY,
                None,
            )
            .await?;
        Ok(l.commands)
    }

    /// Fetch an artifact's bytes and media type (`GET /v1/artifacts/{id}`).
    pub async fn artifact(&self, id: Uuid) -> Result<(String, Vec<u8>)> {
        let resp = self
            .http
            .send(Method::GET, &format!("v1/artifacts/{id}"), NO_BODY, None)
            .await?;
        let mime = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        Ok((mime, resp.bytes().await?.to_vec()))
    }

    /// Bytes of a screenshot result: from its artifact handle, or the inline
    /// `data` of an older control plane.
    pub async fn screenshot_bytes(&self, result: &serde_json::Value) -> Result<(String, Vec<u8>)> {
        use base64::Engine;
        if let Some(id) = result["artifact_id"].as_str().and_then(|s| s.parse().ok()) {
            return self.artifact(id).await;
        }
        let data = result["data"].as_str().unwrap_or_default();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| ClientError::Decode(e.to_string()))?;
        let mime = result["mime"].as_str().unwrap_or("image/jpeg").to_string();
        Ok((mime, bytes))
    }

    pub async fn create_session(&self, req: &CreateSessionRequest) -> Result<SessionView> {
        self.http
            .json(Method::POST, "v1/sessions", Some(req), None)
            .await
    }

    pub async fn session(&self, id: Uuid) -> Result<SessionView> {
        self.http
            .json(Method::GET, &format!("v1/sessions/{id}"), NO_BODY, None)
            .await
    }

    pub async fn end_session(&self, id: Uuid) -> Result<SessionView> {
        self.http
            .json(Method::DELETE, &format!("v1/sessions/{id}"), NO_BODY, None)
            .await
    }

    /// Run an action and wait for its terminal state. A browser-side failure
    /// or timeout is reported in [`OperationView::state`], not as an `Err`.
    pub async fn act(
        &self,
        session_id: Uuid,
        action: RemoteAction,
        timeout: Option<Duration>,
    ) -> Result<OperationView> {
        let req = ActionRequest {
            action,
            timeout_ms: timeout.map(|t| t.as_millis() as u64),
            inline_artifacts: false,
        };
        let wait = timeout.unwrap_or(Duration::from_secs(30)) + Duration::from_secs(10);
        self.http
            .json(
                Method::POST,
                &format!("v1/sessions/{session_id}/actions"),
                Some(&req),
                Some(wait),
            )
            .await
    }

    pub async fn operation(&self, id: Uuid) -> Result<OperationView> {
        self.http
            .json(Method::GET, &format!("v1/operations/{id}"), NO_BODY, None)
            .await
    }

    // ------------------------------------------------------- credentials

    /// Create a single-use host enrollment token (operator or service).
    pub async fn create_enrollment(
        &self,
        name: Option<&str>,
        ttl: Option<Duration>,
    ) -> Result<serde_json::Value> {
        self.http
            .json(
                Method::POST,
                "v1/admin/hosts/enrollments",
                Some(&serde_json::json!({
                    "name": name,
                    "ttl_s": ttl.map(|t| t.as_secs()),
                })),
                None,
            )
            .await
    }

    /// Revoke a host's credential and remove it.
    pub async fn revoke_host(&self, host_id: Uuid) -> Result<()> {
        self.http
            .send(
                Method::DELETE,
                &format!("v1/admin/hosts/{host_id}"),
                NO_BODY,
                None,
            )
            .await?;
        Ok(())
    }

    /// Create a service token (operator only).
    pub async fn create_service_token(&self, name: &str) -> Result<serde_json::Value> {
        self.http
            .json(
                Method::POST,
                "v1/admin/service-tokens",
                Some(&serde_json::json!({ "name": name })),
                None,
            )
            .await
    }

    /// List service tokens (operator only; never includes the tokens).
    pub async fn list_service_tokens(&self) -> Result<serde_json::Value> {
        self.http
            .json(Method::GET, "v1/admin/service-tokens", NO_BODY, None)
            .await
    }

    /// Revoke a service token (operator only).
    pub async fn revoke_service_token(&self, id: Uuid) -> Result<()> {
        self.http
            .send(
                Method::DELETE,
                &format!("v1/admin/service-tokens/{id}"),
                NO_BODY,
                None,
            )
            .await?;
        Ok(())
    }

    // ------------------------------------------------------------ handoffs

    /// Pause a session for a human. The response carries the single-use
    /// response token channels use to answer.
    pub async fn create_handoff(
        &self,
        session_id: Uuid,
        req: &CreateHandoffRequest,
    ) -> Result<CreateHandoffResponse> {
        self.http
            .json(
                Method::POST,
                &format!("v1/sessions/{session_id}/handoffs"),
                Some(req),
                None,
            )
            .await
    }

    pub async fn handoffs(&self, pending_only: bool) -> Result<Vec<HandoffView>> {
        #[derive(Deserialize)]
        struct L {
            handoffs: Vec<HandoffView>,
        }
        let l: L = self
            .http
            .json(
                Method::GET,
                &format!("v1/handoffs?pending={pending_only}"),
                NO_BODY,
                None,
            )
            .await?;
        Ok(l.handoffs)
    }

    /// Read a handoff, waiting up to `wait` (max 120 s) for it to resolve.
    pub async fn handoff(&self, id: Uuid, wait: Option<Duration>) -> Result<HandoffView> {
        let ms = wait.map(|w| w.as_millis() as u64).unwrap_or(0);
        self.http
            .json(
                Method::GET,
                &format!("v1/handoffs/{id}?wait_ms={ms}"),
                NO_BODY,
                Some(wait.unwrap_or_default() + Duration::from_secs(10)),
            )
            .await
    }

    /// Answer a handoff as the operator (API token).
    pub async fn respond_handoff(
        &self,
        id: Uuid,
        req: &RespondHandoffRequest,
    ) -> Result<HandoffView> {
        self.http
            .json(
                Method::POST,
                &format!("v1/handoffs/{id}/respond"),
                Some(req),
                None,
            )
            .await
    }

    pub async fn cancel_handoff(&self, id: Uuid) -> Result<HandoffView> {
        self.http
            .json(
                Method::POST,
                &format!("v1/handoffs/{id}/cancel"),
                NO_BODY,
                None,
            )
            .await
    }

    // ------------------------------------------------------------ webhooks

    pub async fn add_webhook(&self, req: &CreateWebhookRequest) -> Result<CreatedWebhook> {
        self.http
            .json(Method::POST, "v1/webhooks", Some(req), None)
            .await
    }

    pub async fn webhooks(&self) -> Result<Vec<WebhookView>> {
        #[derive(Deserialize)]
        struct L {
            webhooks: Vec<WebhookView>,
        }
        let l: L = self
            .http
            .json(Method::GET, "v1/webhooks", NO_BODY, None)
            .await?;
        Ok(l.webhooks)
    }

    pub async fn remove_webhook(&self, id: Uuid) -> Result<()> {
        self.http
            .send(Method::DELETE, &format!("v1/webhooks/{id}"), NO_BODY, None)
            .await?;
        Ok(())
    }

    /// Send a `webhook.test` event; returns its event id.
    pub async fn test_webhook(&self, id: Uuid) -> Result<String> {
        let v: serde_json::Value = self
            .http
            .json(
                Method::POST,
                &format!("v1/webhooks/{id}/test"),
                NO_BODY,
                None,
            )
            .await?;
        Ok(v["event_id"].as_str().unwrap_or_default().to_string())
    }

    /// Most recent delivery attempts first.
    pub async fn webhook_deliveries(&self, id: Uuid) -> Result<Vec<WebhookDelivery>> {
        #[derive(Deserialize)]
        struct L {
            deliveries: Vec<WebhookDelivery>,
        }
        let l: L = self
            .http
            .json(
                Method::GET,
                &format!("v1/webhooks/{id}/deliveries"),
                NO_BODY,
                None,
            )
            .await?;
        Ok(l.deliveries)
    }

    /// Retrieve a `secret` answer once. Deprecated on the server: prefer a
    /// `type_secret` action ([`RemoteAction::TypeSecret`]), which types the
    /// value without returning it.
    pub async fn claim_handoff_secret(&self, id: Uuid) -> Result<String> {
        let v: ClaimedHandoffValue = self
            .http
            .json(
                Method::POST,
                &format!("v1/handoffs/{id}/claim"),
                NO_BODY,
                None,
            )
            .await?;
        Ok(v.value)
    }
}

/// What a host reports on each poll.
#[derive(Debug, Clone, Default)]
pub struct HostPollStatus {
    /// A browser extension is connected (attach mode, or any running browser).
    pub browser_connected: bool,
    /// The host launches browsers on demand.
    pub on_demand: bool,
    /// `(profiles the host has, profiles running now)`.
    pub profiles: Option<(Vec<String>, Vec<String>)>,
    /// The agent runs host commands (#213); the poll may then return one.
    pub accepts_commands: bool,
}

/// Client used by a host agent.
#[derive(Clone)]
pub struct HostClient {
    http: Http,
}

/// Result of exchanging an enrollment token.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostEnrollment {
    pub host_id: Uuid,
    /// The host's own credential (`hxh_…`).
    pub host_token: String,
}

impl HostClient {
    pub fn new(base_url: &str, token: &str) -> Result<Self> {
        Ok(Self {
            http: Http::new(base_url, token, Duration::from_secs(60))?,
        })
    }

    /// Exchange a single-use enrollment token (`hxe_…`) for a host
    /// credential. Needs no other credential.
    pub async fn enroll(
        base_url: &str,
        enrollment_token: &str,
        name: &str,
        version: &str,
    ) -> Result<HostEnrollment> {
        let http = Http::new(base_url, "", Duration::from_secs(30))?;
        http.json(
            Method::POST,
            "v1/hosts/enroll",
            Some(&serde_json::json!({
                "enrollment_token": enrollment_token,
                "name": name,
                "version": version,
            })),
            None,
        )
        .await
    }

    /// Announce that this host is shutting down.
    pub async fn offline(&self, host_id: Uuid) -> Result<()> {
        self.http
            .send(
                Method::POST,
                &format!("v1/hosts/{host_id}/offline"),
                NO_BODY,
                None,
            )
            .await?;
        Ok(())
    }

    pub async fn register(&self, req: &RegisterHostRequest) -> Result<RegisterHostResponse> {
        self.http
            .json(Method::POST, "v1/hosts/register", Some(req), None)
            .await
    }

    /// Long-poll for the next operation. `Ok(None)` when nothing arrived.
    pub async fn next(
        &self,
        host_id: Uuid,
        browser_connected: bool,
        wait: Duration,
    ) -> Result<Option<hexactra_core::remote::DispatchedOperation>> {
        self.next_with(host_id, browser_connected, false, wait)
            .await
    }

    /// Long-poll, also reporting whether this host launches its browser on demand.
    pub async fn next_with(
        &self,
        host_id: Uuid,
        browser_connected: bool,
        on_demand: bool,
        wait: Duration,
    ) -> Result<Option<hexactra_core::remote::DispatchedOperation>> {
        self.poll(
            host_id,
            &HostPollStatus {
                browser_connected,
                on_demand,
                profiles: None,
                accepts_commands: false,
            },
            wait,
        )
        .await
        .map(|w| match w {
            Some(HostWork::Operation(op)) => Some(op),
            _ => None,
        })
    }

    /// Long-poll with the host's full status.
    pub async fn poll(
        &self,
        host_id: Uuid,
        status: &HostPollStatus,
        wait: Duration,
    ) -> Result<Option<HostWork>> {
        let mut path = format!(
            "v1/hosts/{host_id}/next?wait_ms={}&browser_connected={}&on_demand={}&commands={}",
            wait.as_millis(),
            status.browser_connected,
            status.on_demand,
            status.accepts_commands,
        );
        if let Some((profiles, running)) = &status.profiles {
            // Profile names are [a-z0-9_-], so they need no escaping.
            path.push_str(&format!(
                "&profiles={}&running={}",
                profiles.join(","),
                running.join(",")
            ));
        }
        let resp = self
            .http
            .send(
                Method::GET,
                &path,
                NO_BODY,
                Some(wait + Duration::from_secs(10)),
            )
            .await?;
        if resp.status() == StatusCode::NO_CONTENT {
            return Ok(None);
        }
        Ok(Some(resp.json().await?))
    }

    /// Report a host command's result.
    pub async fn report_command(
        &self,
        host_id: Uuid,
        command_id: Uuid,
        result: &OperationResult,
    ) -> Result<()> {
        self.http
            .send(
                Method::POST,
                &format!("v1/hosts/{host_id}/commands/{command_id}/result"),
                Some(result),
                None,
            )
            .await?;
        Ok(())
    }

    pub async fn report(&self, host_id: Uuid, op_id: Uuid, result: &OperationResult) -> Result<()> {
        self.http
            .send(
                Method::POST,
                &format!("v1/hosts/{host_id}/operations/{op_id}/result"),
                Some(result),
                None,
            )
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_handling() {
        let h = Http::new("http://127.0.0.1:8787", "t", Duration::from_secs(1)).unwrap();
        assert_eq!(
            h.url("v1/hosts").unwrap().as_str(),
            "http://127.0.0.1:8787/v1/hosts"
        );
        let h = Http::new("https://x.test/prefix", "t", Duration::from_secs(1)).unwrap();
        assert_eq!(
            h.url("/v1/hosts").unwrap().as_str(),
            "https://x.test/prefix/v1/hosts"
        );
        assert!(Http::new("ftp://x", "t", Duration::from_secs(1)).is_err());
    }
}
