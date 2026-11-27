// The diagnostics panel (E50.14, #984): one component for a connection, a provider app and a search provider. Each state (running,
// pass, warn, fail, skipped), the first failure open with its remedy and who must act, history, Copy report (no label, address or host
// unless ticked), the live region, the Google API named with its console link (#681), and an axe pass with no serious finding.
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

import { DiagnosticsPanel } from '../diagnostics/DiagnosticsPanel';
import type { DiagnosticReport, DiagnosticTarget } from '../diagnostics/api';
import { reportText } from '../diagnostics/report';
import { expectedStages, facts, summarySentence } from '../diagnostics/words';
import { healthWords } from '../diagnostics/HealthChip';
import { ConfirmProvider, ToastHost } from '../ui';
import { seriousFindings } from './axe';
import { mockViewport } from './matchMedia';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const CONNECTION: DiagnosticTarget = { kind: 'connection', id: ID, provider: 'google', capabilities: ['mail_read', 'docs_read'], name: 'Work account', host: null };
const MCP: DiagnosticTarget = { kind: 'connection', id: ID, provider: 'mcp', capabilities: [], name: 'My notes', host: 'notes.private.example.test' };

const at = (s: number) => new Date(Date.UTC(2026, 10, 26, 10, 0, s)).toISOString();
const report = (overall: DiagnosticReport['overall'], stages: DiagnosticReport['stages'], id = 'r-1', target: DiagnosticReport['target'] = { kind: 'connection', id: ID }): DiagnosticReport => ({ id, target, trigger: 'owner', overall, startedAt: at(0), finishedAt: at(2), stages });

const PASS = report('pass', [
  { id: 'status', status: 'pass', code: null, remedy: null, ms: 1 },
  { id: 'sign_in', status: 'pass', code: null, remedy: null, ms: 120 },
  { id: 'capability:mail_read', status: 'pass', code: null, remedy: null, ms: 80 },
]);
const WARN = report('warn', [
  { id: 'status', status: 'pass', code: null, remedy: null, ms: 1 },
  { id: 'latency', status: 'warn', code: 'SLOW', remedy: 'SLOW', ms: 9100 },
]);
const FAIL = report('fail', [
  { id: 'status', status: 'pass', code: null, remedy: null, ms: 1 },
  { id: 'sign_in', status: 'pass', code: null, remedy: null, ms: 120 },
  { id: 'capability:mail_read', status: 'pass', code: null, remedy: null, ms: 80 },
  { id: 'capability:docs_read', status: 'fail', code: 'API_DISABLED', remedy: 'API_DISABLED_DRIVE', ms: 90, data: { api: 'drive.googleapis.com' } },
  { id: 'clock', status: 'skipped', code: null, remedy: null, ms: null },
]);
const SKIPPED = report('skipped', [{ id: 'status', status: 'skipped', code: null, remedy: null, ms: null }]);

function mount(target: DiagnosticTarget | null, responses: Record<string, unknown>, props: Partial<Parameters<typeof DiagnosticsPanel>[0]> = {}) {
  const host = createTestPlatformHost({ permissions: ['connections:read', 'connections:write'], responses: responses as never });
  function Harness() {
    const [t, setT] = useState<DiagnosticTarget | null>(target);
    return (
      <>
        <button type="button" onClick={() => setT(target ?? CONNECTION)}>
          Open the panel
        </button>
        <DiagnosticsPanel target={t} onClose={() => setT(null)} {...props} />
      </>
    );
  }
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter>
          <Harness />
          <ToastHost />
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}

let restore: (() => void) | null = null;
beforeEach(() => {
  restore = mockViewport(1440);
});
afterEach(() => {
  restore?.();
  restore = null;
  cleanup();
});

const steps = async () => within(await screen.findByRole('list', { name: 'Steps of the test' }));

describe('the words', () => {
  it('lists the expected stages of each kind of target', () => {
    expect(expectedStages(CONNECTION)).toEqual(['status', 'provider_installed', 'app_config', 'sign_in', 'token_lifetime', 'permissions', 'capability:mail_read', 'capability:docs_read', 'clock', 'latency']);
    expect(expectedStages({ kind: 'provider_app', provider: 'google', name: 'g' })).toContain('redirect_uri');
    expect(expectedStages({ kind: 'search_provider', id: 'brave', scope: 'user', name: 'Brave' })).toEqual(['switches', 'credential', 'network', 'live_query', 'limits', 'fetch']);
  });

  it('shows data as small facts and says in one sentence what is wrong and what to do', () => {
    expect(facts({ data: { api: 'gmail.googleapis.com', changed: 3 }, ms: 1200 })).toEqual(['Gmail API', '3 tools changed', '1.2 s']);
    expect(summarySentence(FAIL)).toMatch(/^The Google Drive API is not enabled\. In the Google Cloud project/);
    expect(summarySentence(PASS)).toBe('Everything works.');
    expect(summarySentence(WARN)).toMatch(/^It works, but: /);
    expect(summarySentence(SKIPPED)).toBe('Nothing could be checked.');
    expect(healthWords(null)).toBe('Not checked yet');
    expect(healthWords({ overall: 'fail', at: at(0) }, Date.parse(at(0)) + 2 * 3_600_000)).toMatch(/^Problem · checked 2 h/);
  });

  it('copies codes and statuses with the version, never a label, an address or a host unless asked', () => {
    const r = report('fail', [{ id: 'server', status: 'fail', code: 'UNAVAILABLE', remedy: 'UNAVAILABLE', ms: 300, data: { host: 'notes.private.example.test' } }]);
    const text = reportText(r, MCP, { version: '9.9.9' });
    expect(text).toContain('Target: connection');
    expect(text).toContain('Provider: mcp');
    expect(text).toContain('Console version: 9.9.9');
    expect(text).toContain('- server: fail UNAVAILABLE (300 ms)');
    expect(text).not.toContain('My notes');
    expect(text).not.toContain('notes.private.example.test');
    expect(reportText(r, MCP, { includeHost: true })).toContain('notes.private.example.test');
  });
});

describe('the panel', () => {
  it('running: the expected stages in order, a spinner on the current one; then the report fills them in and is announced', async () => {
    let finish: (r: DiagnosticReport) => void = () => undefined;
    mount(CONNECTION, { [`POST /connections/${ID}/diagnose`]: () => new Promise<DiagnosticReport>((r) => (finish = r)), [`GET /connections/${ID}/diagnostics`]: [] });
    const list = await steps();
    const items = list.getAllByRole('listitem');
    expect(items.map((i) => i.getAttribute('data-testid'))).toEqual(expectedStages(CONNECTION).map((id) => `stage-${id}`));
    expect(items[0]).toHaveAttribute('data-status', 'running');
    expect(items[1]).toHaveAttribute('data-status', 'waiting');
    expect(screen.getByRole('button', { name: 'Run a test' })).toBeDisabled();
    finish(PASS);
    expect(await screen.findByTestId('diagnostics-summary')).toHaveTextContent('Everything works.');
    await waitFor(() => expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('Finished: Working. Everything works.'));
  });

  it('pass: every stage passed, nothing is open', async () => {
    mount(CONNECTION, { [`POST /connections/${ID}/diagnose`]: PASS, [`GET /connections/${ID}/diagnostics`]: [] });
    const list = await steps();
    await list.findByText('Read mail');
    expect(list.getAllByText('Passed')).toHaveLength(3);
    expect(list.getAllByRole('button', { expanded: false })).toHaveLength(3);
  });

  it('warn: the warning is open and says it works', async () => {
    mount(CONNECTION, { [`POST /connections/${ID}/diagnose`]: WARN, [`GET /connections/${ID}/diagnostics`]: [] });
    const list = await steps();
    expect(await list.findByRole('button', { name: /Time taken/, expanded: true })).toBeInTheDocument();
    expect(screen.getByTestId('diagnostics-summary')).toHaveTextContent('It works, but:');
    expect(list.getByText('9.1 s')).toBeInTheDocument();
  });

  it('fail: the first failure is open with the remedy, who must act, the API named and, for an administrator, the console link (#681)', async () => {
    mount(CONNECTION, { [`POST /connections/${ID}/diagnose`]: FAIL, [`GET /connections/${ID}/diagnostics`]: [] }, { actions: { provider: 'google', canAdmin: true } });
    const list = await steps();
    const failed = await list.findByTestId('stage-capability:docs_read');
    expect(within(failed).getByRole('button', { expanded: true })).toBeInTheDocument();
    expect(within(failed).getByText('The Google Drive API is not enabled')).toBeInTheDocument();
    expect(within(failed).getByText('Who can fix it: Your administrator')).toBeInTheDocument();
    expect(within(failed).getByText('Google Drive API')).toBeInTheDocument();
    const link = within(failed).getByRole('link', { name: 'Open the Google Cloud console' });
    expect(link).toHaveAttribute('href', 'https://console.cloud.google.com/apis/library/drive.googleapis.com');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(list.getByTestId('stage-clock')).toHaveAttribute('data-status', 'skipped');
    expect(list.getByText('Skipped')).toBeInTheDocument();
    expect(screen.getByTestId('diagnostics-summary')).toHaveTextContent('Problem');
  });

  it('fail for an owner: no console link, and Reconnect when a new sign-in fixes it', async () => {
    const onReconnect = vi.fn();
    const revoked = report('fail', [{ id: 'sign_in', status: 'fail', code: 'GRANT_REVOKED', remedy: 'GRANT_REVOKED', ms: 50 }]);
    mount(CONNECTION, { [`POST /connections/${ID}/diagnose`]: revoked, [`GET /connections/${ID}/diagnostics`]: [] }, { actions: { provider: 'google', onReconnect } });
    const list = await steps();
    fireEvent.click(await list.findByRole('button', { name: 'Reconnect' }));
    expect(onReconnect).toHaveBeenCalled();
    expect(list.queryByRole('link')).toBeNull();
    expect(list.getByText('Who can fix it: You')).toBeInTheDocument();
  });

  it('skipped: says nothing could be checked', async () => {
    mount(CONNECTION, { [`POST /connections/${ID}/diagnose`]: SKIPPED, [`GET /connections/${ID}/diagnostics`]: [] });
    expect(await screen.findByTestId('diagnostics-summary')).toHaveTextContent('Nothing could be checked.');
  });

  it('a failed request is shown as an error and can be run again', async () => {
    let n = 0;
    mount(CONNECTION, {
      [`POST /connections/${ID}/diagnose`]: () => {
        n += 1;
        if (n === 1) throw new Error('Too many tests: wait a minute');
        return PASS;
      },
      [`GET /connections/${ID}/diagnostics`]: [],
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many tests: wait a minute');
    fireEvent.click(screen.getByRole('button', { name: 'Run again' }));
    expect(await screen.findByTestId('diagnostics-summary')).toHaveTextContent('Everything works.');
  });

  it('history: the last reports with their status; choosing one shows it', async () => {
    const old = report('fail', [{ id: 'sign_in', status: 'fail', code: 'GRANT_REVOKED', remedy: 'GRANT_REVOKED', ms: 50 }], 'r-old');
    const fresh = { ...PASS, id: 'r-new' };
    mount(CONNECTION, { [`POST /connections/${ID}/diagnose`]: fresh, [`GET /connections/${ID}/diagnostics`]: [fresh, old] });
    await screen.findByTestId('diagnostics-summary');
    await waitFor(() => expect(screen.getByRole('button', { name: 'History' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    const past = within(screen.getByRole('list', { name: 'Last reports' }));
    expect(past.getAllByRole('button').map((b) => /^(Working|Problem)/.exec(b.textContent ?? '')?.[1])).toEqual(['Working', 'Problem']);
    fireEvent.click(past.getByText('Problem'));
    expect(await screen.findByText('You are looking at an earlier report.')).toBeInTheDocument();
    expect(screen.getByTestId('diagnostics-summary')).toHaveTextContent('The access was withdrawn');
  });

  it('opened without running, it shows the last report', async () => {
    mount(CONNECTION, { [`GET /connections/${ID}/diagnostics`]: [FAIL] }, { runOnOpen: false });
    expect(await screen.findByTestId('diagnostics-summary')).toHaveTextContent('Problem');
  });

  it('copy: the report as plain text, the server address only when ticked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const r = report('fail', [{ id: 'server', status: 'fail', code: 'UNAVAILABLE', remedy: 'UNAVAILABLE', ms: 300 }]);
    mount(MCP, { [`POST /connections/${ID}/diagnose`]: r, [`GET /connections/${ID}/diagnostics`]: [] });
    await screen.findByTestId('diagnostics-summary');
    fireEvent.click(screen.getByRole('button', { name: 'Copy report' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0]).toContain('- server: fail UNAVAILABLE');
    expect(writeText.mock.calls[0]![0]).not.toContain('notes.private.example.test');
    expect(writeText.mock.calls[0]![0]).not.toContain('My notes');
    fireEvent.click(screen.getByRole('checkbox', { name: "Include the server's address in the copied report" }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy report' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText.mock.calls[1]![0]).toContain('Server address: notes.private.example.test');
  });

  it('renders text from a report as text, never as markup', async () => {
    const r = report('fail', [{ id: 'server', status: 'fail', code: 'UNAVAILABLE', remedy: null, ms: 1, data: { note: '<img src=x onerror=alert(1)>' } }]);
    mount(MCP, { [`POST /connections/${ID}/diagnose`]: r, [`GET /connections/${ID}/diagnostics`]: [] });
    await screen.findByTestId('diagnostics-summary');
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  it('serves a provider app and a search provider with the same component and their own routes', async () => {
    const host = mount({ kind: 'provider_app', provider: 'google', name: 'the Google app' }, { 'POST /connections/admin/apps/google/diagnose': PASS, 'GET /connections/admin/apps/google/diagnostics': [] });
    expect(await screen.findByRole('dialog', { name: 'Test of the Google app' })).toBeInTheDocument();
    await screen.findByTestId('diagnostics-summary');
    expect(host.requests.map((r) => `${r.method} ${r.path}`)).toContain('POST /connections/admin/apps/google/diagnose');
    cleanup();
    const user = mount({ kind: 'search_provider', id: 'brave', scope: 'user', name: 'Brave Search' }, { 'POST /web-search/diagnose?provider=brave': PASS, 'GET /web-search/diagnostics?limit=20': [] });
    await screen.findByTestId('diagnostics-summary');
    expect(user.requests.map((r) => `${r.method} ${r.path}`)).toContain('POST /web-search/diagnose?provider=brave');
    cleanup();
    const admin = mount({ kind: 'search_provider', id: 'brave', scope: 'deployment', name: 'Brave Search' }, { 'POST /web-search/admin/providers/brave/diagnose': PASS, 'GET /web-search/admin/providers/brave/diagnostics': [] });
    await screen.findByTestId('diagnostics-summary');
    expect(admin.requests.map((r) => `${r.method} ${r.path}`)).toContain('POST /web-search/admin/providers/brave/diagnose');
  });

  it('is a labelled dialog that gives focus back when it closes, full-screen on a phone', async () => {
    restore?.();
    restore = mockViewport(390);
    mount(null, { [`POST /connections/${ID}/diagnose`]: PASS, [`GET /connections/${ID}/diagnostics`]: [] });
    const opener = screen.getByRole('button', { name: 'Open the panel' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Test of Work account' });
    expect(dialog.className).toContain('MuiDialog-paperFullScreen');
    await screen.findByTestId('diagnostics-summary');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('has no serious accessibility finding, running or finished', async () => {
    mount(CONNECTION, { [`POST /connections/${ID}/diagnose`]: FAIL, [`GET /connections/${ID}/diagnostics`]: [FAIL] }, { actions: { provider: 'google', canAdmin: true } });
    await screen.findByTestId('diagnostics-summary');
    expect(await seriousFindings(screen.getByRole('dialog'))).toEqual([]);
  });
});
