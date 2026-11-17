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

## Console API: agent policies

The Hexactra Console (`console/`) has its own REST API under `/api`, separate from the fabric API above. It authenticates with the console's access token or a personal access token and wraps responses in `{ "data": ... }`. The per-endpoint reference is its generated OpenAPI document at `/api/docs` (committed as `console/packages/sdk/openapi.json`). This section holds the conventions the document cannot: the concepts are in [console/README.md](../console/README.md#agent-policies).

### Policy endpoints

An agent policy sets a run's model tiers, budgets (each may be `null`, unlimited), stall detection and context settings. Permissions are `agent_policies:read` and `agent_policies:write`. A policy id is the UUID of one of your own policies, or `builtin:economy|balanced|thorough|unlimited`.

| Route | Does |
|---|---|
| `GET /api/agent-policies` | The built-ins and your own, each with `spec`, `version`, `isDefault`, `usage` and `hasNoHardStop` |
| `POST /api/agent-policies` | Create from a full `spec` (`400 POLICY_PIN_INVALID`, `409 POLICY_NAME_TAKEN`) |
| `GET /api/agent-policies/{id}` | Read one |
| `PATCH /api/agent-policies/{id}` | Edit; `If-Match: <version>` refuses a stale edit (`412 POLICY_VERSION_CONFLICT`); built-ins answer `403 POLICY_BUILTIN_READONLY` |
| `DELETE /api/agent-policies/{id}` | `409 POLICY_IN_USE` (details list the tasks and schedules) unless `?reassignTo=<id>`; `409 POLICY_IS_DEFAULT` |
| `POST /api/agent-policies/{id}/duplicate` | Copy any policy under a new name |
| `GET`, `PUT /api/agent-policies/default` | Read or set your default (`null` returns to `builtin:balanced`) |
| `GET /api/agent-policies/model-tiers/effective` | The models Fast, Standard and Frontier resolve to, with where each came from |
| `GET /api/agent-policies/export` | The portable file (`ids`, `includePins`) |
| `POST /api/agent-policies/import` | Import a file (`file`, `onConflict`) |

Tasks (`POST`/`PATCH /api/tasks`), schedules (`POST`/`PATCH /api/schedules`) and run starts (`POST /api/runs`, `POST /api/tasks/{id}/runs`) take `policyId`; `null` follows the next level (run, schedule, task, your default, `builtin:balanced`). The task fields `maxSteps`, `maxMinutes` and `model` are deprecated: sending one derives a personal `Task: <name>` policy and the response carries a `Deprecation: true` header. They are removed in the release after the one that introduced agent policies.

The deployment's model tiers, price table and budget ceilings are system settings (`browserAgentTiers`, `agentPricing`, `browserAgentCeilings`; `PATCH /api/system-settings`, `system_settings:write`), and each user's tier overrides and default policy are user settings (`browserAgent`).

### Export file format: `hexactra.agent-policies` version 1

`GET /api/agent-policies/export?ids=all|<id>,<id>&includePins=true|false` answers a JSON attachment `agent-policies-<yyyymmdd>.json` (not wrapped in `data`). `ids` defaults to `all`: the built-ins, then your own.

```json
{
  "kind": "hexactra.agent-policies",
  "formatVersion": 1,
  "exportedAt": "2026-11-17T12:00:00.000Z",
  "policies": [
    {
      "name": "Fare lookups",
      "description": "Cheap and quick",
      "spec": {
        "schemaVersion": 1,
        "models": { "startTier": "fast", "maxTier": "standard", "allowProviderFallback": true },
        "budget": { "maxActions": 40, "maxModelCalls": 80, "maxActiveMinutes": 10, "maxInputTokens": null, "maxOutputTokens": null, "maxCostUsd": 0.5, "warnAtPercent": 80 },
        "stall": { "maxConsecutiveFailures": 4, "maxRepeatedAction": 3, "noProgressActions": 10, "onStall": "nudge_then_escalate", "maxEscalations": 1 },
        "context": { "screenshotsKept": 1, "pruneBatch": 10, "callsPerChunk": 8, "observationChars": 6000 }
      }
    }
  ]
}
```

- **Contents.** Names, descriptions and specs only. No ids, user, version, timestamps, task usage or secret. `includePins=false` removes `models.pins`, so the file works on any deployment.
- **Import.** `POST /api/agent-policies/import` takes `{ "file": <the JSON>, "onConflict": "rename" | "skip" | "replace" }` and answers `{ created, replaced, skipped, warnings, errors }`. The import is one transaction: an invalid policy rejects the file (`400 POLICY_IMPORT_INVALID`, `details.errors` lists each). A newer `formatVersion` or `schemaVersion` is `400 POLICY_IMPORT_UNSUPPORTED_VERSION`; more than 100 policies or 256 KB is `413 POLICY_IMPORT_TOO_LARGE`.
- **Warnings.** `PIN_DROPPED` (a pin names a model this deployment cannot use; the pin is dropped) and `EXCEEDS_CEILING` (a budget above the deployment's ceilings; stored as written, held to the ceiling when a run uses it).

### Run fields

`GET /api/runs`, `GET /api/runs/{id}` and the `run` events of `GET /api/runs/{id}/stream` carry:

| Field | Meaning |
|---|---|
| `policy` | `{ id, name, version, source, builtin }` of the policy the run was snapshotted with; `source` is `run`, `schedule`, `task`, `user_default` or `system_default`. `null` until the run's first step |
| `budget` | `{ effective, used, percent, source, costKnown }`, each keyed by `actions`, `modelCalls`, `activeMinutes`, `inputTokens`, `outputTokens`, `cost`. `effective` is the policy's limit clamped by the deployment ceilings (`null` is unlimited; active time in minutes, cost in USD); `percent` is `null` for an unlimited budget; `source` is `policy` or `ceiling`. `null` until the first step |
| `stopReason` | Why the run ended: `finished`, `budget_actions`, `budget_model_calls`, `budget_active_time`, `budget_input_tokens`, `budget_output_tokens`, `budget_cost`, `stalled`, `cancelled`, `error` or `no_model`. `null` while it runs and on runs from before the field |
| `tier` | `{ start, max, current, escalations, model }`; `null` until the run starts |
| `currentTier` | The tier the run is on now (`fast`, `standard`, `frontier`); it rises when the run stalls and falls after progress |
| `escalations` | How many times a stall moved the run to a stronger tier |
| `costUsd`, `costKnown` | USD spent on model calls from the `agentPricing` table; `costKnown` false means a call had no price and `costUsd` is a lower bound |
| `modelCalls` | Provider round trips so far |

Tasks carry `spend30d` (runs, cost, tokens and the average cost of a successful run over 30 days).
