"""Validate that the published API contracts parse (OpenAPI YAML, MCP JSON, the sensitive-text patterns)."""
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

# The extension's copy of the console's sensitive-text patterns (#538). Its
# freshness is checked by `node scripts/gen-sensitive-patterns.mjs --check`;
# here, that it parses and has the fields the extension reads.
with open("packages/contracts/sensitive-patterns.json", encoding="utf-8") as f:
    masks = json.load(f)
if not isinstance(masks.get("version"), int):
    sys.exit("sensitive-patterns.json: missing integer 'version'")
ids = [p.get("id") for p in masks.get("patterns", [])]
expected = {"card", "iban", "ssn", "routing", "account", "digits", "email", "phone", "token", "urlSecret"}
if set(ids) != expected or len(ids) != len(expected):
    sys.exit(f"sensitive-patterns.json: pattern ids {ids} are not {sorted(expected)}")
for p in masks["patterns"]:
    for key in ("source", "flags", "mask"):
        if not p.get(key):
            sys.exit(f"sensitive-patterns.json: pattern {p['id']} has no '{key}'")
    if p.get("check") not in (None, *masks.get("checks", [])):
        sys.exit(f"sensitive-patterns.json: pattern {p['id']} names an unknown check {p['check']!r}")
print(f"sensitive-patterns.json OK: version {masks['version']}, {len(ids)} patterns")
