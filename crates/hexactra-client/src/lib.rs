//! Client for the Hexactra control plane `/v1` API.
//!
//! [`ControlClient`] is used by people and agents (CLI, MCP, SDKs);
//! [`HostClient`] is used by the host agent that owns a browser.

use std::time::Duration;

use hexactra_core::remote::{
    ActionRequest, ApiError, ClaimedHandoffValue, CreateHandoffRequest, CreateHandoffResponse,
    CreateSessionRequest, CreateWebhookRequest, CreatedWebhook, DispatchedOperation, HandoffView,
    HostView, OperationResult, OperationView, RegisterHostRequest, RegisterHostResponse,
    RemoteAction, RespondHandoffRequest, SessionView, WebhookDelivery, WebhookView,
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
        let mut req = self
            .http
            .request(method, self.url(path)?)
            .bearer_auth(&self.token);
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

    /// Retrieve a `secret` answer once.
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

/// Client used by a host agent.
#[derive(Clone)]
pub struct HostClient {
    http: Http,
}

impl HostClient {
    pub fn new(base_url: &str, token: &str) -> Result<Self> {
        Ok(Self {
            http: Http::new(base_url, token, Duration::from_secs(60))?,
        })
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
    ) -> Result<Option<DispatchedOperation>> {
        let path = format!(
            "v1/hosts/{host_id}/next?wait_ms={}&browser_connected={browser_connected}",
            wait.as_millis()
        );
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
