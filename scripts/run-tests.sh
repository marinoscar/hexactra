#!/bin/bash

# Run all tests for Hexactra monorepo

set -e

echo "=== Running Rust tests ==="
cargo test --workspace

echo "=== Running TypeScript tests ==="
pnpm -r test

echo "=== All tests passed ==="
