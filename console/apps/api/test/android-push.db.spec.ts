// Push to the Android app, against a real database: a subscription made
// inside the app (tagged `android_app` by apps/web/src/androidPush.ts) is
// what the android_app channel and Administration → Android app → "Send me a
// test notification" deliver to; an untagged one is not found, and a later
// untagged re-post never drops the tag.
import { createECDH, randomBytes } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';

let app: NestFastifyApplication;

// Generating the VAPID key pair stores it encrypted: a fixed test key (32 bytes, not a real secret).
const savedKey = process.env.SECRETS_ENCRYPTION_KEY;
beforeAll(async () => {
  process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
  if (savedKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = savedKey;
});

async function token(email: string, role: 'admin' | 'contributor') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
  return new URL(String(res.headers.location)).searchParams.get('token')!;
}

/** A browser-shaped PushSubscription.toJSON(): a P-256 public key and a 16-byte auth secret. */
function subscription(id: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://push.example.test/send/${id}`,
    expirationTime: null,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
}

describe('push to the Android app', () => {
  it('finds a subscription only once it is tagged android_app, and keeps the tag', async () => {
    const stamp = Date.now();
    const admin = await token(`push-admin-${stamp}@example.test`, 'admin');
    const auth = { authorization: `Bearer ${admin}` };
    const gen = await app.inject({ method: 'POST', url: '/api/admin/push-config/generate', headers: auth, payload: { subject: 'mailto:admin@example.test' } });
    expect([200, 201, 409]).toContain(gen.statusCode);

    const sub = subscription(String(stamp));
    const post = (body: unknown) => app.inject({ method: 'POST', url: '/api/notifications/push/subscriptions', headers: auth, payload: body as object });
    const test = async () => (await app.inject({ method: 'POST', url: '/api/admin/android-app/test-notification', headers: auth, payload: {} })).json<{ data: { androidSubscriptions: number; reason?: string | null } }>().data;

    // What the platform's web client posts today: no platform → stored as browser.
    expect((await post(sub)).statusCode).toBe(201);
    expect(await test()).toMatchObject({ androidSubscriptions: 0, reason: 'NO_ANDROID_SUBSCRIPTION' });

    // What the console posts inside the app.
    const tagged = await post({ ...sub, platform: 'android_app' });
    expect(tagged.statusCode).toBe(201);
    expect(tagged.json<{ data: { platform: string } }>().data.platform).toBe('android_app');
    expect((await test()).androidSubscriptions).toBe(1);

    // The platform's own sync re-posts without a platform: the tag stays.
    await post(sub);
    const row = await app.get(PrismaService).pushSubscription.findFirstOrThrow({ where: { endpoint: sub.endpoint } });
    expect(row.platform).toBe('android_app');
  });
});
