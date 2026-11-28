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
| Install | `hexactra agent install --mode unattended` | `hexactra agent install --mode attended` (or `--mode both`) |

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

To use it, sign its profiles in to Google:
1. In the console, open **Fleet**. Each profile that is not signed in shows **Not signed in to Google** (see [Sign-in status](#sign-in-status)).
2. Click **Sign in** on it. The console takes over the node's desktop and opens that profile at the Google sign-in.
3. Sign in to Google on the desktop. The console notices, closes that Chrome so the sign-in is saved, and gives the desktop back. There is nothing else to do.

With several profiles to sign in, **Fix sign-ins** on the Fleet page takes you through them one after another.

Manage it with `hexactra agent status | logs | start | stop | restart | uninstall --mode unattended`. `hexactra agent update` updates it too.

**Is a node current?** A console deploy updates the console and the fabric, never a node: run `hexactra agent update` on each node machine (or **Update** on the terminal UI's Agent screen, the same routine). It does everything, and nothing is left for you to restart:

1. installs the latest agent and restarts the agent services (and the unattended node, with sudo);
2. on an attended node, restarts your Google Chrome gracefully (`--restore-last-session`: your tabs come back), so Chrome fetches the new extension from its policy within seconds;
3. waits for the extension to connect to the agent again and checks its version;
4. prints what runs now, for example `Agent 0.2.0 (c278006)` and `Extension 0.2.0.81 connected`, or says what is wrong and how to fix it.

An unattended node's browsers belong to its agent: the restart closes them and each starts with the new extension at its next run. Version **0.2.0** is the first with run recordings (epic #755); an older node records nothing. The extension's version is the agent's plus a build number.

### Attended mode and Wayland
Ubuntu 22.04 and later log in to Wayland by default. Wayland blocks the tools that share a live desktop, so attended mode needs an X11 session for now.
- **To switch:** on the login screen, choose your user, click the gear and pick **Ubuntu on Xorg**.
- **Or:** set `WaylandEnable=false` in `/etc/gdm3/custom.conf` and reboot.

`hexactra agent install --mode attended` detects Wayland and tells you this. Wayland support is planned.

**While someone views your desktop**, the agent runs x11vnc on a private socket and Chrome shows nothing extra. A notice on your screen names the person, and x11vnc stops 30 seconds after they leave. Nothing listens on the network.

## Using a node

Everything goes through the console. A node is just another host in **Fleet**.
- **Web app and Android app:**
  - Fleet shows each host's mode and whether it is online.
  - **Open desktop** shows its screen in the console, for people with `fleet:desktop` (`hexactra fleet desktop <host>` prints the link).
  - Each profile shows its Google sign-in status, and **Sign in** signs it in with one click ([Sign-in status](#sign-in-status)).
  - **Sign in to profile** (on the desktop page) opens that profile's Chrome on the node at the Google sign-in, for doing it by hand; `hexactra fleet profile show <host> <profile>` does the same.
  - Tasks and runs pick a host and profile.
- **MCP:** `hosts_list` shows hosts with their mode. Browser tools and goals take a profile. Viewing and controlling a desktop is for people, so MCP has no viewer tool.
- **API and SDK:** the same operations over REST (`/api/docs`).
- **CLI on the node:** `hexactra agent install | status | logs | update | start | stop | restart | uninstall`, also in the terminal UI under **Agent ▸ This machine as a browser node**.

When a site needs you (a CAPTCHA, a code, an approval), the run pauses and asks in the Inbox and on your phone (a run started from a chat asks in that chat). You answer, or **take over** the desktop: the agent pauses between steps until you release it. On the desktop page you watch by default: **Take over** gives you the mouse and keyboard and pauses the agent, and **Release** hands it back. `hexactra fleet takeover | release <host>` does the same.

## Sign-in status

Most sites sign in through Google, and the agent relies on the profile's Google session. So every node reports, for every profile, whether it is signed in to Google (epic #926, [decision record](decisions/profile-signin-health.md)).

| State | Fleet shows | Meaning |
|---|---|---|
| `signed_in` | **Signed in as** the account's email, in full | A valid Google session |
| `signed_out` | **Not signed in to Google** (warning) | No Google account in the profile |
| `expired` | **Google session expired** (warning) | Chrome knows the account, but Google wants the person to sign in again |
| `unknown` | **Sign-in not checked** | The browser never ran, the check failed, or the checks disagree. A failed check is never shown as signed out. While the browser runs, a failed check with Google does not hide a signed-in account the node read from the profile's settings |

**How it is checked.** The node reads the profile's Chrome settings on disk (at agent start, after the browser closes, and when a profile is created), and while the browser runs, the extension asks Google which accounts the profile's session holds (when it starts, every 10 minutes, and as soon as a Google sign-in page finishes loading). Only the state, the email and the time of the check leave the node; cookies and Google's answer never do. `expired` is seen only while the browser runs.

**Where it shows.** The Fleet page shows it on each profile, a "needs sign-in" count on each host, and a **Needs sign-in** filter; Home's Machines block shows the count; `hexactra fleet hosts` marks a profile that needs sign-in; `hexactra agent doctor` on the node prints each profile's status (on an unattended node it reads the profiles as the node's `hexactra` user, through `sudo -n`; when sudo needs a password, it prints the command to run instead). The owner gets a **profile signed out** alert, and starting a task or run on a profile that needs sign-in shows a warning with a **Sign in** link. Neither ever blocks a run.

**What each mode can do.**
- **Unattended with a desktop:** **Sign in** (one click) and **Fix sign-ins** (a queue across the fleet), for people with `fleet:desktop`. If the profile's browser is busy with a run, the console names the run and waits for it; it never interrupts a run. Cancel, leaving the page or 15 minutes without a sign-in give the desktop back and leave the browser open.
- **Attended:** the status and the warning, with the hint "Sign in on this computer's Chrome".
- **Browser-only (no desktop):** the status and the warning, with the hint to sign in with `hexactra fleet profile show`.

The email is shown in full to people with `fleet:read` (they own these accounts). It is never in a log, a span, a run trace, an export, a model's context or Hexactra's MCP tools. Sign-in status never authorises anything.

## Looking like a person

A node is built to look like what it is: a person's computer at home.
- **Network:** your residential IP.
- **Headful Google Chrome, never headless: no exceptions** (AGENTS.md, "MANDATORY: Never a headless browser"). Headless browsers are the first thing anti-bot systems detect. The agent refuses to start with a `--headless` argument or a headless-shell binary.
- **A real GPU.** On a virtual display without a GPU, Chrome reports a software graphics renderer (SwiftShader) to WebGL, or WebGL fails, and anti-bot scripts read that string. On an unattended node Chrome renders with the machine's integrated Intel or AMD graphics directly (Vulkan through the render node), which every mini PC has, so WebGL names the real hardware. You need no extra hardware, and this has nothing to do with AI.
- **Driven by the extension:** no `--enable-automation` flag, no DevTools or CDP port, and no WebDriver. The extension's trusted input and JavaScript go through `chrome.debugger` without enabling any CDP domain, and Chrome runs with `--silent-debugger-extension-api`, so there is no debugging bar.
- **Real input, and the whole desktop:** the agent clicks, types and scrolls with trusted events, and drives the node's desktop (native file pickers, OS dialogs) with `xdotool`. `hexactra agent install` installs the tools it needs (`xdotool`, `imagemagick`), and `hexactra agent update` adds them on nodes set up earlier (VISION §27).
- **Your environment:** the system's timezone and locale, and a normal screen size (1920x1080).
- **Persistent profiles:** real sign-ins, kept between runs. Each new chat and each task restarts the profile's browser and starts on a blank tab (unless another session is using that profile); the sign-ins stay ([console/docs/runner.md](../console/docs/runner.md), E40.5).

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

## What a node holds of a secret

**Nothing secret is stored on a node by Hexactra.** The node never holds a secrets-provider token, a vault key or a saved login, and it cannot ask a provider for anything: the control plane (the fabric) fetches a saved login, identity detail or card from the owner's provider ([console/docs/secrets.md](../console/docs/secrets.md)), and the node's own credential can act only for itself.

What the node does see is the value **inside the one action that types it**, because the page must receive it:

- **Path.** (A saved card's number, expiry and code travel the same way, as `type_keys` at screen coordinates when the field is inside a payment frame.) The control plane sends the host an ordinary `type` (or `type_keys`) action in the answer to its outbound long-poll, over TLS. The host agent hands it to the native host on its local Unix socket, which hands it to the extension, which types it with trusted input.
- **How long.** For the length of that one action: the time to deliver and type it, normally well under a second, or until the action's deadline. The control plane keeps the text in a zeroizing buffer apart from the operation's view (which shows `[secret]`) until the host takes the action, and wipes that buffer then; the copy placed in the answer to the host's poll is an ordinary string for as long as it takes to serialize and send.
- **In memory only.** The agent, the native host and the extension hold it as ordinary process memory. The host agent and the native host log an action's **kind**, its operation id and its outcome, never its text (`crates/hexactra-agent/src/remote_daemon.rs`, `crates/hexactra-native-host/src/relay.rs`); nothing is written to disk by Hexactra.
- **Not wiped on the node.** The Rust agent and native host do not zeroize the text, and the extension is JavaScript: whoever can read a node's process memory during that window can read the value. Only the control plane's holding buffer is zeroed (best effort: the managed runtimes cannot promise perfect erasure, VISION §11.6).
- **The extension checks the origin at the moment of typing.** The `type` or `type_keys` carries `expect_origin`, the origin the control plane verified; the extension types nothing if the tab's top-level origin differs then (E37.10), so a navigation after the control plane's last read cannot receive the value.
- **The origin comes from the node.** The control plane reads the tab's URL by asking the host for its tabs, so a compromised node can report an origin of its choosing (and a compromised extension can ignore `expect_origin`). That is why the node is the owner's own machine, with full-disk encryption, and why [the threat model](../console/docs/security-secrets.md) lists a compromised node.
- **No picture while a value is in flight.** The control plane refuses a screenshot of the session while a typing action holds a value (`409`), and a box covers what the fabric filled in every picture the model is shown.

What the node has always held is unchanged: the browser profiles, with their cookies and saved site sessions, and the Chrome policy file. A secrets provider adds nothing to that on the node except the typing windows above.

## Acceptance and security review

- [nodes-acceptance.md](nodes-acceptance.md): the manual check on a real mini PC.
- [nodes-security-review.md](nodes-security-review.md): each security invariant with the code and the test that proves it.
- CI's **Unattended node end to end** job installs a node with the CLI on a real Ubuntu 24.04 machine on every change.

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
| Profile shows **Not signed in to Google** or **Google session expired** | Click **Sign in** on it in Fleet (unattended nodes) and sign in on the desktop. On an attended node, sign in in your own Chrome; on a browser-only host, use `hexactra fleet profile show`. The warning clears within seconds of the sign-in. |
| Profile shows **Sign-in not checked** | Its browser has not run yet, or the node could not read its settings. Start a run or open the profile once; `hexactra agent doctor` on the node prints what it read. When the check with Google fails, the node agent's log has a line `live sign-in check could not tell` with the reason (`http_<status>`, `timeout`, `network`, `parse`). |
| Every profile shows **Sign-in not checked**, and its tooltip says **Not reported** | The status is not reaching the console. Hover the chip: "the server's fabric does not accept sign-in status yet" means the server is older than the node: update it (`hexactra deploy update`). "This node has not sent its sign-in status" means the node's agent is older: `hexactra agent update`. On the node, `hexactra agent doctor` shows a **sign-in reports** line (for example `HTTP 404 … update the server`), and the node agent's journal has `reporting profile sign-in status failed` (#998). |
| A warning about software graphics | The machine has no usable Intel or AMD GPU (or uses NVIDIA's proprietary driver). The node works but is easier to detect. |
