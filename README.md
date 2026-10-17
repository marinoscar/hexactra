# Hexactra Monorepo

This is the monorepo for Hexactra, an AI-powered browser automation runtime.

## Structure

### Rust Crates (`crates/`)

- `hexactra-core` - Core types and traits
- `hexactra-telemetry` - Telemetry and tracing utilities
- `hexactra-control` - Control plane API
- `hexactra-agent` - Host agent
- `hexactra-worker` - Session worker
- `hexactra-native-host` - Chrome Native Messaging host
- `hexactra-cli` - CLI tool
- `hexactra-mcp` - MCP server

### TypeScript Packages (`packages/`)

- `@hexactra/sdk` - TypeScript SDK
- `@hexactra/contracts` - OpenAPI and MCP contracts

### Applications (`apps/`)

- `@hexactra/chrome-extension` - Chrome extension
- `@hexactra/dashboard` - Web dashboard

## Development

### Prerequisites

- Rust (stable)
- Node.js 22+
- pnpm

### Setup

```bash
# Install Rust dependencies
cargo build --workspace

# Install TypeScript dependencies
pnpm install

# Build everything
pnpm build

# Run tests
pnpm test
```

### Running the fixture server

```bash
node scripts/fixture-server.js
```

## Documentation

For detailed documentation, see the `docs/` directory:

- [Installation Guide](docs/installation.md) - Install Hexactra on Linux with systemd or Docker
- [Operations Guide](docs/operations.md) - Daily operations, monitoring, and maintenance
- [API Documentation](docs/api.md) - REST API and MCP tools reference
- [Security Guide](docs/security.md) - Security principles and best practices
- [Recovery Guide](docs/recovery.md) - Backup, restore, and disaster recovery

## CI

The CI pipeline runs on push and pull requests:

- Rust: clippy, fmt, tests
- TypeScript: build, lint, test
- Contracts: schema roundtrip check
