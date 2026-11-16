# Changelog

## Unreleased

- **The extension id changed** to `ahpjoclfeibdmlnbaednepiihpamklcl` (new signing key, #335).
  - The agent bundle and its native host use the new id.
  - Run `hexactra agent update` on each host.
  - If you loaded the extension unpacked, remove the old copy and load the new build.
- **A signed CRX and `updates.xml`** are published with every agent release, so Google Chrome can force-install the extension by policy (`apps/chrome-extension/README.md`).

#90
