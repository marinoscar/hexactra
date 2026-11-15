// The Android companion slice, on the web: the admin page (trusted apps, hosted
// APK releases, a test push), the "update available" banner shown ONLY inside the
// Android app's Trusted Web Activity, and the launch capture that remembers the
// installed build before the router drops the `?source=twa&appVersion=...`
// parameters. The Kotlin shell is built by the CLI's `android` command.
import { ANDROID_IDENTITY_SOURCE } from '@app/shared';
import { androidIdentity, captureTwaLaunch, isRunningInTwa } from '@marinoscar/platform-web/android-app/headless';
import { AndroidUpdateBanner, androidAppSettingsPage } from '@marinoscar/platform-web/android-app/ui';
import { lazy, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ListItemIcon, ListItemText, MenuItem } from '@mui/material';
import PhoneAndroidIcon from '@mui/icons-material/PhoneAndroid';

import { api } from '../api';
import { currentSubscription, tagAndroidSubscription } from '../androidPush';

import type { WebSlice } from './slice';

const AndroidAppPage = lazy(() => import('@marinoscar/platform-web/android-app/ui').then((m) => ({ default: m.AndroidAppPage })));
const AndroidAppDownloadPage = lazy(() => import('../pages/AndroidAppDownloadPage'));

/** The Android identity every surface shares (derived from identity.json like the Gradle build derives it). */
export const ANDROID_IDENTITY = androidIdentity(ANDROID_IDENTITY_SOURCE);

/** Where people download the app (#301); title and description mirror the page's. */
const DOWNLOAD_PATH = '/settings/android-app';
const DOWNLOAD_TITLE = 'Android app';
const DOWNLOAD_DESCRIPTION = 'Download and install the Android app to control your agents and get their notifications on your phone.';

/** "Get the Android app" in the user menu; hidden inside the app itself. */
function GetAndroidAppMenuItem({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  if (isRunningInTwa(ANDROID_IDENTITY.storagePrefix)) return null;
  return (
    <MenuItem
      onClick={() => {
        navigate(DOWNLOAD_PATH);
        onDone();
      }}
    >
      <ListItemIcon>
        <PhoneAndroidIcon fontSize="small" />
      </ListItemIcon>
      <ListItemText>Get the Android app</ListItemText>
    </MenuItem>
  );
}

function UpdateBanner() {
  return <AndroidUpdateBanner keyPrefix={ANDROID_IDENTITY.storagePrefix} />;
}

/** How often (and how long) to look for a subscription made after the page loaded: the person may allow notifications later. */
const TAG_RETRY_MS = 15_000;
const TAG_TRIES = 40;

/**
 * Inside the Android app, tags this device's push subscription `android_app`
 * (see ../androidPush.ts) once one exists: at once, then every 15 s for ten
 * minutes until it is, and again whenever notification permission changes.
 * Renders nothing; mounted with the signed-in shell, so the API call carries
 * the session.
 */
function AndroidPushTagger() {
  useEffect(() => {
    if (!isRunningInTwa(ANDROID_IDENTITY.storagePrefix)) return;
    let tries = 0;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deps = { inTwa: () => true, subscription: currentSubscription, post: (path: string, body: unknown) => api.post(path, body) };
    const attempt = async () => {
      if (done) return;
      try {
        done = await tagAndroidSubscription(deps);
      } catch {
        done = false;
      }
      if (!done && ++tries < TAG_TRIES) timer = setTimeout(() => void attempt(), TAG_RETRY_MS);
    };
    void attempt();
    // A permission granted later: tag as soon as the subscription follows.
    let status: PermissionStatus | undefined;
    const onChange = () => {
      done = false;
      tries = 0;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void attempt(), 2_000);
    };
    navigator.permissions
      ?.query({ name: 'notifications' as PermissionName })
      .then((s) => {
        status = s;
        s.addEventListener('change', onChange);
      })
      .catch(() => undefined);
    return () => {
      done = true;
      if (timer) clearTimeout(timer);
      status?.removeEventListener('change', onChange);
    };
  }, []);
  return null;
}

export const androidAppWebSlice: WebSlice = {
  id: 'android-app',
  setup: () => captureTwaLaunch(undefined, ANDROID_IDENTITY.storagePrefix),
  banners: [UpdateBanner, AndroidPushTagger],
  // `system_settings:read` is the exact string `GET /api/admin/android-app` enforces; writes are gated inside the page.
  routes: [
    { path: 'admin/settings/android', permission: 'system_settings:read', element: <AndroidAppPage /> },
    // No permission: the latest-release and download-link routes are `@Auth()` for every signed-in user.
    { path: 'settings/android-app', element: <AndroidAppDownloadPage appName={ANDROID_IDENTITY.label} storagePrefix={ANDROID_IDENTITY.storagePrefix} /> },
  ],
  adminCards: [{ group: 'General', cards: [{ ...androidAppSettingsPage.card, Icon: androidAppSettingsPage.Icon }] }],
  userCards: [{ group: 'Account', cards: [{ title: DOWNLOAD_TITLE, description: DOWNLOAD_DESCRIPTION, Icon: PhoneAndroidIcon, path: DOWNLOAD_PATH }] }],
  userMenuItems: [(close) => <GetAndroidAppMenuItem onDone={close} />],
};
