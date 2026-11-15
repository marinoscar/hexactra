#!/usr/bin/env bash
# Install the hexactra CLI:
#
#   curl -fsSL https://raw.githubusercontent.com/marinoscar/hexactra/main/install.sh | bash
#
# A bootstrap: the installer is console/install.sh (the CLI is the console's).
# Run from a clone, this runs that file; piped from curl, it fetches it at
# INSTALL_REF (default main). Every INSTALL_* variable passes through; see
# console/install.sh and console/apps/cli/README.md.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" 2>/dev/null && pwd || true)"
if [[ -n "$here" && -f "$here/console/install.sh" ]]; then
  exec bash "$here/console/install.sh" "$@"
fi

command -v curl >/dev/null || { printf 'install: curl is required\n' >&2; exit 1; }
ref="${INSTALL_REF:-main}"
script="$(curl -fsSL "https://raw.githubusercontent.com/marinoscar/hexactra/${ref}/console/install.sh")"
exec bash -c "$script" install.sh "$@"
