// Tag this device's push subscription `android_app` when the console runs
// inside its Android app (the Trusted Web Activity).
//
// WORKAROUND for a missing platform seam: @marinoscar/platform-web subscribes
// with `subscription.toJSON()` and no `platform`, so the server stores every
// subscription as `browser`. Then the `android_app` channel and Administration
// → Android app → "Send me a test notification" find nothing on the phone.
// The API already takes `platform: 'android_app'` on the same route and only
// ever re-tags upward, so re-posting the existing subscription with the tag is
// safe and idempotent. Remove this once the platform sends the tag itself
// (EnterpriseAppBase seam request).

export interface PushTagDeps {
  /** Whether this page runs inside the Android app. */
  inTwa(): boolean;
  /** This browser's current push subscription, or null (none yet, or no push support). */
  subscription(): Promise<PushSubscriptionJSON | null>;
  /** POST through the console's API client (bearer token, refresh, retries). */
  post(path: string, body: unknown): Promise<unknown>;
}

/** Tags the current subscription. Returns true when one was tagged, false when there is none yet (or not in the app). */
export async function tagAndroidSubscription(deps: PushTagDeps): Promise<boolean> {
  if (!deps.inTwa()) return false;
  const sub = await deps.subscription();
  if (!sub?.endpoint || !sub.keys) return false;
  await deps.post('/notifications/push/subscriptions', { ...sub, platform: 'android_app' });
  return true;
}

/** The browser's push subscription as JSON, without ever prompting. */
export async function currentSubscription(): Promise<PushSubscriptionJSON | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  const sub = await registration?.pushManager?.getSubscription();
  return sub ? sub.toJSON() : null;
}
