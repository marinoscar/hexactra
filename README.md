# Hexactra Monorepo

This is the monorepo for Hexactra, an AI-powered browser automation runtime.

## Remote browser control: start here

Drive your own signed-in Chrome on a Linux machine from anywhere, through the `hexactra` CLI or, for AI agents, the `hexactra-mcp` MCP server:

```bash
scripts/install-remote-control.sh   # build, install to ~/.local/bin, start user services
# load apps/chrome-extension/dist in Chrome (Developer mode -> Load unpacked)
hexactra status
hexactra navigate https://example.com && hexactra screenshot -o page.jpg
```

- Quickstart, remote access and safety: [docs/remote-control-quickstart.md](docs/remote-control-quickstart.md)
- Desktop off? Run the always-on container host (`deploy/container`, browser on demand plus web viewer): [docs/container-host.md](docs/container-host.md)
- `/v1` API: [docs/remote-control-api.md](docs/remote-control-api.md)
- Proven by a real-Chromium end-to-end test in CI: `tests/e2e/remote-control.e2e.mjs`

## Structure

### Rust Crates (`crates/`)

- `hexactra-core` - Core types and traits
- `hexactra-telemetry` - Telemetry and tracing utilities
- `hexactra-control` - Control plane (`hexactra-control serve`: the `/v1` remote control API)
- `hexactra-client` - HTTP client for the `/v1` API
- `hexactra-agent` - Host agent (`hexactra-agent daemon`: attaches to your Chrome via the extension)
- `hexactra-worker` - Session worker (earlier scaffolding; not on the remote control path)
- `hexactra-native-host` - Chrome Native Messaging host (relays the extension to the agent)
- `hexactra-cli` - `hexactra` CLI
- `hexactra-mcp` - MCP server (stdio) exposing the browser as tools for AI agents

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
