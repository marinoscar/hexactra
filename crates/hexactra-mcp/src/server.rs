//! MCP JSON-RPC handling and the browser tools.

use std::time::Duration;

use hexactra_client::{ClientError, ControlClient};
use hexactra_core::remote::{
    valid_profile_name, CreateHandoffRequest, CreateSessionRequest, HandoffInput, HandoffPage,
    HandoffStatus, OperationState, RemoteAction,
};
use serde_json::{json, Map, Value};
use tokio::sync::Mutex;
use uuid::Uuid;

const PROTOCOL_VERSION: &str = "2025-06-18";
const TOOL_PREFIX: &str = "browser_";

const INSTRUCTIONS: &str =
    "These tools operate a real Chrome browser, and the computer it runs on, on behalf of the \
user who owns them; it is signed in to their accounts. Work like a person at the machine. Start \
with browser_navigate, then browser_elements (CSS selectors) and browser_click / browser_type. \
When the page structure does not help (canvas, custom widgets, unlabeled icons), look at it: \
browser_screenshot with marks=true numbers the interactive elements and gives their boxes, and \
browser_click_at / browser_mouse / browser_drag / browser_scroll_at / browser_type_keys / \
browser_key act by position with trusted input. browser_evaluate runs any JavaScript in the page. \
For anything outside the page (native dialogs, file pickers, other windows) use the browser_desktop_* \
tools on the whole screen. When the person themself is needed (a CAPTCHA puzzle, a code sent to \
their phone, a passkey), call browser_request_human; browser actions pause while it is open. A \
secret the person gives (input=secret) is never shown to you: type it with browser_type_secret.";

fn tab_prop() -> Value {
    json!({"type": "integer", "description": "Tab id from browser_tabs; defaults to the active tab."})
}

fn coord() -> Value {
    json!({"type": "integer", "minimum": 0})
}

fn button_prop() -> Value {
    json!({"type": "string", "enum": ["left", "middle", "right"]})
}

fn modifiers_prop() -> Value {
    json!({"type": "array", "items": {"type": "string", "enum": ["alt", "ctrl", "meta", "shift"]}})
}

fn tool(name: &str, description: &str, props: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": props,
            "required": required,
            "additionalProperties": false,
        }
    })
}

/// Tool catalog. Tool `browser_<x>` maps to remote action type `<x>`.
pub fn tools() -> Vec<Value> {
    vec![
        tool("browser_status", "Show whether the user's browser is connected.", json!({}), &[]),
        tool(
            "browser_profiles",
            "List the user's browser profiles (each has its own sign-ins, e.g. personal, travel, work) and which one this agent is using.",
            json!({}),
            &[],
        ),
        tool(
            "browser_use_profile",
            "Switch to another browser profile. Pick the profile that is signed in to the site the task needs. create=true makes a new, signed-out profile; only do that when the user asks.",
            json!({"profile": {"type": "string"}, "create": {"type": "boolean"}}),
            &["profile"],
        ),
        tool(
            "browser_navigate",
            "Open an http(s) URL in the current tab and wait for it to load. Returns the final URL and title.",
            json!({"url": {"type": "string"}, "tab_id": tab_prop()}),
            &["url"],
        ),
        tool(
            "browser_elements",
            "List visible interactive elements (links, buttons, inputs) with a CSS selector, tag and label for each. Call this before clicking or typing.",
            json!({"max_elements": {"type": "integer", "minimum": 1, "maximum": 500}, "tab_id": tab_prop()}),
            &[],
        ),
        tool(
            "browser_click",
            "Click the first element matching a CSS selector.",
            json!({"selector": {"type": "string"}, "tab_id": tab_prop()}),
            &["selector"],
        ),
        tool(
            "browser_type",
            "Type text into an input, textarea or editable element. Set clear to replace the existing value and submit to press Enter / submit the form.",
            json!({
                "selector": {"type": "string"},
                "text": {"type": "string"},
                "clear": {"type": "boolean"},
                "submit": {"type": "boolean"},
                "tab_id": tab_prop()
            }),
            &["selector", "text"],
        ),
        tool(
            "browser_type_secret",
            "Type the secret (one-time code, password) a person gave to a browser_request_human request with input=secret. The browser fabric types it for you; you never see the value. Each answer can be typed once; if typing it fails, ask the person again.",
            json!({
                "handoff_id": {"type": "string", "description": "The handoff_id browser_request_human returned."},
                "selector": {"type": "string"},
                "clear": {"type": "boolean"},
                "submit": {"type": "boolean"},
                "tab_id": tab_prop()
            }),
            &["handoff_id", "selector"],
        ),
        tool(
            "browser_press",
            "Press a key such as Enter, Escape, Tab or ArrowDown on the focused element or on selector.",
            json!({"key": {"type": "string"}, "selector": {"type": "string"}, "tab_id": tab_prop()}),
            &["key"],
        ),
        tool(
            "browser_scroll",
            "Scroll the page by dx/dy pixels, or scroll selector into view.",
            json!({"dx": {"type": "integer"}, "dy": {"type": "integer"}, "selector": {"type": "string"}, "tab_id": tab_prop()}),
            &[],
        ),
        tool(
            "browser_text",
            "Read the visible text of the page or of selector.",
            json!({"selector": {"type": "string"}, "max_chars": {"type": "integer", "minimum": 1}, "tab_id": tab_prop()}),
            &[],
        ),
        tool(
            "browser_screenshot",
            "Capture the visible part of the tab as an image, in CSS pixels (the coordinates browser_click_at takes). With marks=true, interactive elements are boxed and numbered, and their selectors and boxes are listed.",
            json!({"marks": {"type": "boolean"}, "tab_id": tab_prop()}),
            &[],
        ),
        tool(
            "browser_evaluate",
            "Run JavaScript in the page and return its JSON value. The script is an expression, or statements whose last expression is the value; await_promise awaits a returned promise.",
            json!({"script": {"type": "string"}, "await_promise": {"type": "boolean"}, "tab_id": tab_prop()}),
            &["script"],
        ),
        tool(
            "browser_click_at",
            "Trusted click at viewport CSS-pixel coordinates from browser_screenshot. click_count 2 double-clicks; button left, middle or right; modifiers alt, ctrl, meta, shift.",
            json!({"x": coord(), "y": coord(), "button": button_prop(), "click_count": {"type": "integer", "minimum": 1, "maximum": 3}, "modifiers": modifiers_prop(), "tab_id": tab_prop()}),
            &["x", "y"],
        ),
        tool(
            "browser_mouse",
            "Trusted pointer move (hover), button press or release at viewport coordinates.",
            json!({"op": {"type": "string", "enum": ["move", "down", "up"]}, "x": coord(), "y": coord(), "button": button_prop(), "tab_id": tab_prop()}),
            &["op", "x", "y"],
        ),
        tool(
            "browser_drag",
            "Trusted drag from one viewport point to another (sliders, drag and drop, drawing).",
            json!({"from_x": coord(), "from_y": coord(), "to_x": coord(), "to_y": coord(), "steps": {"type": "integer", "minimum": 1, "maximum": 100}, "tab_id": tab_prop()}),
            &["from_x", "from_y", "to_x", "to_y"],
        ),
        tool(
            "browser_scroll_at",
            "Trusted mouse-wheel scroll at a viewport point (scrolls the element under it).",
            json!({"x": coord(), "y": coord(), "dx": {"type": "integer"}, "dy": {"type": "integer"}, "tab_id": tab_prop()}),
            &["x", "y"],
        ),
        tool(
            "browser_type_keys",
            "Type text into the focused element with trusted keyboard input, as a person would.",
            json!({"text": {"type": "string"}, "tab_id": tab_prop()}),
            &["text"],
        ),
        tool(
            "browser_key",
            "Press one key with trusted keyboard input, optionally with modifiers (key a with modifiers [ctrl] selects all).",
            json!({"key": {"type": "string"}, "modifiers": modifiers_prop(), "tab_id": tab_prop()}),
            &["key"],
        ),
        tool(
            "browser_desktop_screenshot",
            "Capture the computer's whole screen (outside the page too), in screen pixels.",
            json!({}),
            &[],
        ),
        tool(
            "browser_desktop_click",
            "Click anywhere on the computer's screen, at screen coordinates from browser_desktop_screenshot.",
            json!({"x": coord(), "y": coord(), "button": button_prop(), "click_count": {"type": "integer", "minimum": 1, "maximum": 3}}),
            &["x", "y"],
        ),
        tool(
            "browser_desktop_move",
            "Move the computer's pointer to screen coordinates.",
            json!({"x": coord(), "y": coord()}),
            &["x", "y"],
        ),
        tool(
            "browser_desktop_drag",
            "Drag on the computer's screen.",
            json!({"from_x": coord(), "from_y": coord(), "to_x": coord(), "to_y": coord()}),
            &["from_x", "from_y", "to_x", "to_y"],
        ),
        tool(
            "browser_desktop_type",
            "Type text into whatever has focus on the computer (a native file dialog, another window).",
            json!({"text": {"type": "string"}}),
            &["text"],
        ),
        tool(
            "browser_desktop_key",
            "Press a key chord on the computer, xdotool style: Return, Escape, ctrl+l, alt+F4.",
            json!({"key": {"type": "string"}}),
            &["key"],
        ),
        tool(
            "browser_desktop_scroll",
            "Scroll the computer's screen by mouse-wheel clicks (positive dy scrolls down), optionally at x,y.",
            json!({"x": coord(), "y": coord(), "dy": {"type": "integer", "minimum": -100, "maximum": 100}}),
            &["dy"],
        ),
        tool(
            "browser_wait_for",
            "Wait until an element matching selector exists (timeout_ms up to 60000).",
            json!({"selector": {"type": "string"}, "timeout_ms": {"type": "integer", "minimum": 0, "maximum": 60000}, "tab_id": tab_prop()}),
            &["selector"],
        ),
        tool("browser_tabs", "List open tabs with ids, titles and URLs.", json!({}), &[]),
        tool(
            "browser_new_tab",
            "Open a new tab, optionally at an http(s) URL.",
            json!({"url": {"type": "string"}}),
            &[],
        ),
        tool(
            "browser_activate_tab",
            "Switch to a tab.",
            json!({"tab_id": {"type": "integer"}}),
            &["tab_id"],
        ),
        tool(
            "browser_close_tab",
            "Close a tab.",
            json!({"tab_id": {"type": "integer"}}),
            &["tab_id"],
        ),
        tool("browser_back", "Go back in history.", json!({"tab_id": tab_prop()}), &[]),
        tool("browser_forward", "Go forward in history.", json!({"tab_id": tab_prop()}), &[]),
        tool("browser_reload", "Reload the tab.", json!({"tab_id": tab_prop()}), &[]),
        tool(
            "browser_request_human",
            "Pause and ask the user to do something only a person should do, or a question only they can answer: solve a CAPTCHA, enter a one-time code, approve a passkey, sign in, confirm a purchase, pick from options. The user is reached on their configured channels (chat, email link, ...). With wait=true (default) this returns the outcome and the person's answer: `value` for text, choice (the option id), number (a decimal string) and confirm (`approve` or `deny`), `values` (option ids) for multi_choice. Use input=secret for one-time codes and passwords: the answer is never returned (`value_withheld`); type it into the page with browser_type_secret and the handoff_id. Use input=takeover when the person must operate the browser themselves.",
            json!({
                "kind": {"type": "string", "enum": ["captcha", "code", "passkey", "login", "confirmation", "other"]},
                "prompt": {"type": "string", "description": "What the person should do, in plain words."},
                "input": {"type": "string", "enum": ["none", "text", "secret", "choice", "multi_choice", "number", "confirm", "takeover"], "description": "none: the person acts in the browser and marks it done. takeover: the person operates the browser, then marks it done. confirm: approve or deny."},
                "choices": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 10,
                    "description": "Options for choice and multi_choice: a string (used as id and label) or {id, label, description}.",
                    "items": {"oneOf": [
                        {"type": "string"},
                        {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$"},
                                "label": {"type": "string", "maxLength": 100},
                                "description": {"type": "string", "maxLength": 200}
                            },
                            "required": ["id", "label"],
                            "additionalProperties": false
                        }
                    ]}
                },
                "constraints": {
                    "type": "object",
                    "description": "Bounds on the answer; only those that apply to the input are allowed.",
                    "properties": {
                        "max_length": {"type": "integer", "minimum": 1, "maximum": 4096, "description": "text, secret"},
                        "pattern": {"type": "string", "maxLength": 200, "description": "text: regex the whole answer must match"},
                        "multiline": {"type": "boolean", "description": "text: false rejects newlines"},
                        "min": {"type": "number", "description": "number"},
                        "max": {"type": "number", "description": "number"},
                        "step": {"type": "number", "exclusiveMinimum": 0, "description": "number"},
                        "unit": {"type": "string", "maxLength": 20, "description": "number"},
                        "min_selections": {"type": "integer", "minimum": 0, "description": "multi_choice (default 1)"},
                        "max_selections": {"type": "integer", "minimum": 1, "description": "multi_choice (default all)"}
                    },
                    "additionalProperties": false
                },
                "confirm_label": {"type": "string", "maxLength": 40, "description": "confirm: approve button label"},
                "deny_label": {"type": "string", "maxLength": 40, "description": "confirm: deny button label"},
                "risk": {"type": "string", "enum": ["low", "high"], "description": "confirm: how risky approving is (default high)"},
                "timeout_s": {"type": "integer", "minimum": 10, "maximum": 86400},
                "wait": {"type": "boolean", "description": "Wait for the answer (default true)."}
            }),
            &["kind", "prompt"],
        ),
        tool(
            "browser_handoff_status",
            "Check (and optionally wait for) a request created by browser_request_human with wait=false.",
            json!({"handoff_id": {"type": "string"}, "wait_s": {"type": "integer", "minimum": 0, "maximum": 3600}}),
            &["handoff_id"],
        ),
    ]
}

/// Tools that are not browser actions.
#[cfg(test)]
const NON_ACTION_TOOLS: &[&str] = &[
    "browser_status",
    "browser_profiles",
    "browser_use_profile",
    "browser_request_human",
    "browser_handoff_status",
];

/// Build a remote action from a tool name and its arguments.
pub fn action_for(name: &str, args: &Map<String, Value>) -> Result<RemoteAction, String> {
    let kind = name
        .strip_prefix(TOOL_PREFIX)
        .ok_or_else(|| format!("unknown tool {name}"))?;
    if !tools().iter().any(|t| t["name"] == name) {
        return Err(format!("unknown tool {name}"));
    }
    let mut obj = args.clone();
    obj.insert("type".into(), Value::String(kind.into()));
    let action: RemoteAction = serde_json::from_value(Value::Object(obj))
        .map_err(|e| format!("invalid arguments for {name}: {e}"))?;
    action.validate().map_err(|e| e.0)?;
    Ok(action)
}

fn text_result(text: impl Into<String>, is_error: bool) -> Value {
    json!({"content": [{"type": "text", "text": text.into()}], "isError": is_error})
}

/// MCP server state.
struct SessionState {
    profile: String,
    /// Create the profile if no host has it (set by browser_use_profile).
    create: bool,
    id: Option<Uuid>,
}

pub struct Server {
    client: ControlClient,
    session: Mutex<SessionState>,
}

impl Server {
    #[cfg(test)]
    pub fn new(client: ControlClient) -> Self {
        Self::with_profile(client, hexactra_core::remote::DEFAULT_PROFILE.to_string())
    }

    /// Start on a given browser profile (e.g. from `HEXACTRA_PROFILE`).
    pub fn with_profile(client: ControlClient, profile: String) -> Self {
        Self {
            client,
            session: Mutex::new(SessionState {
                profile,
                create: false,
                id: None,
            }),
        }
    }

    /// Handle one JSON-RPC line; `None` for notifications.
    pub async fn handle_line(&self, line: &str) -> Option<Value> {
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                return Some(json!({"jsonrpc": "2.0", "id": null,
                    "error": {"code": -32700, "message": format!("parse error: {e}")}}))
            }
        };
        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        let id = id?; // notifications get no response

        let result = match method {
            "initialize" => {
                let version = params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or(PROTOCOL_VERSION);
                Ok(json!({
                    "protocolVersion": version,
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": {"name": "hexactra", "version": env!("CARGO_PKG_VERSION")},
                    "instructions": INSTRUCTIONS,
                }))
            }
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({"tools": tools()})),
            "tools/call" => Ok(self.call_tool(&params).await),
            _ => Err((-32601, format!("method not found: {method}"))),
        };
        Some(match result {
            Ok(r) => json!({"jsonrpc": "2.0", "id": id, "result": r}),
            Err((code, message)) => {
                json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
            }
        })
    }

    async fn session(&self, fresh: bool) -> Result<Uuid, ClientError> {
        let mut guard = self.session.lock().await;
        if let (Some(id), false) = (guard.id, fresh) {
            return Ok(id);
        }
        let s = self
            .client
            .create_session(&CreateSessionRequest {
                host_id: None,
                label: Some("mcp".into()),
                profile: Some(guard.profile.clone()),
                create_profile: guard.create,
                allowed_domains: Vec::new(),
            })
            .await?;
        guard.id = Some(s.id);
        Ok(s.id)
    }

    async fn list_profiles(&self) -> Value {
        let current = self.session.lock().await.profile.clone();
        match self.client.hosts().await {
            Ok(hosts) => {
                let hosts: Vec<Value> = hosts
                    .iter()
                    .filter(|h| h.online)
                    .map(|h| json!({"host": h.name, "profiles": h.profiles, "running": h.running_profiles}))
                    .collect();
                text_result(
                    serde_json::to_string_pretty(
                        &json!({"current_profile": current, "hosts": hosts}),
                    )
                    .unwrap_or_default(),
                    false,
                )
            }
            Err(e) => text_result(e.to_string(), true),
        }
    }

    async fn use_profile(&self, args: &Map<String, Value>) -> Value {
        let Some(profile) = args.get("profile").and_then(Value::as_str) else {
            return text_result("profile is required", true);
        };
        if !valid_profile_name(profile) {
            return text_result(
                "profile names are 1-32 characters: lowercase letters, digits, '-' and '_'",
                true,
            );
        }
        let create = args.get("create").and_then(Value::as_bool).unwrap_or(false);
        {
            let mut g = self.session.lock().await;
            g.profile = profile.to_string();
            g.create = create;
            g.id = None;
        }
        match self.session(true).await {
            Ok(id) => text_result(
                format!("Now using browser profile {profile:?} (session {id})."),
                false,
            ),
            Err(e) if e.to_string().contains("profile_not_found") => text_result(
                format!(
                    "No host has a profile named {profile:?}. Ask the user whether to create it (browser_use_profile with create=true opens a new, signed-out browser)."
                ),
                true,
            ),
            Err(e) => text_result(e.to_string(), true),
        }
    }

    /// Create a handoff on the current session and, unless `wait` is false,
    /// wait for the person.
    async fn request_human(&self, args: &Map<String, Value>) -> Value {
        let mut obj = args.clone();
        let wait = obj.remove("wait").and_then(|v| v.as_bool()).unwrap_or(true);
        let timeout_s = obj
            .remove("timeout_s")
            .and_then(|v| v.as_u64())
            .unwrap_or(600);
        obj.insert("timeout_ms".into(), json!(timeout_s * 1000));
        let mut req: CreateHandoffRequest = match serde_json::from_value(Value::Object(obj)) {
            Ok(r) => r,
            Err(e) => return text_result(format!("invalid arguments: {e}"), true),
        };
        if let Err(e) = req.validate() {
            return text_result(e.0, true);
        }
        let mut fresh = false;
        let created = loop {
            let session = match self.session(fresh).await {
                Ok(s) => s,
                Err(e) => return text_result(format!("no browser session: {e}"), true),
            };
            // Tell the person which page this is about.
            if req.page.is_none() {
                if let Ok(op) = self
                    .client
                    .act(session, RemoteAction::Tabs, Some(Duration::from_secs(10)))
                    .await
                {
                    let active = op.result.as_ref().and_then(|r| {
                        r["tabs"]
                            .as_array()?
                            .iter()
                            .find(|t| t["active"] == true)
                            .cloned()
                    });
                    if let Some(t) = active {
                        req.page = Some(HandoffPage {
                            url: t["url"].as_str().map(|s| s.chars().take(2000).collect()),
                            title: t["title"].as_str().map(|s| s.chars().take(200).collect()),
                        });
                    }
                }
            }
            match self.client.create_handoff(session, &req).await {
                Err(e) if !fresh && matches!(e.status(), Some(404)) => fresh = true,
                Err(e) => return text_result(e.to_string(), true),
                Ok(c) => break c,
            }
        };
        if !wait {
            return text_result(
                format!(
                    "Asked the person (handoff_id {}). Browser actions are paused until they answer; call browser_handoff_status to check.",
                    created.handoff.id
                ),
                false,
            );
        }
        self.handoff_outcome(created.handoff.id, Duration::from_secs(timeout_s + 5))
            .await
    }

    async fn handoff_outcome(&self, id: Uuid, wait: Duration) -> Value {
        let end = tokio::time::Instant::now() + wait;
        let h = loop {
            let left = end.saturating_duration_since(tokio::time::Instant::now());
            match self
                .client
                .handoff(id, Some(left.min(Duration::from_secs(110))))
                .await
            {
                Ok(h) if h.status != HandoffStatus::Pending || left.is_zero() => break h,
                Ok(_) => continue,
                Err(e) => return text_result(e.to_string(), true),
            }
        };
        match h.status {
            HandoffStatus::Pending => text_result(
                format!("Still waiting for the person (handoff_id {id})."),
                false,
            ),
            HandoffStatus::Completed => {
                let channel = h
                    .response
                    .as_ref()
                    .and_then(|r| r.channel.clone())
                    .map(|c| format!(" via {c}"))
                    .unwrap_or_default();
                let mut out = json!({ "status": "completed", "handoff_id": id });
                let mut next = String::new();
                if h.input == HandoffInput::Secret {
                    // The value stays in the fabric; it is typed for us.
                    out["value_withheld"] = json!(true);
                    next = format!(
                        "\nThe secret is not shown to you. Type it with browser_type_secret {{\"handoff_id\": \"{id}\", \"selector\": <the field>, \"submit\": true}}."
                    );
                } else if let Some(v) = h.response.as_ref().and_then(|r| r.value.clone()) {
                    out["value"] = json!(v);
                }
                if let Some(vs) = h.response.as_ref().and_then(|r| r.values.as_ref()) {
                    out["values"] = json!(vs);
                }
                text_result(
                    format!(
                        "The person completed the request{channel}. Browser actions are resumed.\n{out}{next}"
                    ),
                    false,
                )
            }
            other => text_result(
                format!(
                    "The request was {other:?}. Stop this task and tell the user; do not retry the check yourself."
                ),
                true,
            ),
        }
    }

    async fn call_tool(&self, params: &Value) -> Value {
        let name = params.get("name").and_then(Value::as_str).unwrap_or("");
        let empty = Map::new();
        let args = params
            .get("arguments")
            .and_then(Value::as_object)
            .unwrap_or(&empty);

        if name == "browser_request_human" {
            return self.request_human(args).await;
        }
        if name == "browser_handoff_status" {
            let id = match args
                .get("handoff_id")
                .and_then(Value::as_str)
                .map(str::parse::<Uuid>)
            {
                Some(Ok(id)) => id,
                _ => return text_result("handoff_id must be a UUID", true),
            };
            let wait = Duration::from_secs(args.get("wait_s").and_then(Value::as_u64).unwrap_or(0));
            return self.handoff_outcome(id, wait).await;
        }
        if name == "browser_profiles" {
            return self.list_profiles().await;
        }
        if name == "browser_use_profile" {
            return self.use_profile(args).await;
        }
        if name == "browser_status" {
            return match self.client.hosts().await {
                Ok(hosts) => text_result(
                    serde_json::to_string_pretty(&json!({"hosts": hosts})).unwrap_or_default(),
                    false,
                ),
                Err(e) => text_result(e.to_string(), true),
            };
        }

        let action = match action_for(name, args) {
            Ok(a) => a,
            Err(e) => return text_result(e, true),
        };
        let timeout = match &action {
            RemoteAction::WaitFor { timeout_ms, .. } => {
                Duration::from_millis(timeout_ms.unwrap_or(10_000) + 5_000)
            }
            _ => Duration::from_secs(45),
        };

        let mut fresh = false;
        let op = loop {
            let session = match self.session(fresh).await {
                Ok(s) => s,
                Err(e) => return text_result(format!("no browser session: {e}"), true),
            };
            match self
                .client
                .act(session, action.clone(), Some(timeout))
                .await
            {
                // Session ended or unknown (control plane restarted): retry
                // once. Not for type_secret: its handoff belongs to this
                // session, and its 404/409 are about the secret.
                Err(e)
                    if !fresh
                        && !matches!(action, RemoteAction::TypeSecret { .. })
                        && matches!(e.status(), Some(404) | Some(409)) =>
                {
                    fresh = true
                }
                Err(e) => return text_result(e.to_string(), true),
                Ok(op) => break op,
            }
        };

        if op.state != OperationState::Succeeded {
            return text_result(
                format!(
                    "{} {:?}: {}",
                    action.kind(),
                    op.state,
                    op.error.unwrap_or_default()
                ),
                true,
            );
        }
        let result = op.result.unwrap_or(Value::Null);
        if action.returns_image() {
            let (mime, bytes) = match self.client.screenshot_bytes(&result).await {
                Ok(v) => v,
                Err(e) => return text_result(format!("fetching the screenshot: {e}"), true),
            };
            let data = {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD.encode(bytes)
            };
            let mut caption = format!(
                "{}  {}",
                result["url"].as_str().unwrap_or(""),
                result["title"].as_str().unwrap_or("")
            );
            if let Some(marks) = result.get("marks").filter(|m| m.is_array()) {
                caption.push_str("\nmarks: ");
                caption.push_str(&marks.to_string());
            }
            return json!({
                "content": [
                    {"type": "image", "data": data, "mimeType": mime},
                    {"type": "text", "text": caption.trim().to_string()}
                ],
                "isError": false
            });
        }
        if let RemoteAction::Text { .. } = action {
            if let Some(t) = result["text"].as_str() {
                return text_result(t.to_string(), false);
            }
        }
        text_result(
            serde_json::to_string_pretty(&result).unwrap_or_default(),
            false,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hexactra_core::remote::{HandoffConstraints, HandoffKind, HandoffRisk};

    #[test]
    fn every_tool_maps_to_an_action_or_is_status() {
        for t in tools() {
            let name = t["name"].as_str().unwrap();
            if NON_ACTION_TOOLS.contains(&name) {
                continue;
            }
            // Build minimal valid arguments from the required list.
            let mut args = Map::new();
            for r in t["inputSchema"]["required"].as_array().unwrap() {
                let r = r.as_str().unwrap();
                let v = match r {
                    "url" => json!("https://example.test/"),
                    "tab_id" => json!(1),
                    "key" => json!("Enter"),
                    "handoff_id" => json!(Uuid::nil()),
                    "x" | "y" | "from_x" | "from_y" | "to_x" | "to_y" => json!(10),
                    "dy" => json!(1),
                    "op" => json!("move"),
                    "script" => json!("document.title"),
                    "text" => json!("hi"),
                    _ => json!("#x"),
                };
                args.insert(r.into(), v);
            }
            let a = action_for(name, &args).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(format!("browser_{}", a.kind()), name);
        }
    }

    #[test]
    fn bad_arguments_and_policy_are_reported() {
        assert!(action_for("browser_click", &Map::new())
            .unwrap_err()
            .contains("invalid arguments"));
        let mut a = Map::new();
        a.insert("url".into(), json!("javascript:alert(1)"));
        assert!(action_for("browser_navigate", &a)
            .unwrap_err()
            .contains("evaluate"));
        assert!(action_for("browser_execute_script", &Map::new()).is_err());
        assert!(action_for("other", &Map::new()).is_err());
    }

    /// `api/mcp-schemas.json` must list exactly the tools this server
    /// serves. Regenerate with `HEXACTRA_UPDATE_CONTRACTS=1 cargo test -p hexactra-mcp`.
    #[test]
    fn published_mcp_contract_matches_tools() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../api/mcp-schemas.json");
        let expected = json!({
            "name": "hexactra",
            "description": "Hexactra MCP server (hexactra-mcp): operate the user's browser through the control plane /v1 API.",
            "version": env!("CARGO_PKG_VERSION"),
            "instructions": INSTRUCTIONS,
            "tools": tools(),
        });
        if std::env::var("HEXACTRA_UPDATE_CONTRACTS").as_deref() == Ok("1") {
            let text = serde_json::to_string_pretty(&expected).unwrap() + "\n";
            std::fs::write(path, text).unwrap();
        }
        let actual: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(
            actual, expected,
            "api/mcp-schemas.json is stale; run HEXACTRA_UPDATE_CONTRACTS=1 cargo test -p hexactra-mcp"
        );
    }

    /// Every `browser_request_human` property (but `wait`, `timeout_s`) is a
    /// `CreateHandoffRequest` field, and typed questions parse and validate.
    #[test]
    fn request_human_schema_matches_the_handoff_contract() {
        let t = tools()
            .into_iter()
            .find(|t| t["name"] == "browser_request_human")
            .unwrap();
        let props = t["inputSchema"]["properties"].as_object().unwrap();
        let mut args = json!({
            "kind": "confirmation", "prompt": "Pick extras", "input": "multi_choice",
            "choices": ["Window seat", {"id": "bag", "label": "Checked bag", "description": "23 kg"}],
            "constraints": {"min_selections": 0, "max_selections": 2},
        });
        let req: CreateHandoffRequest = serde_json::from_value(args.clone()).unwrap();
        req.validate().unwrap();
        for (k, v) in [
            ("input", json!("confirm")),
            ("confirm_label", json!("Pay")),
            ("deny_label", json!("Don't")),
            ("risk", json!("low")),
        ] {
            args[k] = v;
        }
        args.as_object_mut().unwrap().remove("choices");
        args.as_object_mut().unwrap().remove("constraints");
        let req: CreateHandoffRequest = serde_json::from_value(args).unwrap();
        req.validate().unwrap();
        let fields = serde_json::to_value(CreateHandoffRequest {
            choices: vec!["a".into()],
            constraints: HandoffConstraints {
                max_length: Some(1),
                ..Default::default()
            },
            confirm_label: Some("a".into()),
            deny_label: Some("b".into()),
            risk: Some(HandoffRisk::Low),
            timeout_ms: Some(10_000),
            ..CreateHandoffRequest::new(HandoffKind::Other, "p", HandoffInput::Choice)
        })
        .unwrap();
        for k in props.keys() {
            if k != "wait" && k != "timeout_s" && k != "page" {
                assert!(fields.get(k).is_some(), "{k} is not a request field");
            }
        }
        let inputs: Vec<HandoffInput> =
            serde_json::from_value(props["input"]["enum"].clone()).unwrap();
        assert_eq!(inputs.len(), 8);
    }

    #[tokio::test]
    async fn request_human_rejects_invalid_questions_locally() {
        let s = server();
        let r = s
            .handle_line(r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"browser_request_human","arguments":{"kind":"other","prompt":"Approve?","input":"confirm","constraints":{"min":1}}}}"#)
            .await
            .unwrap();
        assert_eq!(r["result"]["isError"], true);
        assert!(r["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("does not apply"));
    }

    /// The secret a person gives never reaches the model: request_human
    /// reports it withheld and browser_type_secret has the fabric type it.
    #[tokio::test]
    async fn secrets_are_typed_by_the_fabric_never_returned() {
        use hexactra_client::HostClient;
        use hexactra_control::runtime::{self, ApiState, RuntimeStore};
        use hexactra_core::remote::{OperationResult, RegisterHostRequest};
        const TOKEN: &str = "mcp-secret-test-token-0123456789abc";
        const SECRET: &str = "987654-mcp-otp";

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(runtime::serve(
            listener,
            ApiState::new(RuntimeStore::new(), TOKEN),
            std::future::pending(),
        ));
        let host = HostClient::new(&url, TOKEN).unwrap();
        let host_id = host
            .register(&RegisterHostRequest {
                name: "h".into(),
                version: "0".into(),
                host_id: None,
                viewer_url: None,
                mode: None,
                desktop: false,
            })
            .await
            .unwrap()
            .host_id;
        // A fake host: answers every action and records what it was sent.
        let typed = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let t2 = typed.clone();
        tokio::spawn(async move {
            loop {
                if let Ok(Some(op)) = host.next(host_id, true, Duration::from_secs(5)).await {
                    let result = match &op.action {
                        RemoteAction::Tabs => json!({"tabs": []}),
                        _ => json!({}),
                    };
                    t2.lock().unwrap().push(op.action.clone());
                    let _ = host
                        .report(
                            host_id,
                            op.id,
                            &OperationResult {
                                navigation_blocked: Vec::new(),
                                ok: true,
                                result: Some(result),
                                error: None,
                            },
                        )
                        .await;
                }
            }
        });
        let client = ControlClient::new(&url, TOKEN).unwrap();
        let server = std::sync::Arc::new(Server::new(client.clone()));
        let call = |name: &str, args: Value| {
            json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": name, "arguments": args}})
            .to_string()
        };

        let s2 = server.clone();
        let line = call(
            "browser_request_human",
            json!({"kind": "code", "prompt": "Enter the code", "input": "secret"}),
        );
        let asked = tokio::spawn(async move { s2.handle_line(&line).await.unwrap() });
        // The person answers.
        let pending = loop {
            if let Some(h) = client.handoffs(true).await.unwrap().into_iter().next() {
                break h;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        client
            .respond_handoff(
                pending.id,
                &hexactra_core::remote::RespondHandoffRequest {
                    value: Some(SECRET.into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let r = asked.await.unwrap();
        let text = r["result"]["content"][0]["text"].as_str().unwrap();
        assert_eq!(r["result"]["isError"], false, "{text}");
        assert!(!text.contains(SECRET), "{text}");
        assert!(text.contains("\"value_withheld\":true"), "{text}");
        assert!(text.contains("browser_type_secret"), "{text}");

        let r = server
            .handle_line(&call(
                "browser_type_secret",
                json!({"handoff_id": pending.id, "selector": "#otp", "submit": true}),
            ))
            .await
            .unwrap();
        assert_eq!(r["result"]["isError"], false, "{r}");
        assert!(!r.to_string().contains(SECRET), "{r}");
        assert!(typed.lock().unwrap().iter().any(|a| matches!(
            a,
            RemoteAction::Type { text, submit: true, .. } if text == SECRET
        )));

        // A second use is a tool error, without the value.
        let r = server
            .handle_line(&call(
                "browser_type_secret",
                json!({"handoff_id": pending.id, "selector": "#otp"}),
            ))
            .await
            .unwrap();
        assert_eq!(r["result"]["isError"], true);
        assert!(r.to_string().contains("secret_unavailable"), "{r}");
    }

    fn server() -> Server {
        Server::new(ControlClient::new("http://127.0.0.1:9", "t").unwrap())
    }

    #[tokio::test]
    async fn initialize_list_and_errors() {
        let s = server();
        let r = s
            .handle_line(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}"#)
            .await
            .unwrap();
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert!(r["result"]["instructions"]
            .as_str()
            .unwrap()
            .contains("CAPTCHA"));

        assert!(s
            .handle_line(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
            .await
            .is_none());

        let r = s
            .handle_line(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#)
            .await
            .unwrap();
        assert!(r["result"]["tools"].as_array().unwrap().len() >= 15);

        let r = s
            .handle_line(r#"{"jsonrpc":"2.0","id":3,"method":"nope"}"#)
            .await
            .unwrap();
        assert_eq!(r["error"]["code"], -32601);

        let r = s.handle_line("{not json").await.unwrap();
        assert_eq!(r["error"]["code"], -32700);

        // Policy errors become tool errors without contacting the server.
        let r = s
            .handle_line(r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"browser_navigate","arguments":{"url":"file:///etc/passwd"}}}"#)
            .await
            .unwrap();
        assert_eq!(r["result"]["isError"], true);
    }
}
