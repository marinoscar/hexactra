// The Connections pages (E39.2, #599): the list in every state (two Google accounts and one Microsoft account), the connect
// dialog, an incremental capability change, defaults, disconnect with the list of tasks that use the account, pause and test, the
// consent's result banner, permissions, and the administrator's page. No token or scope string is ever on screen.
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminConnectionsPage } from '../pages/AdminConnectionsPage';
import { ConnectionsPage } from '../pages/ConnectionsPage';
import { ConnectionsMenuItem } from '../connections/ConnectionsMenuItem';
import type { AdminProvider, Connection, ProviderAvailability } from '../connections/api';
import { levelOf, outcomeBanner, remedyWords, testCodeWords, GROUPS } from '../connections/words';
import { MenuList } from '@mui/material';
import { ConfirmProvider } from '../ui';
import { mockViewport } from './matchMedia';
import { seriousFindings } from './axe';
import { webCountWords, webStepLine } from '../components/webSteps';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const MARKER = 'MARKER-never-on-screen';

const WORK: Connection = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  provider: 'google',
  label: 'Work',
  accountEmail: 'person.a@example.test',
  accountName: 'Person A',
  capabilities: ['mail_read', 'mail_send', 'calendar_read'],
  granted: ['mail_read', 'mail_send', 'calendar_read'],
  defaultFor: ['mail'],
  status: 'active',
  statusReason: null,
  connectedAt: '2026-11-18T10:00:00.000Z',
  lastUsedAt: '2026-11-19T09:00:00.000Z',
  lastRefreshAt: '2026-11-19T09:00:00.000Z',
};
const PERSONAL: Connection = { ...WORK, id: 'bbbbbbbb-2222-4222-8222-222222222222', label: 'Personal', accountEmail: 'person.b@example.test', accountName: null, capabilities: ['docs_read'], granted: ['docs_read'], defaultFor: [], status: 'paused', lastUsedAt: null };
const OUTLOOK: Connection = { ...WORK, id: 'cccccccc-3333-4333-8333-333333333333', provider: 'microsoft', label: 'Outlook', accountEmail: 'person.m@example.test', capabilities: ['calendar_read', 'calendar_write'], granted: ['calendar_read', 'calendar_write'], defaultFor: ['calendar'], lastUsedAt: '2026-11-17T09:00:00.000Z' };
const BROKEN: Connection = { ...WORK, id: 'dddddddd-4444-4444-8444-444444444444', label: 'Old account', accountEmail: 'person.c@example.test', capabilities: ['mail_read'], granted: ['mail_read'], defaultFor: [], status: 'needs_reconnect', statusReason: 'GRANT_REVOKED' };

const PROVIDERS: ProviderAvailability[] = [
  { provider: 'google', displayName: 'Google', ready: true, reason: null, accountTypes: [{ id: 'personal', label: 'Personal Gmail account', supported: true, note: 'Works while the project is published.' }, { id: 'workspace', label: 'Google Workspace account', supported: true, note: 'Your administrator may have to allow the app.' }] },
  { provider: 'microsoft', displayName: 'Microsoft', ready: false, reason: 'disabled', accountTypes: [{ id: 'work', label: 'Work or school account', supported: false, note: 'Not supported by this deployment.' }] },
];

const WRITE = ['connections:read', 'connections:write'];

function renderPage(responses: Record<string, unknown>, permissions: readonly string[] = WRITE, entry = '/settings/connections') {
  const host = createTestPlatformHost({
    permissions,
    responses: { 'GET /connections/providers': PROVIDERS, ...responses } as never,
  });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/settings/connections" element={<ConnectionsPage />} />
            <Route path="/admin/settings/connections" element={<AdminConnectionsPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}

let restore: (() => void) | null = null;
const assign = vi.fn();
beforeEach(() => {
  restore = mockViewport(1440);
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign } });
});
afterEach(() => {
  restore?.();
  restore = null;
  assign.mockReset();
  cleanup();
});

const row = (label: string) => screen.getByRole('listitem', { name: `Connection ${label}` });
const openMenu = async (label: string) => {
  fireEvent.click(within(row(label)).getByRole('button', { name: `Actions for ${label}` }));
  return screen.findByRole('menu');
};

describe('the words', () => {
  it('reads a group as read, or read and write', () => {
    expect(levelOf(['mail_read'], GROUPS[0]!)).toBe('read');
    expect(levelOf(['mail_read', 'mail_send'], GROUPS[0]!)).toBe('read and write');
    expect(levelOf(['calendar_read'], GROUPS[0]!)).toBeNull();
  });

  it('reads mail with the organize switch (archive, labels, drafts) as its own level', () => {
    expect(levelOf(['mail_read', 'mail_modify'], GROUPS[0]!)).toBe('read and organize');
    expect(levelOf(['mail_read', 'mail_send', 'mail_modify'], GROUPS[0]!)).toBe('read, send and organize');
    expect(levelOf(['calendar_read', 'calendar_write'], GROUPS[1]!)).toBe('read and write');
  });

  it('reads a test or diagnostic code from the remedy table the API and the CLI share (E50.10)', () => {
    expect(testCodeWords(null)).toBe('Works');
    expect(testCodeWords('FORBIDDEN')).toBe('The provider refused: the permission is missing');
    expect(testCodeWords('GRANT_REVOKED')).toBe('The access was withdrawn');
    expect(testCodeWords('NOT_A_CODE')).toBe('Failed');
    expect(remedyWords('RATE_LIMITED')).toMatch(/Try again in a minute/);
    expect(remedyWords(null)).toBeNull();
  });

  it('says what happened when the consent returns, from a closed set, naming what was not allowed', () => {
    expect(outcomeBanner('connected', 'Work', [])).toEqual({ severity: 'success', text: 'Connected Work.' });
    expect(outcomeBanner('connected', 'Work', ['calendar_read']).text).toMatch(/did not allow: Read calendar\. Those are off/);
    expect(outcomeBanner('denied', null, []).severity).toBe('info');
    // Each way a callback fails reads differently, so the owner (and the person helping) can tell them apart (#670).
    expect(outcomeBanner('state_invalid', null, []).text).toMatch(/no longer valid/);
    expect(outcomeBanner('binding_invalid', null, []).text).toMatch(/different browser or app/);
    expect(outcomeBanner('exchange_failed', null, []).text).toMatch(/client secret and redirect address/);
    expect(outcomeBanner('refused', null, []).text).toMatch(/refused the request/);
    expect(outcomeBanner('something_new', null, []).text).toMatch(/could not be completed/);
    const failures = ['state_invalid', 'binding_invalid', 'exchange_failed', 'refused', 'something_new'].map((o) => outcomeBanner(o, null, []).text);
    expect(new Set(failures).size).toBe(failures.length);
    expect(outcomeBanner('account_mismatch', null, []).text).toMatch(/different account/);
    // Told apart from a decline: an administrator's approval is needed (E39.4).
    expect(outcomeBanner('admin_consent_required', null, [])).toMatchObject({ severity: 'warning' });
    expect(outcomeBanner('admin_consent_required', null, []).text).toMatch(/administrator to approve/);
  });
});

describe('the list', () => {
  it('shows each account by provider: the label, the email, what it may do, its status, its defaults and its last use', async () => {
    renderPage({ 'GET /connections': [BROKEN, WORK, PERSONAL, OUTLOOK] });
    expect(await screen.findByRole('heading', { name: 'Connections and tools', level: 1 })).toBeInTheDocument();
    // Needs-reconnect first, then the three sections of E50.14 (Web search needs `web_search:read`); the rule is said once at the top.
    expect(screen.getByTestId('connections-rule')).toHaveTextContent('What is switched on here is available to the agent in every task and chat. Sending or changing something still asks you first.');
    const sections = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(sections).toEqual(['Needs reconnecting', 'Accounts', 'Added tools']);

    const work = within(row('Work'));
    expect(work.getByText('person.a@example.test · Person A')).toBeInTheDocument();
    expect(work.getByText('Mail: read and write')).toBeInTheDocument();
    expect(work.getByText('Calendar: read')).toBeInTheDocument();
    expect(work.queryByText(/Documents/)).not.toBeInTheDocument();
    expect(work.getByText('Active')).toBeInTheDocument();
    expect(work.getByText('Default for mail')).toBeInTheDocument();
    expect(work.getByText(/Last used/)).toBeInTheDocument();

    const personal = within(row('Personal'));
    expect(personal.getByText('Paused')).toBeInTheDocument();
    expect(personal.getByText('Documents: read')).toBeInTheDocument();
    expect(personal.getByText('Not used yet')).toBeInTheDocument();
    expect(personal.getByText(/no task, chat or delivery uses it until you resume it/)).toBeInTheDocument();

    expect(within(row('Outlook')).getByText('Calendar: read and write')).toBeInTheDocument();
    expect(within(row('Outlook')).getByText('Default for calendar')).toBeInTheDocument();

    const broken = within(row('Old account'));
    expect(broken.getByText('Needs reconnect')).toBeInTheDocument();
    expect(broken.getByText(/no longer accepts it .* Connect it again/)).toBeInTheDocument();
    expect(broken.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('never shows a token, a scope or anything else the API should not send', async () => {
    renderPage({ 'GET /connections': [{ ...WORK, accessToken: MARKER, refreshToken: MARKER, grantedScopes: [MARKER] }] });
    await screen.findByRole('listitem', { name: 'Connection Work' });
    expect(document.body.textContent).not.toContain(MARKER);
  });

  it('empty: says what a connection is, and that every task and chat can use what is switched on (E50.17)', async () => {
    renderPage({ 'GET /connections': [], 'GET /connections/mcp/status': { enabled: true, restricted: false } });
    expect(await screen.findByText('No accounts connected yet')).toBeInTheDocument();
    expect(screen.getByTestId('connections-rule')).toHaveTextContent('available to the agent in every task and chat');
    expect(screen.getByText('No tools added yet')).toBeInTheDocument();
    expect(screen.queryByText(/a task has to be told to/)).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Connect an account' }).length).toBeGreaterThan(0);
  });

  it('a viewer sees the list but cannot connect or change anything', async () => {
    renderPage({ 'GET /connections': [WORK, BROKEN] }, ['connections:read']);
    await screen.findByRole('listitem', { name: 'Connection Work' });
    expect(screen.queryByRole('button', { name: 'Connect an account' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
  });

  it('a failed load says so and offers Retry', async () => {
    renderPage({
      'GET /connections': () => {
        throw createTestApiError(500, 'The server failed');
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('The server failed');
  });

  it('coming back from the provider says what happened and names what was not allowed', async () => {
    renderPage({ 'GET /connections': [WORK] }, WRITE, `/settings/connections?connect=connected&connection=${WORK.id}&missing=calendar_write,docs_read`);
    expect(await screen.findByText(/Connected Work, but the provider did not allow: Change calendar, Read documents/)).toBeInTheDocument();
    cleanup();
    renderPage({ 'GET /connections': [] }, WRITE, '/settings/connections?connect=denied');
    expect(await screen.findByText(/You did not allow access, so nothing was connected/)).toBeInTheDocument();
  });
});

describe('connect an account', () => {
  it('chooses the provider, explains the account types first, ticks capabilities (write brings read), names it and goes to the provider in this tab', async () => {
    const host = renderPage({ 'GET /connections': [], 'POST /connections/authorize': { authorizeUrl: 'https://accounts.example.test/consent?x=1', expiresAt: '2026-11-19T10:00:00.000Z' } });
    fireEvent.click((await screen.findAllByRole('button', { name: 'Connect an account' }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Connect an account' });
    // the accounts that work, and the ones that do not, before anything starts
    expect(within(dialog).getByText('Accounts that work with Google')).toBeInTheDocument();
    expect(within(dialog).getByText(/Personal Gmail account/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Works while the project is published/)).toBeInTheDocument();
    // a provider the administrator has not switched on cannot be chosen, and says why
    expect(within(dialog).getByRole('radio', { name: /Microsoft/ })).toBeDisabled();
    expect(within(dialog).getByText(/Your administrator has not turned this on/)).toBeInTheDocument();
    // write brings read
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Documents: write' }));
    expect(within(dialog).getByRole('checkbox', { name: 'Documents: read' })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Documents: read' }));
    expect(within(dialog).getByRole('checkbox', { name: 'Documents: write' })).not.toBeChecked();
    // organizing mail (archive, labels, drafts) needs read too, and goes with it
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Mail: organize' }));
    expect(within(dialog).getByRole('checkbox', { name: 'Mail: read' })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Mail: read' }));
    expect(within(dialog).getByRole('checkbox', { name: 'Mail: organize' })).not.toBeChecked();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Mail: read' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Calendar: read' }));
    fireEvent.change(within(dialog).getByLabelText('Name (optional)'), { target: { value: 'Work' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue to Google' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.example.test/consent?x=1'));
    expect(host.requests.find((r) => r.path === '/connections/authorize')?.body).toEqual({ provider: 'google', capabilities: ['mail_read', 'calendar_read'], label: 'Work', returnTo: '/settings/connections' });
  });

  it('cannot start with nothing ticked', async () => {
    renderPage({ 'GET /connections': [] });
    fireEvent.click((await screen.findAllByRole('button', { name: 'Connect an account' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Mail: read' }));
    expect(within(dialog).getByRole('button', { name: 'Continue to Google' })).toBeDisabled();
  });

  it('a refusal (a taken name) is shown and nothing opens', async () => {
    renderPage({ 'GET /connections': [], 'POST /connections/authorize': () => {
        throw createTestApiError(409, 'You already have a connection with this name.', 'CONNECTION_LABEL_TAKEN');
      },
    });
    fireEvent.click((await screen.findAllByRole('button', { name: 'Connect an account' }))[0]!);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Continue to Google' }));
    expect(await screen.findByText('You already have a connection with this name.')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('Reconnect starts the flow for the same account, with it as the login hint', async () => {
    const host = renderPage({ 'GET /connections': [BROKEN], 'POST /connections/authorize': { authorizeUrl: 'https://accounts.example.test/consent?r=1', expiresAt: 'x' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.example.test/consent?r=1'));
    expect(host.requests.find((r) => r.path === '/connections/authorize')?.body).toEqual({ provider: 'google', capabilities: ['mail_read'], loginHint: 'person.c@example.test', returnTo: '/settings/connections' });
  });
});

describe('change what it can do', () => {
  it('turning one off is immediate and says the permission stays granted at the provider', async () => {
    const host = renderPage({ 'GET /connections': [WORK], [`PATCH /connections/${WORK.id}`]: { connection: { ...WORK, capabilities: ['mail_read', 'calendar_read'] }, consent: null } });
    await screen.findByRole('listitem', { name: 'Connection Work' });
    fireEvent.click(within(await openMenu('Work')).getByRole('menuitem', { name: 'Change what it can do' }));
    const dialog = await screen.findByRole('dialog', { name: 'What Work can do' });
    expect(within(dialog).getByRole('checkbox', { name: 'Mail: send' })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Mail: send' }));
    expect(within(dialog).getByText(/Turning off send mail takes effect now. Google keeps the permission/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(host.requests.find((r) => r.method === 'PATCH')?.body).toEqual({ capabilities: ['mail_read', 'calendar_read'], returnTo: '/settings/connections' });
    expect(assign).not.toHaveBeenCalled();
  });

  it('adding one the provider has not granted warns, and goes to the provider for just that permission', async () => {
    const host = renderPage({ 'GET /connections': [WORK], [`PATCH /connections/${WORK.id}`]: { connection: WORK, consent: { authorizeUrl: 'https://accounts.example.test/consent?inc=1', expiresAt: 'x' } } });
    await screen.findByRole('listitem', { name: 'Connection Work' });
    fireEvent.click(within(await openMenu('Work')).getByRole('menuitem', { name: 'Change what it can do' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Documents: read' }));
    expect(within(dialog).getByText(/Google will ask you to allow read documents/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save and continue to Google' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.example.test/consent?inc=1'));
    expect(host.requests.find((r) => r.method === 'PATCH')?.body).toMatchObject({ capabilities: ['mail_read', 'mail_send', 'calendar_read', 'docs_read'] });
  });

  it('switching on one the provider already granted needs no consent', async () => {
    renderPage({ 'GET /connections': [{ ...WORK, capabilities: ['mail_read'], granted: ['mail_read', 'mail_send', 'calendar_read'] }] });
    await screen.findByRole('listitem', { name: 'Connection Work' });
    fireEvent.click(within(await openMenu('Work')).getByRole('menuitem', { name: 'Change what it can do' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Mail: send' }));
    expect(within(dialog).queryByText(/will ask you to allow/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});

describe('defaults, rename, pause, test', () => {
  it('makes an account the default for an area, offering only the areas that are switched on', async () => {
    const host = renderPage({ 'GET /connections': [WORK], [`PATCH /connections/${WORK.id}`]: { connection: { ...WORK, defaultFor: ['mail', 'calendar'] }, consent: null } });
    await screen.findByRole('listitem', { name: 'Connection Work' });
    fireEvent.click(within(await openMenu('Work')).getByRole('menuitem', { name: 'Make default for…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Make Work the default for…' });
    expect(within(dialog).getByRole('checkbox', { name: /Documents/ })).toBeDisabled();
    expect(within(dialog).getByRole('checkbox', { name: 'Mail' })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Calendar' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(host.requests.find((r) => r.method === 'PATCH')?.body).toEqual({ defaultFor: ['mail', 'calendar'] }));
  });

  it('renames, and shows a taken name', async () => {
    const host = renderPage({ 'GET /connections': [WORK], [`PATCH /connections/${WORK.id}`]: { connection: { ...WORK, label: 'Office' }, consent: null } });
    await screen.findByRole('listitem', { name: 'Connection Work' });
    fireEvent.click(within(await openMenu('Work')).getByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename' });
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Office' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(host.requests.find((r) => r.method === 'PATCH')?.body).toEqual({ label: 'Office' }));
  });

  it('pauses an active account and resumes a paused one', async () => {
    const host = renderPage({ 'GET /connections': [WORK, PERSONAL], [`POST /connections/${WORK.id}/pause`]: { ...WORK, status: 'paused' }, [`POST /connections/${PERSONAL.id}/resume`]: { ...PERSONAL, status: 'active' } });
    await screen.findByRole('listitem', { name: 'Connection Work' });
    fireEvent.click(within(await openMenu('Work')).getByRole('menuitem', { name: 'Pause' }));
    await waitFor(() => expect(host.requests.some((r) => r.path === `/connections/${WORK.id}/pause`)).toBe(true));
    fireEvent.click(within(await openMenu('Personal')).getByRole('menuitem', { name: 'Resume' }));
    await waitFor(() => expect(host.requests.some((r) => r.path === `/connections/${PERSONAL.id}/resume`)).toBe(true));
  });

  it('Test is a visible button on an active row: it opens the panel with each capability as it fared, and the chip follows', async () => {
    const report = { id: 'r1', target: { kind: 'connection', id: WORK.id }, trigger: 'owner', overall: 'fail', startedAt: '2026-11-26T10:00:00.000Z', finishedAt: '2026-11-26T10:00:01.000Z', stages: [{ id: 'sign_in', status: 'pass', code: null, remedy: null, ms: 120 }, { id: 'capability:mail_read', status: 'pass', code: null, remedy: null, ms: 80 }, { id: 'capability:calendar_read', status: 'fail', code: 'FORBIDDEN', remedy: 'FORBIDDEN', ms: 90 }] };
    let summary: unknown[] = [];
    const host = renderPage({
      'GET /connections': [WORK, PERSONAL],
      'GET /connections/diagnostics/summary': () => summary,
      [`POST /connections/${WORK.id}/diagnose`]: () => {
        summary = [{ targetId: WORK.id, overall: 'fail', at: report.finishedAt }];
        return report;
      },
      [`GET /connections/${WORK.id}/diagnostics`]: [],
    });
    await screen.findByRole('listitem', { name: 'Connection Work' });
    expect(within(row('Work')).getByTestId('health-chip')).toHaveTextContent('Not checked yet');
    // Not in the menu any more; not on a paused row.
    expect(within(row('Personal')).queryByRole('button', { name: 'Test Personal' })).not.toBeInTheDocument();
    fireEvent.click(within(row('Work')).getByRole('button', { name: 'Test Work' }));
    const dialog = await screen.findByRole('dialog', { name: 'Test of Work' });
    const steps = within(await within(dialog).findByRole('list', { name: 'Steps of the test' }));
    expect(await steps.findByText('Read calendar')).toBeInTheDocument();
    expect(steps.getByText('Read mail')).toBeInTheDocument();
    expect(within(dialog).getByTestId('diagnostics-summary')).toHaveTextContent('The provider refused: the permission is missing');
    expect(host.requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual([`/connections/${WORK.id}/diagnose`]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(within(row('Work')).getByTestId('health-chip')).toHaveTextContent(/^Problem · checked/));
  });

  it('on a phone, Test is an icon button with a name', async () => {
    restore?.();
    restore = mockViewport(390);
    renderPage({ 'GET /connections': [WORK] });
    await screen.findByRole('listitem', { name: 'Connection Work' });
    const test = within(row('Work')).getByRole('button', { name: 'Test Work' });
    expect(test.textContent).toBe('');
  });

  it('a row has one switch: on is active, off is paused', async () => {
    const host = renderPage({ 'GET /connections': [WORK, PERSONAL], [`POST /connections/${WORK.id}/pause`]: { ...WORK, status: 'paused' } });
    await screen.findByRole('listitem', { name: 'Connection Work' });
    expect(within(row('Personal')).getByRole('switch', { name: 'Personal switched on' })).not.toBeChecked();
    fireEvent.click(within(row('Work')).getByRole('switch', { name: 'Work switched on' }));
    await waitFor(() => expect(host.requests.some((r) => r.path === `/connections/${WORK.id}/pause`)).toBe(true));
  });

  it('offers Test only while active, no switch while it needs reconnecting, and Change and Make default not while it needs reconnecting', async () => {
    renderPage({ 'GET /connections': [BROKEN, PERSONAL] });
    await screen.findByRole('listitem', { name: 'Connection Old account' });
    expect(within(row('Old account')).queryByRole('button', { name: 'Test Old account' })).not.toBeInTheDocument();
    expect(within(row('Old account')).queryByRole('switch')).not.toBeInTheDocument();
    const broken = within(await openMenu('Old account'));
    expect(broken.queryByRole('menuitem', { name: 'Change what it can do' })).not.toBeInTheDocument();
    expect(broken.getByRole('menuitem', { name: 'Disconnect' })).toBeInTheDocument();
    fireEvent.keyDown(broken.getByRole('menuitem', { name: 'Rename' }), { key: 'Escape' });
  });
});

describe('disconnect', () => {
  const USED = { ...WORK, usedBy: [{ kind: 'task', id: 't1', name: 'Pay the car loan' }, { kind: 'task', id: 't2', name: 'Monthly report' }] };

  it('asks first, lists the tasks that use the account, then disconnects', async () => {
    const host = renderPage({ 'GET /connections': [WORK], [`GET /connections/${WORK.id}`]: USED, [`DELETE /connections/${WORK.id}`]: { revoked: true, clearedReferences: 2 } });
    await screen.findByRole('listitem', { name: 'Connection Work' });
    fireEvent.click(within(await openMenu('Work')).getByRole('menuitem', { name: 'Disconnect' }));
    const ask = await screen.findByRole('dialog', { name: 'Disconnect Work?' });
    expect(within(ask).getByText(/revokes its access at Google and deletes the saved sign-in/)).toBeInTheDocument();
    expect(within(ask).getByText('Pay the car loan')).toBeInTheDocument();
    expect(within(ask).getByText('Monthly report')).toBeInTheDocument();
    fireEvent.click(within(ask).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(host.requests.some((r) => r.method === 'DELETE' && r.path === `/connections/${WORK.id}`)).toBe(true));
  });

  it('says when nothing uses it, and Cancel disconnects nothing', async () => {
    const host = renderPage({ 'GET /connections': [WORK], [`GET /connections/${WORK.id}`]: { ...WORK, usedBy: [] } });
    await screen.findByRole('listitem', { name: 'Connection Work' });
    fireEvent.click(within(await openMenu('Work')).getByRole('menuitem', { name: 'Disconnect' }));
    const ask = await screen.findByRole('dialog');
    expect(within(ask).getByText('No task or chat uses it.')).toBeInTheDocument();
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(host.requests.some((r) => r.method === 'DELETE')).toBe(false);
  });
});

describe('the avatar menu', () => {
  const menu = (permissions: string[]) => {
    const host = createTestPlatformHost({ permissions });
    render(
      <PlatformHostProvider host={host}>
        <MemoryRouter>
          <MenuList>
            <ConnectionsMenuItem onDone={() => undefined} />
          </MenuList>
        </MemoryRouter>
      </PlatformHostProvider>,
    );
  };
  it('links to the page for a viewer who may read their connections, and shows nothing otherwise', () => {
    menu(['connections:read']);
    expect(screen.getByRole('menuitem', { name: 'Connections' })).toHaveAttribute('href', '/settings/connections');
    cleanup();
    menu([]);
    expect(screen.queryByRole('menuitem', { name: 'Connections' })).not.toBeInTheDocument();
  });
});

describe('the administrator page', () => {
  const GOOGLE: AdminProvider = {
    provider: 'google',
    displayName: 'Google',
    enabled: true,
    clientId: 'google-client-id',
    hasClientSecret: true,
    tenant: null,
    installed: true,
    redirectUri: 'https://console.example.test/api/connections/callback/google',
    setupSteps: ['Create a project at Google.', 'Add the redirect URI shown on this page.'],
    accountTypes: [],
  };
  const MICROSOFT: AdminProvider = { ...GOOGLE, provider: 'microsoft', displayName: 'Microsoft', enabled: false, clientId: null, hasClientSecret: false, tenant: 'common', installed: false, redirectUri: 'https://console.example.test/api/connections/callback/microsoft', setupSteps: ['Register an application.'] };
  const ADMIN = ['system_settings:read', 'system_settings:write'];
  const page = (permissions: readonly string[] = ADMIN, extra: Record<string, unknown> = {}) => renderPage({ 'GET /connections/admin/apps': [GOOGLE, MICROSOFT], ...extra }, permissions, '/admin/settings/connections');
  const card = (name: string) => screen.getByRole('region', { name });

  it('shows each provider\'s checklist, the redirect URI to copy, the client id and whether a secret is stored: never the secret', async () => {
    page();
    expect(await screen.findByRole('heading', { name: 'Google', level: 2 })).toBeInTheDocument();
    const g = within(card('Google'));
    expect(g.getByText('Create a project at Google.')).toBeInTheDocument();
    expect(g.getByLabelText('Redirect address')).toHaveValue('https://console.example.test/api/connections/callback/google');
    expect(g.getByRole('button', { name: 'Copy the Google redirect address' })).toBeInTheDocument();
    expect(g.getByLabelText('Client ID')).toHaveValue('google-client-id');
    expect(g.getByLabelText('Client secret')).toHaveValue('');
    expect(g.getByText(/A secret is stored/)).toBeInTheDocument();
    const m = within(card('Microsoft'));
    expect(m.getByLabelText('Tenant')).toHaveValue('common');
    expect(m.getByText(/not installed on this deployment yet/)).toBeInTheDocument();
    expect(m.getByRole('switch', { name: /Let users connect Microsoft/ })).toBeDisabled();
    expect(screen.queryByText(/connection/i, { selector: 'li' })).not.toBeInTheDocument();
  });

  it('saves without the secret when it is left blank, and sends a new one write-only', async () => {
    const host = page(ADMIN, { 'PUT /connections/admin/apps/google': [GOOGLE, MICROSOFT] });
    const g = within(await screen.findByRole('region', { name: 'Google' }));
    fireEvent.change(g.getByLabelText('Client ID'), { target: { value: 'new-client-id' } });
    fireEvent.click(g.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(host.requests.find((r) => r.method === 'PUT')?.body).toEqual({ enabled: true, clientId: 'new-client-id' }));
    // Save is disabled while the first save is in flight: wait for it to settle before saving again.
    await waitFor(() => expect(g.getByRole('button', { name: 'Save' })).toBeEnabled());
    fireEvent.change(g.getByLabelText('Client secret'), { target: { value: 'a-new-secret' } });
    fireEvent.click(g.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(host.requests.filter((r) => r.method === 'PUT').at(-1)?.body).toEqual({ enabled: true, clientId: 'new-client-id', clientSecret: 'a-new-secret' }));
  });

  it('removes an app only after asking', async () => {
    const host = page(ADMIN, { 'DELETE /connections/admin/apps/google': [{ ...GOOGLE, enabled: false, clientId: null, hasClientSecret: false }, MICROSOFT] });
    fireEvent.click(within(await screen.findByRole('region', { name: 'Google' })).getByRole('button', { name: 'Remove the app' }));
    const ask = await screen.findByRole('dialog', { name: 'Remove the Google app?' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(host.requests.some((r) => r.method === 'DELETE')).toBe(true));
  });

  it('a reader sees the settings and cannot change them; the page never asks for a user\'s connections', async () => {
    const host = page(['system_settings:read']);
    const g = within(await screen.findByRole('region', { name: 'Google' }));
    expect(g.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(g.getByLabelText('Client ID')).toBeDisabled();
    expect(host.requests.every((r) => r.path.startsWith('/connections/admin/'))).toBe(true);
  });
});

describe('E50.14: Connections and tools', () => {
  afterEach(() => {
    try {
      window.localStorage.clear();
    } catch {
      // no storage
    }
  });

  it('has three sections with their own button and empty state; web search shows with its permission', async () => {
    renderPage({ 'GET /connections': [], 'GET /connections/mcp/status': { enabled: true, restricted: false }, 'GET /web-search/status': { enabled: false, reason: 'no_key', provider: null, today: { calls: 0, limit: null, remaining: null }, perRunLimit: null }, 'GET /web-search/providers': [], 'GET /user-settings': {} }, [...WRITE, 'web_search:read']);
    await screen.findByText('No accounts connected yet');
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Accounts', 'Added tools', 'Web search']);
    expect(within(screen.getByRole('region', { name: 'Added tools' })).getByText('MCP servers')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Added tools' })).getByRole('button', { name: 'Add a tool' })).toBeInTheDocument();
    expect(await screen.findByText(/No key is set that your searches may use/)).toBeInTheDocument();
  });

  it('with added tools switched off, says the administrator must switch them on, with the link for an administrator', async () => {
    renderPage({ 'GET /connections': [] }, [...WRITE, 'system_settings:read']);
    const tools = within(await screen.findByRole('region', { name: 'Added tools' }));
    expect(tools.getByText('Added tools are switched off here')).toBeInTheDocument();
    expect(tools.queryByRole('button', { name: 'Add a tool' })).toBeNull();
    expect(tools.getByRole('link', { name: "Open the administrator's Connections settings" })).toHaveAttribute('href', '/admin/settings/connections');
    cleanup();
    renderPage({ 'GET /connections': [] });
    expect(within(await screen.findByRole('region', { name: 'Added tools' })).queryByRole('link')).toBeNull();
  });

  it('shows the Google checklist before the first Google account, once, and it can be dismissed (#681)', async () => {
    renderPage({ 'GET /connections': [] });
    fireEvent.click((await screen.findAllByRole('button', { name: 'Connect an account' }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Connect an account' });
    const list = within(dialog).getByTestId('google-checklist');
    expect(list).toHaveTextContent('Gmail API (mail)');
    expect(list).toHaveTextContent('Google Drive API, Google Docs API and Google Sheets API (documents)');
    fireEvent.click(within(list).getByRole('button', { name: 'Close' }));
    expect(within(dialog).queryByTestId('google-checklist')).toBeNull();
    cleanup();
    renderPage({ 'GET /connections': [] });
    fireEvent.click((await screen.findAllByRole('button', { name: 'Connect an account' }))[0]!);
    expect(within(await screen.findByRole('dialog', { name: 'Connect an account' })).queryByTestId('google-checklist')).toBeNull();
  });

  it('no checklist once a Google account is connected', async () => {
    renderPage({ 'GET /connections': [WORK] });
    await screen.findByRole('listitem', { name: 'Connection Work' });
    fireEvent.click(screen.getByRole('button', { name: 'Connect an account' }));
    expect(within(await screen.findByRole('dialog', { name: 'Connect an account' })).queryByTestId('google-checklist')).toBeNull();
  });

  it('the administrator tests the app setup in the same panel', async () => {
    const apps: AdminProvider[] = [{ provider: 'google', displayName: 'Google', enabled: true, clientId: 'id.apps.example.test', hasClientSecret: true, tenant: null, installed: true, redirectUri: 'https://console.example.test/api/connections/callback/google', setupSteps: [], accountTypes: [] }];
    const host = renderPage({ 'GET /connections/admin/apps': apps, 'POST /connections/admin/apps/google/diagnose': { id: 'r', target: { kind: 'provider_app', id: 'google' }, trigger: 'admin', overall: 'warn', startedAt: '2026-11-26T10:00:00Z', finishedAt: '2026-11-26T10:00:01Z', stages: [{ id: 'picker_key', status: 'warn', code: 'PICKER_KEY_MISSING', remedy: 'PICKER_KEY_MISSING', ms: 0 }] }, 'GET /connections/admin/apps/google/diagnostics': [] }, ['system_settings:read', 'system_settings:write'], '/admin/settings/connections');
    fireEvent.click(await screen.findByRole('button', { name: 'Test app setup' }));
    const dialog = await screen.findByRole('dialog', { name: 'Test of the Google app' });
    expect(await within(dialog).findByText('File picker key')).toBeInTheDocument();
    expect(host.requests.some((r) => r.method === 'POST' && r.path === '/connections/admin/apps/google/diagnose')).toBe(true);
  });

  it('the page has no serious accessibility finding', async () => {
    renderPage({ 'GET /connections': [BROKEN, WORK, PERSONAL, OUTLOOK] });
    await screen.findByRole('listitem', { name: 'Connection Work' });
    expect(await seriousFindings(document.body)).toEqual([]);
  });
});

describe('web steps on the run page', () => {
  it('reads a search and a page read, and counts them', () => {
    expect(webStepLine({ kind: 'action', action: 'web_search', args: { query: 'opening hours' }, summary: 'searched the web for "opening hours" (5 results, brave)', ok: true })).toEqual({ primary: 'Searched the web for “opening hours”', secondary: '5 results · brave' });
    expect(webStepLine({ kind: 'action', action: 'web_fetch', args: { url: 'https://docs.example.test/a?b=1' }, summary: 'docs.example.test', ok: true })).toEqual({ primary: 'Read docs.example.test', secondary: null });
    expect(webStepLine({ kind: 'action', action: 'web_search', args: { query: 'x' }, summary: 'web search failed (RATE_LIMITED)', ok: false }).primary).toBe('Searched the web for “x” (failed)');
    expect(webCountWords([{ kind: 'action', action: 'web_search' }, { kind: 'action', action: 'web_search' }, { kind: 'action', action: 'web_fetch' }])).toBe('2 web searches · 1 page read');
    expect(webCountWords([{ kind: 'action', action: 'click' }])).toBeNull();
  });
});

describe('E50.14: changed tools', () => {
  it('a banner names the added tool whose tools are new or changed, and links to the review', async () => {
    const NOTES: Connection = { ...WORK, id: 'eeeeeeee-5555-4555-8555-555555555555', provider: 'mcp', label: 'Notes', accountEmail: 'mcp.example.test', capabilities: [], granted: [], defaultFor: [], mcp: { url: 'https://mcp.example.test/mcp', auth: 'none', serverName: null, tools: { total: 3, enabled: 1, needsReview: 2 }, toolsFetchedAt: null } };
    renderPage({ 'GET /connections': [NOTES], 'GET /connections/mcp/status': { enabled: true, restricted: false }, [`GET /connections/${NOTES.id}/tools`]: { tools: [], needsReview: 2, fetchedAt: null } });
    const banner = await screen.findByTestId('tools-to-review');
    expect(banner).toHaveTextContent('Notes: 2 tools are new or changed. They stay off until you choose.');
    fireEvent.click(within(banner).getByRole('button', { name: 'Review the tools of Notes' }));
    expect(await screen.findByRole('dialog', { name: 'Tools of Notes' })).toBeInTheDocument();
  });
});
