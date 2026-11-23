// Delete everything learned, end to end in the web app (E46.37, #893; closes #794's "asks for confirmation and empties the pages"): one
// stateful fake of the API answers every Knowledge Graph read with the owner's data until `DELETE /kgraph` is called, and as the real route
// answers after a purge from then on (kgraph-switches.db.spec.ts proves those answers against the database). Cancelling the confirmation
// sends nothing and keeps every page as it was; confirming it empties the Procedures, Map, Sites, Reviews and History tabs and the run
// page's panel. React Flow needs `ResizeObserver` and `DOMMatrixReadOnly`, which jsdom lacks: both are stubbed, as in KgraphMap.test.tsx.
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost, type TestPlatformHost } from '@marinoscar/platform-web/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { KgGraph, KgProcedureItem, KgReview, KgRun, KgSiteFact, KgVersionItem } from '../kgraph/api';
import { RunKgraphPanel } from '../kgraph/RunKgraphPanel';
import { KgraphPage } from '../pages/KgraphPage';
import { KgraphSettingsPage } from '../pages/KgraphSettingsPage';
import { ConfirmProvider } from '../ui';
import { threeTasks } from './kgraphMapFixture';
import { mockViewport } from './matchMedia';

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 8_000 });

beforeAll(() => {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= RO;
  class Matrix {
    m22 = 1;
    constructor(_t?: string) {}
  }
  (globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly ??= Matrix;
});

// The Map's canvas needs 768 px or more; the other tabs read the same at any width.
let restoreViewport: (() => void) | null = null;
afterEach(() => {
  restoreViewport?.();
  restoreViewport = null;
});

const TASK = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const REVIEW = '33333333-3333-4333-8333-333333333333';
const ON = { deployment: true, user: true, available: true, everyday: false };
const PERMISSIONS = ['kgraph:read', 'kgraph:write', 'runs:read'];

const PROC: KgProcedureItem = {
  id: 'kgp-1',
  taskId: TASK,
  taskName: 'Download the invoices',
  name: 'invoices',
  versionId: 'kgv-2',
  versionNumber: 2,
  state: 'active',
  health: 'healthy',
  steps: 2,
  updatedAt: '2026-11-20T10:00:00.000Z',
  ledger: { runs: 4, procedureRuns: 3, cleanReplayRate: 1, everydayRuns: 0 },
};
const V1: KgVersionItem = { id: 'kgv-1', number: 1, state: 'retired', changeClass: 'initial', parentId: null, sourceRunId: RUN, createdAt: '2026-11-10T10:00:00.000Z', health: 'healthy', counts: { successes: 3, failures: 0, repairs: 0 }, steps: 2 };
const V2: KgVersionItem = { ...V1, id: 'kgv-2', number: 2, state: 'active', changeClass: 'structural', parentId: 'kgv-1', createdAt: '2026-11-19T10:00:00.000Z' };
const REVIEW_ROW: KgReview = { id: REVIEW, versionId: 'kgv-3', procedureId: 'kgp-1', status: 'pending', changes: [{ reason: 'recipient', text: 'sends to a new recipient: a***@example.test' }], createdAt: '2026-11-21T10:00:00.000Z', expiresAt: '2026-12-21T10:00:00.000Z' };
const PROPOSAL: KgSiteFact = {
  id: 'kgsf-9',
  site: 'portal.example.test',
  kind: 'timing',
  text: 'Reports take a minute to load',
  source: 'derived',
  status: 'proposed',
  evidence: { runId: RUN, steps: 3, screens: 1 },
  declinedAt: null,
  lastUsedAt: null,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
};
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
    { id: 's2', kind: 'call', label: 'press Download', tool: 'browser_click', how: 'replayed' },
  ],
  ledger: null,
};
/** `GET /kgraph/runs/{id}` once the run's kg_runs and kg_ledger rows are gone: what KgraphReadService.run answers (the db spec checks it). */
const RUN_AFTER: KgRun = { enabled: true, runId: RUN, taskId: TASK, mode: 'off', aiOnly: false, outcome: null, procedureId: null, procedureName: null, versionId: null, versionNumber: null, steps: [], ledger: null, kgFactIds: [], siteFacts: [] } as KgRun;
const EMPTY_GRAPH: KgGraph = { ...threeTasks(), nodes: [], edges: [], clusters: [], totalNodes: 0 };

/** A fake API with the owner's Knowledge Graph until `DELETE /kgraph`, empty after it. */
function backend() {
  const state = { purged: false };
  const learned = <T,>(before: T, after: T) => () => (state.purged ? after : before);
  const responses: Record<string, unknown> = {
    'GET /kgraph/status': ON,
    'GET /kgraph/procedures': learned({ enabled: true, procedures: [PROC] }, { enabled: true, procedures: [] }),
    'GET /kgraph/summary': learned({ tasks: [{ taskId: TASK, taskName: PROC.taskName, runs: 4, procedureRuns: 3, cleanReplayRate: 1, baseline: null, note: null, procedureFigures: null, saving: null }] }, { tasks: [] }),
    'GET /kgraph/reviews?status=pending': learned([REVIEW_ROW], []),
    'GET /kgraph/reviews/site-facts': learned([PROPOSAL], []),
    'GET /kgraph/sites': learned([{ site: 'portal.example.test', active: 2, proposed: 1, archived: 0 }], []),
    'GET /kgraph/graph': learned(threeTasks(), EMPTY_GRAPH),
    'GET /kgraph/procedures/kgp-1/versions': { enabled: true, procedureId: 'kgp-1', versions: [V2, V1] },
    [`GET /kgraph/runs/${RUN}`]: learned(RUN_ROW, RUN_AFTER),
    'PATCH /user-settings': { version: 2 },
    'DELETE /kgraph': () => {
      state.purged = true;
      return { deleted: { procedures: 1, versions: 2, nodes: 9, edges: 4, tasks: 1, runs: 4, reviews: 1, evidence: 2, traces: 6, ledger: 4, siteFacts: 3 } };
    },
  };
  return { state, responses };
}

type Backend = ReturnType<typeof backend>;
let host: TestPlatformHost | null = null;

/** Renders the settings page, the Knowledge Graph page and the run page's panel against the same fake API. */
function mount(b: Backend, path: string) {
  cleanup();
  host = createTestPlatformHost({ permissions: PERMISSIONS, responses: b.responses });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/settings/kgraph" element={<KgraphSettingsPage />} />
            <Route path="/kgraph" element={<KgraphPage />} />
            <Route path="/runs/:id" element={<RunKgraphPanel runId={RUN} />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}

/** Every Knowledge Graph view with what was learned. */
async function expectLearned(b: Backend) {
  mount(b, '/kgraph');
  expect((await screen.findAllByText('Download the invoices')).length).toBeGreaterThan(0);
  expect(screen.queryByText('Nothing learned yet')).not.toBeInTheDocument();

  mount(b, '/kgraph?tab=history');
  expect(await screen.findByRole('listitem', { name: 'Version 2' })).toBeInTheDocument();

  mount(b, '/kgraph?tab=reviews');
  expect(await screen.findByText(/sends to a new recipient/)).toBeInTheDocument();
  expect(await screen.findByText(/Reports take a minute to load/)).toBeInTheDocument();
  expect(screen.queryByText('Nothing to review')).not.toBeInTheDocument();

  mount(b, '/kgraph?tab=sites');
  expect((await screen.findAllByText('portal.example.test')).length).toBeGreaterThan(0);
  expect(screen.queryByText('No site facts yet')).not.toBeInTheDocument();

  restoreViewport = mockViewport(1440);
  mount(b, '/kgraph?tab=map');
  expect((await screen.findAllByText('a.test')).length).toBeGreaterThan(0);
  expect(screen.queryByText('Nothing on the map yet')).not.toBeInTheDocument();

  mount(b, `/runs/${RUN}`);
  expect(await screen.findByTestId('run-kgraph-summary')).toHaveTextContent('2 of 2 steps without AI');
}

describe('Delete everything learned (#794)', () => {
  it('asks first: Cancel sends nothing, and every page still shows what was learned', async () => {
    const b = backend();
    const h = mount(b, '/settings/kgraph');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete everything learned' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Delete everything learned?');
    // The confirmation needs the word typed: the button stays disabled until then.
    expect(within(dialog).getByRole('button', { name: 'Delete everything' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(h.requests.filter((r) => r.method === 'DELETE')).toEqual([]);
    expect(b.state.purged).toBe(false);
    await expectLearned(b);
  });

  it('after the confirmation, Procedures, History, Reviews, Sites and the Map show their empty states and the run panel shows nothing learned', async () => {
    const b = backend();
    await expectLearned(b);

    const h = mount(b, '/settings/kgraph');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete everything learned' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'delete' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete everything' }));
    await waitFor(() => expect(h.requests.filter((r) => r.method === 'DELETE').map((r) => r.path)).toEqual(['/kgraph']));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(b.state.purged).toBe(true);

    mount(b, '/kgraph');
    expect(await screen.findByText('Nothing learned yet')).toBeInTheDocument();
    expect(screen.queryByText('Download the invoices')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Reviews' })).toBeInTheDocument();

    mount(b, '/kgraph?tab=history');
    expect(await screen.findByText('Nothing learned yet')).toBeInTheDocument();
    expect(screen.queryByRole('listitem', { name: /^Version/ })).not.toBeInTheDocument();

    mount(b, '/kgraph?tab=reviews');
    expect(await screen.findByText('Nothing to review')).toBeInTheDocument();
    expect(screen.queryByText(/sends to a new recipient/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Reports take a minute to load/)).not.toBeInTheDocument();

    mount(b, '/kgraph?tab=sites');
    expect(await screen.findByText('No site facts yet')).toBeInTheDocument();
    expect(screen.queryByText('portal.example.test')).not.toBeInTheDocument();

    restoreViewport = mockViewport(1440);
    mount(b, '/kgraph?tab=map');
    expect(await screen.findByText('Nothing on the map yet')).toBeInTheDocument();

    const runHost = mount(b, `/runs/${RUN}`);
    await waitFor(() => expect(runHost.requests.some((r) => r.path === `/kgraph/runs/${RUN}`)).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('run-kgraph')).not.toBeInTheDocument();
    expect(screen.queryByText('Knowledge Graph')).not.toBeInTheDocument();
  });
});
