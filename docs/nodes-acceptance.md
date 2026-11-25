# Node acceptance: the mini PC at home

This is the manual check that closes epic #333 (#344). Run it once on a real machine on your residential network. CI cannot check what only real hardware and a real home connection show: the GPU, Google sign-in, and an internet path from your phone. CI does check the rest on every change (the **Unattended node end to end** job, `console/scripts/node-e2e.sh`).

**You need:**
- an Ubuntu 24.04 mini PC (x86_64, Intel or AMD graphics) on your home network;
- the console (for example `https://hex.example.test`) with you as an administrator;
- the Android app or a phone browser;
- an MCP client or `curl` with an API token.

Tick each line, and note anything unexpected.

## 1. Install both modes

On the mini PC, logged in to your desktop with an **Xorg** session:

```bash
hexactra login https://hex.example.test
hexactra agent install --mode both
hexactra agent doctor
```

- [ ] One sudo password prompt for the whole install.
- [ ] `agent doctor`: every line `ok`. `graphics` names `i915`, `xe` or `amdgpu`, not "software rendering".
- [ ] Fleet shows `mini-pc` (Unattended, desktop icon) and `mini-pc-attended` (Attended), both online.
- [ ] `ss -ltnp` shows no new listening port after the install.

## 2. Unattended survives a reboot with nobody logged in

- [ ] Reboot and **do not log in**. Within 2 minutes, Fleet shows `mini-pc` online.
- [ ] **Open desktop** in the web app shows the XFCE desktop at 1920x1080.
- [ ] The same from the Android app (the console in its window). Touch and the on-screen keyboard work after **Take over**.

## 3. Sign in to a profile through the remote desktop

- [ ] In Fleet, create a profile `personal` on `mini-pc`.
- [ ] On the desktop page, pick `personal`, click **Take over**, then **Sign in to profile**. Chrome opens at the Google sign-in.
- [ ] Sign in to Google, then close that Chrome window, and click **Release**.
- [ ] In that Chrome, `chrome://policy` lists `ExtensionSettings` as OK, and the Hexactra extension is pinned, "Installed by your administrator".
- [ ] In that Chrome, `chrome://gpu` shows **Hardware accelerated** for WebGL. A WebGL report page shows an unmasked renderer naming Intel or AMD, not SwiftShader or llvmpipe.

## 4. Agents use the node

- [ ] **MCP:** `hosts_list` shows both hosts with their mode. `browser_open` on host `mini-pc`, profile `personal`, then `browser_navigate` to `https://mail.google.com`: you are signed in. No "unusual sign-in" challenge from a datacenter IP.
- [ ] **API:** the same with `POST /api/runs` (a goal) or the external browser routes.
- [ ] While a run is going, **Take over** on its desktop: the run's next step waits ("A person is controlling this browser"). **Release** it, and the run continues.

## 5. Attended mode

- [ ] Logged in on the mini PC with Xorg, open your own Google Chrome. The Hexactra extension is there, by policy.
- [ ] A run on `mini-pc-attended` drives that Chrome.
- [ ] **Open desktop** on `mini-pc-attended` shows your live screen, and a notice on the mini PC names you as the viewer.
- [ ] After you close the desktop page, `pgrep x11vnc` finds nothing within 30 seconds.
- [ ] Log out, log in with a **Wayland** session, and run `hexactra agent doctor`. The `session` line says Wayland and how to switch. Opening the desktop says it is unavailable.

## 6. Network and recovery

- [ ] Unplug the mini PC's network for 2 minutes. The open desktop page shows it reconnecting, then the host goes offline in Fleet.
- [ ] Plug it back in. The host comes back online within a minute, and the desktop page reconnects or reopens.
- [ ] `hexactra agent update` updates both modes, and both come back online.

## 7. Profile sign-in status (epic #926)

Note the Chrome version (`chrome://version`) in the result.

- [ ] On `mini-pc`, sign profile `personal` out of Google (in its Chrome, at `accounts.google.com`). Within the check interval (10 minutes, or at once when the sign-out page loads), Fleet shows **Not signed in to Google** on `personal` and "1 profile needs sign-in" on the host; the **profile signed out** alert fires.
- [ ] The **expired** state: revoke the session from another device (Google Account → Security → Your devices → sign out of the mini PC). Fleet shows **Google session expired** at the next live check. If it cannot be reproduced, note why.
- [ ] Click **Sign in** on `personal`. The desktop opens in sign-in mode with Chrome at Google's sign-in. Sign in. With no further step, the banner shows "Signed in as <your email>", Chrome closes and the desktop is released; Fleet shows **Signed in as <your email>**.
- [ ] `hexactra fleet profile restart mini-pc personal` (or **Restart browser**), then reboot the mini PC: `personal` is still **Signed in**.
- [ ] Sign two profiles out, then **Fix sign-ins (2)**: both are signed in in one pass, with one takeover.
- [ ] Start a run on a signed-out profile: the run starts and shows the "not signed in to Google" warning with a **Sign in** link.
- [ ] Export the acceptance run's traces, the console and fabric logs (`docker compose logs`) and the OTel spans, and `grep -i` them for your email: nothing.

## Result

Attach this checklist, ticked, with notes and the `agent doctor` output, to #344. Any unticked line needs an issue.
