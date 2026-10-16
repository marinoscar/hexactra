#!/bin/bash

# Build all packages for Hexactra monorepo

set -e

echo "=== Building Rust workspace ==="
cargo build --workspace

echo "=== Building TypeScript packages ==="
pnpm -r build

echo "=== All builds passed ==="
