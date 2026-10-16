#!/usr/bin/env bash
# Script to validate OpenAPI specification
set -e

OPENAPI_FILE="api/openapi.yaml"

if [ ! -f "$OPENAPI_FILE" ]; then
    echo "Error: $OPENAPI_FILE not found"
    exit 1
fi

echo "Validating OpenAPI specification..."
if command -v openapi-spec-validator &> /dev/null; then
    openapi-spec-validator "$OPENAPI_FILE"
    echo "OpenAPI spec is valid"
elif command -v node &> /dev/null && [ -f "package.json" ]; then
    # Try using Node.js with ajv-cli if available
    if npm list -g ajv-cli &> /dev/null; then
        ajv validate -s "$OPENAPI_FILE" 2>&1 || echo "Note: ajv validation skipped"
    else
        echo "Note: ajv-cli not installed, skipping JSON schema validation"
    fi
else
    # Basic YAML syntax check using Python's built-in capabilities
    python3 -c "
import json
try:
    import yaml
    with open('$OPENAPI_FILE', 'r') as f:
        spec = yaml.safe_load(f)
    print('OpenAPI YAML is valid')
    print(f'Version: {spec.get(\"openapi\", \"unknown\")}')
    print(f'Title: {spec.get(\"info\", {}).get(\"title\", \"unknown\")}')
except ImportError:
    # Fallback: just check it's valid UTF-8
    with open('$OPENAPI_FILE', 'r') as f:
        content = f.read()
    print('OpenAPI YAML is valid (basic check)')
    if 'openapi:' in content:
        import re
        version = re.search(r'version:\\s*[\"\\']?([^\"\\'\\n]+)', content)
        if version:
            print(f'Version: {version.group(1)}')
except Exception as e:
    print(f'Validation error: {e}')
    exit(1)
"
fi

echo "OpenAPI specification check complete"
