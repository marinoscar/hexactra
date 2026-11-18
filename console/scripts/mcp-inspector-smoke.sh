#!/usr/bin/env bash
# MCP Inspector smoke (#461): the official MCP Inspector CLI, pinned, against
# a RUNNING console (the dev stack or a deployment). It lists the tools over
# Streamable HTTP and calls one read-only tool, authenticated with a
# personal access token.
#
#   MCP_URL=http://localhost:3535/api/mcp HEXACTRA_TOKEN=pat_... console/scripts/mcp-inspector-smoke.sh
#
# Needs network access to npm (npx downloads the pinned Inspector once).
set -euo pipefail

INSPECTOR_VERSION=2.15.0
url=${MCP_URL:-http://localhost:3535/api/mcp}
: "${HEXACTRA_TOKEN:?set HEXACTRA_TOKEN to a personal access token (pat_...)}"

inspect() {
  npx --yes "@modelcontextprotocol/inspector@${INSPECTOR_VERSION}" --cli "$url" --transport http \
    --header "Authorization: Bearer ${HEXACTRA_TOKEN}" "$@"
}

echo "== tools/list ($url, inspector $INSPECTOR_VERSION)"
list=$(inspect --method tools/list)
echo "$list" | head -c 2000; echo
echo "$list" | grep -q '"run_goal"' || { echo "FAIL: run_goal missing from tools/list" >&2; exit 1; }

echo "== tools/call tasks_list"
call=$(inspect --method tools/call --tool-name tasks_list)
echo "$call" | head -c 2000; echo
echo "$call" | grep -q '"isError": *true' && { echo "FAIL: tasks_list returned an error" >&2; exit 1; }

echo "ok   MCP Inspector listed the tools and called tasks_list"
