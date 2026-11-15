#!/usr/bin/env bash
# Install the hexactra CLI (the console's `hexactra`, with its terminal UI):
#
#   curl -fsSL https://raw.githubusercontent.com/marinoscar/hexactra/main/install.sh | bash
#
# That root install.sh is a bootstrap that runs this file. This file is fetched
# and run BEFORE the repository exists on disk, so it cannot read
# packages/shared/identity.json: the CLI name and the repository below are
# literal targets of scripts/rename.mjs.
#
# hexactra is a monorepo, so the installer sparse-clones only console/ (not the
# Rust fabric) into ~/.<cli>/app and builds the CLI there. Re-run it to update;
# set INSTALL_UNINSTALL=1 to remove the CLI again (your login is kept).
#
# Environment (set it on `bash`, not on `curl`):
#   INSTALL_REF        branch or tag to install (default main; a local clone's current branch with INSTALL_SRC)
#   INSTALL_SRC        install from a local clone instead of GitHub (a path)
#   INSTALL_REPO       git URL to clone (default below)
#   INSTALL_BIN_DIR    where the `hexactra` shim goes (default ~/.local/bin)
#   INSTALL_UNINSTALL  1 removes the CLI
set -euo pipefail

CLI_NAME="hexactra"
REPO="${INSTALL_REPO:-https://github.com/marinoscar/hexactra.git}"
HOME_DIR="$HOME/.$CLI_NAME"
APP_DIR="$HOME_DIR/app"
BIN_DIR="${INSTALL_BIN_DIR:-$HOME/.local/bin}"
SHIM="$BIN_DIR/$CLI_NAME"
# The console app inside the monorepo, and the CLI inside the console.
APP_SUBDIR="console"
ENTRY="$APP_DIR/$APP_SUBDIR/apps/cli/dist/cli.js"

say() { printf '%s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

if [[ "${INSTALL_UNINSTALL:-}" == "1" ]]; then
  rm -rf "$APP_DIR" "$SHIM"
  say "Removed $CLI_NAME ($APP_DIR, $SHIM). Your settings in $HOME_DIR are kept."
  exit 0
fi

if [[ -n "${INSTALL_SRC:-}" ]]; then
  [[ -d "$INSTALL_SRC/.git" ]] || die "INSTALL_SRC=$INSTALL_SRC is not a git clone"
  REPO="file://$(cd "$INSTALL_SRC" && pwd)"
  REF="${INSTALL_REF:-$(git -C "$INSTALL_SRC" rev-parse --abbrev-ref HEAD)}"
else
  REF="${INSTALL_REF:-main}"
fi

command -v git >/dev/null || die "git is required"
command -v npm >/dev/null || die "npm is required (it comes with Node.js)"
command -v node >/dev/null || die "Node.js 24 or later is required"
major="$(node -p 'process.versions.node.split(".")[0]')"
(( major >= 24 )) || die "Node.js 24 or later is required (found $(node -v))"

previous=""
[[ -x "$SHIM" ]] && previous="$("$SHIM" --version 2>/dev/null | awk '{print $1}' || true)"
previous_commit=""
[[ -d "$APP_DIR/.git" ]] && previous_commit="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || true)"

# The version a checkout carries, read from the CLI's manifest without building it.
cli_version_in() {
  node -p "require(process.argv[1]).version" "$1/$APP_SUBDIR/apps/cli/package.json" 2>/dev/null || printf 'unknown'
}

mkdir -p "$HOME_DIR" "$BIN_DIR"
if [[ -d "$APP_DIR/.git" ]]; then
  say "Updating $APP_DIR ($REF)"
  git -C "$APP_DIR" remote set-url origin "$REPO"
  git -C "$APP_DIR" sparse-checkout set "$APP_SUBDIR"
  git -C "$APP_DIR" fetch --depth 1 --filter=blob:none origin "$REF"
  git -C "$APP_DIR" checkout -q FETCH_HEAD
else
  say "Cloning $REPO ($REF, $APP_SUBDIR/ only)"
  git clone --depth 1 --filter=blob:none --sparse --branch "$REF" "$REPO" "$APP_DIR"
  git -C "$APP_DIR" sparse-checkout set "$APP_SUBDIR"
fi

incoming="$(cli_version_in "$APP_DIR")"
incoming_commit="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
say ""
if [[ -n "$previous" ]]; then
  say "  current version: $CLI_NAME $previous${previous_commit:+ ($previous_commit)}"
  say "  new version:     $CLI_NAME $incoming ($incoming_commit)"
  if [[ "$previous" == "$incoming" && "$previous_commit" == "$incoming_commit" ]]; then
    say "  (already up to date; rebuilding the same version)"
  fi
else
  say "  installing:      $CLI_NAME $incoming ($incoming_commit)"
fi
say ""

say "Building the CLI"
(cd "$APP_DIR/$APP_SUBDIR" && npm ci --workspace=cli --include-workspace-root --no-audit --no-fund && npm run build --workspace=cli)

cat > "$SHIM" <<SHIM
#!/usr/bin/env bash
exec node "$ENTRY" "\$@"
SHIM
chmod +x "$SHIM"

version="$("$SHIM" --version | awk '{print $1}')"
say ""
if [[ -n "$previous" && ( "$previous" != "$version" || "$previous_commit" != "$incoming_commit" ) ]]; then
  say "Updated $CLI_NAME $previous${previous_commit:+ ($previous_commit)} -> $version ($incoming_commit)"
else
  say "Installed $CLI_NAME $version"
fi
say "  app:  $APP_DIR"
say "  shim: $SHIM"
case ":$PATH:" in
  *":$BIN_DIR:"*) say "Next: $CLI_NAME login --server https://<your console>" ;;
  *)
    say ""
    say "$BIN_DIR is not on your PATH. Add it, then open a new shell:"
    say "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bashrc"
    ;;
esac
