#!/usr/bin/env bash
# Hexactra JS SDK Build Script
# Builds and packages the TypeScript SDK for npm distribution

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SDK_DIR="$PROJECT_ROOT/packages/sdk"
RELEASE_DIR="$PROJECT_ROOT/release/sdk"

# Version from package.json
VERSION=$(node -p "require('$SDK_DIR/package.json').version")

echo "Building Hexactra JS SDK v$VERSION"

# Create release directory
mkdir -p "$RELEASE_DIR"

# Build the SDK
cd "$SDK_DIR"

echo "Cleaning previous build..."
rm -rf dist

echo "Building SDK..."
pnpm build

# Copy built files to release
cp -r dist/* "$RELEASE_DIR/"

# Copy package.json and other necessary files
cp package.json "$RELEASE_DIR/"
cp README.md "$RELEASE_DIR/" 2>/dev/null || true
cp LICENSE "$RELEASE_DIR/" 2>/dev/null || true

# Generate checksums for distribution files
echo "Generating checksums..."
cd "$RELEASE_DIR"

for file in *.js *.d.ts; do
    if [[ -f "$file" ]]; then
        sha256sum "$file" > "${file}.sha256"
        md5sum "$file" > "${file}.md5"
        echo "Checksum generated for: $file"
    fi
done

# Create installation instructions
cat > "$RELEASE_DIR/INSTALL.md" << 'ENDOFDOC'
# JS SDK Installation Guide

## Prerequisites

- Node.js 18 or later
- npm or pnpm package manager

## Installation

### Using npm

npm install @hexactra/sdk

### Using pnpm

pnpm add @hexactra/sdk

### Using yarn

yarn add @hexactra/sdk

## Usage

### Basic Example

import { HexactraClient } from '@hexactra/sdk';

// Create a client with your server URL
const client = new HexactraClient({
  baseUrl: 'http://localhost:8080',
  apiKey: 'your-api-key',
});

// List sessions
const sessions = await client.sessions.list();

// Create a new session
const session = await client.sessions.create({
  profileId: 'default',
});

// Execute a goal
await client.goals.execute(session.sessionId, 'Navigate to example.com');

### Standalone Mode (No Server)

import { HexactraClient } from '@hexactra/sdk';

// Create a client pointing to Chrome extension
const client = new HexactraClient({
  baseUrl: 'chrome-extension://your-extension-id',
});

// Use the client as normal
const result = await client.sessions.list();

## API Reference

For full API documentation, see the API docs.

### Main Classes

- HexactraClient - Main client class for interacting with Hexactra
- SessionClient - Session management operations
- GoalClient - Goal execution operations
- HITLClient - Human-in-the-loop operations

## Development

### Build from Source

# Clone the repository
git clone https://github.com/marinoscar/hexactra.git
cd hexactra/packages/sdk

# Install dependencies
pnpm install

# Build
pnpm build

# Run tests
pnpm test

### Publish to npm

# Login to npm
npm login

# Build and publish
pnpm publish

## Troubleshooting

### Module not found

Ensure you're using Node.js 18+ and the correct import path:
import { HexactraClient } from '@hexactra/sdk';

### Connection refused

Verify your Hexactra server is running and accessible:
curl http://localhost:8080/health

## License

MIT - See LICENSE file for details.
ENDOFDOC

echo ""
echo "JS SDK built successfully!"
echo "Release directory: $RELEASE_DIR"
ls -la "$RELEASE_DIR"
