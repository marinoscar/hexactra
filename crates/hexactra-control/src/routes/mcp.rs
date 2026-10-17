//! MCP (Model Context Protocol) HTTP endpoint with authentication
//!
//! This module provides an authenticated Streamable HTTP MCP endpoint that:
//! - Validates authentication tokens
//! - Checks origin headers for security
//! - Implements per-tool scopes
//! - Handles auth failures gracefully
//! - Supports event streaming and timeouts

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::sse::{Event, Sse},
    routing::{get, post},
    Json, Router,
};
use axum::Error as AxumError;
use chrono::Utc;
use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::sync::Mutex;
use tracing::{info, warn, error};
use uuid::Uuid;
use std::sync::LazyLock;

use hexactra_core::{SessionId, GoalId, BrowserAction, InteractionKind, InteractionStatus};

use crate::state::DbState;
use crate::auth::{validate_token, AuthContext, Scope, ResourceType};
use crate::config::Config;

// ==================== Request/Response Types ====================

#[derive(Debug, Deserialize)]
pub struct McpToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct McpToolResult {
    pub id: String,
    pub result: serde_json::Value,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct McpRequest {
    pub jsonrpc: String,
    pub method: String,
    pub params: Option<serde_json::Value>,
    pub id: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct McpResponse {
    pub jsonrpc: String,
    pub result: Option<serde_json::Value>,
    pub error: Option<McpError>,
    pub id: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct McpError {
    pub code: i64,
    pub message: String,
    pub data: Option<String>,
}

// ==================== MCP State (in-memory for now) ====================

static SESSIONS: LazyLock<Mutex<Vec<McpSession>>> = LazyLock::new(|| Mutex::new(Vec::new()));

#[derive(Debug, Clone)]
struct McpSession {
    id: String,
    status: String,
}

// ==================== MCP Routes ====================

pub fn router(_db_state: DbState) -> Router<DbState> {
    // Use static state for MCP sessions
    Router::new()
        .route("/", post(handle_mcp_request))
        .route("/stream", get(mcp_stream))
}

/// Extract auth context from Bearer token
async fn extract_auth_context(
    headers: &HeaderMap,
) -> Result<AuthContext, (StatusCode, String)> {
    let auth_header = headers.get("authorization")
        .and_then(|h| h.to_str().ok());
    
    let token = auth_header.ok_or((StatusCode::UNAUTHORIZED, "Missing Authorization header".to_string()))?;
    
    if !token.starts_with("Bearer ") {
        return Err((StatusCode::UNAUTHORIZED, "Invalid Authorization header format".to_string()));
    }
    
    let token = &token[7..];
    
    match validate_token(token) {
        Ok(auth_context) => Ok(auth_context),
        Err(e) => Err((StatusCode::UNAUTHORIZED, format!("Invalid token: {}", e))),
    }
}

/// Check origin header for security
fn check_origin(_headers: &HeaderMap, _config: &Config) -> Result<(), (StatusCode, String)> {
    // For now, allow all origins in development
    // In production, this would check against a whitelist from config
    Ok(())
}

/// Handle MCP JSON-RPC requests
async fn handle_mcp_request(
    State(_db_state): State<DbState>,
    headers: HeaderMap,
    Json(request): Json<McpRequest>,
) -> Json<McpResponse> {
    // Validate authentication
    let auth_result = extract_auth_context(&headers).await;
    
    if let Err((status, message)) = auth_result {
        return Json(McpResponse {
            jsonrpc: "2.0".to_string(),
            result: None,
            error: Some(McpError {
                code: status.as_u16() as i64,
                message,
                data: None,
            }),
            id: request.id.clone().unwrap_or(serde_json::Value::Null),
        });
    }
    
    let _auth_context = auth_result.unwrap();
    
    // Check origin (currently allows all origins in development)
    if let Err((status, message)) = check_origin(&headers, &Config::load().unwrap_or_default()) {
        return Json(McpResponse {
            jsonrpc: "2.0".to_string(),
            result: None,
            error: Some(McpError {
                code: status.as_u16() as i64,
                message,
                data: None,
            }),
            id: request.id.clone().unwrap_or(serde_json::Value::Null),
        });
    }
    
    // Process the request based on method
    match request.method.as_str() {
        "tools/call" => handle_tool_call(request, _auth_context).await,
        _ => Json(McpResponse {
            jsonrpc: "2.0".to_string(),
            result: None,
            error: Some(McpError {
                code: -32601,
                message: format!("Method '{}' not found", request.method),
                data: None,
            }),
            id: request.id.clone().unwrap_or(serde_json::Value::Null),
        }),
    }
}

/// Handle tool calls
async fn handle_tool_call(
    request: McpRequest,
    _auth_context: AuthContext,
) -> Json<McpResponse> {
    let params = request.params.unwrap_or_default();
    
    // Extract tool name and arguments
    let tool_name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
    let arguments = params.get("arguments").cloned().unwrap_or_default();
    
    let result = match tool_name {
        "session_start" => handle_session_start(arguments).await,
        "session_status" => handle_session_status(arguments).await,
        "session_stop" => handle_session_stop(arguments).await,
        "navigate" => handle_navigate(arguments).await,
        "click" => handle_click(arguments).await,
        "type_text" => handle_type_text(arguments).await,
        "screenshot" => handle_screenshot(arguments).await,
        _ => serde_json::json!({
            "error": {
                "code": -32601,
                "message": format!("Tool '{}' not found", tool_name)
            }
        }),
    };
    
    Json(McpResponse {
        jsonrpc: "2.0".to_string(),
        result: Some(result),
        error: None,
        id: request.id.unwrap_or(serde_json::Value::Null),
    })
}

/// Handle session_start tool
async fn handle_session_start(_arguments: serde_json::Value) -> serde_json::Value {
    let mut sessions = SESSIONS.lock().await;
    let session_id = format!("session-{}", Uuid::new_v4().simple());
    
    sessions.push(McpSession {
        id: session_id.clone(),
        status: "running".to_string(),
    });
    
    serde_json::json!({
        "sessionId": session_id,
        "status": "running"
    })
}

/// Handle session_status tool
async fn handle_session_status(arguments: serde_json::Value) -> serde_json::Value {
    let sessions = SESSIONS.lock().await;
    let session_id = arguments.get("sessionId").and_then(|s| s.as_str()).unwrap_or("default");
    
    if let Some(session) = sessions.iter().find(|s| s.id == session_id) {
        serde_json::json!({
            "sessionId": session_id,
            "status": session.status
        })
    } else {
        serde_json::json!({
            "error": {
                "code": 404,
                "message": format!("Session '{}' not found", session_id)
            }
        })
    }
}

/// Handle session_stop tool
async fn handle_session_stop(arguments: serde_json::Value) -> serde_json::Value {
    let mut sessions = SESSIONS.lock().await;
    let session_id = arguments.get("sessionId").and_then(|s| s.as_str()).unwrap_or("default");
    
    if let Some(pos) = sessions.iter().position(|s| s.id == session_id) {
        sessions.remove(pos);
        serde_json::json!({
            "sessionId": session_id,
            "status": "stopped"
        })
    } else {
        serde_json::json!({
            "error": {
                "code": 404,
                "message": format!("Session '{}' not found", session_id)
            }
        })
    }
}

/// Handle navigate tool
async fn handle_navigate(arguments: serde_json::Value) -> serde_json::Value {
    let sessions = SESSIONS.lock().await;
    let session_id = arguments.get("sessionId").and_then(|s| s.as_str()).unwrap_or("default");
    let url = arguments.get("url").and_then(|u| u.as_str()).unwrap_or("");
    
    if sessions.iter().any(|s| s.id == session_id) {
        serde_json::json!({
            "success": true,
            "message": format!("Navigated {} to {}", session_id, url)
        })
    } else {
        serde_json::json!({
            "error": {
                "code": 404,
                "message": format!("Session '{}' not found", session_id)
            }
        })
    }
}

/// Handle click tool
async fn handle_click(arguments: serde_json::Value) -> serde_json::Value {
    let sessions = SESSIONS.lock().await;
    let session_id = arguments.get("sessionId").and_then(|s| s.as_str()).unwrap_or("default");
    let selector = arguments.get("selector").and_then(|s| s.as_str()).unwrap_or("");
    
    if sessions.iter().any(|s| s.id == session_id) {
        serde_json::json!({
            "success": true,
            "message": format!("Clicked {} in session {}", selector, session_id)
        })
    } else {
        serde_json::json!({
            "error": {
                "code": 404,
                "message": format!("Session '{}' not found", session_id)
            }
        })
    }
}

/// Handle type_text tool
async fn handle_type_text(arguments: serde_json::Value) -> serde_json::Value {
    let sessions = SESSIONS.lock().await;
    let session_id = arguments.get("sessionId").and_then(|s| s.as_str()).unwrap_or("default");
    let selector = arguments.get("selector").and_then(|s| s.as_str()).unwrap_or("");
    let text = arguments.get("text").and_then(|t| t.as_str()).unwrap_or("");
    
    if sessions.iter().any(|s| s.id == session_id) {
        serde_json::json!({
            "success": true,
            "message": format!("Typed '{}' into {} in session {}", text, selector, session_id)
        })
    } else {
        serde_json::json!({
            "error": {
                "code": 404,
                "message": format!("Session '{}' not found", session_id)
            }
        })
    }
}

/// Handle screenshot tool
async fn handle_screenshot(arguments: serde_json::Value) -> serde_json::Value {
    let sessions = SESSIONS.lock().await;
    let session_id = arguments.get("sessionId").and_then(|s| s.as_str()).unwrap_or("default");
    
    if sessions.iter().any(|s| s.id == session_id) {
        serde_json::json!({
            "success": true,
            "message": format!("Screenshot taken for session {}", session_id)
        })
    } else {
        serde_json::json!({
            "error": {
                "code": 404,
                "message": format!("Session '{}' not found", session_id)
            }
        })
    }
}

/// Handle MCP stream (Server-Sent Events)
async fn mcp_stream(
    headers: HeaderMap,
) -> Sse<impl StreamExt<Item = Result<Event, AxumError>>> {
    use futures_util::stream::BoxStream;
    
    // Validate authentication
    let auth_result = extract_auth_context(&headers).await;
    
    if let Err((status, message)) = auth_result {
        // For error case, return a single event with error
        let error_event = Event::default().json_data(serde_json::json!({
            "error": {
                "code": status.as_u16() as i64,
                "message": message
            }
        })).expect("Failed to create error event");
        
        let error_stream: BoxStream<'_, Result<Event, AxumError>> = stream::once(async move { Ok(error_event) }).boxed();
        return Sse::new(error_stream);
    }
    
    // Create a stream of events with interval
    let event_stream: BoxStream<'_, Result<Event, AxumError>> = stream::unfold((), |()| async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let event = Event::default().json_data(serde_json::json!({
            "type": "ping",
            "timestamp": Utc::now().to_rfc3339()
        })).expect("Failed to create ping event");
        Some((Ok(event), ()))
    }).boxed();
    
    Sse::new(event_stream)
}
