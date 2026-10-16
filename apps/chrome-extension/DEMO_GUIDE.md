# Hexactra Chrome Extension - Demo Guide

This guide demonstrates the standalone AI agent capabilities of Hexactra.

## Prerequisites

- Google Chrome (latest stable version)
- Node.js 22+ with pnpm installed
- Access to an OpenAI-compatible API endpoint (or localhost mock)

## Installation

```bash
# Clone and install dependencies
pnpm install

# Build the extension
pnpm run build
```

## Loading the Extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" in the top right
3. Click "Load unpacked"
4. Select the `dist` directory from this project

## Demo Scenarios

### Scenario 1: Basic Search (5+ actions)

**Goal:** Search for "Hexactra" on Google and click the first result.

1. Open the side panel by clicking the extension icon
2. Type the goal into the task input
3. Click "Start Task"
4. Watch the browser navigate to Google, type the search query, and click the first result

**Expected Outcome:**
- Browser navigates to Google
- Search query is typed
- First result is clicked
- Task status shows "completed"

### Scenario 2: Screenshot Task

**Goal:** Navigate to example.com and take a screenshot.

1. Type the goal into the task input
2. Click "Start Task"
3. Observe the screenshot being captured

**Expected Outcome:**
- Browser navigates to example.com
- Screenshot is captured and displayed

### Scenario 3: Pause/Resume/Stop Controls

**Goal:** Test task lifecycle controls.

1. Start a long-running task
2. Click "Pause" to pause execution
3. Click "Resume" to continue
4. Click "Stop" to terminate early

**Expected Outcome:**
- Task can be paused and resumed
- Task can be stopped at any time
- State is persisted across service worker suspends

### Scenario 4: Permission Denied Handling

**Goal:** Attempt to access restricted Chrome pages.

1. Type: "Navigate to chrome://settings"
2. Click "Start Task"

**Expected Outcome:**
- Action is blocked with permission error
- User is notified of the restriction

### Scenario 5: Capability Gating

**Goal:** Test unsupported capabilities.

1. Type: "Use the debugger API to inspect the page"
2. Click "Start Task"

**Expected Outcome:**
- Unsupported capability is detected
- Alternative approach is suggested

## Model Modes

### Text-Only JSON Action Fallback

When the model cannot produce tool calls, it falls back to text-only JSON:

```json
{
  "type": "text",
  "content": "{\"action\":\"navigate\",\"url\":\"https://example.com\"}"
}
```

### Native Tool-Call Mode

The model can use native tool calls for more structured output:

```json
{
  "type": "tool_call",
  "name": "navigate",
  "arguments": {
    "url": "https://example.com"
  }
}
```

## Testing

Run the E2E test suite:

```bash
pnpm run test
```

Test coverage includes:
- Happy path: Complete tasks successfully
- Error handling: Permission denial, capability gating, malicious instructions
- Recovery: Resume after pause/stop
- Model modes: Text-only JSON fallback and native tool-call mode

## Troubleshooting

### Extension not loading
- Ensure you're loading the `dist` directory
- Check Chrome console for errors

### Task not executing
- Verify API endpoint is configured correctly
- Check network connectivity
- Review task history for errors

### Service worker suspended
- This is expected behavior in Chrome MV3
- State is automatically persisted and recovered

## Security Notes

- No user secrets or external credentials are stored in test fixtures
- Permission checks are enforced before executing actions
- Malicious instructions are detected and blocked
- Capability gating prevents unsupported operations
