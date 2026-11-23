// The Knowledge Graph pages (E46.20, #794): the page's tabs in their off, empty, with-data and pending-review states, the procedure
// detail, the task control, the run page's panel, the Inbox's review card, the user's settings (switch, Delete everything learned)
// and the administrator's card. Every string from the graph is rendered as text.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';
import type { ReactElement } from 'react';
import { registerSettingsFeature } from '@marinoscar/platform-web/settings/headless';
import { ShellNavigationRail } from '@marinoscar/platform-web/shell/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NAVIGATION } from '../config/navigation';
import { KgraphStatusProvider, useKgraphFeature } from '../kgraph/KgraphStatusProvider';
import { mockViewport } from './matchMedia';

import type { KgProcedureDetail, KgProcedureItem, KgReview, KgRun, KgVersionItem } from '../kgraph/api';
import { RunKgraphPanel, runSummary } from '../kgraph/RunKgraphPanel';
import { TaskKgraphControl } from '../kgraph/TaskKgraphControl';
import { versionSource } from '../kgraph/labels';
import { InboxPage } from '../pages/InboxPage';
import { KgraphAdminPage } from '../pages/KgraphAdminPage';
import { KgraphPage } from '../pages/KgraphPage';
import { KgraphProcedurePage } from '../pages/KgraphProcedurePage';
import { KgraphSettingsPage } from '../pages/KgraphSettingsPage';
import { ConfirmProvider } from '../ui';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const TASK = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const REVIEW = '33333333-3333-4333-8333-333333333333';
const ON = { deployment: true, user: true, available: true, everyday: false, autoApproveFacts: false };
const DEPLOYMENT_OFF = { deployment: false, user: true, available: false, everyday: false, autoApproveFacts: false };
const USER_OFF = { deployment: true, user: false, available: false, everyday: false, autoApproveFacts: false };
const READ = ['kgraph:read', 'kgraph:write', 'runs:read'];

const PROC: KgProcedureItem = {
  id: 'kgp-1',
  taskId: TASK,
  taskName: 'Download the <b>invoices</b>',
  name: 'invoices',
  versionId: 'kgv-2',
  versionNumber: 2,
  state: 'active',
  health: 'healthy',
  steps: 3,
  updatedAt: '2026-11-20T10:00:00.000Z',
  ledger: { runs: 8, procedureRuns: 6, cleanReplayRate: 0.83, everydayRuns: 3 },
};
const DETAIL: KgProcedureDetail = {
  ...PROC,
  enabled: true,
  versions: 2,
  activeVersion: {
    id: 'kgv-2',
    number: 2,
    state: 'active',
    changeClass: 'structural',
    parentId: 'kgv-1',
    sourceRunId: RUN,
    createdAt: '2026-11-19T10:00:00.000Z',
    health: 'healthy',
    counts: { successes: 6, failures: 1, repairs: 1 },
    steps: [
      { id: 's1', kind: 'call', label: 'open the portal', tool: 'browser_navigate', target: 'portal.example.test', usesAi: false, commitClass: false, health: 'healthy', counts: { successes: 6, failures: 0, repairs: 0 }, args: [{ name: 'url', source: 'literal', detail: 'https://portal.example.test' }] },
      { id: 's2', kind: 'judge', label: 'pick the newest invoice', tool: null, target: null, usesAi: true, commitClass: false, health: 'degraded', counts: { successes: 5, failures: 1, repairs: 0 }, args: [] },
      { id: 's3', kind: 'agent', label: 'the agent continues from here', tool: null, target: null, usesAi: true, commitClass: false, health: 'unknown', counts: { successes: 0, failures: 0, repairs: 0 }, args: [] },
    ],
    parameters: [{ name: 'month', type: 'string', sensitive: false, required: true }],
    outputs: [],
    sites: ['portal.example.test'],
    accounts: [],
    savedLogins: [{ kind: 'login', label: 'Portal login' }],
  },
};
const V1: KgVersionItem = { id: 'kgv-1', number: 1, state: 'retired', changeClass: 'initial', parentId: null, sourceRunId: RUN, createdAt: '2026-11-10T10:00:00.000Z', health: 'healthy', counts: { successes: 3, failures: 0, repairs: 0 }, steps: 3 };
const V2: KgVersionItem = { ...V1, id: 'kgv-2', number: 2, state: 'active', changeClass: 'structural', parentId: 'kgv-1', createdAt: '2026-11-19T10:00:00.000Z' };
const REVIEW_ROW: KgReview = { id: REVIEW, versionId: 'kgv-3', procedureId: 'kgp-1', status: 'pending', changes: [{ reason: 'recipient', text: 'sends to a new recipient: <script>a***@example.test</script>' }], createdAt: '2026-11-21T10:00:00.000Z', expiresAt: '2026-12-21T10:00:00.000Z' };
const SUMMARY = { tasks: [{ taskId: TASK, taskName: 'x', runs: 8, procedureRuns: 6, cleanReplayRate: 0.83, baseline: { runs: 2, modelCalls: 14, costUsd: 0.6, costKnown: true, activeMs: 1 }, note: null, procedureFigures: null, saving: { modelCalls: 11, costUsd: 0.42, costKnown: true, activeMs: 1 } }] };

function renderAt(path: string, routes: [string, ReactElement][], responses: Record<string, unknown>, permissions = READ) {
  const host = createTestPlatformHost({ permissions, responses });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            {routes.map(([p, el]) => (
              <Route key={p} path={p} element={el} />
            ))}
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}
const page = (status: unknown, procedures: KgProcedureItem[], reviews: KgReview[] = [], path = '/kgraph') =>
  renderAt(path, [['/kgraph', <KgraphPage />]], {
    'GET /kgraph/status': status,
    'GET /kgraph/procedures': { enabled: (status as { available: boolean }).available, procedures },
    'GET /kgraph/summary': SUMMARY,
    'GET /kgraph/reviews?status=pending': reviews,
    'GET /kgraph/reviews/site-facts': [],
    'GET /kgraph/procedures/kgp-1/versions': { enabled: true, procedureId: 'kgp-1', versions: [V2, V1] },
    'GET /kgraph/procedures/kgp-1/versions/2/diff': { enabled: true, procedureId: 'kgp-1', from: 1, to: 2, changes: [{ change: 'retargeted', before: null, after: null, args: [], text: 'Step 2 now finds the button by its label' }, { change: 'unchanged', before: null, after: null, args: [], text: 'same' }] },
    [`POST /kgraph/reviews/${REVIEW}/answer`]: (r: TestApiRequest) => ({ ...REVIEW_ROW, status: (r.body as { approve: boolean }).approve ? 'approved' : 'declined' }),
  });

describe('the Knowledge Graph page', () => {
  it('off for the deployment: says what it is, that it is off, who can turn it on and that nothing was deleted', async () => {
    page(DEPLOYMENT_OFF, [PROC]);
    const off = await screen.findByTestId('kgraph-off');
    expect(off).toHaveTextContent(/learns the steps of your saved tasks/);
    expect(off).toHaveTextContent(/Only an administrator can turn it on/);
    expect(off).toHaveTextContent(/Nothing learned was deleted/);
    // The stored data is still shown.
    expect(await screen.findAllByText('Download the <b>invoices</b>')).not.toHaveLength(0);
  });

  it('off for the user: points to the settings', async () => {
    page(USER_OFF, []);
    expect(await screen.findByTestId('kgraph-off')).toHaveTextContent(/Turn it on in Settings, Knowledge Graph/);
  });

  it('empty: says how to start learning', async () => {
    page(ON, []);
    expect(await screen.findByText('Nothing learned yet')).toBeInTheDocument();
    expect(screen.queryByTestId('kgraph-off')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open your tasks' })).toHaveAttribute('href', '/tasks');
  });

  it('with data: the state, health and what it saved against AI only, the task name as text', async () => {
    page(ON, [PROC]);
    const list = await screen.findByRole('list', { name: 'Procedures' }).catch(() => screen.findByRole('table', { name: 'Procedures' }));
    expect(within(list).getAllByText('Download the <b>invoices</b>').length).toBeGreaterThan(0);
    expect(document.querySelector('b')).toBeNull();
    expect(within(list).getAllByText('Active').length).toBeGreaterThan(0);
    expect(within(list).getAllByText('Healthy').length).toBeGreaterThan(0);
    expect(within(list).getAllByText(/8 runs, 83% replayed cleanly/).length).toBeGreaterThan(0);
    expect(within(list).getAllByText('11 fewer model calls and $0.42 less than AI only, per run').length).toBeGreaterThan(0);
  });

  it('pending review: the Reviews tab counts it, shows the change as text and approves it', async () => {
    const host = page(ON, [PROC], [REVIEW_ROW], '/kgraph?tab=reviews');
    expect(await screen.findByRole('tab', { name: 'Reviews (1)' })).toBeInTheDocument();
    expect(await screen.findByText(/sends to a new recipient: <script>a\*\*\*@example.test<\/script>/)).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(host.requests.some((r) => r.method === 'POST' && r.path === `/kgraph/reviews/${REVIEW}/answer` && (r.body as { approve: boolean }).approve)).toBe(true));
    expect(await screen.findByText('Nothing to review')).toBeInTheDocument();
  });

  it('no review: Reviews says nothing waits', async () => {
    page(ON, [PROC], [], '/kgraph?tab=reviews');
    expect(await screen.findByText('Nothing to review')).toBeInTheDocument();
  });

  it('Map below 768 px: a short note and a link to the Procedures list, no canvas', async () => {
    const restore = mockViewport(390);
    try {
      const host = page(ON, [PROC], [], '/kgraph?tab=map');
      expect(await screen.findByText('The map needs a wider screen')).toBeInTheDocument();
      expect(screen.getByText(/shows what the agent has learned to do reliably, not everything it can do/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Open the Procedures list' })).toHaveAttribute('href', '/kgraph');
      expect(host.requests.some((r) => r.path.startsWith('/kgraph/graph'))).toBe(false);
    } finally {
      restore();
    }
  });

  it('History: versions with state, source and date, and a readable diff', async () => {
    page(ON, [PROC], [], '/kgraph?tab=history');
    const v2 = await screen.findByRole('listitem', { name: 'Version 2' });
    expect(within(v2).getByText(/Repaired from version 1/)).toBeInTheDocument();
    expect(within(screen.getByRole('listitem', { name: 'Version 1' })).getByText(/Learned from a run/)).toBeInTheDocument();
    fireEvent.click(within(v2).getByRole('button', { name: 'What changed' }));
    expect(await within(v2).findByText('Step 2 now finds the button by its label')).toBeInTheDocument();
    expect(within(v2).getByText(/Against version 1: 1 change\./)).toBeInTheDocument();
  });
});

describe('the procedure page', () => {
  const open = (status = ON, permissions = READ) =>
    renderAt('/kgraph/procedures/kgp-1', [['/kgraph/procedures/:id', <KgraphProcedurePage />]], {
      'GET /kgraph/status': status,
      'GET /kgraph/procedures/kgp-1': DETAIL,
      'GET /kgraph/procedures/kgp-1/versions': { enabled: true, procedureId: 'kgp-1', versions: [V2, V1] },
      'POST /kgraph/procedures/kgp-1/restore': { procedureId: 'kgp-1', restoredFrom: 'kgv-1', versionId: 'kgv-3' },
      'POST /kgraph/procedures/kgp-1/forget': { procedureId: 'kgp-1', retired: 2 },
      [`PUT /tasks/${TASK}/kgraph`]: { taskId: TASK, mode: 'off', available: true },
    }, permissions);

  it('lists the steps in order with their kind, tool, target, AI chip and health', async () => {
    open();
    const steps = await screen.findByRole('list', { name: 'Steps' });
    const items = within(steps).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText('open the portal')).toBeInTheDocument();
    expect(within(items[0]!).getByText('No AI')).toBeInTheDocument();
    expect(within(items[0]!).getByText(/Action · browser_navigate · on portal.example.test/)).toBeInTheDocument();
    expect(within(items[1]!).getByText('Small AI call')).toBeInTheDocument();
    expect(within(items[1]!).getByText('Degraded')).toBeInTheDocument();
    expect(within(items[2]!).getByText('Agent', { selector: '.MuiChip-label' })).toBeInTheDocument();
    expect(screen.getByText('Saved logins: Portal login')).toBeInTheDocument();
  });

  it('counts the chats and one-off runs that used it, from the ledger (E46.29)', async () => {
    open();
    expect(await screen.findByTestId('kg-everyday-uses')).toHaveTextContent('Used in chats and one-off runs: 3');
  });

  it('restores a retired version after asking', async () => {
    const host = open();
    const v1 = await screen.findByRole('listitem', { name: 'Version 1' });
    fireEvent.click(within(v1).getByRole('button', { name: 'Restore this version' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(host.requests.find((r) => r.path === '/kgraph/procedures/kgp-1/restore')?.body).toEqual({ versionId: 'kgv-1' }));
  });

  it('forgets after asking, and switches the task to AI only', async () => {
    const host = open();
    fireEvent.click(await screen.findByRole('button', { name: 'Forget' }));
    fireEvent.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: 'Forget' }));
    await waitFor(() => expect(host.requests.some((r) => r.path === '/kgraph/procedures/kgp-1/forget')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Switch this task to AI only' }));
    fireEvent.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: 'Switch to AI only' }));
    await waitFor(() => expect(host.requests.find((r) => r.method === 'PUT')?.body).toEqual({ mode: 'off' }));
  });

  it('off: no write action, the off notice', async () => {
    open(DEPLOYMENT_OFF);
    expect(await screen.findByTestId('kgraph-off')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Forget' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore this version' })).not.toBeInTheDocument();
  });
});

describe("a task's Knowledge Graph control", () => {
  const control = (status: unknown, permissions = ['kgraph:read', 'kgraph:write']) =>
    renderAt('/', [['/', <TaskKgraphControl taskId={TASK} />]], {
      'GET /kgraph/status': status,
      [`GET /tasks/${TASK}/kgraph`]: { taskId: TASK, mode: 'learn', available: (status as { available: boolean }).available },
      [`PUT /tasks/${TASK}/kgraph`]: (r: TestApiRequest) => ({ taskId: TASK, mode: (r.body as { mode: string }).mode, available: true }),
    }, permissions);

  it('offers three choices with help and saves through /tasks/{id}/kgraph', async () => {
    const host = control(ON);
    expect(await screen.findByRole('radio', { name: 'Learn only' })).toBeChecked();
    expect(screen.getByText(/Saved steps run without the model/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Learn and reuse' }));
    await waitFor(() => expect(host.requests.find((r) => r.method === 'PUT')).toMatchObject({ path: `/tasks/${TASK}/kgraph`, body: { mode: 'reuse' } }));
  });

  it('is disabled with the reason while the deployment switch is off', async () => {
    control(DEPLOYMENT_OFF);
    expect(await screen.findByRole('radio', { name: 'AI only' })).toBeDisabled();
    expect(screen.getByText(/Only an administrator can turn it on/)).toBeInTheDocument();
  });

  it('renders nothing (and asks nothing) without kgraph:read', async () => {
    const host = control(ON, ['tasks:read']);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('task-kgraph')).not.toBeInTheDocument();
    expect(host.requests.filter((r) => r.path.includes('kgraph'))).toEqual([]);
  });
});

describe("the run page's Knowledge Graph panel", () => {
  const RUN_ROW: KgRun = {
    enabled: true,
    runId: RUN,
    taskId: TASK,
    mode: 'reuse',
    aiOnly: false,
    outcome: 'replayed',
    procedureId: 'kgp-1',
    procedureName: 'invoices',
    versionId: 'kgv-2',
    versionNumber: 2,
    steps: [
      { id: 's1', kind: 'call', label: 'open the portal', tool: 'browser_navigate', how: 'replayed' },
      { id: 's2', kind: 'call', label: 'press <i>Download</i>', tool: 'browser_click', how: 'recovered' },
      { id: 's3', kind: 'judge', label: 'pick one', tool: null, how: 'judged' },
    ],
    ledger: null,
  };
  const panel = (row: unknown) => renderAt('/', [['/', <RunKgraphPanel runId={RUN} />]], { [`GET /kgraph/runs/${RUN}`]: row });

  it('tags each step and sums it up', async () => {
    panel(RUN_ROW);
    expect(await screen.findByTestId('run-kgraph-summary')).toHaveTextContent('2 of 3 steps without AI; 1 repaired');
    expect(screen.getByText('Replayed')).toBeInTheDocument();
    expect(screen.getByText('Recovered')).toBeInTheDocument();
    expect(screen.getByText('Small AI call')).toBeInTheDocument();
    expect(screen.getByText('press <i>Download</i>')).toBeInTheDocument();
  });

  it('prefers the ledger once written', () => {
    expect(runSummary({ ...RUN_ROW, ledger: { replayed: 14, recovered: 1, judge: 1, agent: 1 } })).toBe('15 of 17 steps without AI; 1 repaired');
  });

  it('an everyday run names the saved procedure it used and links to it (E46.29)', async () => {
    panel({ ...RUN_ROW, taskId: null, mode: 'everyday', outcome: 'procedure_done', procedureName: 'Export <b>invoices</b>', ledger: { replayed: 2, recovered: 0, judge: 0, agent: 3 } });
    const line = await screen.findByTestId('run-kgraph-everyday');
    expect(line).toHaveTextContent('Used saved procedure: Export <b>invoices</b>');
    expect(within(line).getByRole('link', { name: 'Export <b>invoices</b>' })).toHaveAttribute('href', '/kgraph/procedures/kgp-1');
    expect(document.querySelector('b')).toBeNull();
    expect(screen.getByTestId('run-kgraph-summary')).toHaveTextContent('2 of 5 steps without AI');
    expect(screen.getByText(/Chat or one-off run/)).toBeInTheDocument();
    // The version's step tags describe a task's replay, not a run_procedure call: not shown for an everyday run.
    expect(screen.queryByRole('list', { name: 'Procedure steps in this run' })).not.toBeInTheDocument();
  });

  it('a task run shows no everyday line', async () => {
    panel(RUN_ROW);
    await screen.findByTestId('run-kgraph-summary');
    expect(screen.queryByTestId('run-kgraph-everyday')).not.toBeInTheDocument();
  });

  it('shows nothing for a run the Knowledge Graph took no part in', async () => {
    panel({ ...RUN_ROW, mode: 'off', steps: [] });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('run-kgraph')).not.toBeInTheDocument();
  });
});

describe("the Inbox's Suggestions", () => {
  it('shows a pending review with Approve and Decline, and declines it', async () => {
    const host = renderAt('/inbox', [['/inbox', <InboxPage />]], {
      'GET /inbox': [],
      'GET /kgraph/reviews?status=pending': [REVIEW_ROW],
      [`POST /kgraph/reviews/${REVIEW}/answer`]: { ...REVIEW_ROW, status: 'declined' },
    }, ['runs:read', 'runs:write', 'kgraph:read', 'kgraph:write']);
    const group = await screen.findByRole('region', { name: 'Suggestions' }).catch(() => screen.findByLabelText('Suggestions'));
    expect(await within(group).findByText(/sends to a new recipient/)).toBeInTheDocument();
    expect(screen.queryByText('Nothing is waiting for you')).not.toBeInTheDocument();
    fireEvent.click(within(group).getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(host.requests.find((r) => r.method === 'POST')?.body).toEqual({ approve: false }));
  });

  it('without kgraph:write the review is shown without its buttons', async () => {
    renderAt('/inbox', [['/inbox', <InboxPage />]], { 'GET /inbox': [], 'GET /kgraph/reviews?status=pending': [REVIEW_ROW] }, ['runs:read', 'kgraph:read']);
    expect(await screen.findByText(/sends to a new recipient/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });
});

describe('Settings, Knowledge Graph', () => {
  const settings = (status: unknown, permissions = ['kgraph:read', 'kgraph:write']) =>
    renderAt('/settings/kgraph', [['/settings/kgraph', <KgraphSettingsPage />]], {
      'GET /kgraph/status': status,
      'PATCH /user-settings': { version: 2 },
      'DELETE /kgraph': { deleted: { procedures: 2, versions: 4, nodes: 0, edges: 0, tasks: 1, runs: 3, reviews: 1, evidence: 0, traces: 0, ledger: 3 } },
    }, permissions);

  it('turns the own switch on through the user settings', async () => {
    const host = settings(USER_OFF);
    const sw = await screen.findByRole('switch', { name: 'Use the Knowledge Graph for my saved tasks' }).catch(() => screen.findByRole('checkbox', { name: 'Use the Knowledge Graph for my saved tasks' }));
    expect(sw).not.toBeChecked();
    fireEvent.click(sw);
    await waitFor(() => expect(host.requests.find((r) => r.method === 'PATCH')).toMatchObject({ path: '/user-settings', body: { kgraph: { enabled: true } } }));
    expect(screen.getByRole('link', { name: 'See what was learned' })).toHaveAttribute('href', '/kgraph');
  });

  const everydaySwitch = () => screen.findByRole('switch', { name: 'Use in chats and one-off runs' }).catch(() => screen.findByRole('checkbox', { name: 'Use in chats and one-off runs' }));

  it('turns "Use in chats and one-off runs" on through kgraph.everyday, and says what it does (E46.29)', async () => {
    const host = settings(ON);
    const sw = await everydaySwitch();
    expect(sw).not.toBeChecked();
    expect(sw).toBeEnabled();
    expect(screen.getByText(/Offers your learned procedures to chats and one-off runs .*you still approve anything sensitive/)).toBeInTheDocument();
    expect(screen.queryByTestId('kgraph-everyday-reason')).not.toBeInTheDocument();
    fireEvent.click(sw);
    await waitFor(() => expect(host.requests.find((r) => r.method === 'PATCH')).toMatchObject({ path: '/user-settings', body: { kgraph: { everyday: true } } }));
  });

  it('turns it off again', async () => {
    const host = settings({ ...ON, everyday: true });
    const sw = await everydaySwitch();
    expect(sw).toBeChecked();
    fireEvent.click(sw);
    await waitFor(() => expect(host.requests.find((r) => r.method === 'PATCH')).toMatchObject({ path: '/user-settings', body: { kgraph: { everyday: false } } }));
  });

  it('"Use in chats and one-off runs" is disabled with the reason while the own switch is off', async () => {
    settings(USER_OFF);
    const sw = await everydaySwitch();
    expect(sw).toBeDisabled();
    expect(screen.getByTestId('kgraph-everyday-reason')).toHaveTextContent('Turn on "Use the Knowledge Graph for my saved tasks" first.');
  });

  it('"Use in chats and one-off runs" is disabled with the reason while the deployment switch is off', async () => {
    settings(DEPLOYMENT_OFF);
    expect(await everydaySwitch()).toBeDisabled();
    expect(screen.getByTestId('kgraph-everyday-reason')).toHaveTextContent(/administrator allows the Knowledge Graph/);
  });

  const autoSwitch = () => screen.findByRole('switch', { name: 'Approve facts from server records automatically' }).catch(() => screen.findByRole('checkbox', { name: 'Approve facts from server records automatically' }));

  it('turns "Approve facts from server records automatically" on through kgraph.autoApproveFacts, and says what it covers (E46.36)', async () => {
    const host = settings(ON);
    const sw = await autoSwitch();
    expect(sw).not.toBeChecked();
    expect(sw).toBeEnabled();
    expect(screen.getByText(/Covers only navigation, timing and quirk facts .* sign-in facts, the agent.s proposals and imported facts always wait for your review/)).toBeInTheDocument();
    expect(screen.queryByTestId('kgraph-auto-approve-reason')).not.toBeInTheDocument();
    fireEvent.click(sw);
    await waitFor(() => expect(host.requests.find((r) => r.method === 'PATCH')).toMatchObject({ path: '/user-settings', body: { kgraph: { autoApproveFacts: true } } }));
  });

  it('turns auto-approve off again', async () => {
    const host = settings({ ...ON, autoApproveFacts: true });
    const sw = await autoSwitch();
    expect(sw).toBeChecked();
    fireEvent.click(sw);
    await waitFor(() => expect(host.requests.find((r) => r.method === 'PATCH')).toMatchObject({ path: '/user-settings', body: { kgraph: { autoApproveFacts: false } } }));
  });

  it('auto-approve is disabled with the reason while the Knowledge Graph is off', async () => {
    settings(USER_OFF);
    expect(await autoSwitch()).toBeDisabled();
    expect(screen.getByTestId('kgraph-auto-approve-reason')).toHaveTextContent('Turn on "Use the Knowledge Graph for my saved tasks" first.');
  });

  it('says when the administrator has not allowed it', async () => {
    settings(DEPLOYMENT_OFF);
    expect(await screen.findByText(/Your administrator has not allowed the Knowledge Graph/)).toBeInTheDocument();
  });

  it('asks before Delete everything learned, and deletes only after the word is typed', async () => {
    const host = settings(ON);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete everything learned' }));
    const dialog = await screen.findByRole('dialog');
    const go = within(dialog).getByRole('button', { name: 'Delete everything' });
    expect(go).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'delete' } });
    fireEvent.click(go);
    await waitFor(() => expect(host.requests.some((r) => r.method === 'DELETE' && r.path === '/kgraph')).toBe(true));
  });

  it('Cancel deletes nothing', async () => {
    const host = settings(ON);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete everything learned' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(host.requests.some((r) => r.method === 'DELETE')).toBe(false);
  });

  it('read-only without kgraph:write', async () => {
    settings(ON, ['kgraph:read']);
    expect(await screen.findByText('Use the Knowledge Graph for my saved tasks')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete everything learned' })).not.toBeInTheDocument();
  });
});

describe('Administration, Knowledge Graph', () => {
  it('starts off, and saves the switch and the numbers', async () => {
    const host = renderAt('/admin/settings/kgraph', [['/admin/settings/kgraph', <KgraphAdminPage />]], {
      'GET /admin/kgraph/settings': { enabled: false, auditEvery: 10, suspendAfterFailures: 3, retentionDays: null, pacing: 'human' },
      'PUT /admin/kgraph/settings': (r: TestApiRequest) => ({ enabled: false, auditEvery: 10, suspendAfterFailures: 3, retentionDays: null, pacing: 'human', ...(r.body as object) }),
    }, ['kgraph:admin']);
    const sw = await screen.findByRole('switch', { name: 'Allow the Knowledge Graph on this console' }).catch(() => screen.findByRole('checkbox', { name: 'Allow the Knowledge Graph on this console' }));
    expect(sw).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(sw);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Audit every N runs' }), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('radio', { name: /Fast/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(host.requests.find((r) => r.method === 'PUT')?.body).toEqual({ enabled: true, auditEvery: 0, suspendAfterFailures: 3, pacing: 'fast' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('refuses a number out of range', async () => {
    renderAt('/admin/settings/kgraph', [['/admin/settings/kgraph', <KgraphAdminPage />]], { 'GET /admin/kgraph/settings': { enabled: true, auditEvery: 10, suspendAfterFailures: 3, retentionDays: null, pacing: 'human' } }, ['kgraph:admin']);
    fireEvent.change(await screen.findByRole('spinbutton', { name: 'Failures before suspension' }), { target: { value: '0' } });
    expect(screen.getByText('From 1 to 100')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('versionSource', () => {
  it('reads learned, repaired and restored from the versions list', () => {
    const restored: KgVersionItem = { ...V1, id: 'kgv-3', number: 3, state: 'candidate', parentId: 'kgv-1' };
    const sensitive: KgVersionItem = { ...V2, changeClass: 'sensitive' };
    expect(versionSource(V1, [V1])).toBe('Learned from a run');
    expect(versionSource(restored, [restored, V1])).toBe('Restored from version 1');
    expect(versionSource(sensitive, [sensitive, V1])).toBe('Repaired from version 1 (sensitive change)');
  });
});

describe('the navigation entry', () => {
  // As App.tsx does: the entry declares the `kgraph` feature, on only while both switches are on.
  registerSettingsFeature('kgraph', useKgraphFeature);
  let restoreViewport: (() => void) | null = null;
  afterEach(() => {
    restoreViewport?.();
    restoreViewport = null;
  });
  const rail = async (status: unknown) => {
    restoreViewport = mockViewport(1440);
    const host = createTestPlatformHost({ permissions: ['kgraph:read', 'tasks:read'], responses: { 'GET /kgraph/status': status, 'GET /inbox': [] } });
    render(
      <PlatformHostProvider host={host}>
        <MemoryRouter initialEntries={['/tasks']}>
          <KgraphStatusProvider>
            <ShellNavigationRail navigation={NAVIGATION} />
          </KgraphStatusProvider>
        </MemoryRouter>
      </PlatformHostProvider>,
    );
    await screen.findByRole('link', { name: 'Tasks' });
    await waitFor(() => expect(host.requests.some((r) => r.path === '/kgraph/status')).toBe(true));
  };

  it('is hidden while the deployment switch is off', async () => {
    await rail(DEPLOYMENT_OFF);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('link', { name: 'Knowledge Graph' })).not.toBeInTheDocument();
  });

  it('shows while both switches are on', async () => {
    await rail(ON);
    expect(await screen.findByRole('link', { name: 'Knowledge Graph' })).toHaveAttribute('href', '/kgraph');
  });
});
