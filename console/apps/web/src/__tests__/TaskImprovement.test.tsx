// "Improve this task" in the web app (E52.9, #1024): the word diff, the proposal page in each state, and the order the edit page
// records things in: the task's own save first, then `applied`, then the ticked site facts. Nothing changes a task before Save.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { GoalDiff, TaskImprovementPage } from '../pages/TaskImprovementPage';
import { TaskEditPage } from '../pages/TaskEditPage';
import { wordDiff } from '../taskImprover/wordDiff';
import type { Improvement } from '../taskImprover/api';
import { ConfirmProvider } from '../ui';

vi.mock('../components/TaskForm', () => ({
  taskPath: (id: string) => `/tasks/${id}`,
  // The form itself is tested on its own; here it only shows the goal it starts with and saves on a click.
  TaskForm: ({ initial, taskId, onSaved }: { initial: { goal: string }; taskId: string; onSaved?: (id: string, goal: string) => Promise<void> }) => (
    <div>
      <p data-testid="form-goal">{initial.goal}</p>
      <button type="button" onClick={() => void onSaved?.(taskId, initial.goal)}>Save</button>
    </div>
  ),
}));
vi.mock('../kgraph/TaskKgraphControl', () => ({ TaskKgraphControl: () => null }));

const TASK = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';
const BEFORE = 'Send a text message to {{Recipient}} saying "{{Message}}".';
const AFTER = 'Send ONE text message to {{Recipient}} saying "{{Message}}". Click Send once, by position.';

const proposal = (over: Partial<Improvement> = {}): Improvement => ({
  id: ID,
  taskId: TASK,
  status: 'ready',
  runIds: [RUN],
  goalBefore: BEFORE,
  proposedGoal: AFTER,
  summary: 'The agent pressed Send three times.',
  changes: [{ kind: 'add', text: 'Click Send once, by position.', why: 'Script clicks were ignored.', evidence: [{ runId: RUN, seqFrom: 23, seqTo: 33 }] }],
  siteFacts: [{ site: 'example.test', kind: 'quirk', text: 'The Send button ignores script events.', evidence: [{ runId: RUN, seqFrom: 23, seqTo: 33 }] }],
  confidence: 'high',
  model: 'm',
  usedImages: true,
  error: null,
  appliedGoal: null,
  createdAt: '2026-11-27T00:00:00Z',
  finishedAt: '2026-11-27T00:01:00Z',
  decidedAt: null,
  ...over,
});

function mount(path: string, routes: [string, ReactElement][], responses: Record<string, unknown>, permissions = ['tasks:read', 'tasks:write', 'kgraph:read', 'kgraph:write']) {
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

describe('wordDiff', () => {
  it('keeps, removes and adds words in reading order, and the kept and added parts join back to the new text', () => {
    const parts = wordDiff('send a text now', 'send ONE text now please');
    expect(parts).toEqual([
      { op: 'same', text: 'send ' },
      { op: 'removed', text: 'a ' },
      { op: 'added', text: 'ONE ' },
      { op: 'same', text: 'text now ' },
      { op: 'added', text: 'please' },
    ]);
    expect(parts.filter((p) => p.op !== 'removed').map((p) => p.text).join('')).toBe('send ONE text now please');
  });

  it('an unchanged text is one part', () => {
    expect(wordDiff(BEFORE, BEFORE)).toEqual([{ op: 'same', text: BEFORE }]);
  });
});

describe('GoalDiff', () => {
  it('names removed and added words for a screen reader, and shows placeholders as chips', () => {
    render(<GoalDiff before={BEFORE} after={AFTER} />);
    const diff = screen.getByTestId('goal-diff');
    expect(within(diff).getByLabelText(/^added: .*ONE/)).toBeInTheDocument();
    expect(within(diff).getAllByText('Recipient').length).toBeGreaterThan(0);
  });
});

describe('the proposal page', () => {
  const routes: [string, ReactElement][] = [['/tasks/:taskId/improvements/:id', <TaskImprovementPage key="p" />], ['/tasks/:id/edit', <p key="e">edit page</p>]];

  it('ready: what the runs showed, the diff, why with links to steps, facts unticked, and Use this goal opens the form with the ticked facts', async () => {
    const host = mount(`/tasks/${TASK}/improvements/${ID}`, routes, { [`GET /task-improvements/${ID}`]: proposal(), 'GET /kgraph/status': { deployment: true, user: true, available: true, everyday: false, autoApproveFacts: false } });
    expect(await screen.findByText('The agent pressed Send three times.')).toBeInTheDocument();
    expect(screen.getByTestId('goal-diff')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Run 1, steps 23–33' })[0]!.getAttribute('href')).toBe(`/runs/${RUN}#step-23`);
    const fact = await screen.findByRole('checkbox');
    expect(fact).not.toBeChecked();
    fireEvent.click(fact);
    fireEvent.click(screen.getByRole('button', { name: 'Use this goal' }));
    expect(await screen.findByText('edit page')).toBeInTheDocument();
    // Nothing was written: no request but reads.
    expect(host.requests.filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('hides the site facts while the Knowledge Graph is off', async () => {
    mount(`/tasks/${TASK}/improvements/${ID}`, routes, { [`GET /task-improvements/${ID}`]: proposal(), 'GET /kgraph/status': { deployment: true, user: false, available: false, everyday: false, autoApproveFacts: false } });
    await screen.findByText('The agent pressed Send three times.');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('being made: says so; failed: says why and offers to try again; applied: read only', async () => {
    mount(`/tasks/${TASK}/improvements/${ID}`, routes, { [`GET /task-improvements/${ID}`]: proposal({ status: 'running', summary: null, proposedGoal: null, changes: [], siteFacts: [] }) });
    expect(await screen.findByText(/Reading 1 run/)).toBeInTheDocument();
  });

  it('failed', async () => {
    mount(`/tasks/${TASK}/improvements/${ID}`, routes, { [`GET /task-improvements/${ID}`]: proposal({ status: 'failed', error: 'The proposal was refused twice: it names a site that is not in the task.', summary: null, proposedGoal: null }) });
    expect(await screen.findByText(/refused twice/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('applied', async () => {
    mount(`/tasks/${TASK}/improvements/${ID}`, routes, { [`GET /task-improvements/${ID}`]: proposal({ status: 'applied', decidedAt: '2026-11-27T00:05:00Z', appliedGoal: AFTER }) });
    expect((await screen.findAllByText(/Applied/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Use this goal' })).toBeNull();
  });

  it('a proposal that changes nothing says so and offers no Use', async () => {
    mount(`/tasks/${TASK}/improvements/${ID}`, routes, { [`GET /task-improvements/${ID}`]: proposal({ proposedGoal: BEFORE, changes: [] }) });
    expect(await screen.findByText('The runs show nothing to improve in the goal.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use this goal' })).toBeNull();
  });
});

describe('the edit page with a proposal', () => {
  const task = { id: TASK, name: 'Send a text', goal: BEFORE, profile: 'default', hostId: null, hostFallback: true, allowedDomains: [], confirmRiskyActions: false, parameters: [], outputs: [], schedules: [], summary: { schedules: [] } };

  it('starts the form with the proposed goal and a banner, and after the save records applied, then adds the ticked fact', async () => {
    const saved = { ...task, goal: AFTER };
    let gets = 0;
    const host = mount(`/tasks/${TASK}/edit?improvement=${ID}&facts=0`, [['/tasks/:id/edit', <TaskEditPage key="e" />]], {
      [`GET /tasks/${TASK}`]: () => (gets++ === 0 ? task : saved),
      [`GET /task-improvements/${ID}`]: proposal(),
      [`POST /task-improvements/${ID}/applied`]: proposal({ status: 'applied' }),
      'POST /kgraph/sites/example.test/facts': { id: 'f1' },
    });
    expect(await screen.findByTestId('form-goal')).toHaveTextContent(AFTER);
    expect(screen.getByText(/Nothing changes until you save/)).toBeInTheDocument();
    expect(host.requests.filter((r) => r.method !== 'GET')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(host.requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual([`/task-improvements/${ID}/applied`, '/kgraph/sites/example.test/facts']));
    expect(host.requests.find((r) => r.path === `/task-improvements/${ID}/applied`)!.body).toEqual({ goal: AFTER });
  });
});
