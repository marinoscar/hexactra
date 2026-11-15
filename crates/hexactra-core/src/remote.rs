//! Wire contract for remote browser control (epic #173).
//!
//! These types are shared by the control plane, the host agent, the CLI, the
//! MCP server and the Chrome extension (which mirrors them in TypeScript).
//! The flow is:
//!
//! ```text
//! client --POST /v1/sessions/{id}/actions--> control plane
//! host agent --GET /v1/hosts/{id}/next (long-poll)--> control plane
//! host agent --native messaging--> extension --> page
//! host agent --POST /v1/operations/{id}/result--> control plane --> client
//! ```
//!
//! There is deliberately no "execute arbitrary JavaScript" action: remote
//! callers can only perform the bounded operations listed here.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

/// Maximum length of a CSS selector accepted from a remote caller.
pub const MAX_SELECTOR_LEN: usize = 2_000;
/// Maximum text a single `type` action may carry.
pub const MAX_TYPE_TEXT_LEN: usize = 100_000;
/// Maximum wait a single `wait_for` action may request.
pub const MAX_WAIT_MS: u64 = 60_000;
/// Maximum URL length accepted for navigation.
pub const MAX_URL_LEN: usize = 8_192;

/// A single bounded browser operation.
///
/// `tab_id` is optional everywhere: when absent the extension uses the active
/// tab of the last focused window.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RemoteAction {
    /// Navigate a tab to an `http(s)` URL (or `about:blank`).
    Navigate {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_id: Option<i64>,
    },
    /// Click the first element matching a CSS selector.
    Click {
        selector: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_id: Option<i64>,
    },
    /// Type text into an input, textarea or contenteditable element.
    Type {
        selector: String,
        text: String,
        /// Clear the existing value first.
        #[serde(default)]
        clear: bool,
        /// Press Enter / submit the enclosing form after typing.
        #[serde(default)]
        submit: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_id: Option<i64>,
    },
    /// Press a key (e.g. `Enter`, `Escape`, `Tab`, `ArrowDown`) on the focused
    /// element or on `selector` when given.
    Press {
        key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selector: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_id: Option<i64>,
    },
    /// Scroll the page by a delta, or scroll `selector` into view.
    Scroll {
        #[serde(default)]
        dx: i64,
        #[serde(default)]
        dy: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selector: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_id: Option<i64>,
    },
    /// Capture the visible area of a tab. Result: `{ "mime": ..., "data": <base64> }`.
    Screenshot {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_id: Option<i64>,
    },
    /// Read visible text of the page or of `selector`.
    Text {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selector: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_chars: Option<usize>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_id: Option<i64>,
    },
    /// List interactive elements (links, buttons, inputs) with selectors an
    /// agent can use in follow-up actions.
    Elements {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_elements: Option<usize>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_id: Option<i64>,
    },
    /// Wait until an element matching `selector` exists.
    WaitFor {
        selector: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_id: Option<i64>,
    },
    /// List open tabs.
    Tabs,
    /// Open a new tab (optionally at a URL) and make it active.
    NewTab {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
    },
    /// Make a tab active and focus its window.
    ActivateTab { tab_id: i64 },
    /// Close a tab.
    CloseTab { tab_id: i64 },
    /// History back.
    Back {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_id: Option<i64>,
    },
    /// History forward.
    Forward {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_id: Option<i64>,
    },
    /// Reload a tab.
    Reload {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_id: Option<i64>,
    },
}

/// Validation failure for a remote action.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ActionValidationError(pub String);

fn check_selector(selector: &str) -> Result<(), ActionValidationError> {
    if selector.trim().is_empty() {
        return Err(ActionValidationError("selector must not be empty".into()));
    }
    if selector.len() > MAX_SELECTOR_LEN {
        return Err(ActionValidationError(format!(
            "selector longer than {MAX_SELECTOR_LEN} characters"
        )));
    }
    Ok(())
}

/// Only web pages may be opened remotely: `http`, `https` and `about:blank`.
/// `javascript:`, `file:`, `chrome:`, `data:` and extension URLs are refused.
pub fn check_navigable_url(url: &str) -> Result<(), ActionValidationError> {
    if url.len() > MAX_URL_LEN {
        return Err(ActionValidationError(format!(
            "url longer than {MAX_URL_LEN} characters"
        )));
    }
    if url == "about:blank" {
        return Ok(());
    }
    let lower = url.trim().to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        let rest = &lower[lower.find("://").map(|i| i + 3).unwrap_or(0)..];
        if rest.is_empty() || rest.starts_with('/') {
            return Err(ActionValidationError("url has no host".into()));
        }
        return Ok(());
    }
    Err(ActionValidationError(
        "only http(s) URLs and about:blank may be opened".into(),
    ))
}

impl RemoteAction {
    /// Short, content-free name used in logs and telemetry. Never includes
    /// typed text, selectors or URLs.
    pub fn kind(&self) -> &'static str {
        match self {
            RemoteAction::Navigate { .. } => "navigate",
            RemoteAction::Click { .. } => "click",
            RemoteAction::Type { .. } => "type",
            RemoteAction::Press { .. } => "press",
            RemoteAction::Scroll { .. } => "scroll",
            RemoteAction::Screenshot { .. } => "screenshot",
            RemoteAction::Text { .. } => "text",
            RemoteAction::Elements { .. } => "elements",
            RemoteAction::WaitFor { .. } => "wait_for",
            RemoteAction::Tabs => "tabs",
            RemoteAction::NewTab { .. } => "new_tab",
            RemoteAction::ActivateTab { .. } => "activate_tab",
            RemoteAction::CloseTab { .. } => "close_tab",
            RemoteAction::Back { .. } => "back",
            RemoteAction::Forward { .. } => "forward",
            RemoteAction::Reload { .. } => "reload",
        }
    }

    /// Validate bounds and URL policy before an action is queued.
    pub fn validate(&self) -> Result<(), ActionValidationError> {
        match self {
            RemoteAction::Navigate { url, .. } => check_navigable_url(url),
            RemoteAction::NewTab { url: Some(url) } => check_navigable_url(url),
            RemoteAction::Click { selector, .. } => check_selector(selector),
            RemoteAction::Type { selector, text, .. } => {
                check_selector(selector)?;
                if text.len() > MAX_TYPE_TEXT_LEN {
                    return Err(ActionValidationError(format!(
                        "text longer than {MAX_TYPE_TEXT_LEN} characters"
                    )));
                }
                Ok(())
            }
            RemoteAction::Press { key, selector, .. } => {
                if key.is_empty() || key.len() > 32 {
                    return Err(ActionValidationError("key must be 1-32 characters".into()));
                }
                selector.as_deref().map(check_selector).unwrap_or(Ok(()))
            }
            RemoteAction::Scroll { selector, .. } | RemoteAction::Text { selector, .. } => {
                selector.as_deref().map(check_selector).unwrap_or(Ok(()))
            }
            RemoteAction::WaitFor {
                selector,
                timeout_ms,
                ..
            } => {
                check_selector(selector)?;
                if timeout_ms.unwrap_or(0) > MAX_WAIT_MS {
                    return Err(ActionValidationError(format!(
                        "timeout_ms must be at most {MAX_WAIT_MS}"
                    )));
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

/// Name of the profile used when none is given.
pub const DEFAULT_PROFILE: &str = "default";

fn default_profile() -> String {
    DEFAULT_PROFILE.to_string()
}

/// Profile names: 1-32 characters, lowercase letters, digits, `-` and `_`,
/// starting with a letter or digit. They become directory names on hosts.
pub fn valid_profile_name(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-' || *c == b'_')
}

/// Lifecycle of a queued operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationState {
    /// Waiting for the host agent to pick it up.
    Queued,
    /// Handed to a host agent; result not yet reported.
    Dispatched,
    /// Completed successfully; `result` is set.
    Succeeded,
    /// The browser reported an error; `error` is set.
    Failed,
    /// No result arrived in time. The action may or may not have run.
    TimedOut,
    /// The session ended before the operation ran.
    Cancelled,
}

impl OperationState {
    /// True once the operation can no longer change.
    pub fn is_terminal(self) -> bool {
        !matches!(self, OperationState::Queued | OperationState::Dispatched)
    }
}

/// An operation as reported to clients.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OperationView {
    pub id: Uuid,
    pub session_id: Uuid,
    pub host_id: Uuid,
    pub action: RemoteAction,
    pub state: OperationState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
}

/// Session status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteSessionStatus {
    Active,
    Ended,
}

/// A remote-control session bound to one host.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionView {
    pub id: Uuid,
    pub host_id: Uuid,
    /// Browser profile this session drives.
    #[serde(default = "default_profile")]
    pub profile: String,
    pub status: RemoteSessionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub created_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<DateTime<Utc>>,
}

/// A host agent as seen by the control plane.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostView {
    pub id: Uuid,
    pub name: String,
    pub version: String,
    /// Polled the control plane recently.
    pub online: bool,
    /// The Chrome extension is connected to this host's native bridge.
    pub browser_connected: bool,
    /// The host launches its browser on demand, so it can take sessions
    /// while the browser is stopped.
    #[serde(default)]
    pub on_demand: bool,
    /// Web viewer where a person can see and use this host's browser.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewer_url: Option<String>,
    /// Browser profiles this host has.
    #[serde(default)]
    pub profiles: Vec<String>,
    /// Profiles whose browser is running now.
    #[serde(default)]
    pub running_profiles: Vec<String>,
    /// New sessions are not placed on this host (see [`HostCommand::Drain`]).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub draining: bool,
    pub last_seen: DateTime<Utc>,
}

/// `POST /v1/sessions`
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CreateSessionRequest {
    /// Pin the session to a host; otherwise the control plane picks an online
    /// host that has the profile.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Browser profile to use (default `default`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    /// Allow creating the profile on an on-demand host that does not have it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub create_profile: bool,
}

/// `POST /v1/sessions/{id}/actions`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActionRequest {
    pub action: RemoteAction,
    /// How long to wait for a result before the operation times out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    /// Also return screenshot bytes inline (`data`, base64) next to the
    /// artifact handle. For clients that have not moved to
    /// `GET /v1/artifacts/{id}` yet.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub inline_artifacts: bool,
}

/// `POST /v1/hosts/register`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RegisterHostRequest {
    pub name: String,
    pub version: String,
    /// Re-register with a previously issued id to keep sessions bound to it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<Uuid>,
    /// Web viewer for this host's browser (`http(s)` URL), shown to people
    /// answering handoffs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewer_url: Option<String>,
}

/// Response to host registration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RegisterHostResponse {
    pub host_id: Uuid,
}

/// An operation handed to a host agent by `GET /v1/hosts/{id}/next`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DispatchedOperation {
    pub id: Uuid,
    pub session_id: Uuid,
    /// Profile whose browser runs the action.
    #[serde(default = "default_profile")]
    pub profile: String,
    pub action: RemoteAction,
    /// Deadline the host should respect when executing.
    pub deadline: DateTime<Utc>,
    /// W3C trace context of the request that queued the action (#215).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub traceparent: Option<String>,
}

/// `POST /v1/operations/{id}/result`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OperationResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ------------------------------------------------------------------------
// Host commands (#213)

/// Default and longest time a host command may take.
pub const DEFAULT_HOST_COMMAND_TIMEOUT_MS: u64 = 60_000;
pub const MAX_HOST_COMMAND_TIMEOUT_MS: u64 = 5 * 60_000;

/// A management command for a host rather than an action in a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostCommand {
    /// Create an empty profile (signed out).
    CreateProfile { profile: String },
    /// Close the profile's browser and delete its directory (cookies,
    /// sign-ins, storage). The `default` profile cannot be deleted.
    DeleteProfile { profile: String },
    /// Close the profile's browser and start it again.
    RestartBrowser { profile: String },
    /// Close the profile's browser (it starts again on the next action).
    CloseBrowser { profile: String },
    /// Stop (or resume) placing new sessions on the host. Existing sessions
    /// keep working. Handled by the control plane; never sent to the host.
    Drain {
        #[serde(default = "default_true")]
        enabled: bool,
    },
}

fn default_true() -> bool {
    true
}

impl HostCommand {
    /// Stable name, e.g. `create_profile`.
    pub fn kind(&self) -> &'static str {
        match self {
            HostCommand::CreateProfile { .. } => "create_profile",
            HostCommand::DeleteProfile { .. } => "delete_profile",
            HostCommand::RestartBrowser { .. } => "restart_browser",
            HostCommand::CloseBrowser { .. } => "close_browser",
            HostCommand::Drain { .. } => "drain",
        }
    }

    /// Profile the command targets, if any.
    pub fn profile(&self) -> Option<&str> {
        match self {
            HostCommand::CreateProfile { profile }
            | HostCommand::DeleteProfile { profile }
            | HostCommand::RestartBrowser { profile }
            | HostCommand::CloseBrowser { profile } => Some(profile),
            HostCommand::Drain { .. } => None,
        }
    }

    pub fn validate(&self) -> Result<(), ActionValidationError> {
        if let Some(p) = self.profile() {
            if !valid_profile_name(p) {
                return Err(ActionValidationError(format!(
                    "invalid profile name {p:?}: use 1-32 of a-z, 0-9, '-' and '_'"
                )));
            }
        }
        if let HostCommand::DeleteProfile { profile } = self {
            if profile == DEFAULT_PROFILE {
                return Err(ActionValidationError(
                    "the default profile cannot be deleted".into(),
                ));
            }
        }
        Ok(())
    }
}

/// `POST /v1/hosts/{id}/commands`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostCommandRequest {
    pub command: HostCommand,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

/// A host command as reported to clients. States are those of operations.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostCommandView {
    pub id: Uuid,
    pub host_id: Uuid,
    pub command: HostCommand,
    pub state: OperationState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
}

/// A command handed to a host on its poll.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DispatchedCommand {
    pub id: Uuid,
    pub command: HostCommand,
    pub deadline: DateTime<Utc>,
    /// W3C trace context of the request that queued the command (#215).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub traceparent: Option<String>,
}

/// What `GET /v1/hosts/{id}/next` returns: an operation, or (to agents that
/// poll with `commands=true`) a host command wrapped as `{"command": …}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum HostWork {
    Command { command: DispatchedCommand },
    Operation(DispatchedOperation),
}

// ------------------------------------------------------------------------
// Human handoff (epic #186)

/// Longest prompt a handoff may carry.
pub const MAX_HANDOFF_PROMPT: usize = 2_000;
/// Longest value a human may submit.
pub const MAX_HANDOFF_VALUE: usize = 4_096;
/// Default and bounds for how long a handoff waits for a human.
pub const DEFAULT_HANDOFF_TIMEOUT_MS: u64 = 10 * 60 * 1000;
pub const MIN_HANDOFF_TIMEOUT_MS: u64 = 10 * 1000;
pub const MAX_HANDOFF_TIMEOUT_MS: u64 = 24 * 60 * 60 * 1000;

/// Why the agent needs a human.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandoffKind {
    /// A CAPTCHA or "are you human" check.
    Captcha,
    /// A one-time code (SMS, email, authenticator).
    Code,
    /// A passkey, security key or phone prompt.
    Passkey,
    /// Sign-in the agent should not perform.
    Login,
    /// A purchase, payment or other irreversible step to approve.
    Confirmation,
    /// Anything else needing human judgement.
    Other,
}

/// What the human is asked to provide.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandoffInput {
    /// Nothing: the human acts in the browser and marks the handoff done.
    #[default]
    None,
    /// Free text returned to the agent.
    Text,
    /// Sensitive text (e.g. a one-time code): returned once to the API
    /// caller via `claim`, never shown in reads, logs or webhook payloads.
    Secret,
    /// One of `choices`.
    Choice,
}

/// Lifecycle of a handoff.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandoffStatus {
    Pending,
    Completed,
    Cancelled,
    Expired,
}

impl HandoffStatus {
    pub fn is_terminal(self) -> bool {
        self != HandoffStatus::Pending
    }
}

/// Page the agent was on when it asked for help (informational only).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HandoffPage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// `POST /v1/sessions/{id}/handoffs`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreateHandoffRequest {
    pub kind: HandoffKind,
    /// What the human should do, in plain words.
    pub prompt: String,
    #[serde(default)]
    pub input: HandoffInput,
    /// Options for `input: "choice"`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<HandoffPage>,
}

impl CreateHandoffRequest {
    /// Validate bounds before the handoff is created.
    pub fn validate(&self) -> Result<(), ActionValidationError> {
        let p = self.prompt.trim();
        if p.is_empty() || p.len() > MAX_HANDOFF_PROMPT {
            return Err(ActionValidationError(format!(
                "prompt must be 1-{MAX_HANDOFF_PROMPT} characters"
            )));
        }
        match self.input {
            HandoffInput::Choice => {
                if self.choices.is_empty() || self.choices.len() > 10 {
                    return Err(ActionValidationError(
                        "choice input needs 1-10 choices".into(),
                    ));
                }
                if self
                    .choices
                    .iter()
                    .any(|c| c.trim().is_empty() || c.len() > 100)
                {
                    return Err(ActionValidationError(
                        "each choice must be 1-100 characters".into(),
                    ));
                }
            }
            _ if !self.choices.is_empty() => {
                return Err(ActionValidationError(
                    "choices are only allowed with input \"choice\"".into(),
                ))
            }
            _ => {}
        }
        if let Some(t) = self.timeout_ms {
            if !(MIN_HANDOFF_TIMEOUT_MS..=MAX_HANDOFF_TIMEOUT_MS).contains(&t) {
                return Err(ActionValidationError(format!(
                    "timeout_ms must be between {MIN_HANDOFF_TIMEOUT_MS} and {MAX_HANDOFF_TIMEOUT_MS}"
                )));
            }
        }
        if let Some(page) = &self.page {
            if page.url.as_deref().map(str::len).unwrap_or(0) > MAX_URL_LEN
                || page.title.as_deref().map(str::len).unwrap_or(0) > 500
            {
                return Err(ActionValidationError("page url or title too long".into()));
            }
        }
        Ok(())
    }
}

/// The human's answer as visible to readers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HandoffResponse {
    /// The submitted value for `text` and `choice` inputs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// True for `secret` inputs: the value exists but is only available
    /// once through `POST /v1/handoffs/{id}/claim`.
    #[serde(default)]
    pub value_withheld: bool,
    /// Which channel answered (free-form label, e.g. "slack", "web-form").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
}

/// A handoff as reported by the API and in webhook payloads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HandoffView {
    pub id: Uuid,
    pub session_id: Uuid,
    pub host_id: Uuid,
    /// Profile of the session's browser.
    #[serde(default = "default_profile")]
    pub profile: String,
    pub kind: HandoffKind,
    pub prompt: String,
    pub input: HandoffInput,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<HandoffPage>,
    pub status: HandoffStatus,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<HandoffResponse>,
    /// Web viewer of the host's browser, when the host has one: open it to
    /// solve a CAPTCHA or approve a passkey in the remote browser.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewer_url: Option<String>,
}

/// Response to creating a handoff.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreateHandoffResponse {
    pub handoff: HandoffView,
    /// Single-use token any channel can use to answer this handoff.
    pub response_token: String,
    /// Path of the respond endpoint (JSON POST, or GET for an HTML form
    /// with `?token=`).
    pub respond_path: String,
}

/// How the human resolved the handoff.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandoffOutcome {
    #[default]
    Completed,
    Cancelled,
}

/// `POST /v1/handoffs/{id}/respond`
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RespondHandoffRequest {
    #[serde(default)]
    pub outcome: HandoffOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// The handoff's response token (alternatively sent as the
    /// `X-Hexactra-Response-Token` header). Not needed with the API token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_token: Option<String>,
    /// Label of the answering channel, for the record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
}

/// `POST /v1/handoffs/{id}/claim`: the secret value, returned once.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClaimedHandoffValue {
    pub value: String,
}

// ------------------------------------------------------------------------
// Webhooks (epic #186)

/// Event types a webhook can subscribe to.
pub const WEBHOOK_EVENTS: &[&str] = &[
    "handoff.created",
    "handoff.resolved",
    "handoff.cancelled",
    "handoff.expired",
    "webhook.test",
];

/// True if `filter` (`*`, `handoff.*`, or an exact name) selects `event`.
pub fn webhook_filter_matches(filter: &str, event: &str) -> bool {
    filter == "*"
        || filter == event
        || filter
            .strip_suffix(".*")
            .map(|p| event.starts_with(p) && event[p.len()..].starts_with('.'))
            .unwrap_or(false)
}

/// `POST /v1/webhooks`
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CreateWebhookRequest {
    pub url: String,
    /// Event filters; defaults to `["handoff.*"]`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// A webhook endpoint (never includes the secret).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WebhookView {
    pub id: Uuid,
    pub url: String,
    pub events: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// Response to creating a webhook: the signing secret is shown only here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreatedWebhook {
    pub webhook: WebhookView,
    /// Standard Webhooks secret (`whsec_<base64>`).
    pub secret: String,
}

/// One delivery attempt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WebhookDelivery {
    pub event_id: String,
    pub event_type: String,
    pub attempt: u32,
    pub at: DateTime<Utc>,
    /// `succeeded`, `retrying` or `failed`.
    pub outcome: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Error body returned by the `/v1` API.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApiError {
    pub error: String,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn action_wire_format_is_tagged_snake_case() {
        let a: RemoteAction =
            serde_json::from_value(json!({"type": "type", "selector": "#q", "text": "hi"}))
                .unwrap();
        assert_eq!(
            a,
            RemoteAction::Type {
                selector: "#q".into(),
                text: "hi".into(),
                clear: false,
                submit: false,
                tab_id: None
            }
        );
        let v = serde_json::to_value(RemoteAction::WaitFor {
            selector: "a".into(),
            timeout_ms: Some(5),
            tab_id: None,
        })
        .unwrap();
        assert_eq!(
            v,
            json!({"type": "wait_for", "selector": "a", "timeout_ms": 5})
        );
        assert_eq!(
            serde_json::to_value(RemoteAction::Tabs).unwrap(),
            json!({"type": "tabs"})
        );
    }

    #[test]
    fn unknown_action_is_rejected() {
        let r: Result<RemoteAction, _> =
            serde_json::from_value(json!({"type": "execute_script", "script": "1"}));
        assert!(r.is_err());
    }

    #[test]
    fn navigation_policy() {
        for ok in [
            "https://example.test/a",
            "http://localhost:8080",
            "about:blank",
        ] {
            assert!(check_navigable_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "chrome://settings",
            "data:text/html,hi",
            "chrome-extension://abc/x.html",
            "https://",
            "ftp://example.test",
        ] {
            assert!(check_navigable_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn validation_bounds() {
        assert!(RemoteAction::Click {
            selector: " ".into(),
            tab_id: None
        }
        .validate()
        .is_err());
        assert!(RemoteAction::WaitFor {
            selector: "a".into(),
            timeout_ms: Some(MAX_WAIT_MS + 1),
            tab_id: None
        }
        .validate()
        .is_err());
        assert!(RemoteAction::Press {
            key: "Enter".into(),
            selector: None,
            tab_id: None
        }
        .validate()
        .is_ok());
    }

    #[test]
    fn kind_never_contains_content() {
        let a = RemoteAction::Type {
            selector: "#password".into(),
            text: "secret".into(),
            clear: true,
            submit: false,
            tab_id: None,
        };
        assert_eq!(a.kind(), "type");
    }

    #[test]
    fn profile_names() {
        for ok in ["default", "travel", "work-2", "a_b", "9lives"] {
            assert!(valid_profile_name(ok), "{ok}");
        }
        for bad in [
            "",
            "Travel",
            "-x",
            "_x",
            "a/b",
            "..",
            "a b",
            &"x".repeat(33),
        ] {
            assert!(!valid_profile_name(bad), "{bad}");
        }
        let s: SessionView = serde_json::from_value(json!({
            "id": Uuid::nil(), "host_id": Uuid::nil(), "status": "active",
            "created_at": "2026-01-01T00:00:00Z"
        }))
        .unwrap();
        assert_eq!(s.profile, "default");
    }

    #[test]
    fn webhook_filters() {
        assert!(webhook_filter_matches("*", "handoff.created"));
        assert!(webhook_filter_matches("handoff.*", "handoff.expired"));
        assert!(webhook_filter_matches("handoff.created", "handoff.created"));
        assert!(!webhook_filter_matches(
            "handoff.created",
            "handoff.resolved"
        ));
        assert!(!webhook_filter_matches("hand.*", "handoff.created"));
        assert!(!webhook_filter_matches("handoff.*", "webhook.test"));
    }

    #[test]
    fn handoff_request_validation() {
        let base = CreateHandoffRequest {
            kind: HandoffKind::Code,
            prompt: "Enter the code sent to your phone".into(),
            input: HandoffInput::Secret,
            choices: vec![],
            timeout_ms: None,
            page: None,
        };
        assert!(base.validate().is_ok());
        let mut r = base.clone();
        r.prompt = " ".into();
        assert!(r.validate().is_err());
        let mut r = base.clone();
        r.input = HandoffInput::Choice;
        assert!(r.validate().is_err());
        r.choices = vec!["Approve".into(), "Reject".into()];
        assert!(r.validate().is_ok());
        let mut r = base.clone();
        r.choices = vec!["x".into()];
        assert!(r.validate().is_err());
        let mut r = base;
        r.timeout_ms = Some(1);
        assert!(r.validate().is_err());
        let v: CreateHandoffRequest =
            serde_json::from_value(json!({"kind": "captcha", "prompt": "Solve it"})).unwrap();
        assert_eq!(v.input, HandoffInput::None);
    }

    #[test]
    fn terminal_states() {
        assert!(!OperationState::Queued.is_terminal());
        assert!(!OperationState::Dispatched.is_terminal());
        assert!(OperationState::TimedOut.is_terminal());
    }
}
