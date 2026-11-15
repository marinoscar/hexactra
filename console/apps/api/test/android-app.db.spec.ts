// The Android app's trust document, against a real database: an admin trusts
// the APK's (package, signing fingerprint) and /api/well-known/assetlinks.json
// (which nginx serves at /.well-known/assetlinks.json) lists it, so Chrome
// verifies the app and delegates the console's notifications to it.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';

let app: NestFastifyApplication;

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
});

async function token(role: 'admin' | 'viewer') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `android-${role}-${Date.now()}@example.test`, role } });
  return new URL(String(res.headers.location)).searchParams.get('token')!;
}

const FINGERPRINT = Array.from({ length: 32 }, (_, i) => (i * 7 + 3).toString(16).padStart(2, '0').toUpperCase()).join(':');

describe('Android app trust (assetlinks.json)', () => {
  it('lists a trusted (package, fingerprint) pair, publicly, as Digital Asset Links JSON', async () => {
    const admin = await token('admin');
    const put = await app.inject({
      method: 'PUT',
      url: '/api/admin/android-app',
      headers: { authorization: `Bearer ${admin}` },
      payload: { trustedApps: [{ packageName: 'com.hexactra.android', sha256: FINGERPRINT }] },
    });
    expect(put.statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: '/api/well-known/assetlinks.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const doc = JSON.parse(res.body) as { relation: string[]; target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] } }[];
    expect(Array.isArray(doc)).toBe(true);
    expect(doc).toContainEqual(
      expect.objectContaining({
        relation: expect.arrayContaining(['delegate_permission/common.handle_all_urls']),
        target: expect.objectContaining({ namespace: 'android_app', package_name: 'com.hexactra.android', sha256_cert_fingerprints: [FINGERPRINT] }),
      }),
    );
  });

  it('only an administrator changes the trusted list', async () => {
    const viewer = await token('viewer');
    const put = await app.inject({ method: 'PUT', url: '/api/admin/android-app', headers: { authorization: `Bearer ${viewer}` }, payload: { trustedApps: [] } });
    expect(put.statusCode).toBe(403);
  });
});
