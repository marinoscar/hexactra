# Remote browser control: quickstart

Drive your own Chrome on an Ubuntu machine from anywhere, through the CLI or an AI agent. Your Chrome keeps your profile, extensions and sign-ins; Hexactra acts in it through its extension. Epic: #173. API reference: [remote-control-api.md](remote-control-api.md).

```text
laptop: hexactra CLI / AI agent
   │  HTTPS or SSH tunnel, bearer token
   ▼
ubuntu: hexactra-control (127.0.0.1:8787)
   ▲  long-poll
ubuntu: hexactra-agent ──unix socket── hexactra-native-host ──native messaging── Hexactra extension in your Chrome
```

## 1. Install on the Ubuntu machine

Prerequisites: Rust (stable), Node 22+, pnpm, Google Chrome or Chromium, a logged-in desktop session.

```bash
git clone https://github.com/marinoscar/hexactra && cd hexactra
scripts/install-remote-control.sh
```

The script builds and installs `hexactra`, `hexactra-control`, `hexactra-agent` and `hexactra-native-host` to `~/.local/bin`, builds the extension, registers the native messaging host, and starts two systemd user services. It needs no root.

Then load the extension into the Chrome profile you want to drive:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose `apps/chrome-extension/dist`.
3. Check the id is `afamapffbfhaafbjnneoachpknjpmiof`. The native host only accepts that id.

Check it:

```bash
hexactra status
# host 7c1e… my-ubuntu   online=true browser=true
```

The extension's toolbar badge shows **ON** while a remote controller is connected.

## 2. Use it locally

```bash
hexactra navigate https://example.com
hexactra elements                     # interactive elements with selectors
hexactra click 'a[href="/about"]'
hexactra type '#search' 'flights to Denver' --submit
hexactra wait-for '.results'
hexactra text --max-chars 4000
hexactra screenshot -o page.jpg
hexactra tabs
```

The first action creates a session and saves it as current. `hexactra session create`, `session list` and `session end` manage sessions explicitly. Add `--json` for machine-readable output.

## 3. Use it from another machine

The control plane listens on `127.0.0.1` only. Pick one of these:

**SSH tunnel (simplest)**

```bash
# on the laptop
ssh -N -L 8787:127.0.0.1:8787 you@ubuntu-box &
scp you@ubuntu-box:.config/hexactra/api-token ~/.config/hexactra/api-token
chmod 600 ~/.config/hexactra/api-token
hexactra status
```

**Private network (Tailscale or WireGuard)**

```bash
# on the Ubuntu machine: listen on the private interface only
systemctl --user edit hexactra-control
#   [Service]
#   Environment=HEXACTRA_BIND=100.x.y.z:8787
#   Environment=HEXACTRA_ALLOW_REMOTE_BIND=1
systemctl --user restart hexactra-control
# on the laptop
export HEXACTRA_URL=http://100.x.y.z:8787
```

Never bind to a public interface. The token controls a browser signed in to your accounts.

## 4. Let an AI agent drive it (MCP)

`hexactra-mcp` is an MCP server (stdio) that exposes the browser as tools: `browser_navigate`, `browser_elements`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_text`, `browser_screenshot` (returned as an image), `browser_wait_for`, `browser_tabs`, `browser_new_tab`, `browser_activate_tab`, `browser_close_tab`, `browser_back`, `browser_forward`, `browser_reload` and `browser_status`.

The install script puts it in `~/.local/bin`. Register it with any MCP client, for example Claude Code:

```bash
claude mcp add hexactra --env HEXACTRA_URL=http://127.0.0.1:8787 -- ~/.local/bin/hexactra-mcp
```

or in a JSON MCP configuration:

```json
{
  "mcpServers": {
    "hexactra": {
      "command": "/home/you/.local/bin/hexactra-mcp",
      "env": { "HEXACTRA_URL": "http://127.0.0.1:8787" }
    }
  }
}
```

The token is read from `HEXACTRA_API_TOKEN` or `~/.config/hexactra/api-token`. From another machine, point `HEXACTRA_URL` at the SSH tunnel or private address from section 3. The server tells the agent to stop and ask you when it meets a CAPTCHA, a verification code, a passkey or a payment confirmation.

## 5. Seeing the screen

- `hexactra screenshot` returns the visible tab as JPEG.
- For a live view or to take over by hand, use the desktop's own remote desktop: GNOME **Settings → Sharing → Remote Desktop**, or `x11vnc` reached through the same SSH tunnel. A built-in viewer is follow-up work on #173.

## 6. Sign-ins, CAPTCHAs and bot checks

Hexactra acts in your real Chrome profile, so sites see your normal browser, cookies and sign-ins. It does **not** try to defeat bot detection. When a site asks for a CAPTCHA, a one-time code, a passkey or another check:

1. The action fails or the page shows the challenge (`hexactra screenshot` shows it).
2. Complete it yourself through remote desktop.
3. Continue with the next command.

Wiring these handoffs into the human-in-the-loop inbox is follow-up work. Respect each site's terms of use, and keep automated use of your own accounts at a human pace.

## 7. Security checklist

- The token file (`~/.config/hexactra/api-token`, mode `0600`) is the only credential. Rotate it by deleting the file and restarting `hexactra-control` (it generates a new one), then restart `hexactra-agent`.
- The bridge socket lives in `$XDG_RUNTIME_DIR/hexactra` (mode `0700`) and refuses other Unix users.
- Remote callers can only run the bounded actions in [remote-control-api.md](remote-control-api.md). There is no arbitrary JavaScript. Navigation is limited to `http(s)` and `about:blank`.
- To stop remote control: `systemctl --user stop hexactra-agent`, or disable the extension.

## Troubleshooting

| Symptom | Check |
|---|---|
| `browser=false` | Is the extension loaded with id `afamapffbfhaafbjnneoachpknjpmiof`? Run `ls ~/.config/google-chrome/NativeMessagingHosts/com.hexactra.nativehost.json`, then `journalctl --user -u hexactra-agent`. |
| `no_host_available` | `systemctl --user status hexactra-agent`; the agent must reach the control plane URL. |
| `cannot act on this page` | Chrome blocks extensions on `chrome://` pages and the Web Store. Navigate to a normal site first. |
| `Cannot find a next page in history` | Chrome's back button skips entries made without a user gesture; Hexactra falls back to the page's own history, but there may be nothing to go back to. |

## Running the end-to-end test

```bash
cargo build -p hexactra-cli -p hexactra-control -p hexactra-agent -p hexactra-native-host
pnpm --filter @hexactra/chrome-extension build
CHROMIUM_PATH=/path/to/chromium xvfb-run -a node tests/e2e/remote-control.e2e.mjs
```

Use Chromium or Chrome for Testing: branded Google Chrome ignores `--load-extension`, which the test uses. In daily use, load the extension through **Load unpacked** as above.
