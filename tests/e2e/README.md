# E2E Tests for Managed AI Across Remote Session and Connection Failure

This directory contains E2E tests demonstrating managed AI browser automation across remote sessions and connection failures.

## Overview

The tests verify that Hexactra can:
1. Use a persisted Chrome profile across sessions
2. Recover from client disconnections
3. Handle model outages with retry logic
4. Handle host outages and restore state
5. Retain non-secret audit evidence

## Prerequisites

- Node.js 22+
- Google Chrome or Chromium
- OpenAI-compatible model endpoint (optional, for AI-driven tests)

## Running Tests

### Run all E2E tests:

```bash
node tests/e2e/test-e2e.js
```

### Run demo:

```bash
node tests/e2e/demo-e2e.js
```

### With environment variables:

```bash
# Use a specific model endpoint
MODEL_ENDPOINT=http://localhost:11434/v1 \
MODEL_NAME=llama3 \
node tests/e2e/test-e2e.js

# Use a custom Chrome profile path
CHROME_PROFILE_PATH=/tmp/my-chrome-profile \
node tests/e2e/demo-e2e.js
```

## Test Cases

### 1. Chrome Profile Persistence

Verifies that Chrome can be started with a persisted profile and the profile directory is not deleted on shutdown.

### 2. Session State Persistence

Verifies that session state is preserved across simulated disconnections and can be restored.

### 3. Audit Evidence Retention

Verifies that non-secret audit evidence is retained and no secrets are included in logs/events.

### 4. Connection Failure Recovery

Verifies that the system can recover from client disconnections and resume execution.

### 5. Model Outage Handling

Verifies that model request failures are handled with retry logic.

### 6. Host Outage Handling

Verifies that session state can be restored after a host outage.

## Architecture

```
┌─────────────────┐
│   Test Script   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Chrome Driver  │
│ (Persisted      │
│  Profile)       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Agent Run     │
│   (SQLite)      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Planning Loop  │
└─────────────────┘
```

## Audit Evidence

Non-secret evidence is retained in `/tmp/hexactra-audit-evidence.json`:

```json
{
    "sessionId": "test-session-123",
    "goal": "Test goal",
    "status": "completed",
    "steps": [
        { "step": 1, "action": "navigate", "success": true },
        { "step": 2, "action": "verify", "success": true }
    ],
    "timestamp": "2026-10-16T..."
}
```

## Connection Failure Simulation

The tests simulate connection failures by:
1. Saving session state to disk
2. Simulating client disconnection
3. Verifying state persists
4. Simulating reconnection
5. Verifying state can be restored

## Security Considerations

- No secrets (passwords, tokens, API keys) are included in audit evidence
- Chrome profile is stored in a temporary directory
- Test results are written to `/tmp` for easy cleanup
