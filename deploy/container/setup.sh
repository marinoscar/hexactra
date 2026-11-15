#!/usr/bin/env bash
# Create deploy/container/.env (mode 0600) with a generated API token and
# viewer password. Safe to re-run: an existing .env is kept.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
if [[ -f .env ]]; then
    echo ".env already exists; leaving it unchanged."
    exit 0
fi
rand() { head -c "$1" /dev/urandom | od -An -vtx1 | tr -d ' \n'; }
umask 077
cat > .env <<ENV
# Hexactra container stack settings. Keep this file private.
HEXACTRA_API_TOKEN=$(rand 32)
# VNC passwords are limited to 8 characters: keep the viewer port private.
HEXACTRA_VIEWER_PASSWORD=$(rand 4)

# External URLs (fill in when you expose the stack, e.g. with tailscale serve):
HEXACTRA_PUBLIC_URL=
HEXACTRA_VIEWER_URL=

# Close the browser after this many idle seconds (0 keeps it open).
HEXACTRA_IDLE_SHUTDOWN_S=900
HEXACTRA_LAUNCH_EAGERLY=false
# Profiles whose browsers may be open at once (about 300-600 MB each).
HEXACTRA_MAX_BROWSERS=1
HEXACTRA_HOST_NAME=container-host
ENV
echo "Wrote $(pwd)/.env"
echo "Next: docker compose up -d --build"
echo "API token:       grep HEXACTRA_API_TOKEN .env"
echo "Viewer password: grep HEXACTRA_VIEWER_PASSWORD .env  (viewer: http://127.0.0.1:6080/vnc.html)"
