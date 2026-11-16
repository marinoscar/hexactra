# Nodes: browsers on machines you own

A **node** is a machine that runs real browsers for Hexactra. The primary node is a computer **on your own residential network**, such as a mini PC at home. Your agents use it on demand from the web app, the Android app, MCP and the API.

> **Status.** This page describes the node model of epic [#333](https://github.com/marinoscar/hexactra/issues/333). Sections marked *Planned* ship with the issue they name. Today `hexactra agent install` installs an attended-style host ([console/apps/cli/README.md](../console/apps/cli/README.md#agent-run-this-machine-as-a-browser-host)).

## Why a machine at home

Many websites block, throttle or challenge visitors by **IP address**:
- Addresses that belong to cloud and VPS providers (datacenter ranges) are the first to get a CAPTCHA, an extra sign-in check or a block.
- An address from a home internet provider looks like a person, because it is one.

A node on your home network keeps your residential IP. Sites see the same network you use every day. A VPS can still run a browser for Hexactra (the bundled container host, see [container-host.md](container-host.md)), but expect more challenges there. Hexactra hands those challenges to you; it does not try to get around them.

## How a node connects

```text
web app · Android app · MCP · API
        │  HTTPS
        ▼
Console (your VPS, e.g. https://hex.example.test) ── fabric control plane (private)
        ▲
        │  outbound HTTPS only: enroll, then a long-poll for work, results back
        │  (and a WebSocket tunnel for the remote desktop, #338)
Node at home: hexactra-agent ── Google Chrome (headful) ── Hexactra extension
```

- **Outbound only.** The node opens HTTPS connections to `https://<console>/fabric/`. It never opens an inbound port, so you need no router port-forward, no VPN and no Tailscale.
- **Only the host protocol is published.** That covers enrollment, registration, the work long-poll and results. Every other fabric API stays private to the console ([console/docs/runbooks/vps-stack.md](../console/docs/runbooks/vps-stack.md#5-add-more-hosts-desktop-other-machines)).
- **Real time.** The agent keeps one long-poll open. The fabric answers it the moment work is queued, so actions start within milliseconds.
- **Credentials.**
  - Each node enrolls once with a single-use token, minted by `hexactra agent install` through your console login, or by an admin from Fleet → Enroll host.
  - After that it uses its own host credential, which can act only for itself.

## Two modes

A node can run **unattended**, **attended**, or **both at once**. In both mode, it shows up as two hosts, for example `mini-pc` and `mini-pc-attended`.

| | Unattended | Attended |
|---|---|---|
| Who is logged in | Nobody. It starts at boot. | You, at the machine's desktop |
| Desktop | A persistent full desktop (XFCE) on a virtual display (TigerVNC's Xvnc, served only on a private Unix socket); Chrome renders with the machine's built-in GPU | Your own desktop (an **X11** session for now, see below) |
| OS user | A dedicated `hexactra` user, isolated from your account and files | Your own account |
| Chrome | Google Chrome, one browser per profile. You sign into Google **once** per profile through the remote desktop; the agent then works in that profile. | Your own Google Chrome profile |
| Remote view and takeover | Yes, from the web app and the Android app | Yes. Your live desktop, with a notification on the machine while someone watches. |
| Best for | An always-on robot with its own signed-in profiles | Letting an agent use the browser you are already signed into |
| Status | `hexactra agent install --mode unattended` | *Planned* (#341) |

**The extension is installed by Chrome policy.** Google Chrome no longer loads unpacked extensions. `hexactra agent install` installs Google Chrome if needed, and writes one Chrome enterprise policy file (`/etc/opt/chrome/policies/managed/hexactra.json`) that force-installs the Hexactra extension. Chrome then shows "Managed by your organization", which refers to that one file. Available now as `hexactra agent chrome setup` (or `hexactra agent install --google-chrome`); `hexactra agent doctor` checks it.

### Set up an unattended node

On the mini PC, logged in as yourself:

```bash
hexactra login https://hex.example.test
hexactra agent install --mode unattended      # asks for your sudo password once
hexactra agent doctor                          # every check, and how to fix what fails
```

It installs:
- Google Chrome, with the extension by policy;
- the desktop (TigerVNC, XFCE);
- the `hexactra` user;
- the agent in `/opt/hexactra`;
- three system units: `hexactra-desktop`, `hexactra-session` and `hexactra-node-agent`.

They start at every boot with nobody logged in.

To use it:
1. In the console, open **Fleet → Open desktop**.
2. Pick a profile and click **Sign in to profile**, then sign in to Google there.
3. Close that Chrome window to save the sign-in.

Manage it with `hexactra agent status | logs | start | stop | restart | uninstall --mode unattended`. `hexactra agent update` updates it too.

### Attended mode and Wayland
Ubuntu 22.04 and later log in to Wayland by default. Wayland blocks the tools that share a live desktop, so attended mode needs an X11 session for now.
- **To switch:** on the login screen, choose your user, click the gear and pick **Ubuntu on Xorg**.
- **Or:** set `WaylandEnable=false` in `/etc/gdm3/custom.conf` and reboot.

`hexactra agent install` detects Wayland and tells you this. Wayland support is planned.

## Using a node

Everything goes through the console. A node is just another host in **Fleet**.
- **Web app and Android app:**
  - Fleet shows each host's mode and whether it is online.
  - **Open desktop** shows its screen in the console, for people with `fleet:desktop` (`hexactra fleet desktop <host>` prints the link).
  - **Sign in to profile** (on the desktop page) opens that profile's Chrome on the node at the Google sign-in; `hexactra fleet profile show <host> <profile>` does the same.
  - Tasks and runs pick a host and profile.
- **MCP:** `hosts_list` shows hosts with their mode. Browser tools and goals take a profile. Viewing and controlling a desktop is for people, so MCP has no viewer tool.
- **API and SDK:** the same operations over REST (`/api/docs`).
- **CLI on the node:** `hexactra agent install | status | logs | update | start | stop | restart | uninstall`, also in the terminal UI's **Agent** screen.

When a site needs you (a CAPTCHA, a code, an approval), the run pauses and asks in the Inbox and on your phone. You answer, or **take over** the desktop: the agent pauses between steps until you release it. On the desktop page you watch by default: **Take over** gives you the mouse and keyboard and pauses the agent, and **Release** hands it back. `hexactra fleet takeover | release <host>` does the same.

## Looking like a person

A node is built to look like what it is: a person's computer at home.
- **Network:** your residential IP.
- **Headful Google Chrome**, never headless. Headless browsers are the first thing anti-bot systems detect.
- **A real GPU.** On a virtual display without a GPU, Chrome reports a software graphics renderer (SwiftShader) to WebGL, or WebGL fails, and anti-bot scripts read that string. On an unattended node Chrome renders with the machine's integrated Intel or AMD graphics directly (Vulkan through the render node), which every mini PC has, so WebGL names the real hardware. You need no extra hardware, and this has nothing to do with AI.
- **Driven by the extension:** no `--enable-automation` flag, no DevTools or CDP port, and no WebDriver.
- **Your environment:** the system's timezone and locale, and a normal screen size (1920x1080).
- **Persistent profiles:** real sign-ins, kept between runs.

A residential IP lowers the chance of being challenged; it does not remove it. A fresh Google sign-in may still ask for confirmation, which you answer through the remote desktop.

## Security model

These hold for every node:
1. **No inbound ports.** The node only dials out over HTTPS.
2. **The desktop server is local only:** a Unix socket or 127.0.0.1 with credentials only the agent can read. It is never reachable from the network.
3. **Tunnels are authenticated at both ends.**
   - The node's end uses its own host credential.
   - The viewer's end uses a single-use token that lasts 30 seconds.
4. **Remote-desktop access is bound to you.** A viewer session belongs to one host, one user and one organization, is stored in the database, and can be revoked.
5. **Watching is the default.** Keyboard and mouse input pass only while you hold the takeover lease, and the fabric enforces it.
6. **Everything is audited:** opening and closing a desktop, and taking over and releasing it.
7. **Tokens never appear in URLs or logs.**

Also:
- The unattended desktop runs as a separate `hexactra` user, so a page in its browser cannot reach your home directory.
- With nobody logged in there is no keyring. Chrome then stores saved passwords and cookies with a fixed key (`--password-store=basic`), so use full-disk encryption on the node.

## Requirements

- **OS:** Linux x86_64: Ubuntu 22.04 or 24.04, or Debian 12. Windows and macOS nodes are planned.
- **Graphics:** integrated Intel or AMD graphics for the unattended desktop's GPU acceleration. Without one, the node still works, but warns that it is easier to detect.
- **Network:** outbound HTTPS (443) to your console.
- **Hardware:** about 2 GB of RAM per browser open at once, plus the desktop ([capacity.md](../console/docs/runbooks/capacity.md)).

## Troubleshooting

| Symptom | What to do |
|---|---|
| Attended install refuses: Wayland | Log in with **Ubuntu on Xorg** (see above) |
| `chrome://policy` does not list Hexactra | Run `hexactra agent doctor`, then `hexactra agent chrome setup`, then restart Chrome |
| The extension is not connected | `hexactra agent doctor` checks the policy, the native host and the extension |
| The node shows offline | `hexactra agent status`, then `hexactra agent logs`. The node needs outbound HTTPS to the console. |
| A warning about software graphics | The machine has no usable Intel or AMD GPU (or uses NVIDIA's proprietary driver). The node works but is easier to detect. |
