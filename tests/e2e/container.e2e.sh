#!/usr/bin/env bash
# End-to-end test of the container stack (#197, #198).
#
# Builds the images, starts control plane + browser host + a fixture site,
# and drives Chromium inside the container with the CLI from the control
# image. Requires Docker with compose v2.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/deploy/container"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-hexactra-e2e}"
COMPOSE=(docker compose -f compose.yml -f compose.test.yml)

pass() { printf 'ok   %s\n' "$*"; }
fail() {
    printf 'FAIL %s\n' "$*" >&2
    "${COMPOSE[@]}" logs --tail 80 >&2 || true
    echo "----- browser log -----" >&2
    "${COMPOSE[@]}" exec -T host tail -60 /data/profiles/default/hexactra-browser.log >&2 || true
    exit 1
}

cleanup() {
    if [[ "${KEEP:-0}" != 1 ]]; then "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; fi
    rm -f .env.e2e
}
trap cleanup EXIT

# Test settings (never reuse a real .env).
rand() { head -c "$1" /dev/urandom | od -An -vtx1 | tr -d ' \n'; }
export HEXACTRA_API_TOKEN="$(rand 32)"
export HEXACTRA_VIEWER_PASSWORD="$(rand 4)"
export HEXACTRA_IDLE_SHUTDOWN_S=8
export HEXACTRA_LAUNCH_EAGERLY=false

"${COMPOSE[@]}" up -d --build --wait --wait-timeout 300 || fail "stack did not become healthy"
pass "stack is up and healthy"

hx() { "${COMPOSE[@]}" exec -T -e HEXACTRA_API_TOKEN="$HEXACTRA_API_TOKEN" control hexactra --url http://127.0.0.1:8787 "$@"; }
chromium_running() { "${COMPOSE[@]}" exec -T host pgrep -f 'user-data-dir=/data/profiles/default' >/dev/null; }

curl -fsS http://127.0.0.1:8787/v1/health >/dev/null || fail "API not published on 127.0.0.1:8787"
[[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/v1/hosts)" == 401 ]] || fail "API accepted a request without the token"
pass "API published on loopback and requires the token"

curl -fsS http://127.0.0.1:6080/vnc.html | grep -qi novnc || fail "viewer page not served"
"${COMPOSE[@]}" exec -T host pgrep -a x11vnc | grep -q -- '-rfbauth' || fail "viewer is not password protected"
pass "viewer served on loopback and password protected"

for _ in $(seq 1 30); do
    hx status | grep -q 'on_demand=true' && break
    sleep 1
done
hx status | grep -q 'on_demand=true' || fail "host did not register as on-demand"
hx status | grep -q 'viewer=http://127.0.0.1:6080/vnc.html' || fail "host viewer URL missing"
chromium_running && fail "browser started before it was needed"
pass "host registered on demand with its viewer; browser not running yet"

hx session create >/dev/null
hx --timeout-ms 60000 navigate http://fixture/persist.html | grep -q 'Hexactra Fixture Persist' || fail "navigate failed"
hx text --selector '#visits' | grep -q 'visits: 1' || fail "first visit not recorded"
chromium_running || fail "browser not running after the first action"
# The sandbox is really on: renderers live in their own PID namespace and
# nothing runs with --no-sandbox; the browser runs as the unprivileged user.
"${COMPOSE[@]}" exec -T host sh -c '
  set -e
  ! pgrep -af -- "--no-sandbox" | grep -q chromium
  main=$(pgrep -o -f "user-data-dir=/data/profiles/default")
  rend=$(pgrep -f -- "--type=renderer" | head -1)
  [ -n "$rend" ]
  [ "$(readlink /proc/$main/ns/pid)" != "$(readlink /proc/$rend/ns/pid)" ]
  [ "$(stat -c %u /proc/$main)" = 1000 ]
' || fail "Chromium sandbox is not active"
pass "first action launched Chromium in the container: sandboxed (renderer in its own PID namespace), uid 1000"

hx navigate http://fixture/index.html >/dev/null
hx type '#q' 'from the container' --submit >/dev/null
hx text --selector '#out' | grep -q 'searched: from the container' || fail "type/submit failed"
hx screenshot -o /tmp/shot.jpg | grep -q 'bytes' || fail "screenshot failed"
pass "navigate, type, submit, text and screenshot work"

for _ in $(seq 1 30); do chromium_running || break; sleep 1; done
chromium_running && fail "idle browser was not closed"
pass "idle browser closed"

hx navigate http://fixture/persist.html >/dev/null
visits() { hx text --selector '#visits' | sed -n 's/.*visits: \([0-9]*\).*/\1/p'; }
[ "$(visits)" -ge 2 ] || fail "profile did not persist across idle relaunch"
pass "relaunch after idle keeps the profile"

"${COMPOSE[@]}" restart host >/dev/null
"${COMPOSE[@]}" up -d --wait --wait-timeout 120 >/dev/null || fail "host not healthy after restart"
for _ in $(seq 1 30); do hx status | grep -q 'on_demand=true' && break; sleep 1; done
hx --timeout-ms 60000 navigate http://fixture/persist.html >/dev/null || fail "navigate after container restart failed"
[ "$(visits)" -ge 3 ] || fail "profile did not survive the container restart"
pass "profile survives a container restart (stale lock cleared)"

hx --profile travel session create --create >/dev/null
hx --profile travel navigate http://fixture/persist.html >/dev/null
hx --profile travel text --selector '#visits' | grep -q 'visits: 1' || fail "new profile does not have its own storage"
"${COMPOSE[@]}" exec -T host test -d /data/profiles/travel || fail "profile directory missing"
browsers() { "${COMPOSE[@]}" exec -T host sh -c "pgrep -af 'user-data-dir=/data/profiles/' | grep -cv -- '--type='" || true; }
[ "$(browsers)" -eq 1 ] || fail "expected one browser at HEXACTRA_MAX_BROWSERS=1, found $(browsers)"
hx navigate http://fixture/persist.html >/dev/null
[ "$(visits)" -ge 4 ] || fail "default profile lost its storage after switching profiles"
[ "$(browsers)" -eq 1 ] || fail "switching back did not close the travel browser"
hx profile list | grep -q 'travel' || fail "profile list does not show travel"
pass "a second profile has its own storage; profiles share one browser slot"

id="$(hx handoff request --kind captcha --prompt 'Solve it in the viewer' 2>/dev/null)"
hx --json handoff show "$id" | grep -q '"viewer_url": "http://127.0.0.1:6080/vnc.html"' || fail "handoff has no viewer link"
hx handoff cancel "$id" >/dev/null
pass "handoffs link to the container's viewer"

echo
echo "container e2e passed"
