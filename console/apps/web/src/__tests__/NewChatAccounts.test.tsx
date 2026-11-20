// "New chats" (#680): the owner's choice of how a NEW chat starts with their accounts (Off, Read only, Read and change; read and change when
// never saved). Canned API answers only.
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';
import { vi } from 'vitest';

import { NewChatAccountsSetting, NEW_CHATS_HELP } from '../connections/NewChatAccounts';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 10_000 });

const wrap = (host: ReturnType<typeof createTestPlatformHost>) =>
  render(
    <PlatformHostProvider host={host}>
      <NewChatAccountsSetting />
    </PlatformHostProvider>,
  );

const choice = (name: string) => screen.findByRole('button', { name: `New chats: ${name}` });

describe('the New chats setting (#680)', () => {
  it('starts on Read and change when nothing was ever saved, and says what it does and does not do', async () => {
    const host = createTestPlatformHost({ permissions: [], responses: { 'GET /user-settings': { version: 1 } } });
    wrap(host);
    const readWrite = await choice('Read and change');
    await waitFor(() => expect(readWrite).toBeEnabled());
    expect(readWrite).toHaveAttribute('aria-pressed', 'true');
    expect((await choice('Off'))).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText(NEW_CHATS_HELP)).toBeInTheDocument();
    expect(NEW_CHATS_HELP).toMatch(/still asks you first/);
    expect(NEW_CHATS_HELP).toMatch(/MCP servers are never on by default/);
  });

  it('saves the choice as soon as it is made, as the connections namespace of the user settings', async () => {
    const host = createTestPlatformHost({
      permissions: [],
      responses: {
        'GET /user-settings': { version: 1, connections: { newChats: 'read_write' } },
        'PATCH /user-settings': (r: TestApiRequest) => ({ version: 2, connections: (r.body as { connections: unknown }).connections }),
      },
    });
    wrap(host);
    const off = await choice('Off');
    await waitFor(() => expect(off).toBeEnabled());
    fireEvent.click(off);
    await waitFor(() => expect(host.requests.some((r) => r.method === 'PATCH')).toBe(true));
    expect(host.requests.find((r) => r.method === 'PATCH')!.body).toEqual({ connections: { newChats: 'off' } });
    await waitFor(() => expect(off).toHaveAttribute('aria-pressed', 'true'));
    expect(await choice('Read and change')).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows a saved Read only, and puts the choice back with a message when saving fails', async () => {
    const host = createTestPlatformHost({
      permissions: [],
      responses: {
        'GET /user-settings': { version: 3, connections: { newChats: 'read' } },
        'PATCH /user-settings': () => {
          throw createTestApiError(500, 'INTERNAL_ERROR', 'boom');
        },
      },
    });
    wrap(host);
    const readOnly = await choice('Read only');
    await waitFor(() => expect(readOnly).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(await choice('Off'));
    expect(await screen.findByText('Could not save this setting. Try again.')).toBeInTheDocument();
    await waitFor(() => expect(readOnly).toHaveAttribute('aria-pressed', 'true'));
  });
});
