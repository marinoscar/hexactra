# Hexactra API Documentation

## Overview

Hexactra provides a RESTful HTTP API for browser automation, along with MCP (Model Context Protocol) tools for AI agents.

## Authentication

All endpoints (except `/health`) require authentication via Bearer token:

```
Authorization: Bearer <token>
```

Tokens are issued by the identity provider and include scopes for granular access control.

## Error Handling

Errors return JSON with structure:

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "Human-readable error message",
    "details": {},
    "request_id": "uuid"
  }
}
```

Error codes:
- `INVALID_INPUT` - Request validation failed
- `NOT_FOUND` - Resource not found
- `UNAUTHORIZED` - Authentication required/failed
- `FORBIDDEN` - Insufficient permissions
- `CONFLICT` - Resource already exists or state conflict
- `INTERNAL_ERROR` - Server-side error
- `TIMEOUT` - Operation timed out
- `SERVICE_UNAVAILABLE` - Service temporarily unavailable

## Idempotency

Mutating requests support the `Idempotency-Key` header. Repeated requests with the same key return the original response without re-executing the operation.

## API Endpoints

### System

#### Health Check
```
GET /health
```

Returns service health status.

### Sessions

#### List Sessions
```
GET /sessions
Scopes: sessions:read
```

#### Create Session
```
POST /sessions
Scopes: sessions:write
```

Body:
```json
{
  "profile_id": "uuid",
  "timeout_minutes": 30
}
```

### Goals

#### Create Goal
```
POST /goals
Scopes: goals:write
```

Body:
```json
{
  "session_id": "uuid",
  "actions": [
    {
      "type": "navigate",
      "url": "https://example.com"
    }
  ]
}
```

#### List Goals
```
GET /goals
Scopes: goals:read
```

#### Get Goal
```
GET /goals/{goalId}
Scopes: goals:read
```

### Operations

#### List Operations
```
GET /operations
Scopes: operations:read
```

#### Get Operation
```
GET /operations/{operationId}
Scopes: operations:read
```

### Human handoffs

The early `/interaction-requests` and `/hitl/...` routes were never served and
have been removed. A person is asked for help through the remote control API's
handoffs (`POST /v1/sessions/{id}/handoffs`, `GET /v1/handoffs`,
`POST /v1/handoffs/{id}/respond`, and the `type_secret` action for secrets):
see [remote-control-api.md](remote-control-api.md#human-handoff). The
TypeScript SDK wraps them as `createHandoff`, `listHandoffs`, `getHandoff`,
`respondHandoff`, `cancelHandoff` and `typeSecret`.

## MCP Tools

The following MCP tools are available:

- `create_session` - Create a new browser session
- `list_sessions` - List active sessions
- `create_goal` - Create a goal to execute
- `get_goal_status` - Get goal status
- `list_goals` - List goals for a session
- `browser_request_human` - Ask a person for help (a human handoff)
- `browser_type_secret` - Type the answer of a `secret` handoff into the page
- `get_operation_status` - Get operation status
- `get_health` - Check service health

## Browser Actions

The authoritative list, with fields and results, is [remote-control-api.md, Actions](remote-control-api.md#actions). In short:
- **By element:** `navigate`, `click`, `type`, `type_secret`, `press`, `scroll`, `wait_for`, `text`, `elements`.
- **What the agent sees:** `screenshot` (with `marks`: numbered interactive elements), `desktop_screenshot`.
- **Trusted input by position:** `click_at`, `mouse`, `drag`, `scroll_at`, `type_keys`, `key`.
- **JavaScript:** `evaluate`, any script in the page.
- **The node's OS desktop:** `desktop_click`, `desktop_move`, `desktop_drag`, `desktop_type`, `desktop_key`, `desktop_scroll`.
- **Tabs and history:** `tabs`, `new_tab`, `activate_tab`, `close_tab`, `back`, `forward`, `reload`.

## Security Considerations

- Secrets (passwords, tokens, OTPs) are never logged or included in error messages
- User data is redacted before storage
- All sensitive operations require explicit user approval via HITL
- Network access is default-deny; only explicitly configured endpoints allowed
