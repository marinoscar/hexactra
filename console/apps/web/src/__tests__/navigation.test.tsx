import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { act, render, screen, waitFor, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { ShellBottomNav, ShellNavigationRail } from '@marinoscar/platform-web/shell/ui';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, vi } from 'vitest';

import { INBOX_POLL_MS, InboxCountProvider, titleWithCount, useInboxCount } from '../components/InboxCountProvider';
import { NAVIGATION, PHONE_NAVIGATION } from '../config/navigation';
import { BOTTOM_BAR_HEIGHT, aboveBottomBar } from '../ui';
import { mockViewport } from './matchMedia';

const PERMISSIONS = ['chat:read', 'runs:read', 'tasks:read', 'fleet:read', 'system_settings:read'];
const question = (id: string) => ({ questionId: id });

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  vi.useRealTimers();
  document.title = 'Hexactra';
});

function renderNav(ui: React.ReactElement, inbox: unknown, permissions = PERMISSIONS) {
  const host = createTestPlatformHost({ permissions, responses: { 'GET /inbox': inbox } });
  render(
    <PlatformHostProvider host={host}>
      <MemoryRouter initialEntries={['/tasks']}>
        <InboxCountProvider>{ui}</InboxCountProvider>
      </MemoryRouter>
    </PlatformHostProvider>,
  );
  return host;
}

describe('phone bottom bar', () => {
  it('draws Chat, Inbox, Overview and "More" (Tasks and Runs are under it): chat is the home (#486, #713)', async () => {
    restore = mockViewport(390);
    renderNav(<ShellBottomNav navigation={PHONE_NAVIGATION} />, []);
    const tabs = await screen.findAllByRole('button');
    expect(tabs.map((t) => t.textContent)).toEqual(['Chat', 'Inbox', 'Overview', 'More']);
    expect(screen.getByRole('button', { name: /More destinations/ })).toBeInTheDocument();
  });

  it('without chat:read draws four tabs: Inbox, Overview, Tasks, Runs, and no "More"', async () => {
    restore = mockViewport(390);
    renderNav(<ShellBottomNav navigation={PHONE_NAVIGATION} />, [], PERMISSIONS.filter((p) => p !== 'chat:read'));
    const tabs = await screen.findAllByRole('button');
    expect(tabs.map((t) => t.textContent)).toEqual(['Inbox', 'Overview', 'Tasks', 'Runs']);
    expect(screen.queryByRole('button', { name: /More destinations/ })).not.toBeInTheDocument();
  });

  it('shows the pending count on the Inbox tab and in its accessible name', async () => {
    restore = mockViewport(390);
    renderNav(<ShellBottomNav navigation={PHONE_NAVIGATION} />, [question('a'), question('b')]);
    const inbox = await screen.findByRole('button', { name: 'Inbox (2)' });
    expect(within(inbox).getByTestId('destination-badge')).toHaveTextContent('2');
  });

  it('shows no badge at zero', async () => {
    restore = mockViewport(390);
    const host = renderNav(<ShellBottomNav navigation={PHONE_NAVIGATION} />, []);
    await waitFor(() => expect(host.requests.some((c) => c.path === '/inbox')).toBe(true));
    expect(screen.getByRole('button', { name: 'Inbox' })).toBeInTheDocument();
    expect(screen.queryByTestId('destination-badge')).not.toBeInTheDocument();
  });
});

describe('chat is the home (#713)', () => {
  it('marks Chat active on / and on every chat, and Overview on /overview', async () => {
    const { resolveActiveDestination, shellDestinationRoutes } = await import('@marinoscar/platform-web/shell/headless');
    const routes = shellDestinationRoutes(NAVIGATION);
    expect(resolveActiveDestination(routes, '/')).toBe('chat');
    expect(resolveActiveDestination(routes, '/chat')).toBe('chat');
    expect(resolveActiveDestination(routes, '/chat/abc')).toBe('chat');
    expect(resolveActiveDestination(routes, '/overview')).toBe('overview');
    expect(resolveActiveDestination(routes, '/tasks')).toBe('tasks');
  });
});

describe('Inbox badge on the other surfaces', () => {
  it('is on the rail', async () => {
    restore = mockViewport(1440);
    renderNav(<ShellNavigationRail navigation={NAVIGATION} />, [question('a'), question('b'), question('c')]);
    expect(await screen.findByRole('link', { name: 'Inbox (3)' })).toBeInTheDocument();
    // Every destination is on the rail (tablet and desktop).
    for (const name of ['Chat', 'Overview', 'Tasks', 'Runs', 'Fleet', 'Settings', 'Administration']) expect(screen.getByRole('link', { name })).toBeInTheDocument();
  });
});

describe('InboxCountProvider', () => {
  function Probe() {
    const { count } = useInboxCount();
    return <output>{count}</output>;
  }

  it('puts the count in the document title and takes it out at zero', async () => {
    document.title = 'Hexactra';
    renderNav(<Probe />, [question('a'), question('b')]);
    await waitFor(() => expect(document.title).toBe('(2) Hexactra'));
    expect(titleWithCount('(2) Hexactra', 0)).toBe('Hexactra');
    expect(titleWithCount('(2) Hexactra', 5)).toBe('(5) Hexactra');
  });

  it('shows no badge and does not throw when the request fails', async () => {
    const host = createTestPlatformHost({ permissions: PERMISSIONS, responses: { 'GET /inbox': () => { throw new Error('offline'); } } });
    render(
      <PlatformHostProvider host={host}>
        <MemoryRouter>
          <InboxCountProvider>
            <Probe />
          </InboxCountProvider>
        </MemoryRouter>
      </PlatformHostProvider>,
    );
    await waitFor(() => expect(host.requests.length).toBeGreaterThan(0));
    expect(screen.getByRole('status')).toHaveTextContent('0');
    expect(document.title).toBe('Hexactra');
  });

  it('does not ask without runs:read', async () => {
    const host = renderNav(<Probe />, [question('a')], ['tasks:read']);
    await act(async () => undefined);
    expect(host.requests).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent('0');
  });

  it('polls every 15 s while the tab is visible', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const host = renderNav(<Probe />, [question('a')]);
    await waitFor(() => expect(host.requests).toHaveLength(1));
    await act(async () => {
      vi.advanceTimersByTime(INBOX_POLL_MS);
    });
    await waitFor(() => expect(host.requests).toHaveLength(2));
  });
});

describe('bottom bar offset', () => {
  it('clears the bar and the safe area on a phone, the safe area alone from sm', () => {
    expect(BOTTOM_BAR_HEIGHT).toBe(56);
    expect(aboveBottomBar()).toEqual({ xs: 'calc(56px + env(safe-area-inset-bottom, 0px))', sm: 'calc(0px + env(safe-area-inset-bottom, 0px))' });
    expect(aboveBottomBar(8).xs).toBe('calc(64px + env(safe-area-inset-bottom, 0px))');
  });

  it('nothing else carries its own offset above the bar: no safe-area arithmetic or numeric `bottom` outside ui/bottomBar.ts', () => {
    const root = join(__dirname, '..');
    const sources = (readdirSync(root, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f) && !f.startsWith('__tests__') && f !== join('ui', 'bottomBar.ts'));
    const offenders = sources.filter((f) => {
      const text = readFileSync(join(root, f), 'utf8');
      // A pinned element's `bottom` (a chart's `margin={{ …, bottom: 8 }}` is not one).
      return /safe-area-inset-bottom/.test(text) || /\bbottom:\s*(\{\s*xs:\s*\d|['"`]calc\()/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});

