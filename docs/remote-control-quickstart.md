# Remote browser control: quickstart

> The fabric's CLI is `hexactra-fabric`. It was called `hexactra` before the console arrived; `hexactra` is now the console's CLI.

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
hexactra-fabric status
# host 7c1e… my-ubuntu   online=true browser=true
```

The extension's toolbar badge shows **ON** while a remote controller is connected.

### Launch mode: the agent opens the browser for you

By default the agent attaches to the Chrome you run yourself. In **launch mode** it starts a visible browser on demand with a persistent profile, restarts it after a crash, and can close it when idle. No one needs to be logged in or open Chrome:

```bash
hexactra-agent daemon \
  --browser /usr/bin/chromium \
  --profiles-dir ~/.local/share/hexactra/profiles \
  --extension-dir ~/hexactra/apps/chrome-extension/dist \
  --idle-shutdown-s 900          # close after 15 idle minutes; 0 keeps it open
```

- The browser needs a display. Use your desktop session, or Xvfb on a headless machine.
- Use Chromium or Chrome for Testing: branded Google Chrome ignores `--extension-dir` (`--load-extension`).
- Each profile is a subdirectory of `--profiles-dir`, with its own cookies and sign-ins. `--max-browsers` (default 1) caps how many run at once: at the cap, the least recently used idle browser is closed to make room.
- Idle and evicted browsers are closed through the extension, so Chromium flushes cookies and storage. Chromium usually restores the tabs they had when they reopen.
- The launched profile is separate from your everyday Chrome profile. Sign in to the sites you need once, through the browser or its viewer.
- Add `--viewer-url` when you have a web viewer (noVNC). Handoffs then link people straight to the browser.

The container host packages all of this, so it runs on an always-on machine even when your desktop is off: [container-host.md](container-host.md).

## 2. Use it locally

```bash
hexactra-fabric navigate https://example.com
hexactra-fabric elements                     # interactive elements with selectors
hexactra-fabric click 'a[href="/about"]'
hexactra-fabric type '#search' 'flights to Denver' --submit
hexactra-fabric wait-for '.results'
hexactra-fabric text --max-chars 4000
hexactra-fabric screenshot -o page.jpg
hexactra-fabric tabs
```

Add `--profile <name>` (or set `HEXACTRA_PROFILE`) to act in another browser profile. Run `hexactra-fabric profile list` to see them, and `hexactra-fabric --profile <name> session create --create` to make a new one; see [container-host.md §4](container-host.md#4-profiles-one-per-set-of-sign-ins). The first action creates a session and saves it as current. `hexactra-fabric session create`, `session list` and `session end` manage sessions explicitly. Add `--json` for machine-readable output.

## 3. Use it from another machine

The control plane listens on `127.0.0.1` only. Pick one of these:

**SSH tunnel (simplest)**

```bash
# on the laptop
ssh -N -L 8787:127.0.0.1:8787 you@ubuntu-box &
scp you@ubuntu-box:.config/hexactra/api-token ~/.config/hexactra/api-token
chmod 600 ~/.config/hexactra/api-token
hexactra-fabric status
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

`hexactra-mcp` is an MCP server (stdio) that exposes the browser as tools: `browser_navigate`, `browser_elements`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_text`, `browser_screenshot` (returned as an image), `browser_wait_for`, `browser_tabs`, `browser_new_tab`, `browser_activate_tab`, `browser_close_tab`, `browser_back`, `browser_forward`, `browser_reload`, `browser_status`, `browser_profiles` and `browser_use_profile`.

The install script puts it in `~/.local/bin`. Register it with any MCP client, for example Claude Code:

```bash
claude mcp add hexactra-fabric --env HEXACTRA_URL=http://127.0.0.1:8787 -- ~/.local/bin/hexactra-mcp
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

- `hexactra-fabric screenshot` returns the visible tab as JPEG.
- For a live view or to take over by hand, use the desktop's own remote desktop: GNOME **Settings → Sharing → Remote Desktop**, or `x11vnc` reached through the same SSH tunnel. A built-in viewer is follow-up work on #173.

## 6. CAPTCHAs, codes and approvals: handing off to you

Hexactra acts in your real Chrome profile, so sites see your normal browser, cookies and sign-ins. It does **not** try to defeat bot detection. When a site asks for something only you should do, the agent opens a **handoff**:

1. The session pauses. Browser actions return `handoff_pending` until you answer.
2. Every webhook channel you registered gets a signed `handoff.created` event. The event holds the prompt, the page, and a single-use link and token to answer with.
3. You answer from any channel: tap the link and fill in the small form, reply through your bot, or run `hexactra-fabric handoff respond`. For a CAPTCHA or passkey, act in the browser through remote desktop, then tap **I've done it**.
4. The agent gets the answer (for example the one-time code) and carries on.

With MCP, the agent does this through the `browser_request_human` tool. The server instructions tell it to use the tool for any CAPTCHA, code, passkey, sign-in or purchase confirmation.

From the CLI:

```bash
hexactra-fabric handoff request --kind code --prompt "Enter the code the airline texted you" --input secret --wait
hexactra-fabric handoff list                 # pending requests
hexactra-fabric handoff respond <id> --value 123456
hexactra-fabric handoff cancel <id>
```

### Add channels (webhooks)

Run the control plane with a public URL so payloads contain clickable links. For channels on your LAN or tailnet, also allow insecure targets:

```bash
systemctl --user edit hexactra-control
#   [Service]
#   Environment=HEXACTRA_PUBLIC_URL=https://hexactra.your-tailnet.ts.net
#   Environment=HEXACTRA_WEBHOOK_ALLOW_INSECURE=1     # only for http or private-address channels
systemctl --user restart hexactra-control

hexactra-fabric webhook add https://hooks.example.test/hexactra --description "phone"
# prints the id and the whsec_ signing secret (shown once)
hexactra-fabric webhook test <id> && hexactra-fabric webhook deliveries <id>
```

Channel recipes:

| Channel | How |
|---|---|
| **n8n / Zapier / Make** | Webhook trigger, then send `data.handoff.prompt` and `data.respond.form_url` to Telegram, Slack, SMS or email. Tapping the link opens the answer form. |
| **Chat bot (Slack, Telegram, Discord)** | Your bot receives the webhook, verifies `webhook-signature`, posts the prompt with buttons or a reply box, and answers with `POST data.respond.url` with body `{ "value", "channel": "slack", "response_token": data.respond.token }`. |
| **Email or SMS** | Send `data.respond.form_url`. The page works on a phone. A secret field is masked and offers your keyboard's one-time-code autofill. |
| **Your own app** | Use `/v1/handoffs` directly with the API token. |

Several channels can be active at once. The first answer wins and the token then stops working everywhere. Every registered channel receives a token that can answer, so register only channels you control. Payload and signature reference: [remote-control-api.md](remote-control-api.md#webhooks-channels-that-reach-a-person).

Respect each site's terms of use, and keep automated use of your own accounts at a human pace.

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
| `handoff_pending` | The agent asked you for something. Run `hexactra-fabric handoff list`, then answer or cancel. |
| Webhook never arrives | Run `hexactra-fabric webhook deliveries <id>`. A target on http or a private address needs `HEXACTRA_WEBHOOK_ALLOW_INSECURE=1`. |
| `Cannot find a next page in history` | Chrome's back button skips entries made without a user gesture; Hexactra falls back to the page's own history, but there may be nothing to go back to. |

## Running the end-to-end test

```bash
cargo build -p hexactra-cli -p hexactra-control -p hexactra-agent -p hexactra-native-host
pnpm --filter @hexactra/chrome-extension build
CHROMIUM_PATH=/path/to/chromium xvfb-run -a node tests/e2e/remote-control.e2e.mjs
```

Use Chromium or Chrome for Testing: branded Google Chrome ignores `--load-extension`, which the test uses. In daily use, load the extension through **Load unpacked** as above.
