// The Map tab (E46.21, #795) from 768 px up: the canvas loads lazily, nodes have accessible names, the list and the side panel reach
// everything the canvas does (expand, focus, what uses this site, the step list and history links), unused capabilities and the legend
// show, and every string is text. React Flow needs `ResizeObserver` and `DOMMatrixReadOnly`, which jsdom lacks: both are stubbed.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { KgProcedureItem, KgReview } from '../kgraph/api';
import { KgraphPage } from '../pages/KgraphPage';
import { ConfirmProvider } from '../ui';
import { threeTasks } from './kgraphMapFixture';
import { mockViewport } from './matchMedia';

vi.setConfig({ testTimeout: 20_000 });
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

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

const ON = { deployment: true, user: true, available: true, everyday: true };
const proc = (id: string, taskName: string, state: KgProcedureItem['state'] = 'active'): KgProcedureItem => ({
  id,
  taskId: `00000000-0000-4000-8000-00000000000${id.slice(1)}`,
  taskName,
  name: id,
  versionId: `v-${id}`,
  versionNumber: 1,
  state,
  health: 'healthy',
  steps: 2,
  updatedAt: '2026-11-20T10:00:00.000Z',
  ledger: { runs: 3, procedureRuns: 2, cleanReplayRate: 1, everydayRuns: id === 'p1' ? 4 : 0 },
});
const PROCS = [proc('p1', 'Download the <b>invoices</b>'), proc('p2', 'Check the orders', 'suspended'), proc('p3', 'Weekly report')];
const REVIEW: KgReview = { id: 'r1', versionId: 'v9', procedureId: 'p1', status: 'pending', changes: [{ reason: 'recipient', text: 'would send to <img src=x onerror=alert(1)>' }], createdAt: '2026-11-21T10:00:00.000Z', expiresAt: '2026-12-21T10:00:00.000Z' };

function renderMap(width = 1440) {
  restore = mockViewport(width);
  const graph = threeTasks();
  graph.nodes.find((n) => n.id === 'secret:login:old')!.label = '<script>Old shop</script>';
  const host = createTestPlatformHost({
    permissions: ['kgraph:read'],
    responses: {
      'GET /kgraph/status': ON,
      'GET /kgraph/procedures': { enabled: true, procedures: PROCS },
      'GET /kgraph/summary': { tasks: [] },
      'GET /kgraph/reviews?status=pending': [REVIEW],
      'GET /kgraph/graph': graph,
    },
  });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={['/kgraph?tab=map']}>
          <Routes>
            <Route path="/kgraph" element={<KgraphPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}

const list = () => screen.findByRole('list', { name: 'Nodes on the map' });

describe('the Map', () => {
  it('loads the graph and draws it clustered, with accessible names, the legend and the help', async () => {
    const host = renderMap();
    const nodes = await list();
    await waitFor(() => expect(host.requests.some((r) => r.path === '/kgraph/graph')).toBe(true));
    expect(screen.getByText(/shows what the agent has learned to do reliably, not everything it can do/)).toBeInTheDocument();
    const names = within(nodes).getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual([
      'Task: Download the <b>invoices</b>, healthy, 2 more inside',
      'Task: Check the orders, suspended, 2 more inside',
      'Task: Weekly report, failing, 3 more inside',
      'Site: a.test',
      'Site: b.test',
      'Account: Work mail, 2 more inside',
      'Saved login or card: Portal',
      'Saved login or card: <script>Old shop</script>, not used by any task yet',
    ]);
    // The canvas nodes carry the same names.
    await waitFor(() => expect(document.querySelector('[aria-label="Site: a.test"].react-flow__node')).not.toBeNull());
    const legend = screen.getByRole('region', { name: 'Legend' });
    for (const t of ['uses', 'then', 'feeds a value', 'Not used by any task yet', 'Suspended (marked with a pause icon)']) expect(within(legend).getByText(t)).toBeInTheDocument();
    // Every string is text.
    expect(within(nodes).getAllByText('Download the <b>invoices</b>').length).toBeGreaterThan(0);
    expect(within(nodes).getByText('<script>Old shop</script>')).toBeInTheDocument();
    expect(document.querySelector('b')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });

  it('the side panel: expand a task, focus on it, and its step list, history and pending review', async () => {
    renderMap();
    fireEvent.click(within(await list()).getByRole('button', { name: /^Task: Download the/ }));
    const panel = screen.getByRole('complementary', { name: 'Details' });
    expect(within(panel).getByRole('link', { name: 'Step list' })).toHaveAttribute('href', '/kgraph/procedures/p1');
    expect(within(panel).getByRole('link', { name: 'History' })).toHaveAttribute('href', '/kgraph?tab=history&procedure=p1');
    expect(within(panel).getByTestId('map-everyday-uses')).toHaveTextContent('Used in chats and one-off runs: 4');
    expect(within(panel).getByText('would send to <img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Show its steps' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Nodes on the map' })).getByRole('button', { name: /^Step: open the portal/ })).toBeInTheDocument());
    fireEvent.click(within(panel).getByRole('button', { name: 'Focus on this task' }));
    expect(within(panel).getByRole('button', { name: 'Stop focusing' })).toBeInTheDocument();
  });

  it('"what uses this site" lists and counts exactly the tasks that use it', async () => {
    renderMap(1024);
    fireEvent.click(within(await list()).getByRole('button', { name: 'Site: a.test' }));
    const panel = screen.getByRole('complementary', { name: 'Details' });
    fireEvent.click(within(panel).getByRole('button', { name: 'What uses this site' }));
    expect(await screen.findByText('A change to this site would affect 2 tasks, highlighted on the map.')).toBeInTheDocument();
    const affected = within(panel).getAllByRole('listitem').map((li) => li.textContent);
    expect(affected).toEqual(['Download the <b>invoices</b>', 'Check the orders']);
  });

  it('filters by type', async () => {
    renderMap(768);
    await list();
    fireEvent.click(screen.getByRole('button', { name: 'Saved login or card' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Nodes on the map' })).getAllByRole('button')).toHaveLength(2));
  });
});
