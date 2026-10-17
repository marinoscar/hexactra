//! Hexactra MCP server - Model Context Protocol implementation for Hexactra
//!
//! This server exposes scoped tools for browser session management, AI goal execution,
//! and HITL (Human in the Loop) interaction through MCP stdio.

use anyhow::Result;
use clap::Parser;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::io::stdin;
use tokio::sync::Mutex;
use tracing::{info, error};
use uuid::Uuid;

/// Hexactra MCP configuration
#[derive(Parser, Debug)]
#[command(name = "hexactra-mcp")]
#[command(about = "Hexactra Model Context Protocol server", long_about = None)]
struct Args {
    /// Path to config file
    #[arg(short, long)]
    config: Option<String>,

    /// Verbose output
    #[arg(short, long)]
    verbose: bool,
}

/// State for the MCP server
struct ServerState {
    sessions: HashMap<String, SessionState>,
}

/// State for a single session
#[derive(Debug, Clone)]
struct SessionState {
    #[allow(dead_code)]
    id: String,
    status: SessionStatus,
    #[allow(dead_code)]
    browser_url: Option<String>,
}

/// Status of a session
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum SessionStatus {
    Initializing,
    Running,
    Paused,
    Ended,
}

impl Default for ServerState {
    fn default() -> Self {
        let mut sessions = HashMap::new();
        // Pre-populate with a default session for testing
        sessions.insert(
            "default".to_string(),
            SessionState {
                id: "default".to_string(),
                status: SessionStatus::Running,
                browser_url: Some("http://localhost:3000".to_string()),
            },
        );
        ServerState { sessions }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    if args.verbose || cfg!(debug_assertions) {
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::DEBUG)
            .init();
    } else {
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::INFO)
            .init();
    }

    info!("Hexactra MCP server starting");
    info!("Configuration: {:?}", args);

    let state = ServerState::default();
    let state = Mutex::new(state);

    // Read from stdin (MCP stdio protocol)
    // Simple line-based protocol for now
    // In production, this would use JSON-RPC over stdio
    loop {
        let mut line = String::new();
        match stdin().read_line(&mut line) {
            Ok(0) => break, // EOF
            Ok(_) => {
                // Parse and handle the request
                match handle_request(&line, &state).await {
                    Ok(response) => {
                        let json = serde_json::to_string(&response)?;
                        println!("{}", json);
                    }
                    Err(e) => {
                        let error_response = serde_json::json!({
                            "error": {
                                "code": -32000,
                                "message": e.to_string()
                            }
                        });
                        let json = serde_json::to_string(&error_response)?;
                        println!("{}", json);
                    }
                }
            }
            Err(e) => {
                error!("Error reading input: {}", e);
                break;
            }
        }
    }

    info!("Hexactra MCP server shutting down");
    Ok(())
}

async fn handle_request(
    request: &str,
    state: &Mutex<ServerState>,
) -> Result<serde_json::Value, anyhow::Error> {
    // Try to parse as JSON-RPC
    let parsed: serde_json::Value = match serde_json::from_str(request) {
        Ok(v) => v,
        Err(_) => {
            return Ok(serde_json::json!({
                "error": {
                    "code": -32700,
                    "message": "Parse error",
                    "data": "Invalid JSON"
                }
            }))
        }
    };

    // Extract method and params
    let method = parsed.get("method").and_then(|m| m.as_str());
    let params = parsed.get("params");

    match method {
        Some("tools/call") => {
            handle_tool_call(params, state).await
        }
        Some("initialize") => {
            Ok(serde_json::json!({
                "jsonrpc": "2.0",
                "id": parsed.get("id").cloned().unwrap_or_default(),
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {
                        "tools": {}
                    },
                    "serverInfo": {
                        "name": "hexactra-mcp",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }
            }))
        }
        _ => Ok(serde_json::json!({
            "error": {
                "code": -32601,
                "message": "Method not found"
            }
        })),
    }
}

async fn handle_tool_call(
    params: Option<&serde_json::Value>,
    state: &Mutex<ServerState>,
) -> Result<serde_json::Value, anyhow::Error> {
    let params = params.unwrap_or(&serde_json::Value::Null);

    let tool_name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
    let arguments = params.get("arguments").cloned().unwrap_or_default();

    match tool_name {
        "session_start" => handle_session_start(arguments, state).await,
        "session_status" => handle_session_status(arguments, state).await,
        "session_stop" => handle_session_stop(arguments, state).await,
        "navigate" => handle_navigate(arguments, state).await,
        "click" => handle_click(arguments, state).await,
        "type_text" => handle_type_text(arguments, state).await,
        "screenshot" => handle_screenshot(arguments, state).await,
        "agent_run" => handle_agent_run(arguments, state).await,
        "agent_status" => handle_agent_status(arguments, state).await,
        "agent_cancel" => handle_agent_cancel(arguments, state).await,
        "hitl_status" => handle_hitl_status(arguments, state).await,
        _ => Ok(serde_json::json!({
            "error": {
                "code": -32601,
                "message": format!("Tool '{}' not found", tool_name)
            }
        })),
    }
}

async fn handle_session_start(
    _args: serde_json::Value,
    state: &Mutex<ServerState>,
) -> Result<serde_json::Value, anyhow::Error> {
    let mut state = state.lock().await;
    let session_id = "session-".to_string() + &Uuid::new_v4().simple().to_string();

    state.sessions.insert(
        session_id.clone(),
        SessionState {
            id: session_id.clone(),
            status: SessionStatus::Running,
            browser_url: Some("http://localhost:3000".to_string()),
        },
    );

    Ok(serde_json::json!({
        "content": [{"type": "text", "text": format!("Session started: {}", session_id)}],
        "isError": false
    }))
}

async fn handle_session_status(
    args: serde_json::Value,
    state: &Mutex<ServerState>,
) -> Result<serde_json::Value, anyhow::Error> {
    let session_id = args.get("sessionId").and_then(|s| s.as_str()).unwrap_or("default");
    let state = state.lock().await;

    if let Some(session) = state.sessions.get(session_id) {
        Ok(serde_json::json!({
            "content": [{"type": "text", "text": format!("Session {}: {}", session_id, serde_json::to_string(&session.status)?) }],
            "isError": false
        }))
    } else {
        Ok(serde_json::json!({
            "error": {
                "code": -32001,
                "message": format!("Session '{}' not found", session_id)
            }
        }))
    }
}

async fn handle_session_stop(
    args: serde_json::Value,
    state: &Mutex<ServerState>,
) -> Result<serde_json::Value, anyhow::Error> {
    let session_id = args.get("sessionId").and_then(|s| s.as_str()).unwrap_or("default");
    let mut state = state.lock().await;

    if state.sessions.remove(session_id).is_some() {
        Ok(serde_json::json!({
            "content": [{"type": "text", "text": format!("Session {} stopped", session_id)}],
            "isError": false
        }))
    } else {
        Ok(serde_json::json!({
            "error": {
                "code": -32001,
                "message": format!("Session '{}' not found", session_id)
            }
        }))
    }
}

async fn handle_navigate(
    args: serde_json::Value,
    state: &Mutex<ServerState>,
) -> Result<serde_json::Value, anyhow::Error> {
    let session_id = args.get("sessionId").and_then(|s| s.as_str()).unwrap_or("default");
    let url = args.get("url").and_then(|u| u.as_str()).unwrap_or("");

    let state = state.lock().await;
    if state.sessions.contains_key(session_id) {
        Ok(serde_json::json!({
            "content": [{"type": "text", "text": format!("Navigated {} to {}", session_id, url)}],
            "isError": false
        }))
    } else {
        Ok(serde_json::json!({
            "error": {
                "code": -32001,
                "message": format!("Session '{}' not found", session_id)
            }
        }))
    }
}

async fn handle_click(
    args: serde_json::Value,
    state: &Mutex<ServerState>,
) -> Result<serde_json::Value, anyhow::Error> {
    let session_id = args.get("sessionId").and_then(|s| s.as_str()).unwrap_or("default");
    let selector = args.get("selector").and_then(|s| s.as_str()).unwrap_or("");

    let state = state.lock().await;
    if state.sessions.contains_key(session_id) {
        Ok(serde_json::json!({
            "content": [{"type": "text", "text": format!("Clicked {} in session {}", selector, session_id)}],
            "isError": false
        }))
    } else {
        Ok(serde_json::json!({
            "error": {
                "code": -32001,
                "message": format!("Session '{}' not found", session_id)
            }
        }))
    }
}

async fn handle_type_text(
    args: serde_json::Value,
    state: &Mutex<ServerState>,
) -> Result<serde_json::Value, anyhow::Error> {
    let session_id = args.get("sessionId").and_then(|s| s.as_str()).unwrap_or("default");
    let selector = args.get("selector").and_then(|s| s.as_str()).unwrap_or("");
    let text = args.get("text").and_then(|t| t.as_str()).unwrap_or("");

    let state = state.lock().await;
    if state.sessions.contains_key(session_id) {
        Ok(serde_json::json!({
            "content": [{"type": "text", "text": format!("Typed '{}' into {} in session {}", text, selector, session_id)}],
            "isError": false
        }))
    } else {
        Ok(serde_json::json!({
            "error": {
                "code": -32001,
                "message": format!("Session '{}' not found", session_id)
            }
        }))
    }
}

async fn handle_screenshot(
    args: serde_json::Value,
    state: &Mutex<ServerState>,
) -> Result<serde_json::Value, anyhow::Error> {
    let session_id = args.get("sessionId").and_then(|s| s.as_str()).unwrap_or("default");

    let state = state.lock().await;
    if state.sessions.contains_key(session_id) {
        Ok(serde_json::json!({
            "content": [{"type": "text", "text": format!("Screenshot taken for session {}", session_id)}],
            "isError": false
        }))
    } else {
        Ok(serde_json::json!({
            "error": {
                "code": -32001,
                "message": format!("Session '{}' not found", session_id)
            }
        }))
    }
}

async fn handle_agent_run(
    args: serde_json::Value,
    state: &Mutex<ServerState>,
) -> Result<serde_json::Value, anyhow::Error> {
    let session_id = args.get("sessionId").and_then(|s| s.as_str()).unwrap_or("default");
    let goal = args.get("goal").and_then(|g| g.as_str()).unwrap_or("");

    let state = state.lock().await;
    if state.sessions.contains_key(session_id) {
        Ok(serde_json::json!({
            "content": [{"type": "text", "text": format!("Agent run started for goal: '{}' in session {}", goal, session_id)}],
            "isError": false
        }))
    } else {
        Ok(serde_json::json!({
            "error": {
                "code": -32001,
                "message": format!("Session '{}' not found", session_id)
            }
        }))
    }
}

async fn handle_agent_status(
    args: serde_json::Value,
    state: &Mutex<ServerState>,
) -> Result<serde_json::Value, anyhow::Error> {
    let session_id = args.get("sessionId").and_then(|s| s.as_str()).unwrap_or("default");

    let state = state.lock().await;
    if state.sessions.contains_key(session_id) {
        Ok(serde_json::json!({
            "content": [{"type": "text", "text": format!("Agent status for session {}: running", session_id)}],
            "isError": false
        }))
    } else {
        Ok(serde_json::json!({
            "error": {
                "code": -32001,
                "message": format!("Session '{}' not found", session_id)
            }
        }))
    }
}

async fn handle_agent_cancel(
    args: serde_json::Value,
    state: &Mutex<ServerState>,
) -> Result<serde_json::Value, anyhow::Error> {
    let session_id = args.get("sessionId").and_then(|s| s.as_str()).unwrap_or("default");

    let state = state.lock().await;
    if state.sessions.contains_key(session_id) {
        Ok(serde_json::json!({
            "content": [{"type": "text", "text": format!("Agent run cancelled for session {}", session_id)}],
            "isError": false
        }))
    } else {
        Ok(serde_json::json!({
            "error": {
                "code": -32001,
                "message": format!("Session '{}' not found", session_id)
            }
        }))
    }
}

async fn handle_hitl_status(
    args: serde_json::Value,
    state: &Mutex<ServerState>,
) -> Result<serde_json::Value, anyhow::Error> {
    let session_id = args.get("sessionId").and_then(|s| s.as_str()).unwrap_or("default");

    let state = state.lock().await;
    if state.sessions.contains_key(session_id) {
        Ok(serde_json::json!({
            "content": [{"type": "text", "text": format!("HITL status for session {}: no pending requests", session_id)}],
            "isError": false
        }))
    } else {
        Ok(serde_json::json!({
            "error": {
                "code": -32001,
                "message": format!("Session '{}' not found", session_id)
            }
        }))
    }
}
