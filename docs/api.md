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

### Interaction Requests (HITL)

#### Create Interaction Request
```
POST /interaction-requests
Scopes: interaction:write
```

Body:
```json
{
  "session_id": "uuid",
  "reason": "User approval required",
  "details": {}
}
```

#### List Interaction Requests
```
GET /interaction-requests
Scopes: interaction:read
```

#### Approve Request
```
POST /interaction-requests/{requestId}/approve
Scopes: interaction:write
```

#### Reject Request
```
POST /interaction-requests/{requestId}/reject
Scopes: interaction:write
```

## MCP Tools

The following MCP tools are available:

- `create_session` - Create a new browser session
- `list_sessions` - List active sessions
- `create_goal` - Create a goal to execute
- `get_goal_status` - Get goal status
- `list_goals` - List goals for a session
- `create_interaction_request` - Create HITL request
- `approve_interaction_request` - Approve HITL request
- `reject_interaction_request` - Reject HITL request
- `get_operation_status` - Get operation status
- `get_health` - Check service health

## Browser Actions

Supported action types:
- `navigate` - Navigate to URL
- `click` - Click element by selector
- `type` - Type text into input
- `get_value` - Get element value
- `screenshot` - Screenshot page
- `execute_script` - Execute JavaScript
- `wait_for_element` - Wait for element
- `back` - Navigate back
- `forward` - Navigate forward
- `refresh` - Refresh page

## Security Considerations

- Secrets (passwords, tokens, OTPs) are never logged or included in error messages
- User data is redacted before storage
- All sensitive operations require explicit user approval via HITL
- Network access is default-deny; only explicitly configured endpoints allowed
