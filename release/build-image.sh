#!/usr/bin/env bash
# Build OCI image for Hexactra

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TAG="${HEXACTRA_IMAGE_TAG:-hexactra:latest}"

echo "Building OCI image: $TAG"

# Build the image
for target in control host; do
    docker build -f "$PROJECT_ROOT/deploy/container/Dockerfile" --target "$target" \
        -t "${TAG%:*}-$target:${TAG##*:}" "$PROJECT_ROOT"
done

echo "OCI image built: $TAG"
