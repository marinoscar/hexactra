#!/usr/bin/env bash
# Bring up the whole VPS stack (console + fabric + browser host) and check it
# (#221): healthy services, the fabric unpublished and reachable from the API,
# the bundled host registered, and the /viewer/local/ gate (401 without a
# ticket, a one-time ticket exchanged for a cookie, the ticket refused again).
#
#   console/scripts/stack-smoke.sh            # from the repository root
#   KEEP=1 console/scripts/stack-smoke.sh     # leave the stack running
set -euo pipefail
cd "$(dirname "$0")/.."
console=$PWD
files=(-f base.compose.yml -f prod.compose.yml -f devdb.compose.yml -f app.fabric.compose.yml)
fail() { echo "FAIL: $*" >&2; (cd "$console/infra/compose" && docker compose "${files[@]}" logs --tail 80) >&2 || true; exit 1; }
pass() { echo "ok   $*"; }

env_file=infra/compose/.env
set_var() { if grep -q "^$1=" "$env_file"; then sed -i "s|^$1=.*|$1=$2|" "$env_file"; else echo "$1=$2" >> "$env_file"; fi; }
if [ ! -f "$env_file" ]; then
  cp infra/compose/.env.example "$env_file"
  chmod 600 "$env_file"
  set_var STACK_AGENT_TOKEN "$(openssl rand -hex 32)"
  set_var GOOGLE_CLIENT_ID ci-google-client-id
  set_var GOOGLE_CLIENT_SECRET ci-google-client-secret
  set_var HEXACTRA_FABRIC_OPERATOR_TOKEN "$(openssl rand -hex 32)"
  set_var HEXACTRA_VIEWER_PASSWORD "$(openssl rand -hex 4)"
  set_var POSTGRES_HOST db
  # Blank, so init generates them with the CSPRNG.
  for k in JWT_SECRET COOKIE_SECRET SECRETS_ENCRYPTION_KEY; do set_var "$k" ""; done
  node apps/cli/dist/cli.js init --force --non-interactive --admin-email admin@example.test >/dev/null
fi

cd infra/compose
dc() { docker compose "${files[@]}" "$@"; }
cleanup() { if [ "${KEEP:-0}" != 1 ]; then dc down -v --remove-orphans >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT

# The platform stack joins the shared external network (README: once per host).
docker network create devnet >/dev/null 2>&1 || true
dc build >/dev/null
dc up -d --wait --wait-timeout 300 db fabric-control fabric-host || fail "fabric or database did not become healthy"
pass "database, fabric control plane and browser host are healthy"
mig=$(mktemp)
dc run --rm --no-deps api npm run prisma:migrate >"$mig" 2>&1 || { cat "$mig" >&2; fail "migrations"; }
dc up -d --wait --wait-timeout 300 || fail "stack did not become healthy"
pass "the whole stack is healthy"

base=http://127.0.0.1:${NGINX_PORT:-3535}
for i in $(seq 1 30); do curl -fsS "$base/api/health" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS "$base/api/health" >/dev/null || fail "/api/health"
pass "console API answers through nginx"

[ -z "$(docker port "$(dc ps -q fabric-control)" 2>/dev/null)" ] || fail "the fabric control plane is published"
[ -z "$(docker port "$(dc ps -q fabric-host)" 2>/dev/null)" ] || fail "the browser host is published"
dc exec -T api node -e "fetch('http://fabric-control:8787/v1/health').then(r=>{if(!r.ok)process.exit(1)})" || fail "API cannot reach the fabric"
pass "fabric unpublished, reachable from the API on the private network"

token=$(grep '^HEXACTRA_FABRIC_OPERATOR_TOKEN=' ../../infra/compose/.env 2>/dev/null | cut -d= -f2- || true)
[ -n "$token" ] || token=$(grep '^HEXACTRA_FABRIC_OPERATOR_TOKEN=' .env | cut -d= -f2-)
for i in $(seq 1 30); do
  dc exec -T -e HEXACTRA_API_TOKEN="$token" fabric-control hexactra --url http://127.0.0.1:8787 status 2>/dev/null | grep -q 'online=true' && break
  sleep 2
done
dc exec -T -e HEXACTRA_API_TOKEN="$token" fabric-control hexactra --url http://127.0.0.1:8787 status | grep -q 'online=true' || fail "browser host not online"
pass "bundled browser host registered and online"

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
[ "$(code "$base/viewer/local/vnc.html")" = 401 ] || fail "viewer without a ticket is not refused"
[ "$(code "$base/viewer/local/vnc.html?ticket=t.9999999999.x.forged")" = 401 ] || fail "forged ticket accepted"
[ "$(code -H 'Cookie: hx_viewer=c.9999999999.x.forged' "$base/viewer/local/vnc.html")" = 401 ] || fail "forged cookie accepted"
pass "viewer refuses unauthenticated, forged-ticket and forged-cookie requests"

# A real ticket, signed like ViewerTicketService with the stack's JWT_SECRET.
secret=$(grep '^JWT_SECRET=' .env | cut -d= -f2-)
ticket=$(JWT_SECRET="$secret" node -e '
  const c=require("node:crypto");
  const key=c.createHmac("sha256",process.env.JWT_SECRET).update("hexactra-viewer-v1").digest();
  const body=`t.${Math.floor(Date.now()/1000)+60}.${c.randomBytes(12).toString("base64url")}`;
  process.stdout.write(`${body}.${c.createHmac("sha256",key).update(body).digest("base64url")}`);')
jar=$(mktemp)
[ "$(code -c "$jar" "$base/viewer/local/vnc.html?ticket=$ticket")" = 200 ] || fail "a valid ticket does not open the viewer"
grep -q hx_viewer "$jar" || fail "no viewer cookie set"
[ "$(code -b "$jar" "$base/viewer/local/vnc.html")" = 200 ] || fail "the viewer cookie does not work"
[ "$(code "$base/viewer/local/vnc.html?ticket=$ticket")" = 401 ] || fail "a ticket worked twice"
pass "a one-time ticket opens the viewer, sets its cookie and cannot be reused"
echo "stack smoke: all checks passed"
