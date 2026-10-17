#!/usr/bin/env bash
# Hexactra Rollback Script
# Restores previous version of Hexactra

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "Error: This script must be run as root"
    exit 1
fi

echo "Rolling back Hexactra..."

systemctl stop hexactra-agent

# Remove current binaries
rm -f /usr/local/bin/hexactra
rm -f /usr/local/bin/hexactra-agent
rm -f /usr/local/bin/hexactra-native-host
rm -f /usr/local/bin/hexactra-mcp

# Restore from backup if exists
if [[ -d /var/lib/hexactra/backup ]]; then
    cp /var/lib/hexactra/backup/* /usr/local/bin/
fi

systemctl start hexactra-agent

echo "Rollback complete!"
