# @hexactra/sdk

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

### HITL (Human in the Loop)

```typescript
// Create an interaction request
const request = await client.createInteractionRequest(
  'session-id',
  'Please verify this action',
  { action: 'click' },
  InteractionKind.ActionApproval
);

// Claim and respond to it
await client.claimInteractionRequest(request.id, 'operator-1');
await client.respondInteractionRequest(request.id, InteractionStatus.Approved, 'operator-1');
```

## API Reference

### ControlPlaneClient

- `createGoal(sessionId, actions)` - Create a new goal
- `getSession(sessionId)` - Get session details
- `listSessions()` - List all sessions
- `getOperation(operationId)` - Get operation details
- `executeAction(sessionId, action)` - Execute a browser action
- `createInteractionRequest(...)` - Create a HITL request
- `claimInteractionRequest(requestId, ownerId)` - Claim a HITL request
- `respondInteractionRequest(requestId, status, ownerId, secret?)` - Respond to a HITL request
- `getPendingInteractionRequests(sessionId)` - Get pending HITL requests
- `requestOobConfirmation(...)` - Request OOB confirmation
- `verifyOob(channelId, verificationCode)` - Verify OOB code
- `requestPasskey(...)` - Request passkey auth
- `verifyPasskey(...)` - Verify passkey

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
