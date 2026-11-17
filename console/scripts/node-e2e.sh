#!/usr/bin/env bash
# End to end on a real machine (#344): an unattended node installed with
# nothing but the hexactra CLI (`agent install --mode unattended`, real sudo
# and systemd, as on a mini PC), joined to a real fabric, then checked from
# the outside: the host is online with its desktop; the desktop answers a
# full RFB handshake (ServerInit 1920x1080) through the fabric's tunnel; a
# takeover pauses actions; the node opens no listening port; it goes offline
# and comes back with its service.
#
#   console/scripts/node-e2e.sh        # on an Ubuntu 24.04 machine (CI runner)
#
# Needs: a release build of the agent and fabric (target/release), the
# extension build (apps/chrome-extension/dist), the console CLI build
# (console/apps/cli/dist), passwordless sudo and systemd. With
# EXTENSION_CRX_KEY set it also serves the signed extension locally and
# checks that Google Chrome installed it by policy and the agent drives it.
set -euo pipefail
cd "$(dirname "$0")/../.."
root=$PWD
work=$(mktemp -d)
fail() {
  echo "FAIL: $*" >&2
  sudo journalctl -u hexactra-desktop -u hexactra-session -u hexactra-node-agent -n 120 --no-pager >&2 || true
  tail -n 60 "$work/fabric.log" >&2 || true
  exit 1
}
pass() { echo "ok   $*"; }
listeners() { ss -ltnH | awk '{print $4}' | sort -u; }

token=$(openssl rand -hex 32)
printf '%s\n' "$token" >"$work/token"
fabric=http://127.0.0.1:8787
cli() { node "$root/console/apps/cli/dist/cli.js" "$@"; }

# The fabric (the console's private control plane, here on loopback).
XDG_CONFIG_HOME="$work/fabric" XDG_DATA_HOME="$work/fabric" \
  "$root/target/release/hexactra-control" serve --bind 127.0.0.1:8787 --token-file "$work/token" >"$work/fabric.log" 2>&1 &
for _ in $(seq 1 30); do curl -fsS "$fabric/v1/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "$fabric/v1/health" >/dev/null || fail "the fabric did not start"
before=$(listeners)

# The agent bundle, as the release workflow packs it.
node scripts/package-agent-bundle.mjs --target-dir target/release --extension-dir apps/chrome-extension/dist --out "$work/dist" >/dev/null \
  || fail "package the agent bundle"
update_args=()
if [ -n "${EXTENSION_CRX_KEY:-}" ]; then
  printf '%s\n' "$EXTENSION_CRX_KEY" >"$work/crx.pem" && chmod 600 "$work/crx.pem"
  node scripts/pack-crx3.mjs --key "$work/crx.pem" --version 0.0.0.1 --codebase http://127.0.0.1:8099/hexactra-extension.crx --out "$work/ext" >/dev/null \
    || fail "pack the extension"
  rm -f "$work/crx.pem"
  (cd "$work/ext" && python3 -m http.server 8099 --bind 127.0.0.1 >/dev/null 2>&1 &)
  # Take the baseline only once the server listens, or its port looks like the node's.
  for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:8099/updates.xml >/dev/null 2>&1 && break; sleep 0.2; done
  curl -fsS http://127.0.0.1:8099/updates.xml >/dev/null || fail "the extension server did not start"
  update_args=(--extension-update-url http://127.0.0.1:8099/updates.xml)
  before=$(listeners)
fi

hxe=$(curl -fsS -X POST "$fabric/v1/admin/hosts/enrollments" -H "authorization: Bearer $token" -H 'content-type: application/json' \
  -d '{"name":"ci-node","ttl_s":600}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).enrollment_token))')
[ -n "$hxe" ] || fail "no enrollment token"

cli agent install --mode unattended --name ci-node --bundle "$work/dist/hexactra-agent-linux-x86_64.tar.gz" \
  --enrollment-token "$hxe" --agent-url "$fabric" "${update_args[@]}" >"$work/install.log" 2>&1 \
  || { cat "$work/install.log" >&2; fail "hexactra agent install --mode unattended"; }
! grep -q "$hxe" "$work/install.log" || fail "the enrollment token was printed"
pass "hexactra agent install --mode unattended (sudo once, system units, user hexactra)"

for u in hexactra-desktop hexactra-session hexactra-node-agent; do
  systemctl is-active --quiet "$u" || fail "$u is not active"
done
[ "$(stat -c %U /var/lib/hexactra)" = hexactra ] || fail "/var/lib/hexactra is not owned by hexactra"
[ "$(sudo stat -c '%a %U' /var/lib/hexactra/.config/hexactra/host-credential.json)" = "600 hexactra" ] || fail "the host credential is not 0600 hexactra"
sudo test -S /run/hexactra/vnc.sock || fail "no desktop socket"
[ "$(sudo stat -c %a /run/hexactra)" = 700 ] || fail "/run/hexactra is not 0700"
pass "units active; credential 0600 for hexactra; desktop socket in a 0700 directory"

cli agent doctor >"$work/doctor.log" 2>&1 || true
grep -q '^ok    hexactra-desktop' "$work/doctor.log" || { cat "$work/doctor.log" >&2; fail "agent doctor"; }
pass "agent doctor reports the units"

T="$token" FABRIC="$fabric" CRX="${EXTENSION_CRX_KEY:+1}" node "$root/console/scripts/node-e2e.mjs" || fail "node checks"

after=$(listeners)
new=$(comm -13 <(echo "$before") <(echo "$after") || true)
[ -z "$new" ] || fail "the node opened listening ports: $new"
pass "the node opens no listening port"

sudo systemctl stop hexactra-node-agent
T="$token" FABRIC="$fabric" PHASE=offline node "$root/console/scripts/node-e2e.mjs" || fail "offline checks"
sudo systemctl start hexactra-node-agent
T="$token" FABRIC="$fabric" PHASE=online node "$root/console/scripts/node-e2e.mjs" || fail "back online"
pass "stopping the agent takes the host offline; starting it brings it back"

cli agent uninstall --mode unattended --yes --keep-host >/dev/null || fail "uninstall"
! systemctl is-active --quiet hexactra-node-agent || fail "the agent still runs after uninstall"
pass "uninstall stops and removes the node (profiles kept)"
