// The built-in store's switch on Administration → Secrets (#711): never an environment variable.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';

import { BuiltinStoreCard } from '../secrets/BuiltinStoreCard';

const STATE = { keyConfigured: true, mounted: true, enabled: false, keyId: 'a1b2c3d4', legacyEnv: false };

function mount(state: Record<string, unknown>, canWrite = true) {
  let current = { ...state };
  const host = createTestPlatformHost({
    responses: {
      'GET /secrets/store/state': () => current,
      'GET /system-settings': { version: 7 },
      'PATCH /system-settings': (req: { body: { secrets: { store: { enabled: boolean } } } }) => ((current = { ...current, enabled: req.body.secrets.store.enabled }), { version: 8 }),
    },
  } as never);
  render(
    <PlatformHostProvider host={host}>
      <BuiltinStoreCard canWrite={canWrite} />
    </PlatformHostProvider>,
  );
  return host;
}

describe('BuiltinStoreCard', () => {
  it('switches the store on in the admin panel: a system setting, with the version it read', async () => {
    const host = mount(STATE);
    const toggle = await screen.findByRole('switch', { name: 'Offer the built-in store' });
    expect(toggle).not.toBeChecked();
    expect(screen.getByTestId('store-key')).toHaveTextContent('Store key: configured (id a1b2c3d4)');
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Offer the built-in store' })).toBeChecked());
    const patch = host.requests.find((r) => r.method === 'PATCH' && r.path === '/system-settings');
    expect(patch?.body).toEqual({ secrets: { store: { enabled: true } } });
  });

  it('without a key the switch cannot be turned on, and says how to get one', async () => {
    mount({ ...STATE, keyConfigured: false, mounted: false, keyId: null });
    expect(await screen.findByRole('switch', { name: 'Offer the built-in store' })).toBeDisabled();
    expect(screen.getByTestId('store-key')).toHaveTextContent(/no store key yet\. Run hexactra deploy/);
  });

  it('is read-only without system_settings:write', async () => {
    mount(STATE, false);
    expect(await screen.findByRole('switch', { name: 'Offer the built-in store' })).toBeDisabled();
  });
});
