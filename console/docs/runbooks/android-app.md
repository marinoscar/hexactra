# Runbook: the Hexactra Console Android app

The Android app (`apps/android`) is a Trusted Web Activity around your console. It runs the full web app, so tasks, runs, the Inbox and Fleet all work on the phone. It also receives the console's push notifications on the `android_app` channel: "an agent needs you" and "a run finished". A phone becomes the place to solve a CAPTCHA (through the viewer) or type a code.

The build, versioning and releases go through the console CLI's `android` group. The platform documents that group in detail, as the `appctl android` commands, in its [Android release runbook](https://github.com/marinoscar/EnterpriseAppBase/blob/main/docs/runbooks/android-release.md).

## 1. Prerequisites

- JDK 17 or newer, and the Android SDK (platform 36, build-tools 36.0.0).
  - `hexactra android doctor` checks both.
  - `hexactra android doctor --fix` installs the SDK pieces. It never installs a JDK.
- A clone of the repository with the console's dependencies installed: `cd console && npm ci`. The Android build takes the platform's Android library from `console/node_modules`.
  - Run the `android` commands from the clone: its root, `console/`, or any directory inside. From the root, the CLI says it uses `console/`.
  - `build` and `release` stop before the version bump when the dependencies are missing, and name the command to run.
- The console reachable over **https**. The app's launcher binds to the console's host.
- The `android-app` slice enabled (`packages/shared/slices.json`; it is enabled by default).

## 2. Build and release

```bash
hexactra login                                   # once, as an admin
hexactra android keystore init                   # once: RSA 4096, kept under ~/.hexactra/android/
hexactra android release --bump patch --notes "First release"
```

`release` does the whole release:
1. It bumps the version in `apps/android/version.properties`.
2. It builds and signs the APK for the console you are logged in to.
3. It uploads the APK and makes it the current release. Phones download it from the console.
4. It commits `version.properties`, only after the upload succeeded.

Publishing also adds the APK's signing key to the trusted apps that `/.well-known/assetlinks.json` lists. For a step-by-step release, see the platform runbook's `publish --trust`.

`hexactra android releases` lists what is published.

## 3. Install on a phone

Any signed-in person can install the app; no administrator permission is needed.

1. On the phone, open `https://<console>/settings/android-app` and sign in. The page is also reachable as **Settings → Android app**, and as **Get the Android app** in the user menu (hidden inside the app itself).
2. Tap **Download APK**. Allow installs from the browser when Android asks.
   - The button asks for a signed link that is valid for ten minutes, then opens it, so Android hands the file straight to the installer.
   - The page shows the version, release date, size, notes and the SHA-256 checksum, so you can check the file.
3. Open **Hexactra Console** from the launcher. Once asset links verify, it opens the console full screen, without the browser's address bar.
4. Allow notifications when asked. Run, handoff and reminder notifications now reach the phone.

Inside the app, the same page says whether the installed build is current. The in-app banner also offers a newer release.

With nothing published, the page says so. An administrator also sees how to publish: `hexactra android release` (section 2), or upload an APK on Administration → Android app.

## 4. Notifications and deep links

### Checklist: notifications on the phone

Work through these in order; each step names how to check it.

1. **Web Push keys.** Administration → Web Push: generate the VAPID key pair and enable it. Check: the page shows the key as active.
2. **Built for this console.** `hexactra android release`, which builds with the console you are logged in to. Check: in the app, a notification shows the app's icon and name, not Chrome's.
3. **Trusted.** Administration → Android app lists the release's package and SHA-256, trusted. Publishing with `hexactra android release` does this.
4. **Verified.** Open `https://<console>/.well-known/assetlinks.json`. Check: a JSON array that names the package and fingerprint. If you see the web app's page instead, `infra/nginx/app.d/locations/android-app.conf` is missing.
5. **Allowed.** Open the app, accept the notification prompt (Android 13+ shows the system dialog), and keep notifications on in Settings → Notifications for the events you want.
6. **Test.** Administration → Android app → **Send me a test notification**. Check: it arrives as the app's own notification.

Why each step matters:
- Chrome hands the console's notifications to the app only after it verifies the app (step 4), for an APK built with the console's host (step 2).
- A subscription made inside the app is tagged `android_app` (step 5). That is what the admin test and the app-only channel deliver to.

### Events

| Event | On the phone | Opens |
|---|---|---|
| An agent needs you (`runs.needs_you`) | High urgency, one per run (a newer one replaces it) | `/inbox?run=<id>`: the Inbox with that request first, outlined |
| Run finished (`runs.finished`) | High urgency when it failed, normal otherwise; one per run | `/runs/<id>` |
| Reminders while an agent waits (`runs.needs_you_reminder`) | High urgency; replaces the request's notification and alerts again | `/inbox?run=<id>` |
| Schedule failing (`schedules.failing`) | Normal urgency, one per schedule | `/tasks` |

- **Buttons that act without opening the app.** Browsers show two buttons at most, so the pair depends on the request:
  - A plain confirmation can be answered with one tap: **Approve** and **Stop run**.
  - A code, a password, a choice or a sign-in always needs the app: **Remind me in 15 min** (while 20 min or more remain) and **Stop run**.
  - The service worker handles the buttons (`apps/web/src/notificationActions.ts`), so they work the same in the Android app, the installed PWA and a desktop browser.
  - It holds no session: a button carries a single-use token, valid for an hour, that can stop that one run or approve that one confirmation (`POST /api/notification-actions`).
  - An expired, used or stale button opens the run instead.
  - Stopping a run that waits for a person cancels it at once: its request is withdrawn and its browser session ends.
- **Reminders before a request expires** (`apps/api/src/tasks/reminder-schedule.ts`). The schedule comes from the request's own window, from when the agent asked to when the fabric expires the request (10 min by default, at most 24 h):
  - **Nudge:** at 25 % of the window, between 3 and 15 min after the request.
  - **Midpoint:** only for windows of 2 h or more.
  - **Final:** 5 min before expiry (20 % of a short window), titled "Expires in N min".
  - Points closer than 3 min to the request or to each other are dropped. At most 5 reminders per request, snoozes included. With no known expiry: 10 and 60 min.
  - Example: a 10 min request reminds at 3 and 8 min; a 30 min request at 7.5 and 25 min.
  - **Remind me in 15 min** closes the notification quietly. The reminder comes back after 15 min, and no nudge fires in between.
  - A reminder replaces the request's notification (tag `run-<id>`) and makes sound again. The service worker adds `renotify` to pushed run notifications, because the platform's push extras have no such field yet.
  - **How it runs.** A 30 s cron only enqueues `browser.runs.remind` when a run's `remind_at` has passed. The job re-reads the request on the fabric, so an answered, cancelled or expired request is never reminded about. An unreachable fabric is tried again a minute later.
  - **Turning them off.** Settings → Notifications → **Reminders while an agent waits**. The first "needs you" notification still arrives.
- **How a tap reaches the app.** A notification's link is a URL on the console. The app holds a verified `https://<console>` app link (the `autoVerify` intent filter that `aapt2` checks in CI), so Android opens the link inside the app rather than in the browser.
- **Payloads carry no secrets.** A request names what is asked, never an answer: codes typed into the Inbox go straight to the fabric.
- **Tests.** `apps/api/test/push-payload.spec.ts` covers the payloads, links and buttons. `apps/api/test/run-reminders.spec.ts` covers the schedule. `apps/api/test/run-reminders.db.spec.ts` covers sending, snooze and replay. `apps/web/src/__tests__/notificationActions.test.ts` covers the buttons and `renotify`. `apps/web/src/__tests__/InboxPage.test.tsx` covers the deep link.

## 5. CI

`.github/workflows/console-android.yml` runs on every change to the app. It:
- runs the unit tests;
- builds a debug APK for `https://console.example.test`;
- checks the built APK's package, launcher activity, label and host binding with `aapt2`;
- uploads the APK as an artifact.

Signed release builds in CI are an owner step. See section 9 of the platform runbook for the four keystore secrets.

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| The app shows a browser address bar | Asset links do not verify: the APK's signing key is not the trusted one, or the console is not https | `hexactra android keystore show`, then `hexactra android release` again; check `https://<console>/.well-known/assetlinks.json` |
| No push on the phone | Notifications are off for the app, or the event's `android_app` channel is off in your preferences | Settings → Notifications in the console; Android settings → Apps → Hexactra Console → Notifications |
| `... is not inside the hexactra repository` | The command ran outside the clone | Run it from the clone (its root or `console/`), or set `HEXACTRA_REPO_ROOT` to the clone |
| `The console's dependencies are not installed`, or Gradle's `platform-core not found` | `npm ci` was never run in `console/` of this clone | `cd console && npm ci`, then run the command again |
| `409 RELEASE_VERSION_EXISTS` | That `versionCode` is already published | `hexactra android version --bump patch`, then rebuild |
