import { describe, expect, it, vi } from 'vitest';

import { tagAndroidSubscription } from '../androidPush';

const sub = { endpoint: 'https://push.example.test/abc', keys: { p256dh: 'p', auth: 'a' } };

describe('tagging the Android app push subscription', () => {
  it('inside the app, re-posts the subscription with platform android_app', async () => {
    const post = vi.fn(async () => ({}));
    expect(await tagAndroidSubscription({ inTwa: () => true, subscription: async () => sub, post })).toBe(true);
    expect(post).toHaveBeenCalledWith('/notifications/push/subscriptions', { ...sub, platform: 'android_app' });
  });

  it('outside the app, or before a subscription exists, posts nothing', async () => {
    const post = vi.fn(async () => ({}));
    expect(await tagAndroidSubscription({ inTwa: () => false, subscription: async () => sub, post })).toBe(false);
    expect(await tagAndroidSubscription({ inTwa: () => true, subscription: async () => null, post })).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
});
