#!/usr/bin/env bash
# Bring up the whole VPS stack (console + fabric + browser host) and check it
# (#221): healthy services, the fabric unpublished and reachable from the API,
# the bundled host registered (it is opt-in: COMPOSE_PROFILES=bundled-host),
# and its desktop through the fabric's tunnel (#343) behind the console's
# /viewer/<host>/websockify gate.
#
#   console/scripts/stack-smoke.sh            # from the repository root
#   KEEP=1 console/scripts/stack-smoke.sh     # leave the stack running
set -euo pipefail
cd "$(dirname "$0")/.."
console=$PWD
# The api's memory limit as a deploy applies it (`app.prod.api-memory.compose.yml`, #668): the fabric-connect step below boots a
# second copy of the application inside the api container, and under the platform's 512M the pair is killed (exit 137, no output).
files=(-f base.compose.yml -f prod.compose.yml -f devdb.compose.yml -f app.fabric.compose.yml -f app.prod.api-memory.compose.yml)
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
  # The built-in secrets store's key (#711): `deploy` generates it; the local init profile asks for it, so set it here.
  set_var SECRETS_STORE_KEY "$(openssl rand -base64 32)"
  set_var COMPOSE_PROFILES bundled-host
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
# No pipeline here ends in `grep -q`: it exits at the first match, the writer can then die on a closed pipe, and
# under pipefail the pipeline fails although it matched (a check with `&& fail` would then pass by mistake).
# Each grep reads all of its input and discards it; grep on a file or a here-string keeps -q.
for i in $(seq 1 30); do
  dc exec -T -e HEXACTRA_API_TOKEN="$token" fabric-control hexactra-fabric --url http://127.0.0.1:8787 status 2>/dev/null | grep 'online=true' >/dev/null && break
  sleep 2
done
dc exec -T -e HEXACTRA_API_TOKEN="$token" fabric-control hexactra-fabric --url http://127.0.0.1:8787 status | grep 'online=true' >/dev/null || fail "browser host not online"
pass "bundled browser host registered and online"

# The documented way to mint the console's service token (docs/runbooks/vps-stack.md §3).
dc exec -T fabric-control hexactra-fabric --url http://127.0.0.1:8787 admin service-token-create console | grep 'hxs_' >/dev/null \
  || fail "the documented service-token command does not print an hxs_ token"
pass "the fabric admin CLI mints a service token"

# What `hexactra deploy` does at the end of install/update (#309): the token is
# piped from the fabric into the api container's script, never shown or logged.
connect_out=$(dc exec -T fabric-control hexactra-fabric --url http://127.0.0.1:8787 admin service-token-create console 2>/dev/null \
  | dc exec -T api node dist/fabric/fabric-connect.cli.js set --url http://fabric-control:8787) \
  || fail "the deploy's fabric-connect pipe: $connect_out"
echo "$connect_out" | grep '"state":"connected"' >/dev/null || fail "the console did not connect to the bundled fabric: $connect_out"
! echo "$connect_out" | grep 'hxs_' >/dev/null || fail "the fabric-connect output shows the token"
dc exec -T api node dist/fabric/fabric-connect.cli.js status | grep '"state":"connected"' >/dev/null || fail "fabric-connect status after connecting"
pass "the deploy's fabric-connect step connects the console to the bundled fabric"

# Browser hosts reach the fabric over the console's own HTTPS vhost at /fabric/
# (infra/nginx/app.d/locations/fabric-agents.conf): only the host protocol is
# published; the client, admin and operator APIs stay private.
fabric_pub="$base/fabric"
curl -fsS "$fabric_pub/v1/health" | grep '"status"' >/dev/null || fail "/fabric/v1/health through nginx"
for private in "GET /v1/hosts" "GET /v1/sessions" "GET /v1/events" "POST /v1/admin/hosts/enrollments" "GET /v1/admin/service-tokens"; do
  set -- $private
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X "$1" "$fabric_pub$2")" = 404 ] || fail "$1 /fabric$2 must not be published"
done
hxe=$(dc exec -T fabric-control hexactra-fabric --url http://127.0.0.1:8787 admin enroll --name smoke-desktop 2>/dev/null | grep -o 'hxe_[A-Za-z0-9_-]*' | head -1)
[ -n "$hxe" ] || fail "the fabric admin CLI did not mint an enrollment token"
enrolled=$(curl -fsS -X POST "$fabric_pub/v1/hosts/enroll" -H 'content-type: application/json' \
  -d "{\"enrollment_token\":\"$hxe\",\"name\":\"smoke-desktop\",\"version\":\"smoke\"}") || fail "enroll through /fabric/"
host_id=$(node -e 'const j=JSON.parse(process.argv[1]);process.stdout.write(j.host_id||"")' "$enrolled")
host_token=$(node -e 'const j=JSON.parse(process.argv[1]);process.stdout.write(j.host_token||"")' "$enrolled")
[ -n "$host_id" ] && [ -n "$host_token" ] || fail "enroll through /fabric/ returned no host credential"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$fabric_pub/v1/hosts/enroll" -H 'content-type: application/json' \
  -d "{\"enrollment_token\":\"$hxe\"}")" != 200 ] || fail "an enrollment token was accepted twice"
curl -fsS -X POST "$fabric_pub/v1/hosts/register" -H "authorization: Bearer $host_token" -H 'content-type: application/json' \
  -d "{\"name\":\"smoke-desktop\",\"version\":\"smoke\",\"host_id\":\"$host_id\"}" >/dev/null || fail "register through /fabric/"
next_code=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $host_token" "$fabric_pub/v1/hosts/$host_id/next?wait_ms=1000&browser_connected=false")
case "$next_code" in 200|204) ;; *) fail "long-poll through /fabric/ answered $next_code" ;; esac
[ "$(curl -s -o /dev/null -w '%{http_code}' "$fabric_pub/v1/hosts/$host_id/next?wait_ms=1")" = 401 ] || fail "/fabric/ host routes must require the host credential"
# Desktop tunnels (#338): only the node's leg is published, and it needs the host credential.
zero=00000000-0000-4000-8000-000000000000
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$fabric_pub/v1/hosts/$host_id/desktop-sessions")" = 404 ] || fail "desktop-sessions must not be published"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$fabric_pub/v1/desktop/$zero/connect")" = 404 ] || fail "the viewer's tunnel leg must not be published"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$fabric_pub/v1/hosts/$host_id/desktop/$zero")" = 401 ] || fail "the node's tunnel leg must require the host credential"
dc exec -T fabric-control hexactra-fabric --url http://127.0.0.1:8787 admin revoke-host "$host_id" >/dev/null 2>&1 || true
pass "browser hosts enroll, register and long-poll over HTTPS at /fabric/; private APIs are not published"

# A machine joins with nothing but the hexactra CLI (#328): the agent bundle
# (packaged from this stack's host image with the release script), then
# `hexactra agent install` with an admin-minted token and `hexactra agent run`,
# reaching the fabric through nginx at /fabric/. The host must come online.
agent_tmp=$(mktemp -d)
cid=$(docker create "$(dc images -q fabric-host | head -1)")
docker cp "$cid:/usr/local/bin/hexactra-agent" "$agent_tmp/" && docker cp "$cid:/usr/local/bin/hexactra-native-host" "$agent_tmp/" \
  && docker cp "$cid:/opt/hexactra/extension" "$agent_tmp/extension" || fail "extract the agent from the host image"
docker rm "$cid" >/dev/null
node "$console/../scripts/package-agent-bundle.mjs" --target-dir "$agent_tmp" --extension-dir "$agent_tmp/extension" --out "$agent_tmp/dist" >/dev/null \
  || fail "package the agent bundle"
hxe=$(dc exec -T fabric-control hexactra-fabric --url http://127.0.0.1:8787 admin enroll --name ci-cli-host 2>/dev/null | grep -o 'hxe_[A-Za-z0-9_-]*' | head -1)
mkdir -p "$agent_tmp/run" && chmod 700 "$agent_tmp/run"
cli_env=(env HOME="$agent_tmp/home" XDG_DATA_HOME="$agent_tmp/home/data" XDG_CONFIG_HOME="$agent_tmp/home/config" XDG_RUNTIME_DIR="$agent_tmp/run")
"${cli_env[@]}" node "$console/apps/cli/dist/cli.js" agent install --no-service --name ci-cli-host \
  --bundle "$agent_tmp/dist/hexactra-agent-linux-x86_64.tar.gz" --browser /usr/bin/true \
  --enrollment-token "$hxe" --agent-url "$fabric_pub" >"$agent_tmp/install.log" 2>&1 || { cat "$agent_tmp/install.log" >&2; fail "hexactra agent install"; }
grep -q 'Checksum verified' "$agent_tmp/install.log" || fail "hexactra agent install did not verify the bundle"
! grep -q "$hxe" "$agent_tmp/install.log" "$agent_tmp/home/data/hexactra/agent/install.json" || fail "the enrollment token was written out"
"${cli_env[@]}" node "$console/apps/cli/dist/cli.js" agent run >"$agent_tmp/agent.log" 2>&1 &
agent_pid=$!
# The agent starts its browser before it registers (up to 60 s), so wait longer than that.
for i in $(seq 1 90); do
  dc exec -T -e HEXACTRA_API_TOKEN="$token" fabric-control hexactra-fabric --url http://127.0.0.1:8787 status 2>/dev/null | grep 'ci-cli-host .*online=true' >/dev/null && break
  sleep 1
done
dc exec -T -e HEXACTRA_API_TOKEN="$token" fabric-control hexactra-fabric --url http://127.0.0.1:8787 status | grep 'ci-cli-host .*online=true' >/dev/null \
  || { kill "$agent_pid" 2>/dev/null; cat "$agent_tmp/agent.log" >&2; fail "the CLI-installed agent did not come online over /fabric/"; }
agent_status=$("${cli_env[@]}" node "$console/apps/cli/dist/cli.js" agent status) || fail "hexactra agent status"
grep -q 'Host:     ci-cli-host' <<<"$agent_status" || fail "hexactra agent status: $agent_status"
kill "$agent_pid" 2>/dev/null || true
"${cli_env[@]}" node "$console/apps/cli/dist/cli.js" agent uninstall --yes --keep-host >/dev/null || fail "hexactra agent uninstall"
[ ! -e "$agent_tmp/home/config/hexactra/host-credential.json" ] || fail "uninstall left the host credential"
pass "a machine joins with only the hexactra CLI: verified bundle, enrollment, online over HTTPS at /fabric/"

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
tmpdir_headers=$(mktemp)

# Android: Chrome verifies the app (and only then delegates the site's
# notifications to it) with /.well-known/assetlinks.json, which must be the
# API's JSON array, never the SPA's index.html.
links=$(curl -s -D "$tmpdir_headers" "$base/.well-known/assetlinks.json")
grep -qi '^content-type: application/json' "$tmpdir_headers" || fail "assetlinks.json is not served as JSON (the SPA answered?)"
echo "$links" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{if(!Array.isArray(JSON.parse(s)))process.exit(1)})' \
  || fail "assetlinks.json is not a JSON array"
pass "/.well-known/assetlinks.json is served by the API"
# Remote desktops (#339, #343): the old ticket viewer is gone, and nginx
# admits a desktop WebSocket only with a console viewer session.
[ "$(code "$base/viewer/local/vnc.html")" = 404 ] || fail "the legacy /viewer/local/ viewer is still served"
[ "$(code "$base/viewer/00000000-0000-4000-8000-000000000000/websockify")" = 401 ] || fail "a desktop WebSocket without a session is not refused"
[ "$(code -H 'Cookie: hx_desktop=forged' "$base/viewer/00000000-0000-4000-8000-000000000000/websockify")" = 401 ] || fail "a forged desktop cookie is accepted"
pass "desktops need a console viewer session; the legacy viewer is gone"

# The bundled host's desktop through the fabric's tunnel: a tunnel for host
# "local", the viewer's WebSocket leg, and the RFB greeting from the
# container's own VNC, relayed by its agent.
rfb=$(dc exec -T -e T="$token" api node -e '
  (async () => {
    const h = { authorization: `Bearer ${process.env.T}`, "content-type": "application/json" };
    const hosts = await (await fetch("http://fabric-control:8787/v1/hosts", { headers: h })).json();
    const local = hosts.hosts.find((x) => x.name === "local");
    if (!local || !local.desktop || local.mode !== "container") throw new Error("host local has no desktop: " + JSON.stringify(local));
    const s = await (await fetch(`http://fabric-control:8787/v1/hosts/${local.id}/desktop-sessions`, { method: "POST", headers: h, body: JSON.stringify({ actor: { display_name: "smoke" } }) })).json();
    const ws = new WebSocket(`ws://fabric-control:8787/v1/desktop/${s.tunnel_id}/connect`, { headers: { authorization: `Bearer ${s.connect_token}` } });
    ws.binaryType = "arraybuffer";
    const t = setTimeout(() => { console.error("timeout"); process.exit(1); }, 30000);
    ws.onmessage = (m) => { process.stdout.write(Buffer.from(m.data).toString()); clearTimeout(t); ws.close(); process.exit(0); };
    ws.onerror = (e) => { console.error(e.message); process.exit(1); };
  })().catch((e) => { console.error(e.message); process.exit(1); });') || fail "the bundled host's desktop through the tunnel: $rfb"
[ "$rfb" = "RFB 003.008" ] || [ "$(printf '%s' "$rfb" | head -c 11)" = "RFB 003.008" ] || fail "no RFB greeting through the tunnel (got: $rfb)"
pass "the bundled host's desktop answers RFB 003.008 through the fabric tunnel"

# Without the profile the bundled host is not part of the stack (#343).
COMPOSE_PROFILES=none docker compose --env-file .env "${files[@]}" config --services | grep -x fabric-host >/dev/null \
  && fail "fabric-host runs without COMPOSE_PROFILES=bundled-host"
pass "the bundled host is opt-in (COMPOSE_PROFILES)"
# Back up the fabric's state the way docs/runbooks/operations.md says (stop,
# archive the volume, start), then check the host comes back online with the
# state the control plane restored from its database.
backups=$(mktemp -d)
dc stop fabric-host fabric-control >/dev/null || fail "stop the fabric for a backup"
for svc in fabric-control fabric-host; do
  docker run --rm --volumes-from "$(dc ps -aq "$svc")" -v "$backups:/backup" alpine:3.22 \
    tar czf "/backup/$svc.tgz" -C /data . || fail "back up $svc"
done
dc start fabric-control fabric-host >/dev/null || fail "start the fabric after the backup"
tar tzf "$backups/fabric-control.tgz" | grep 'control.db$' >/dev/null || fail "the control-plane backup has no control.db"
[ -s "$backups/fabric-host.tgz" ] || fail "the browser-host backup is empty"
for _ in $(seq 1 60); do
  dc exec -T -e HEXACTRA_API_TOKEN="$token" fabric-control hexactra-fabric --url http://127.0.0.1:8787 status 2>/dev/null | grep 'online=true' >/dev/null && break
  sleep 2
done
dc exec -T -e HEXACTRA_API_TOKEN="$token" fabric-control hexactra-fabric --url http://127.0.0.1:8787 status | grep 'online=true' >/dev/null || fail "browser host not online after a backup and restart"
pass "the documented fabric backup works and the host comes back online"
echo "stack smoke: all checks passed"
