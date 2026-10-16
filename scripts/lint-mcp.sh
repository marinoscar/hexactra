#!/usr/bin/env bash
# Script to validate MCP schemas
set -e

MCP_FILE="api/mcp-schemas.json"

if [ ! -f "$MCP_FILE" ]; then
    echo "Error: $MCP_FILE not found"
    exit 1
fi

echo "Validating MCP schema..."
if command -v python3 &> /dev/null; then
    python3 -c "
import json
import sys

try:
    with open('$MCP_FILE', 'r') as f:
        schema = json.load(f)
    
    print('MCP schema is valid JSON')
    print(f'Name: {schema.get(\"name\", \"unknown\")}')
    print(f'Version: {schema.get(\"version\", \"unknown\")}')
    print(f'Tools: {len(schema.get(\"tools\", []))}')
    print(f'Resource templates: {len(schema.get(\"resourceTemplates\", []))}')
except json.JSONDecodeError as e:
    print(f'JSON Error: {e}')
    sys.exit(1)
"
else
    echo "Note: Python not available, skipping validation"
fi

echo "MCP schema check complete"
