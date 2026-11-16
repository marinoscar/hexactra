# Changelog

## Unreleased

- **The bundled VPS browser host is opt-in** (#343). New deploys leave it off; an existing deploy that runs it keeps it (`COMPOSE_PROFILES=bundled-host` in `infra/compose/.env`). Its desktop now opens in the console through the fabric tunnel, like a node's. The old ticket viewer (`/viewer/local/`, `POST /api/fleet/viewer-ticket`, `HEXACTRA_VIEWER_PASSWORD`) is removed.
- **The extension id changed** to `ahpjoclfeibdmlnbaednepiihpamklcl` (new signing key, #335).
  - The agent bundle and its native host use the new id.
  - Run `hexactra agent update` on each host.
  - If you loaded the extension unpacked, remove the old copy and load the new build.
- **A signed CRX and `updates.xml`** are published with every agent release, so Google Chrome can force-install the extension by policy (`apps/chrome-extension/README.md`).

#90
