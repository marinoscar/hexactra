# @hexactra/sdk

> **Talking to the Hexactra Console?** Use `@hexactra/console-sdk` (`console/packages/sdk`): it is generated from the console's OpenAPI document. This package keeps the planning loop and the OpenAI-compatible client the Chrome extension uses; its HTTP client targets the fabric's early routes and is superseded.

Hexactra TypeScript SDK for browser automation runtime

## Installation

```bash
npm install @hexactra/sdk
```

## Usage

### Basic Example

```typescript
import { ControlPlaneClient } from '@hexactra/sdk';

// Create a client
const client = new ControlPlaneClient({
  baseUrl: 'http://localhost:3000',
  token: 'your-auth-token',
});

// List sessions
const sessions = await client.listSessions();
console.log(sessions);

// Execute an action
const result = await client.executeAction('session-id', {
  type: 'click',
  selector: '#button',
});
console.log(result);
```

### Authentication

All API calls require authentication via a Bearer token:

```typescript
const client = new ControlPlaneClient({
  baseUrl: 'http://localhost:3000',
  token: process.env.HEXACTRA_TOKEN,
});
```

### Error Handling

The SDK throws `HexactraError` for API errors:

```typescript
import { HexactraError, ErrorCode } from '@hexactra/sdk';

try {
  await client.listSessions();
} catch (error) {
  if (error instanceof HexactraError) {
    switch (error.details.code) {
      case ErrorCode.Unauthorized:
        console.log('Invalid or missing token');
        break;
      case ErrorCode.NotFound:
        console.log('Resource not found');
        break;
      default:
        console.log(`API error: ${error.message}`);
    }
  } else if (client.isNetworkError(error)) {
    console.log('Network error - check server connectivity');
  }
}
```

### Human handoffs

Ask a person for help through the remote control API's handoffs (`/v1`; see
`docs/remote-control-api.md#human-handoff`). These methods call `/v1/...`
paths relative to `baseUrl`, so set `baseUrl` to the control plane's origin.

```typescript
// Ask a typed question; the session pauses until it is answered.
const { handoff, response_token } = await client.createHandoff('session-id', {
  kind: 'confirmation',
  prompt: 'Which seat do you want?',
  input: 'choice',
  choices: ['aisle', { id: 'window', label: 'Window seat' }],
  timeout_ms: 600_000,
});

// Hand `response_token` to a channel that reaches the person. That channel
// answers with it (sent in the X-Hexactra-Response-Token header, never in
// the URL):
await client.respondHandoff(handoff.id, { outcome: 'completed', value: 'window' }, {
  responseToken: response_token,
});

// The agent waits for the answer.
const answered = await client.getHandoff(handoff.id, { waitMs: 60_000 });
console.log(answered.response?.value); // "window"

// Secrets (a one-time code, a password) are never returned: `value_withheld`
// is true and the control plane types the value into the page, once.
const code = await client.createHandoff('session-id', {
  kind: 'code',
  prompt: 'Enter the 6-digit code sent to your phone',
  input: 'secret',
});
// ...after the person answers:
await client.typeSecret('session-id', { handoffId: code.handoff.id, selector: '#otp', submit: true });
```

`input` is `none`, `text`, `secret`, `choice`, `multi_choice`, `number`,
`confirm` or `takeover`; `constraints`, `confirm_label`, `deny_label` and
`risk` bound the answer. `listHandoffs({ sessionId, pending })` lists them and
`cancelHandoff(id)` cancels one.

**Removed:** the legacy HITL methods (`createInteractionRequest`,
`claimInteractionRequest`, `respondInteractionRequest`,
`getPendingInteractionRequests`, `requestOobConfirmation`, `verifyOob`,
`requestPasskey`, `verifyPasskey`) and their types (`InteractionKind`,
`InteractionStatus`, `InteractionRequest`, the OOB and passkey types) called a
`/hitl/...` API the control plane never served. Use the handoff methods above.
There is deliberately no method for the deprecated `POST /v1/handoffs/{id}/claim`.

## API Reference

### ControlPlaneClient

- `getSession(sessionId)` - Get session details
- `listSessions()` - List all sessions
- `getOperation(operationId)` - Get operation details
- `executeAction(sessionId, action)` - Execute a browser action
- `createHandoff(sessionId, request)` - Ask a person a typed question (`POST /v1/sessions/{id}/handoffs`)
- `listHandoffs({ sessionId?, pending? })` - List handoffs
- `getHandoff(id, { waitMs? })` - Read a handoff, optionally waiting for the answer
- `respondHandoff(id, { outcome, value?, values?, channel?, answered_by? }, { responseToken? })` - Answer a handoff
- `cancelHandoff(id)` - Cancel a pending handoff
- `typeSecret(sessionId, { handoffId, selector, clear?, submit?, tabId? })` - Type a `secret` answer into the page (a `type_secret` action)

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run tests
pnpm test

# Lint
pnpm lint

# Format
pnpm format
```

## License

MIT
