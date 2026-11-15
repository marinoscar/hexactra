# Runbook: the Hexactra Console Android app

The Android app (`apps/android`) is a Trusted Web Activity around your console. It runs the full web app, so tasks, runs, the Inbox and Fleet all work on the phone. It also receives the console's push notifications on the `android_app` channel: "an agent needs you" and "a run finished". A phone becomes the place to solve a CAPTCHA (through the viewer) or type a code.

The build, versioning and releases go through the console CLI's `android` group. The platform documents that group in detail, as the `appctl android` commands, in its [Android release runbook](https://github.com/marinoscar/EnterpriseAppBase/blob/main/docs/runbooks/android-release.md).

## 1. Prerequisites

- JDK 17 or newer, and the Android SDK (platform 36, build-tools 36.0.0).
  - `hexactra android doctor` checks both.
  - `hexactra android doctor --fix` installs the SDK pieces. It never installs a JDK.
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

1. On the phone, open the console and sign in.
2. Go to **Administration → Android app** and download the current APK. Allow the install from the browser when asked.
3. Open **Hexactra Console** from the launcher. It opens the console full screen, without the browser's address bar, once asset links verify.
4. Allow notifications when asked. Run and handoff notifications now reach the phone.

## 4. CI

`.github/workflows/console-android.yml` runs on every change to the app. It:
- runs the unit tests;
- builds a debug APK for `https://console.example.test`;
- checks the built APK's package, launcher activity, label and host binding with `aapt2`;
- uploads the APK as an artifact.

Signed release builds in CI are an owner step. See section 9 of the platform runbook for the four keystore secrets.

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| The app shows a browser address bar | Asset links do not verify: the APK's signing key is not the trusted one, or the console is not https | `hexactra android keystore show`, then `hexactra android release` again; check `https://<console>/.well-known/assetlinks.json` |
| No push on the phone | Notifications are off for the app, or the event's `android_app` channel is off in your preferences | Settings → Notifications in the console; Android settings → Apps → Hexactra Console → Notifications |
| `409 RELEASE_VERSION_EXISTS` | That `versionCode` is already published | `hexactra android version --bump patch`, then rebuild |
