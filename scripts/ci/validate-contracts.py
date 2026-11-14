"""Validate that the published API contracts parse (OpenAPI YAML and MCP JSON)."""
import json
import sys

import yaml

with open("api/openapi.yaml", encoding="utf-8") as f:
    spec = yaml.safe_load(f)
if not isinstance(spec, dict) or "openapi" not in spec:
    sys.exit("api/openapi.yaml: missing 'openapi' version field")
print(f"openapi.yaml OK: {spec['openapi']} {spec.get('info', {}).get('title', '')}")

with open("api/mcp-schemas.json", encoding="utf-8") as f:
    mcp = json.load(f)
print(f"mcp-schemas.json OK: {len(mcp.get('tools', []))} tools")
