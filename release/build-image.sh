#!/usr/bin/env bash
# Build OCI image for Hexactra

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TAG="${HEXACTRA_IMAGE_TAG:-hexactra:latest}"

echo "Building OCI image: $TAG"

# Build the image
docker build -t "$TAG" "$PROJECT_ROOT"

echo "OCI image built: $TAG"
