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
//! Hexactra is a human emulator for its owner (epic #366): the agent may do
//! anything a person at the machine could do. That includes running
//! JavaScript in the page (`evaluate`), trusted mouse and keyboard input by
//! position (`click_at`, `mouse`, `drag`, `scroll_at`, `type_keys`, `key`),
//! marked screenshots for vision, and the node's whole OS desktop
//! (`desktop_*`, executed by the host agent itself, never the extension).

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
/// Maximum JavaScript source a single `evaluate` action may carry.
pub const MAX_SCRIPT_LEN: usize = 200_000;
/// Largest coordinate (CSS or screen pixels) a positional action accepts.
pub const MAX_COORD: i64 = 100_000;
/// Longest key name or chord (`Enter`, `ctrl+shift+t`).
pub const MAX_KEY_LEN: usize = 64;
/// Modifier names accepted by `click_at` and `key`.
pub const MODIFIERS: &[&str] = &["alt", "ctrl", "meta", "shift"];

/// A mouse button.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MouseButton {
    #[default]
    Left,
    Middle,
    Right,
}

impl MouseButton {
    fn is_left(&self) -> bool {
        *self == MouseButton::Left
    }
}

/// A low-level mouse operation (`mouse` action).
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MouseOp {
    /// Move the pointer (hover).
    Move,
    /// Press a button.
    Down,
    /// Release a button.
    Up,
}
/// What the control plane stores, reports and logs in place of a secret
/// typed by `type_secret` or a `type` action with `sensitive: true`.
pub const REDACTED_TEXT: &str = "[secret]";

/// A single bounded browser operation.
///
/// `tab_id` is optional everywhere: when absent the extension uses the active
/// tab of the last focused window.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
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
        /// The text is sensitive (a password, a code): the control plane
        /// sends it to the host but stores and reports it as `[secret]`.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        sensitive: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_id: Option<i64>,
    },
    /// Type the secret a person gave to a `secret` handoff of this session.
    /// The control plane resolves the value itself and consumes it: the
    /// caller never sees it, and the operation is reported without it. The
    /// host receives an ordinary `type` action.
    TypeSecret {
        handoff_id: Uuid,
        selector: String,
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
    /// Capture the visible area of a tab. Result: `{ "mime": ..., "data": <base64> }`
    /// (the control plane swaps `data` for an artifact handle). The image is
    /// in CSS pixels, so its coordinates are the ones `click_at` takes. With
    /// `marks`, interactive elements are boxed and numbered in the image and
    /// the result lists them: `marks: [{ n, selector, x, y, w, h, text }]`.
    Screenshot {
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        marks: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_id: Option<i64>,
    },
    /// Run JavaScript in the page's main world and return its JSON value
    /// (`{ "value": ... }`). The script is an expression or a block whose
    /// last expression is the value; `await_promise` awaits a returned promise.
    Evaluate {
        script: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        await_promise: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_id: Option<i64>,
    },
    /// A trusted click at viewport CSS-pixel coordinates.
    ClickAt {
        x: i64,
        y: i64,
        #[serde(default, skip_serializing_if = "MouseButton::is_left")]
        button: MouseButton,
        /// 2 for a double click.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        click_count: Option<u32>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        modifiers: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_id: Option<i64>,
    },
    /// A trusted pointer move (hover), press or release.
    Mouse {
        op: MouseOp,
        x: i64,
        y: i64,
        #[serde(default, skip_serializing_if = "MouseButton::is_left")]
        button: MouseButton,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_id: Option<i64>,
    },
    /// A trusted drag from one point to another.
    Drag {
        from_x: i64,
        from_y: i64,
        to_x: i64,
        to_y: i64,
        /// Intermediate pointer moves (default 10).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        steps: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_id: Option<i64>,
    },
    /// A trusted mouse-wheel scroll at a point.
    ScrollAt {
        x: i64,
        y: i64,
        #[serde(default)]
        dx: i64,
        #[serde(default)]
        dy: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_id: Option<i64>,
    },
    /// Trusted typing at the focused element, as a keyboard would.
    TypeKeys {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_id: Option<i64>,
    },
    /// One trusted key press, with modifiers (`key: "a", modifiers: ["ctrl"]`).
    Key {
        key: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        modifiers: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_id: Option<i64>,
    },
    /// Capture the node's whole desktop (host agent). Screen pixels.
    DesktopScreenshot,
    /// Click on the node's desktop at screen coordinates (host agent).
    DesktopClick {
        x: i64,
        y: i64,
        #[serde(default, skip_serializing_if = "MouseButton::is_left")]
        button: MouseButton,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        click_count: Option<u32>,
    },
    /// Move the desktop pointer (host agent).
    DesktopMove { x: i64, y: i64 },
    /// Drag on the desktop (host agent).
    DesktopDrag {
        from_x: i64,
        from_y: i64,
        to_x: i64,
        to_y: i64,
    },
    /// Type text into whatever has the desktop focus (host agent).
    DesktopType { text: String },
    /// Press a key chord on the desktop, xdotool style: `Return`, `ctrl+l`,
    /// `alt+F4` (host agent).
    DesktopKey { key: String },
    /// Scroll the desktop by wheel clicks, optionally after moving to a point
    /// (host agent). Positive `dy` scrolls down.
    DesktopScroll {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        x: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        y: Option<i64>,
        dy: i64,
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

/// Any URL a person could type in the address bar may be opened (`http(s)`,
/// `file:`, `chrome:`, `data:`, `about:`, extension pages...), except
/// `javascript:`: run script with `evaluate` instead.
pub fn check_navigable_url(url: &str) -> Result<(), ActionValidationError> {
    if url.len() > MAX_URL_LEN {
        return Err(ActionValidationError(format!(
            "url longer than {MAX_URL_LEN} characters"
        )));
    }
    let lower = url.trim().to_ascii_lowercase();
    if lower.starts_with("javascript:") {
        return Err(ActionValidationError(
            "javascript: URLs are not opened: use the evaluate action".into(),
        ));
    }
    let Some(colon) = lower.find(':') else {
        return Err(ActionValidationError("url has no scheme".into()));
    };
    let scheme = &lower[..colon];
    if scheme.is_empty()
        || !scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
    {
        return Err(ActionValidationError("url has no valid scheme".into()));
    }
    if scheme == "http" || scheme == "https" {
        let rest = &lower[colon + 1..];
        let host = rest.strip_prefix("//").unwrap_or(rest);
        if host.is_empty() || host.starts_with('/') {
            return Err(ActionValidationError("url has no host".into()));
        }
    }
    Ok(())
}

fn check_point(x: i64, y: i64) -> Result<(), ActionValidationError> {
    if !(0..=MAX_COORD).contains(&x) || !(0..=MAX_COORD).contains(&y) {
        return Err(ActionValidationError(format!(
            "coordinates must be between 0 and {MAX_COORD}"
        )));
    }
    Ok(())
}

fn check_delta(d: i64) -> Result<(), ActionValidationError> {
    if d.abs() > MAX_COORD {
        return Err(ActionValidationError(format!(
            "scroll delta must be at most {MAX_COORD}"
        )));
    }
    Ok(())
}

fn check_key(key: &str) -> Result<(), ActionValidationError> {
    if key.is_empty() || key.len() > MAX_KEY_LEN {
        return Err(ActionValidationError(format!(
            "key must be 1-{MAX_KEY_LEN} characters"
        )));
    }
    if key.chars().any(char::is_control) {
        return Err(ActionValidationError(
            "key must not contain control characters".into(),
        ));
    }
    Ok(())
}

fn check_modifiers(modifiers: &[String]) -> Result<(), ActionValidationError> {
    for m in modifiers {
        if !MODIFIERS.contains(&m.as_str()) {
            return Err(ActionValidationError(format!(
                "unknown modifier {m:?}: use {}",
                MODIFIERS.join(", ")
            )));
        }
    }
    Ok(())
}

fn check_text(text: &str) -> Result<(), ActionValidationError> {
    if text.len() > MAX_TYPE_TEXT_LEN {
        return Err(ActionValidationError(format!(
            "text longer than {MAX_TYPE_TEXT_LEN} characters"
        )));
    }
    Ok(())
}

fn check_clicks(click_count: Option<u32>) -> Result<(), ActionValidationError> {
    match click_count {
        Some(n) if n == 0 || n > 3 => Err(ActionValidationError(
            "click_count must be 1, 2 or 3".into(),
        )),
        _ => Ok(()),
    }
}

impl RemoteAction {
    /// Short, content-free name used in logs and telemetry. Never includes
    /// typed text, selectors or URLs.
    pub fn kind(&self) -> &'static str {
        match self {
            RemoteAction::Navigate { .. } => "navigate",
            RemoteAction::Click { .. } => "click",
            RemoteAction::Type { .. } => "type",
            RemoteAction::TypeSecret { .. } => "type_secret",
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
            RemoteAction::Evaluate { .. } => "evaluate",
            RemoteAction::ClickAt { .. } => "click_at",
            RemoteAction::Mouse { .. } => "mouse",
            RemoteAction::Drag { .. } => "drag",
            RemoteAction::ScrollAt { .. } => "scroll_at",
            RemoteAction::TypeKeys { .. } => "type_keys",
            RemoteAction::Key { .. } => "key",
            RemoteAction::DesktopScreenshot => "desktop_screenshot",
            RemoteAction::DesktopClick { .. } => "desktop_click",
            RemoteAction::DesktopMove { .. } => "desktop_move",
            RemoteAction::DesktopDrag { .. } => "desktop_drag",
            RemoteAction::DesktopType { .. } => "desktop_type",
            RemoteAction::DesktopKey { .. } => "desktop_key",
            RemoteAction::DesktopScroll { .. } => "desktop_scroll",
        }
    }

    /// Whether the host agent executes this action on its OS desktop itself,
    /// instead of handing it to the browser extension.
    pub fn is_desktop(&self) -> bool {
        matches!(
            self,
            RemoteAction::DesktopScreenshot
                | RemoteAction::DesktopClick { .. }
                | RemoteAction::DesktopMove { .. }
                | RemoteAction::DesktopDrag { .. }
                | RemoteAction::DesktopType { .. }
                | RemoteAction::DesktopKey { .. }
                | RemoteAction::DesktopScroll { .. }
        )
    }

    /// Whether a successful result carries an image (`mime` + base64 `data`)
    /// that the control plane moves into the artifact store.
    pub fn returns_image(&self) -> bool {
        matches!(
            self,
            RemoteAction::Screenshot { .. } | RemoteAction::DesktopScreenshot
        )
    }

    /// Validate bounds and URL policy before an action is queued.
    pub fn validate(&self) -> Result<(), ActionValidationError> {
        match self {
            RemoteAction::Navigate { url, .. } => check_navigable_url(url),
            RemoteAction::NewTab { url: Some(url) } => check_navigable_url(url),
            RemoteAction::Click { selector, .. } | RemoteAction::TypeSecret { selector, .. } => {
                check_selector(selector)
            }
            RemoteAction::Type { selector, text, .. } => {
                check_selector(selector)?;
                check_text(text)
            }
            RemoteAction::Evaluate { script, .. } => {
                if script.trim().is_empty() {
                    return Err(ActionValidationError("script must not be empty".into()));
                }
                if script.len() > MAX_SCRIPT_LEN {
                    return Err(ActionValidationError(format!(
                        "script longer than {MAX_SCRIPT_LEN} characters"
                    )));
                }
                Ok(())
            }
            RemoteAction::ClickAt {
                x,
                y,
                click_count,
                modifiers,
                ..
            } => {
                check_point(*x, *y)?;
                check_clicks(*click_count)?;
                check_modifiers(modifiers)
            }
            RemoteAction::Mouse { x, y, .. } | RemoteAction::DesktopMove { x, y } => {
                check_point(*x, *y)
            }
            RemoteAction::Drag {
                from_x,
                from_y,
                to_x,
                to_y,
                steps,
                ..
            } => {
                check_point(*from_x, *from_y)?;
                check_point(*to_x, *to_y)?;
                if steps.unwrap_or(1) == 0 || steps.unwrap_or(1) > 100 {
                    return Err(ActionValidationError("steps must be 1-100".into()));
                }
                Ok(())
            }
            RemoteAction::DesktopDrag {
                from_x,
                from_y,
                to_x,
                to_y,
            } => {
                check_point(*from_x, *from_y)?;
                check_point(*to_x, *to_y)
            }
            RemoteAction::ScrollAt { x, y, dx, dy, .. } => {
                check_point(*x, *y)?;
                check_delta(*dx)?;
                check_delta(*dy)
            }
            RemoteAction::TypeKeys { text, .. } | RemoteAction::DesktopType { text } => {
                if text.is_empty() {
                    return Err(ActionValidationError("text must not be empty".into()));
                }
                check_text(text)
            }
            RemoteAction::Key { key, modifiers, .. } => {
                check_key(key)?;
                check_modifiers(modifiers)
            }
            RemoteAction::DesktopKey { key } => check_key(key),
            RemoteAction::DesktopClick {
                x, y, click_count, ..
            } => {
                check_point(*x, *y)?;
                check_clicks(*click_count)
            }
            RemoteAction::DesktopScroll { x, y, dy } => {
                if let (Some(x), Some(y)) = (x, y) {
                    check_point(*x, *y)?;
                }
                if x.is_some() != y.is_some() {
                    return Err(ActionValidationError(
                        "give both x and y, or neither".into(),
                    ));
                }
                if dy.abs() > 100 {
                    return Err(ActionValidationError(
                        "dy must be at most 100 wheel clicks".into(),
                    ));
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
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
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
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
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
    /// Top-level navigations the browser blocked under the session's allowed
    /// sites since the previous action on this browser (#508).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub navigation_blocked: Vec<BlockedNavigation>,
}

/// A top-level navigation the browser refused because its host is not in the
/// session's allowed sites (#508). Only the host is kept, never the full URL.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockedNavigation {
    pub host: String,
    /// When the browser blocked it.
    pub at: DateTime<Utc>,
}

/// Session status.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteSessionStatus {
    Active,
    Ended,
}

/// A remote-control session bound to one host.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
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
    /// The session's allowed sites, normalized (#508). Empty: any site.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_domains: Vec<String>,
}

/// Who opens a remote desktop (from the console: the signed-in person).
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesktopActor {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

/// `POST /v1/hosts/{id}/desktop-sessions`
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateDesktopSessionRequest {
    #[serde(default)]
    pub actor: DesktopActor,
}

/// A desktop tunnel waiting for its viewer. `connect_token` is shown once:
/// the viewer presents it as `Authorization: Bearer` on
/// `GET /v1/desktop/{tunnel_id}/connect` (WebSocket) within 30 seconds.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesktopSession {
    pub tunnel_id: Uuid,
    pub host_id: Uuid,
    pub connect_token: String,
    pub expires_at: DateTime<Utc>,
}

/// Where [`HostCommand::ShowProfile`] opens by default: the Google sign-in.
pub const SHOW_PROFILE_DEFAULT_URL: &str = "https://accounts.google.com/";

/// How a host runs its browsers (#336, docs/nodes.md).
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostMode {
    /// Its own persistent desktop, nobody logged in; one browser per profile.
    Unattended,
    /// The person's own logged-in desktop and Chrome.
    Attended,
    /// A container with a virtual display (the bundled VPS host).
    Container,
}

impl HostMode {
    pub fn as_str(self) -> &'static str {
        match self {
            HostMode::Unattended => "unattended",
            HostMode::Attended => "attended",
            HostMode::Container => "container",
        }
    }
}

impl std::str::FromStr for HostMode {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "unattended" => Ok(HostMode::Unattended),
            "attended" => Ok(HostMode::Attended),
            "container" => Ok(HostMode::Container),
            other => Err(format!(
                "unknown host mode '{other}' (expected unattended, attended or container)"
            )),
        }
    }
}

/// A host agent as seen by the control plane.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
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
    /// Deprecated: the console's desktop viewer replaces it (#339).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewer_url: Option<String>,
    /// How the host runs its browsers; absent for agents older than #336.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<HostMode>,
    /// The host can share its desktop through the fabric (#338).
    #[serde(default)]
    pub desktop: bool,
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
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
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
    /// Sites the session may load as top-level pages (#508): a listed domain
    /// covers its subdomains, an IP literal only itself. Empty: any site.
    /// The browser blocks every other top-level navigation, including ones a
    /// page starts itself, and reports it as `navigation_blocked`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_domains: Vec<String>,
}

/// `POST /v1/sessions/{id}/actions`
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
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
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RegisterHostRequest {
    pub name: String,
    pub version: String,
    /// Re-register with a previously issued id to keep sessions bound to it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<Uuid>,
    /// Web viewer for this host's browser (`http(s)` URL), shown to people
    /// answering handoffs. Deprecated (#339).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewer_url: Option<String>,
    /// How the host runs its browsers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<HostMode>,
    /// The host has a local desktop it can share through the fabric.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub desktop: bool,
}

/// Response to host registration.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RegisterHostResponse {
    pub host_id: Uuid,
}

/// An operation handed to a host agent by `GET /v1/hosts/{id}/next`.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
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
    /// The session's allowed sites (#508); the host hands them to the browser
    /// with the action. Empty: any site.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_domains: Vec<String>,
}

/// `POST /v1/operations/{id}/result`
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OperationResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Navigations the browser blocked under the session's allowed sites
    /// since the previous action (#508).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub navigation_blocked: Vec<BlockedNavigation>,
}

// ------------------------------------------------------------------------
// Host commands (#213)

/// Default and longest time a host command may take.
pub const DEFAULT_HOST_COMMAND_TIMEOUT_MS: u64 = 60_000;
pub const MAX_HOST_COMMAND_TIMEOUT_MS: u64 = 5 * 60_000;

/// A management command for a host rather than an action in a session.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
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
    /// Start the profile's browser and open `url` in a new tab (default: the
    /// Google sign-in page), so a person signs in through the remote desktop
    /// (#340). Closing the browser afterwards saves the sign-in.
    ShowProfile {
        profile: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
    },
    /// Stop (or resume) placing new sessions on the host. Existing sessions
    /// keep working. Handled by the control plane; never sent to the host.
    Drain {
        #[serde(default = "default_true")]
        enabled: bool,
    },
    /// Connect this host's local desktop server to the fabric for a remote
    /// desktop tunnel (#338): the agent opens
    /// `GET /v1/hosts/{host_id}/desktop/{tunnel_id}` with its own credential.
    /// Issued only by `POST /v1/hosts/{id}/desktop-sessions`.
    OpenDesktop {
        tunnel_id: Uuid,
        expires_at: DateTime<Utc>,
        /// Who asked, for the attended desktop's on-screen notice.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        actor_display_name: Option<String>,
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
            HostCommand::ShowProfile { .. } => "show_profile",
            HostCommand::Drain { .. } => "drain",
            HostCommand::OpenDesktop { .. } => "open_desktop",
        }
    }

    /// Profile the command targets, if any.
    pub fn profile(&self) -> Option<&str> {
        match self {
            HostCommand::CreateProfile { profile }
            | HostCommand::DeleteProfile { profile }
            | HostCommand::RestartBrowser { profile }
            | HostCommand::CloseBrowser { profile }
            | HostCommand::ShowProfile { profile, .. } => Some(profile),
            HostCommand::Drain { .. } | HostCommand::OpenDesktop { .. } => None,
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
        if let HostCommand::ShowProfile { url: Some(url), .. } = self {
            check_navigable_url(url)?;
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
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostCommandRequest {
    pub command: HostCommand,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

/// A host command as reported to clients. States are those of operations.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
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
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
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
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
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
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
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
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandoffInput {
    /// Nothing: the human acts in the browser and marks the handoff done.
    #[default]
    None,
    /// Free text returned to the agent (`constraints`: `max_length`,
    /// `pattern`, `multiline`).
    Text,
    /// Sensitive text (e.g. a one-time code): returned once to the API
    /// caller via `claim`, never shown in reads, logs or webhook payloads
    /// (`constraints`: `max_length`).
    Secret,
    /// One of `choices`: the answer's `value` is the option id.
    Choice,
    /// Several of `choices`: the answer's `values` are option ids
    /// (`constraints`: `min_selections`, `max_selections`).
    MultiChoice,
    /// A number, answered as a decimal string (`constraints`: `min`, `max`,
    /// `step`, `unit`).
    Number,
    /// Approve or deny: the answer's `value` is `approve` or `deny`
    /// (`confirm_label`, `deny_label`, `risk`).
    Confirm,
    /// The human takes over the browser and marks the handoff done.
    Takeover,
}

impl HandoffInput {
    /// True for inputs answered with `choices`.
    pub fn has_choices(self) -> bool {
        matches!(self, HandoffInput::Choice | HandoffInput::MultiChoice)
    }

    /// True for inputs answered without any value (`none`, `takeover`).
    pub fn is_valueless(self) -> bool {
        matches!(self, HandoffInput::None | HandoffInput::Takeover)
    }

    fn name(self) -> &'static str {
        match self {
            HandoffInput::None => "none",
            HandoffInput::Text => "text",
            HandoffInput::Secret => "secret",
            HandoffInput::Choice => "choice",
            HandoffInput::MultiChoice => "multi_choice",
            HandoffInput::Number => "number",
            HandoffInput::Confirm => "confirm",
            HandoffInput::Takeover => "takeover",
        }
    }
}

/// Lifecycle of a handoff.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
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
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HandoffPage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// Most options a `choice` or `multi_choice` question may offer.
pub const MAX_HANDOFF_CHOICES: usize = 10;
/// Longest regex a `text` question may carry as its `pattern`.
pub const MAX_HANDOFF_PATTERN: usize = 200;
/// Longest `answered_by` label an authenticated caller may record.
pub const MAX_HANDOFF_ANSWERED_BY: usize = 128;

/// One option of a `choice` or `multi_choice` question, as returned.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandoffChoice {
    /// What the answer carries (exact match).
    pub id: String,
    /// What the human sees.
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// An option as a caller may send it: a bare string (used as both id and
/// label) or `{id, label, description?}`.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum HandoffChoiceSpec {
    /// A bare label, also used as the id.
    Label(String),
    /// An option with its own id.
    Option(HandoffChoice),
}

impl From<&str> for HandoffChoiceSpec {
    fn from(s: &str) -> Self {
        HandoffChoiceSpec::Label(s.to_string())
    }
}

impl From<String> for HandoffChoiceSpec {
    fn from(s: String) -> Self {
        HandoffChoiceSpec::Label(s)
    }
}

impl From<HandoffChoice> for HandoffChoiceSpec {
    fn from(c: HandoffChoice) -> Self {
        HandoffChoiceSpec::Option(c)
    }
}

impl HandoffChoiceSpec {
    /// The option in its returned (object) form.
    pub fn to_choice(&self) -> HandoffChoice {
        match self {
            HandoffChoiceSpec::Label(s) => HandoffChoice {
                id: s.clone(),
                label: s.clone(),
                description: None,
            },
            HandoffChoiceSpec::Option(c) => c.clone(),
        }
    }
}

/// Saved handoffs (before typed questions) store choices as bare strings;
/// read either form.
fn de_choices<'de, D>(d: D) -> Result<Vec<HandoffChoice>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v: Vec<HandoffChoiceSpec> = Deserialize::deserialize(d)?;
    Ok(v.iter().map(HandoffChoiceSpec::to_choice).collect())
}

/// How risky approving a `confirm` question is (a UI hint).
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandoffRisk {
    Low,
    #[default]
    High,
}

/// Bounds on an answer. Each field applies only to some inputs; sending one
/// that does not apply is a validation error.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HandoffConstraints {
    /// `text` (1-4096, default 4096) and `secret`: longest answer in characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_length: Option<u32>,
    /// `text`: regex the whole answer must match (at most 200 characters).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    /// `text`: show a multi-line box; when `false`, newlines are rejected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multiline: Option<bool>,
    /// `number`: smallest accepted value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    /// `number`: largest accepted value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    /// `number`: the answer must be `min` (or 0) plus a multiple of `step`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<f64>,
    /// `number`: unit shown next to the field (at most 20 characters).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    /// `multi_choice`: fewest options to select (default 1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_selections: Option<u32>,
    /// `multi_choice`: most options to select (default: all of them).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_selections: Option<u32>,
}

impl HandoffConstraints {
    pub fn is_empty(&self) -> bool {
        self == &HandoffConstraints::default()
    }

    /// Names of the constraints that are set.
    fn set_names(&self) -> Vec<&'static str> {
        let mut v = Vec::new();
        if self.max_length.is_some() {
            v.push("max_length");
        }
        if self.pattern.is_some() {
            v.push("pattern");
        }
        if self.multiline.is_some() {
            v.push("multiline");
        }
        if self.min.is_some() {
            v.push("min");
        }
        if self.max.is_some() {
            v.push("max");
        }
        if self.step.is_some() {
            v.push("step");
        }
        if self.unit.is_some() {
            v.push("unit");
        }
        if self.min_selections.is_some() {
            v.push("min_selections");
        }
        if self.max_selections.is_some() {
            v.push("max_selections");
        }
        v
    }

    /// Effective longest text answer.
    pub fn text_max_length(&self) -> usize {
        self.max_length
            .map(|n| n as usize)
            .unwrap_or(MAX_HANDOFF_VALUE)
    }

    /// Effective `(min, max)` selections for `n` choices.
    pub fn selection_bounds(&self, n: usize) -> (usize, usize) {
        (
            self.min_selections.map(|v| v as usize).unwrap_or(1),
            self.max_selections.map(|v| v as usize).unwrap_or(n),
        )
    }
}

fn invalid<T>(msg: impl Into<String>) -> Result<T, ActionValidationError> {
    Err(ActionValidationError(msg.into()))
}

fn valid_choice_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Compile a `text` pattern with full-match semantics.
pub fn compile_handoff_pattern(pattern: &str) -> Result<regex::Regex, ActionValidationError> {
    if pattern.is_empty() || pattern.chars().count() > MAX_HANDOFF_PATTERN {
        return invalid(format!(
            "pattern must be 1-{MAX_HANDOFF_PATTERN} characters"
        ));
    }
    regex::RegexBuilder::new(&format!("^(?:{pattern})$"))
        .size_limit(1 << 20)
        .build()
        .map_err(|e| ActionValidationError(format!("pattern is not a valid regex: {e}")))
}

/// `POST /v1/sessions/{id}/handoffs`
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreateHandoffRequest {
    pub kind: HandoffKind,
    /// What the human should do, in plain words.
    pub prompt: String,
    #[serde(default)]
    pub input: HandoffInput,
    /// Options for `choice` and `multi_choice` (1-10): bare strings or
    /// `{id, label, description?}` objects.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<HandoffChoiceSpec>,
    /// Bounds on the answer (see `HandoffConstraints`).
    #[serde(default, skip_serializing_if = "HandoffConstraints::is_empty")]
    pub constraints: HandoffConstraints,
    /// `confirm`: label of the approve button (at most 40 characters).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_label: Option<String>,
    /// `confirm`: label of the deny button (at most 40 characters).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deny_label: Option<String>,
    /// `confirm`: how risky approving is (default `high`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk: Option<HandoffRisk>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<HandoffPage>,
}

impl CreateHandoffRequest {
    /// A request with no options or constraints.
    pub fn new(kind: HandoffKind, prompt: impl Into<String>, input: HandoffInput) -> Self {
        Self {
            kind,
            prompt: prompt.into(),
            input,
            choices: vec![],
            constraints: HandoffConstraints::default(),
            confirm_label: None,
            deny_label: None,
            risk: None,
            timeout_ms: None,
            page: None,
        }
    }

    /// Validate bounds before the handoff is created.
    pub fn validate(&self) -> Result<(), ActionValidationError> {
        let p = self.prompt.trim();
        if p.is_empty() || p.len() > MAX_HANDOFF_PROMPT {
            return invalid(format!("prompt must be 1-{MAX_HANDOFF_PROMPT} characters"));
        }
        self.validate_choices()?;
        self.validate_constraints()?;
        self.validate_confirm()?;
        if let Some(t) = self.timeout_ms {
            if !(MIN_HANDOFF_TIMEOUT_MS..=MAX_HANDOFF_TIMEOUT_MS).contains(&t) {
                return invalid(format!(
                    "timeout_ms must be between {MIN_HANDOFF_TIMEOUT_MS} and {MAX_HANDOFF_TIMEOUT_MS}"
                ));
            }
        }
        if let Some(page) = &self.page {
            if page.url.as_deref().map(str::len).unwrap_or(0) > MAX_URL_LEN
                || page.title.as_deref().map(str::len).unwrap_or(0) > 500
            {
                return invalid("page url or title too long");
            }
        }
        Ok(())
    }

    fn validate_choices(&self) -> Result<(), ActionValidationError> {
        if !self.input.has_choices() {
            if !self.choices.is_empty() {
                return invalid(
                    "choices are only allowed with input \"choice\" or \"multi_choice\"",
                );
            }
            return Ok(());
        }
        if self.choices.is_empty() || self.choices.len() > MAX_HANDOFF_CHOICES {
            return invalid(format!(
                "{} input needs 1-{MAX_HANDOFF_CHOICES} choices",
                self.input.name()
            ));
        }
        let mut ids = std::collections::HashSet::new();
        for c in &self.choices {
            let id = match c {
                HandoffChoiceSpec::Label(s) => {
                    if s.trim().is_empty() || s.chars().count() > 100 {
                        return invalid("each choice must be 1-100 characters");
                    }
                    s
                }
                HandoffChoiceSpec::Option(o) => {
                    if !valid_choice_id(&o.id) {
                        return invalid(format!(
                            "choice id {:?} must match [A-Za-z0-9_-]{{1,64}}",
                            o.id
                        ));
                    }
                    if o.label.trim().is_empty() || o.label.chars().count() > 100 {
                        return invalid("each choice label must be 1-100 characters");
                    }
                    if o.description
                        .as_deref()
                        .map(|d| d.chars().count())
                        .unwrap_or(0)
                        > 200
                    {
                        return invalid("a choice description must be at most 200 characters");
                    }
                    &o.id
                }
            };
            if !ids.insert(id.as_str()) {
                return invalid(format!("duplicate choice id {id:?}"));
            }
        }
        Ok(())
    }

    fn validate_constraints(&self) -> Result<(), ActionValidationError> {
        let c = &self.constraints;
        let allowed: &[&str] = match self.input {
            HandoffInput::Text => &["max_length", "pattern", "multiline"],
            HandoffInput::Secret => &["max_length"],
            HandoffInput::Number => &["min", "max", "step", "unit"],
            HandoffInput::MultiChoice => &["min_selections", "max_selections"],
            _ => &[],
        };
        if let Some(bad) = c.set_names().into_iter().find(|n| !allowed.contains(n)) {
            return invalid(format!(
                "constraint {bad} does not apply to input \"{}\"",
                self.input.name()
            ));
        }
        if let Some(n) = c.max_length {
            if !(1..=MAX_HANDOFF_VALUE as u32).contains(&n) {
                return invalid(format!("max_length must be 1-{MAX_HANDOFF_VALUE}"));
            }
        }
        if let Some(p) = &c.pattern {
            compile_handoff_pattern(p)?;
        }
        for (name, v) in [("min", c.min), ("max", c.max), ("step", c.step)] {
            if v.is_some_and(|v| !v.is_finite()) {
                return invalid(format!("{name} must be a finite number"));
            }
        }
        if let (Some(min), Some(max)) = (c.min, c.max) {
            if min > max {
                return invalid("min must not be greater than max");
            }
        }
        if c.step.is_some_and(|s| s <= 0.0) {
            return invalid("step must be greater than 0");
        }
        if let Some(u) = &c.unit {
            if u.trim().is_empty() || u.chars().count() > 20 {
                return invalid("unit must be 1-20 characters");
            }
        }
        if self.input == HandoffInput::MultiChoice {
            let n = self.choices.len();
            let (min, max) = c.selection_bounds(n);
            if max < 1 || max > n {
                return invalid(format!("max_selections must be 1-{n}"));
            }
            if min > max {
                return invalid("min_selections must not be greater than max_selections");
            }
        }
        Ok(())
    }

    fn validate_confirm(&self) -> Result<(), ActionValidationError> {
        let set = self.confirm_label.is_some() || self.deny_label.is_some() || self.risk.is_some();
        if self.input != HandoffInput::Confirm {
            if set {
                return invalid(
                    "confirm_label, deny_label and risk are only allowed with input \"confirm\"",
                );
            }
            return Ok(());
        }
        for (name, l) in [
            ("confirm_label", &self.confirm_label),
            ("deny_label", &self.deny_label),
        ] {
            if let Some(l) = l {
                if l.trim().is_empty() || l.chars().count() > 40 {
                    return invalid(format!("{name} must be 1-40 characters"));
                }
            }
        }
        Ok(())
    }
}

/// The human's answer as visible to readers.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HandoffResponse {
    /// `completed`, or `cancelled` when the human declined. A `deny` on a
    /// `confirm` question is a completed answer.
    #[serde(default)]
    pub outcome: HandoffOutcome,
    /// The answer for `text`, `choice` (option id), `number` (canonical
    /// decimal string) and `confirm` (`approve` or `deny`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// The selected option ids for `multi_choice`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<String>>,
    /// True for `secret` inputs: the value is never returned. Type it into
    /// the page with a `type_secret` action naming this handoff; the
    /// control plane consumes it once.
    #[serde(default)]
    pub value_withheld: bool,
    /// Which channel answered (free-form label, e.g. "slack", "web-form").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    /// Who answered: `operator`, `service:<name>`, `token` (a response-token
    /// holder), or the `answered_by` an authenticated caller recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answered_at: Option<DateTime<Utc>>,
}

/// A handoff as reported by the API and in webhook payloads.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
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
    /// Options for `choice` and `multi_choice`, always as objects.
    #[serde(
        default,
        skip_serializing_if = "Vec::is_empty",
        deserialize_with = "de_choices"
    )]
    pub choices: Vec<HandoffChoice>,
    #[serde(default, skip_serializing_if = "HandoffConstraints::is_empty")]
    pub constraints: HandoffConstraints,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deny_label: Option<String>,
    /// Set for `confirm` (default `high`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk: Option<HandoffRisk>,
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

/// A validated answer to a handoff's question.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HandoffAnswer {
    pub value: Option<String>,
    pub values: Option<Vec<String>>,
}

/// Format a number answer canonically (`1.5`, `100`, `-0.25`).
fn canonical_number(v: f64) -> String {
    let v = if v == 0.0 { 0.0 } else { v };
    format!("{v}")
}

impl HandoffView {
    /// Check a completed answer against the question. Values are trimmed;
    /// a `number` comes back in canonical form.
    pub fn check_answer(
        &self,
        value: Option<String>,
        values: Option<Vec<String>>,
    ) -> Result<HandoffAnswer, ActionValidationError> {
        let value = value
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let values: Option<Vec<String>> =
            values.map(|vs| vs.into_iter().map(|v| v.trim().to_string()).collect());
        if self.input != HandoffInput::MultiChoice && values.as_ref().is_some_and(|v| !v.is_empty())
        {
            return invalid(format!(
                "values are only accepted for input \"multi_choice\"; send value for \"{}\"",
                self.input.name()
            ));
        }
        let c = &self.constraints;
        let need = |what: &str| ActionValidationError(format!("this handoff needs {what}"));
        let v = match self.input {
            HandoffInput::None | HandoffInput::Takeover => {
                if value.is_some() {
                    return invalid(format!(
                        "input \"{}\" takes no value: mark it done",
                        self.input.name()
                    ));
                }
                return Ok(HandoffAnswer::default());
            }
            HandoffInput::MultiChoice => {
                if value.is_some() {
                    return invalid("multi_choice is answered with values, not value");
                }
                let vs = values.unwrap_or_default();
                let mut seen = std::collections::HashSet::new();
                for v in &vs {
                    if !self.choices.iter().any(|c| &c.id == v) {
                        return invalid(format!("{v:?} is not one of the choices"));
                    }
                    if !seen.insert(v.as_str()) {
                        return invalid(format!("{v:?} is selected more than once"));
                    }
                }
                let (min, max) = c.selection_bounds(self.choices.len());
                if vs.len() < min || vs.len() > max {
                    return invalid(format!("select between {min} and {max} choices"));
                }
                return Ok(HandoffAnswer {
                    value: None,
                    values: Some(vs),
                });
            }
            HandoffInput::Text => {
                let v = value.ok_or_else(|| need("a value"))?;
                if v.chars().count() > c.text_max_length() {
                    return invalid(format!(
                        "value longer than {} characters",
                        c.text_max_length()
                    ));
                }
                if c.multiline == Some(false) && v.contains(['\n', '\r']) {
                    return invalid("value must be a single line");
                }
                if let Some(p) = &c.pattern {
                    if !compile_handoff_pattern(p)?.is_match(&v) {
                        return invalid("value does not match the required format");
                    }
                }
                v
            }
            HandoffInput::Secret => {
                let v = value.ok_or_else(|| need("a value"))?;
                if v.chars().count() > c.text_max_length() {
                    return invalid(format!(
                        "value longer than {} characters",
                        c.text_max_length()
                    ));
                }
                v
            }
            HandoffInput::Choice => {
                let v = value.ok_or_else(|| need("a choice"))?;
                if !self.choices.iter().any(|c| c.id == v) {
                    return invalid("value is not one of the choices");
                }
                v
            }
            HandoffInput::Number => {
                let raw = value.ok_or_else(|| need("a number"))?;
                let n: f64 = raw
                    .parse()
                    .ok()
                    .filter(|n: &f64| n.is_finite())
                    .ok_or_else(|| ActionValidationError("value must be a finite number".into()))?;
                if c.min.is_some_and(|m| n < m) || c.max.is_some_and(|m| n > m) {
                    return invalid(format!(
                        "value must be between {} and {}",
                        c.min.map(canonical_number).unwrap_or_else(|| "-inf".into()),
                        c.max.map(canonical_number).unwrap_or_else(|| "inf".into())
                    ));
                }
                if let Some(step) = c.step {
                    let k = (n - c.min.unwrap_or(0.0)) / step;
                    if (k - k.round()).abs() > 1e-9 * k.abs().max(1.0) {
                        return invalid(format!(
                            "value must be a multiple of {} (from {})",
                            canonical_number(step),
                            canonical_number(c.min.unwrap_or(0.0))
                        ));
                    }
                }
                canonical_number(n)
            }
            HandoffInput::Confirm => {
                let v = value.ok_or_else(|| need("approve or deny"))?;
                if v != "approve" && v != "deny" {
                    return invalid("value must be \"approve\" or \"deny\"");
                }
                v
            }
        };
        Ok(HandoffAnswer {
            value: Some(v),
            values: None,
        })
    }
}

/// Response to creating a handoff.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
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
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandoffOutcome {
    #[default]
    Completed,
    Cancelled,
}

/// `POST /v1/handoffs/{id}/respond`
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RespondHandoffRequest {
    #[serde(default)]
    pub outcome: HandoffOutcome,
    /// The answer for `text`, `secret`, `choice` (option id), `number`
    /// (decimal string) and `confirm` (`approve` or `deny`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// The selected option ids for `multi_choice`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<String>>,
    /// The handoff's response token (alternatively sent as the
    /// `X-Hexactra-Response-Token` header). Not needed with the API token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_token: Option<String>,
    /// Label of the answering channel, for the record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    /// Who answered (e.g. `user:<id>`, at most 128 characters), recorded as
    /// the response's `by`. Honoured only with an operator or service
    /// token; ignored for response-token answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answered_by: Option<String>,
}

/// `POST /v1/handoffs/{id}/claim` (deprecated): the secret value, returned
/// once. Use a `type_secret` action instead, which never returns it.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
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
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
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
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
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
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreatedWebhook {
    pub webhook: WebhookView,
    /// Standard Webhooks secret (`whsec_<base64>`).
    pub secret: String,
}

/// One delivery attempt.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
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
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
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
                sensitive: false,
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
    fn full_power_actions_round_trip() {
        // Wire shapes of the human-emulator actions (#366).
        for v in [
            json!({"type": "evaluate", "script": "document.title"}),
            json!({"type": "evaluate", "script": "await fetch('/x')", "await_promise": true, "tab_id": 3}),
            json!({"type": "click_at", "x": 10, "y": 20}),
            json!({"type": "click_at", "x": 10, "y": 20, "button": "right", "click_count": 2, "modifiers": ["ctrl", "shift"]}),
            json!({"type": "mouse", "op": "move", "x": 1, "y": 2}),
            json!({"type": "mouse", "op": "down", "x": 1, "y": 2, "button": "middle"}),
            json!({"type": "drag", "from_x": 1, "from_y": 2, "to_x": 30, "to_y": 40, "steps": 5}),
            json!({"type": "scroll_at", "x": 100, "y": 100, "dx": 0, "dy": 400}),
            json!({"type": "type_keys", "text": "hello"}),
            json!({"type": "key", "key": "a", "modifiers": ["ctrl"]}),
            json!({"type": "screenshot", "marks": true}),
            json!({"type": "desktop_screenshot"}),
            json!({"type": "desktop_click", "x": 5, "y": 6, "button": "right"}),
            json!({"type": "desktop_move", "x": 5, "y": 6}),
            json!({"type": "desktop_drag", "from_x": 1, "from_y": 2, "to_x": 3, "to_y": 4}),
            json!({"type": "desktop_type", "text": "/home/user/report.pdf"}),
            json!({"type": "desktop_key", "key": "ctrl+l"}),
            json!({"type": "desktop_scroll", "x": 5, "y": 6, "dy": -3}),
        ] {
            let a: RemoteAction =
                serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{v}: {e}"));
            assert_eq!(serde_json::to_value(&a).unwrap(), v);
            assert!(a.validate().is_ok(), "{v}");
            assert_eq!(a.kind(), v["type"].as_str().unwrap());
        }
        let plain: RemoteAction = serde_json::from_value(json!({"type": "screenshot"})).unwrap();
        assert_eq!(
            plain,
            RemoteAction::Screenshot {
                marks: false,
                tab_id: None
            }
        );
        assert_eq!(
            serde_json::to_value(&plain).unwrap(),
            json!({"type": "screenshot"})
        );
    }

    #[test]
    fn desktop_actions_are_flagged_for_the_host_agent() {
        assert!(RemoteAction::DesktopScreenshot.is_desktop());
        assert!(RemoteAction::DesktopKey {
            key: "Return".into()
        }
        .is_desktop());
        assert!(!RemoteAction::Tabs.is_desktop());
        assert!(RemoteAction::DesktopScreenshot.returns_image());
        assert!(RemoteAction::Screenshot {
            marks: true,
            tab_id: None
        }
        .returns_image());
        assert!(!RemoteAction::Tabs.returns_image());
    }

    #[test]
    fn full_power_validation_bounds() {
        let bad = [
            json!({"type": "evaluate", "script": "  "}),
            json!({"type": "evaluate", "script": "x".repeat(MAX_SCRIPT_LEN + 1)}),
            json!({"type": "click_at", "x": -1, "y": 0}),
            json!({"type": "click_at", "x": 0, "y": MAX_COORD + 1}),
            json!({"type": "click_at", "x": 0, "y": 0, "click_count": 0}),
            json!({"type": "click_at", "x": 0, "y": 0, "modifiers": ["hyper"]}),
            json!({"type": "drag", "from_x": 0, "from_y": 0, "to_x": 1, "to_y": 1, "steps": 0}),
            json!({"type": "scroll_at", "x": 0, "y": 0, "dy": MAX_COORD + 1}),
            json!({"type": "type_keys", "text": ""}),
            json!({"type": "key", "key": ""}),
            json!({"type": "key", "key": "a\nb"}),
            json!({"type": "desktop_key", "key": "x".repeat(MAX_KEY_LEN + 1)}),
            json!({"type": "desktop_scroll", "x": 1, "dy": 1}),
            json!({"type": "desktop_scroll", "dy": 1000}),
        ];
        for v in bad {
            let a: RemoteAction =
                serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{v}: {e}"));
            assert!(a.validate().is_err(), "{v} should be refused");
        }
    }

    #[test]
    fn navigation_policy() {
        // A human emulator opens whatever a person could type (#366).
        for ok in [
            "https://example.test/a",
            "http://localhost:8080",
            "about:blank",
            "file:///tmp/report.pdf",
            "chrome://settings",
            "data:text/html,hi",
            "chrome-extension://abc/x.html",
            "ftp://example.test",
        ] {
            assert!(check_navigable_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "javascript:alert(1)",
            "  JavaScript:alert(1)",
            "https://",
            "no-scheme",
            "1abc:x",
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
    fn type_secret_wire_format() {
        let id = Uuid::new_v4();
        let a: RemoteAction = serde_json::from_value(
            json!({"type": "type_secret", "handoff_id": id, "selector": "#otp", "submit": true}),
        )
        .unwrap();
        assert_eq!(
            a,
            RemoteAction::TypeSecret {
                handoff_id: id,
                selector: "#otp".into(),
                clear: false,
                submit: true,
                tab_id: None
            }
        );
        assert!(a.validate().is_ok());
        let empty = RemoteAction::TypeSecret {
            handoff_id: id,
            selector: " ".into(),
            clear: false,
            submit: false,
            tab_id: None,
        };
        assert!(empty.validate().is_err());
        // `sensitive` is omitted unless set.
        let t: RemoteAction =
            serde_json::from_value(json!({"type": "type", "selector": "#p", "text": "x"})).unwrap();
        assert!(serde_json::to_value(&t).unwrap().get("sensitive").is_none());
    }

    #[test]
    fn kind_never_contains_content() {
        let a = RemoteAction::Type {
            selector: "#password".into(),
            text: "secret".into(),
            clear: true,
            submit: false,
            sensitive: true,
            tab_id: None,
        };
        assert_eq!(a.kind(), "type");
        let a = RemoteAction::TypeSecret {
            handoff_id: Uuid::nil(),
            selector: "#otp".into(),
            clear: false,
            submit: true,
            tab_id: None,
        };
        assert_eq!(a.kind(), "type_secret");
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
        let base = CreateHandoffRequest::new(
            HandoffKind::Code,
            "Enter the code sent to your phone",
            HandoffInput::Secret,
        );
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

    fn q(input: HandoffInput) -> CreateHandoffRequest {
        CreateHandoffRequest::new(HandoffKind::Other, "Question?", input)
    }

    fn parse(v: Value) -> CreateHandoffRequest {
        serde_json::from_value(v).unwrap()
    }

    fn err(r: &CreateHandoffRequest) -> String {
        r.validate().unwrap_err().0
    }

    #[test]
    fn handoff_choices_accept_strings_and_objects() {
        let r = parse(json!({
            "kind": "other", "prompt": "Pick", "input": "choice",
            "choices": ["Yes, continue", {"id": "no", "label": "No", "description": "Stop here"}]
        }));
        assert!(r.validate().is_ok());
        let c: Vec<HandoffChoice> = r.choices.iter().map(|c| c.to_choice()).collect();
        assert_eq!(c[0].id, "Yes, continue");
        assert_eq!(c[0].label, "Yes, continue");
        assert_eq!(c[1].id, "no");
        assert_eq!(c[1].description.as_deref(), Some("Stop here"));
        // Returned as objects.
        let out = serde_json::to_value(&c[0]).unwrap();
        assert_eq!(
            out,
            json!({"id": "Yes, continue", "label": "Yes, continue"})
        );

        let mut r = q(HandoffInput::Choice);
        let opt = |id: &str, label: &str| HandoffChoice {
            id: id.into(),
            label: label.into(),
            description: None,
        };
        for bad in ["", "has space", "a,b", &"x".repeat(65)] {
            r.choices = vec![opt(bad, "Label").into()];
            assert!(err(&r).contains("must match"), "{bad:?}");
        }
        r.choices = vec![opt("a", "").into()];
        assert!(r.validate().is_err());
        r.choices = vec![opt("a", &"l".repeat(101)).into()];
        assert!(r.validate().is_err());
        r.choices = vec![HandoffChoice {
            description: Some("d".repeat(201)),
            ..opt("a", "A")
        }
        .into()];
        assert!(r.validate().is_err());
        // Duplicate ids, across both forms.
        r.choices = vec![opt("a", "A").into(), "a".into()];
        assert!(err(&r).contains("duplicate"));
        r.choices = vec!["".into()];
        assert!(r.validate().is_err());
        r.choices = (0..11).map(|i| format!("c{i}").into()).collect();
        assert!(r.validate().is_err());
        // Choices on other inputs.
        let mut r = q(HandoffInput::Text);
        r.choices = vec!["a".into()];
        assert!(err(&r).contains("only allowed"));
    }

    #[test]
    fn handoff_constraints_apply_only_to_their_inputs() {
        let with = |input, c: Value| {
            let mut v = json!({"kind": "other", "prompt": "Q", "input": input, "constraints": c});
            if input == "multi_choice" || input == "choice" {
                v["choices"] = json!(["a", "b", "c"]);
            }
            serde_json::from_value::<CreateHandoffRequest>(v).unwrap()
        };
        for (input, c) in [
            (
                "text",
                json!({"max_length": 10, "pattern": "[0-9]+", "multiline": false}),
            ),
            ("secret", json!({"max_length": 8})),
            (
                "number",
                json!({"min": 0, "max": 10, "step": 0.5, "unit": "kg"}),
            ),
            (
                "multi_choice",
                json!({"min_selections": 0, "max_selections": 2}),
            ),
        ] {
            assert!(with(input, c.clone()).validate().is_ok(), "{input} {c}");
        }
        for (input, c) in [
            ("text", json!({"min": 1})),
            ("secret", json!({"pattern": "x"})),
            ("number", json!({"max_length": 3})),
            ("choice", json!({"min_selections": 1})),
            ("none", json!({"multiline": true})),
            ("confirm", json!({"unit": "x"})),
            ("takeover", json!({"max_length": 1})),
        ] {
            let e = err(&with(input, c.clone()));
            assert!(e.contains("does not apply"), "{input} {c}: {e}");
        }
        // Unknown constraint names are rejected at parse time.
        assert!(serde_json::from_value::<CreateHandoffRequest>(json!({
            "kind": "other", "prompt": "Q", "input": "text", "constraints": {"maxLength": 3}
        }))
        .is_err());
        // Bounds of the constraints themselves.
        for c in [
            json!({"max_length": 0}),
            json!({"max_length": 4097}),
            json!({"pattern": "("}),
            json!({"pattern": ""}),
            json!({"pattern": "a".repeat(201)}),
        ] {
            assert!(with("text", c.clone()).validate().is_err(), "{c}");
        }
        for c in [
            json!({"min": 5, "max": 1}),
            json!({"step": 0}),
            json!({"step": -1}),
            json!({"unit": ""}),
            json!({"unit": "u".repeat(21)}),
        ] {
            assert!(with("number", c.clone()).validate().is_err(), "{c}");
        }
        for c in [
            json!({"max_selections": 4}),
            json!({"max_selections": 0}),
            json!({"min_selections": 3, "max_selections": 2}),
            json!({"min_selections": 4}),
        ] {
            assert!(with("multi_choice", c.clone()).validate().is_err(), "{c}");
        }
    }

    #[test]
    fn handoff_confirm_fields() {
        let mut r = q(HandoffInput::Confirm);
        assert!(r.validate().is_ok());
        r.confirm_label = Some("Pay now".into());
        r.deny_label = Some("Don't pay".into());
        r.risk = Some(HandoffRisk::Low);
        assert!(r.validate().is_ok());
        r.confirm_label = Some("x".repeat(41));
        assert!(r.validate().is_err());
        r.confirm_label = Some(" ".into());
        assert!(r.validate().is_err());
        let mut r = q(HandoffInput::Text);
        r.risk = Some(HandoffRisk::High);
        assert!(err(&r).contains("only allowed"));
        let mut r = q(HandoffInput::Choice);
        r.choices = vec!["a".into()];
        r.deny_label = Some("No".into());
        assert!(r.validate().is_err());
    }

    /// A view of a validated request, as the control plane builds it.
    fn view(r: CreateHandoffRequest) -> HandoffView {
        r.validate().unwrap();
        serde_json::from_value(json!({
            "id": Uuid::nil(), "session_id": Uuid::nil(), "host_id": Uuid::nil(),
            "kind": r.kind, "prompt": r.prompt, "input": r.input,
            "choices": r.choices, "constraints": r.constraints,
            "status": "pending",
            "created_at": "2026-01-01T00:00:00Z", "expires_at": "2026-01-01T00:10:00Z"
        }))
        .unwrap()
    }

    fn ans(v: &HandoffView, value: &str) -> Result<HandoffAnswer, ActionValidationError> {
        v.check_answer(Some(value.into()), None)
    }

    fn pick(v: &HandoffView, values: &[&str]) -> Result<HandoffAnswer, ActionValidationError> {
        v.check_answer(None, Some(values.iter().map(|s| s.to_string()).collect()))
    }

    #[test]
    fn handoff_answers_text() {
        let mut r = q(HandoffInput::Text);
        r.constraints.max_length = Some(7);
        r.constraints.pattern = Some("[0-9]{3}-?[0-9]{3}".into());
        r.constraints.multiline = Some(false);
        let v = view(r);
        assert_eq!(
            ans(&v, " 123-456 ").unwrap().value.as_deref(),
            Some("123-456")
        );
        assert!(ans(&v, "123456").is_ok());
        // Full match: a matching substring is not enough.
        assert!(ans(&v, "x123456").is_err());
        assert!(ans(&v, "1234567").is_err());
        assert!(v.check_answer(None, None).is_err());
        assert!(v.check_answer(Some("  ".into()), None).is_err());
        assert!(pick(&v, &["123456"]).is_err());

        let mut r = q(HandoffInput::Text);
        r.constraints.multiline = Some(false);
        assert!(ans(&view(r), "a\nb").is_err());
        let mut r = q(HandoffInput::Text);
        r.constraints.multiline = Some(true);
        assert!(ans(&view(r), "a\nb").is_ok());
        // Default: newlines allowed, 4096 characters.
        let v = view(q(HandoffInput::Text));
        assert!(ans(&v, "a\nb").is_ok());
        assert!(ans(&v, &"é".repeat(4096)).is_ok());
        assert!(ans(&v, &"é".repeat(4097)).is_err());
    }

    #[test]
    fn handoff_answers_secret_choice_confirm_and_valueless() {
        let mut r = q(HandoffInput::Secret);
        r.constraints.max_length = Some(6);
        let v = view(r);
        assert_eq!(ans(&v, "123456").unwrap().value.as_deref(), Some("123456"));
        assert!(ans(&v, "1234567").is_err());

        let mut r = q(HandoffInput::Choice);
        r.choices = vec![
            "Yes, continue".into(),
            HandoffChoice {
                id: "no".into(),
                label: "No".into(),
                description: None,
            }
            .into(),
        ];
        let v = view(r);
        assert!(ans(&v, "Yes, continue").is_ok());
        assert!(ans(&v, "no").is_ok());
        assert!(ans(&v, "No").is_err(), "labels are not ids");
        assert!(ans(&v, "maybe").is_err());

        let v = view(q(HandoffInput::Confirm));
        assert_eq!(
            ans(&v, "approve").unwrap().value.as_deref(),
            Some("approve")
        );
        assert_eq!(ans(&v, "deny").unwrap().value.as_deref(), Some("deny"));
        assert!(ans(&v, "yes").is_err());
        assert!(v.check_answer(None, None).is_err());

        for input in [HandoffInput::None, HandoffInput::Takeover] {
            let v = view(q(input));
            assert_eq!(
                v.check_answer(None, None).unwrap(),
                HandoffAnswer::default()
            );
            assert_eq!(
                v.check_answer(Some(" ".into()), Some(vec![])).unwrap(),
                HandoffAnswer::default()
            );
            assert!(ans(&v, "x").unwrap_err().0.contains("takes no value"));
            assert!(pick(&v, &["x"]).is_err());
        }
    }

    #[test]
    fn handoff_answers_number() {
        let mut r = q(HandoffInput::Number);
        r.constraints.min = Some(1.0);
        r.constraints.max = Some(10.0);
        r.constraints.step = Some(0.1);
        let v = view(r);
        assert_eq!(ans(&v, "1.3").unwrap().value.as_deref(), Some("1.3"));
        assert_eq!(ans(&v, "02.50").unwrap().value.as_deref(), Some("2.5"));
        assert_eq!(ans(&v, "1e1").unwrap().value.as_deref(), Some("10"));
        assert!(ans(&v, "1.25").unwrap_err().0.contains("multiple"));
        assert!(ans(&v, "0.9").unwrap_err().0.contains("between"));
        assert!(ans(&v, "10.1").is_err());
        for bad in ["abc", "NaN", "inf", "-inf", "1e999", "1,5"] {
            assert!(ans(&v, bad).is_err(), "{bad}");
        }
        // Step counted from 0 without min.
        let mut r = q(HandoffInput::Number);
        r.constraints.step = Some(5.0);
        let v = view(r);
        assert_eq!(ans(&v, "-15").unwrap().value.as_deref(), Some("-15"));
        assert_eq!(ans(&v, "-0").unwrap().value.as_deref(), Some("0"));
        assert!(ans(&v, "7").is_err());
    }

    #[test]
    fn handoff_answers_multi_choice() {
        let mut r = q(HandoffInput::MultiChoice);
        r.choices = vec!["a".into(), "b".into(), "c".into()];
        r.constraints.max_selections = Some(2);
        let v = view(r);
        assert_eq!(
            pick(&v, &["c", "a"]).unwrap().values,
            Some(vec!["c".to_string(), "a".to_string()])
        );
        assert!(pick(&v, &[]).unwrap_err().0.contains("between 1 and 2"));
        assert!(pick(&v, &["a", "b", "c"]).is_err());
        assert!(pick(&v, &["a", "a"])
            .unwrap_err()
            .0
            .contains("more than once"));
        assert!(pick(&v, &["z"]).is_err());
        assert!(ans(&v, "a").is_err(), "multi_choice takes values");

        let mut r = q(HandoffInput::MultiChoice);
        r.choices = vec!["a".into(), "b".into()];
        r.constraints.min_selections = Some(0);
        let v = view(r);
        assert_eq!(pick(&v, &[]).unwrap().values, Some(vec![]));
        assert_eq!(v.check_answer(None, None).unwrap().values, Some(vec![]));
        assert!(pick(&v, &["a", "b"]).is_ok());
    }

    #[test]
    fn old_saved_handoff_view_still_loads() {
        let v: HandoffView = serde_json::from_value(json!({
            "id": Uuid::nil(), "session_id": Uuid::nil(), "host_id": Uuid::nil(),
            "kind": "confirmation", "prompt": "Go?", "input": "choice",
            "choices": ["Approve", "Reject"], "status": "completed",
            "created_at": "2026-01-01T00:00:00Z", "expires_at": "2026-01-01T00:10:00Z",
            "resolved_at": "2026-01-01T00:01:00Z",
            "response": {"value": "Approve", "value_withheld": false, "channel": "web-form"}
        }))
        .unwrap();
        assert_eq!(v.choices[1].id, "Reject");
        assert!(v.constraints.is_empty());
        let r = v.response.as_ref().unwrap();
        assert_eq!(r.outcome, HandoffOutcome::Completed);
        assert_eq!(r.by, None);
        // Round-trips in the new form.
        let again: HandoffView = serde_json::from_value(serde_json::to_value(&v).unwrap()).unwrap();
        assert_eq!(again, v);
        let out = serde_json::to_value(&v).unwrap();
        assert_eq!(
            out["choices"][0],
            json!({"id": "Approve", "label": "Approve"})
        );
        assert!(out.get("constraints").is_none());
    }

    #[test]
    fn terminal_states() {
        assert!(!OperationState::Queued.is_terminal());
        assert!(!OperationState::Dispatched.is_terminal());
        assert!(OperationState::TimedOut.is_terminal());
    }
}
