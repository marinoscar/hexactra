import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { PasskeysSection, type PasskeyItem } from '../secrets/PasskeysSection';
import { ConfirmProvider } from '../ui';

const ITEMS: PasskeyItem[] = [
  { id: 'aaaaaaaa-1111-4111-8111-111111111111', site: 'example.com', origin: 'https://login.example.com', account: 'person-a@example.test', createdAt: '2026-11-20T10:00:00.000Z', lastUsedAt: '2026-11-24T09:00:00.000Z' },
  { id: 'bbbbbbbb-2222-4222-8222-222222222222', site: 'shop.example.org', origin: 'https://shop.example.org', account: '', createdAt: '2026-11-21T10:00:00.000Z', lastUsedAt: null },
];

function renderSection(items: PasskeyItem[], canWrite = true) {
  const host = createTestPlatformHost({ permissions: ['secrets:read', 'secrets:write'], responses: { 'GET /secrets/passkeys': items, [`DELETE /secrets/passkeys/${ITEMS[0]!.id}`]: { removed: true, removeOnSite: true } } });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <PasskeysSection canWrite={canWrite} />
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}

afterEach(cleanup);

describe('the Passkeys for Hexactra section (E47.5)', () => {
  it('lists the site, the account and the dates, never a key', async () => {
    renderSection(ITEMS);
    const list = await screen.findByRole('list', { name: 'Passkeys for Hexactra' });
    expect(within(list).getByText('example.com')).toBeInTheDocument();
    expect(within(list).getByText(/person-a@example\.test/)).toBeInTheDocument();
    expect(within(list).getByText(/not used yet/)).toBeInTheDocument();
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('removes one after a confirmation, and says to remove it on the site too', async () => {
    const host = renderSection(ITEMS);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove the Hexactra passkey for example.com' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.getByText('Removed. Remove it on example.com too: the site still lists it.')).toBeInTheDocument());
    expect(screen.queryByText('example.com', { selector: 'p' })).toBeNull();
    expect(host.requests.some((r: { method: string; path: string }) => r.method === 'DELETE' && r.path === `/secrets/passkeys/${ITEMS[0]!.id}`)).toBe(true);
  });

  it('says how to add one when there is none, and cannot remove without the write permission', async () => {
    renderSection([]);
    expect(await screen.findByText(/No passkeys yet\./)).toBeInTheDocument();
    cleanup();
    renderSection(ITEMS, false);
    expect(await screen.findByRole('button', { name: 'Remove the Hexactra passkey for example.com' })).toBeDisabled();
  });
});
