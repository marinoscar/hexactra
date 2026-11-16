# Hexactra Chrome extension

The MV3 extension that drives the browser for Hexactra. It works standalone (side-panel chat with your own model provider) and, on a node, as the agent's hands in Chrome (docs/nodes.md).

## How it acts (full powers, VISION §27)

`src/remote.ts` executes the fabric's actions; the wire shapes are in [docs/remote-control-api.md](../../docs/remote-control-api.md#actions).
- **DOM actions** (`click`, `type`, `text`, `elements`, ...) run as page functions through `chrome.scripting`.
- **Trusted input and JavaScript** go through `chrome.debugger` (`src/cdp.ts`, permission `debugger`):
  - `click_at`, `mouse`, `drag`, `scroll_at`, `type_keys`, `key` dispatch `Input.*` events that pages see as `isTrusted`;
  - `evaluate` runs `Runtime.evaluate` in REPL mode, whatever the page's CSP.
- **Screenshots** are captured with `Page.captureScreenshot` (`captureVisibleTab` as a fallback) and scaled to CSS pixels, so image coordinates are `click_at` coordinates. With `marks`, interactive elements are boxed and numbered for the model, then the overlay is removed.
- **Stealth:** no CDP domain is ever `enable`d, and the host agent starts Chrome with `--silent-debugger-extension-api`, so there is no debugging bar.
- `navigate` and `new_tab` open any URL but `javascript:`.

## Build

```bash
pnpm --filter @hexactra/chrome-extension build    # → dist/
pnpm --filter @hexactra/chrome-extension test
```

For development, load `dist/` with **Load unpacked** (chrome://extensions, Developer mode). Google Chrome 137+ ignores `--load-extension`, so nodes install it by policy instead (below).

## Extension id

The id is `ahpjoclfeibdmlnbaednepiihpamklcl`. It is derived from the public key in `manifest/manifest.json` (`"key"`), so an unpacked build and the signed CRX have the same id. The native host accepts only this id (`crates/hexactra-core/src/bridge.rs`, `EXTENSION_ID`).

- `node scripts/extension-id.mjs` prints the id the manifest key gives.
- `node scripts/extension-id.mjs --check` (CI, `contracts` job) fails on any other id, or any other manifest key, in a tracked file.

## Signed CRX and update manifest

Nodes run Google Chrome, which installs an off-store extension only through enterprise policy (`ExtensionSettings`, `force_installed`) from a signed CRX listed in an update manifest. The **Agent release** workflow (`.github/workflows/agent-release.yml`) builds both on every push to `main`:

| Asset (release `agent-latest`) | What it is |
|---|---|
| `hexactra-extension.crx` | The extension as CRX3, signed with the key below. The manifest's `key` is stripped; the CRX carries it. |
| `updates.xml` | Chrome's update manifest: the id, the version and the CRX's URL |

- **Version.** `<agent version>.<workflow run number>`, so every build is higher and Chrome updates installed copies on its own.
- **Order.** The CRX is uploaded before `updates.xml`.
- **Check after publishing.** `scripts/verify-extension-release.mjs` downloads both the way Chrome does. It verifies the signature and checks that the id and version match.
- **Tooling.** `scripts/crx3.mjs` (packing and verifying, `node:crypto` only), `scripts/pack-crx3.mjs` (CLI), tests in `scripts/crx3.test.mjs`.

The policy points at `https://github.com/marinoscar/hexactra/releases/download/agent-latest/updates.xml`. A test on Chromium 153 confirmed that a policy install accepts a CRX served as `application/octet-stream`, which is how GitHub serves release assets.

## Signing key

The CRX is signed with an RSA-2048 key in the repository secret **`EXTENSION_CRX_KEY`** (the PEM, `-----BEGIN PRIVATE KEY-----` …). Its public half is the manifest `key`.

- Without the secret, `main` still publishes the agent bundle, but no CRX or `updates.xml` (a workflow warning says so), so nodes cannot force-install the extension.
- A pull request without access to the secret signs with a throwaway key, only to test the packaging.
- The key is written to a 0600 file in `$RUNNER_TEMP` and deleted after packing.

**Rotating the key changes the extension id.** Rotating means:
1. Generate a new key: `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out key.pem`.
2. Set its public half as the manifest `key`: `openssl pkey -in key.pem -pubout -outform DER | base64 -w0`.
3. Replace every id literal: `node scripts/extension-id.mjs --pem key.pem` prints the new id, and `--check` lists the literals that still need it.
4. Update the secret.

Installed nodes pick up the new id after `hexactra agent update`.
