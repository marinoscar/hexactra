// The task builder page (E42.4): Build with AI opens a builder, the thread and its suggested answers, the spec
// panel and its states, Create task opens the task form with the draft, the draft card, the archived builder.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost, type TestApiRequest, type TestPlatformHost } from '@marinoscar/platform-web/testing';

vi.mock('../live', () => ({ subscribeChat: () => () => undefined, subscribeRun: () => () => undefined, fetchRunScreenshot: async () => null }));

import { canCreate, specSections } from '../components/TaskSpecPanel';
import { TaskBuilderPage } from '../pages/TaskBuilderPage';
import type { ChatMessage } from '../types/chat';
import type { TaskBuilderDetail, TaskBuilderDraft, TaskBuilderSpec } from '../types/taskBuilder';
import { ConfirmProvider, ToastHost, dismissToast } from '../ui';
import { mockViewport } from './matchMedia';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const ID = '77777777-7777-4777-8777-777777777777';
const ALL = ['tasks:read', 'tasks:write', 'chat:read'];
const message = (seq: number, over: Partial<ChatMessage> = {}): ChatMessage => ({ id: `m${seq}`, seq, role: 'assistant', kind: 'text', text: `message ${seq}`, runId: null, meta: null, createdAt: '2026-11-21T10:00:00Z', ...over });
const SPEC: TaskBuilderSpec = {
  name: 'Water bill',
  objective: 'The bill is paid',
  goal: 'Pay {{Amount}} on the water site.',
  parameters: [{ name: 'Amount', type: 'money' }],
  guardrails: { confirmRiskyActions: true },
  suggestions: ['Keep the confirmation number as an output'],
  openQuestions: ['Which account pays?'],
};
const detail = (over: Partial<TaskBuilderDetail> = {}): TaskBuilderDetail => ({
  id: ID,
  title: 'Pay my water bill',
  status: 'active',
  spec: SPEC,
  createdAt: '2026-11-21T10:00:00Z',
  updatedAt: '2026-11-21T10:00:00Z',
  messages: [message(1, { role: 'user', text: 'Pay my water bill every month' }), message(2, { kind: 'clarify', text: 'Does the amount change every month?', meta: { options: ['It changes', 'Always the same'] } })],
  hasMore: false,
  thinking: false,
  ...over,
});
const DRAFT: TaskBuilderDraft = { name: 'Water bill', goal: 'Pay {{Amount}} on the water site.', profile: 'default', hostId: null, hostFallback: true, policyId: null, allowedDomains: [], confirmRiskyActions: true, schedules: [], warnings: [] };

let restoreViewport: (() => void) | null = null;
beforeAll(() => {
  Element.prototype.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
});
afterEach(() => {
  restoreViewport?.();
  restoreViewport = null;
  dismissToast();
});

function Where() {
  const location = useLocation();
  return <div data-testid="where" data-state={JSON.stringify(location.state ?? null)}>{location.pathname}</div>;
}

function mount({ width = 1440, responses = {}, permissions = ALL }: { width?: number; responses?: Record<string, unknown>; permissions?: string[] } = {}): TestPlatformHost {
  restoreViewport = mockViewport(width);
  const host = createTestPlatformHost({
    permissions,
    responses: {
      [`GET /task-builder/${ID}`]: detail(),
      [`POST /task-builder/${ID}/messages`]: (req: TestApiRequest) => message(3, { role: 'user', text: (req.body as { text: string }).text }),
      [`PATCH /task-builder/${ID}/spec`]: (req: TestApiRequest) => ({ ...SPEC, ...(req.body as object) }),
      [`POST /task-builder/${ID}/draft`]: DRAFT,
      ...responses,
    },
  });
  render(
    <PlatformHostProvider host={host}>
      <MemoryRouter initialEntries={[`/tasks/builder/${ID}`]}>
        <ConfirmProvider>
          <Routes>
            <Route path="/tasks/builder/:id" element={<TaskBuilderPage />} />
            <Route path="/tasks/new" element={<div>task form</div>} />
          </Routes>
          <Where />
        </ConfirmProvider>
        <ToastHost />
      </MemoryRouter>
    </PlatformHostProvider>,
  );
  return host;
}
const sent = (host: TestPlatformHost, method: string, path: string) => host.requests.filter((r) => r.method === method && r.path === path);
const stateOf = () => JSON.parse(screen.getByTestId('where').getAttribute('data-state') ?? 'null') as unknown;

describe('The task builder page', () => {
  it('shows the thread beside the task so far, and a suggested answer sends it', async () => {
    const host = mount();
    expect(await screen.findByText('Does the amount change every month?')).toBeInTheDocument();
    const panel = screen.getByRole('complementary', { name: 'Task so far' });
    expect(within(panel).getByText('Pay {{Amount}} on the water site.')).toBeInTheDocument();
    expect(within(panel).getByText('{{Amount}} · money')).toBeInTheDocument();
    expect(within(panel).getByText('Which account pays?')).toBeInTheDocument();
    expect(within(panel).getByText('Keep the confirmation number as an output')).toBeInTheDocument();
    expect(within(panel).getByRole('switch', { name: /Confirm before purchases/ })).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'It changes' }));
    await waitFor(() => expect(sent(host, 'POST', `/task-builder/${ID}/messages`)[0]?.body).toEqual({ text: 'It changes' }));
  });

  it('changes the spec from the panel', async () => {
    const host = mount();
    const panel = await screen.findByRole('complementary', { name: 'Task so far' });
    fireEvent.click(within(panel).getByRole('switch', { name: /saved logins/ }));
    await waitFor(() => expect(sent(host, 'PATCH', `/task-builder/${ID}/spec`)[0]?.body).toEqual({ guardrails: { useSavedLogins: true } }));
    fireEvent.click(within(panel).getByLabelText('Remove parameter: {{Amount}} · money'));
    await waitFor(() => expect(sent(host, 'PATCH', `/task-builder/${ID}/spec`)[1]?.body).toEqual({ parameters: null }));
  });

  it('Create task drafts the task and opens the form with it, in the router state', async () => {
    const host = mount();
    await screen.findByText('Does the amount change every month?');
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/tasks/new'));
    expect(sent(host, 'POST', `/task-builder/${ID}/draft`)).toHaveLength(1);
    expect(stateOf()).toEqual({ builderId: ID, builderDraft: DRAFT });
  });

  it('Create task waits until the builder knows what the task does', async () => {
    mount({ responses: { [`GET /task-builder/${ID}`]: detail({ spec: {}, messages: [] }) } });
    expect(await screen.findByText(/What should this task do\?/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled();
  });

  it("a drafted task's card opens the form with the whole draft", async () => {
    const meta = { ...DRAFT, schedules: [{ cron: '0 9 1 * *', timezone: 'UTC', enabled: true, concurrency: 'skip', policyId: null }] };
    mount({ responses: { [`GET /task-builder/${ID}`]: detail({ messages: [message(1, { role: 'user', text: 'create' }), message(2, { kind: 'task_draft', text: DRAFT.goal, meta })] }) } });
    fireEvent.click(within(await screen.findByRole('article', { name: 'Task draft' })).getByRole('button', { name: 'Review and save' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/tasks/new'));
    expect(stateOf()).toEqual({ builderId: ID, builderDraft: meta });
  });

  it('is read-only once its task was saved', async () => {
    mount({ responses: { [`GET /task-builder/${ID}`]: detail({ status: 'archived' }) } });
    expect(await screen.findByText(/This builder's task was saved/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Message|Describe|Answer/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled();
  });

  it('puts the task so far in a tab on a phone', async () => {
    mount({ width: 390 });
    await screen.findByText('Does the amount change every month?');
    expect(screen.queryByRole('complementary', { name: 'Task so far' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Task so far' }));
    expect(screen.getByRole('complementary', { name: 'Task so far' })).toBeInTheDocument();
  });

  it('says so when the builder is not found', async () => {
    mount({ responses: { [`GET /task-builder/${ID}`]: () => Promise.reject(Object.assign(new Error('nf'), { status: 404 })) } });
    expect(await screen.findByText('This task builder was not found')).toBeInTheDocument();
  });
});

describe('specSections', () => {
  it('needs a goal; everything else is optional until it is known', () => {
    expect(specSections({}).map((s) => [s.key, s.state])).toEqual([['goal', 'missing'], ['where', 'optional'], ['parameters', 'optional'], ['outputs', 'optional'], ['guardrails', 'optional'], ['schedules', 'optional'], ['policy', 'optional']]);
    expect(specSections(SPEC).find((s) => s.key === 'parameters')!.state).toBe('done');
    expect(canCreate({})).toBe(false);
    expect(canCreate({ objective: 'x' })).toBe(true);
  });
});

describe('Build with AI', () => {
  it('on the New task page starts a builder with the typed goal and opens it', async () => {
    restoreViewport = mockViewport(1440);
    const { TaskCreatePage } = await import('../pages/TaskCreatePage');
    const { POLICY_READS } = await import('./policyFixtures');
    const host = createTestPlatformHost({ permissions: [...ALL, 'agent_policies:read', 'fleet:read'], responses: { ...POLICY_READS, 'GET /fleet/hosts': [], 'POST /task-builder': { id: ID }, [`GET /task-builder/${ID}`]: detail() } });
    render(
      <PlatformHostProvider host={host}>
        <MemoryRouter initialEntries={['/tasks/new?goal=Pay%20my%20water%20bill']}>
          <ConfirmProvider>
            <Routes>
              <Route path="/tasks/new" element={<TaskCreatePage />} />
              <Route path="/tasks/builder/:id" element={<div>builder page</div>} />
            </Routes>
            <Where />
          </ConfirmProvider>
        </MemoryRouter>
      </PlatformHostProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Build with AI' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`/tasks/builder/${ID}`));
    expect(sent(host, 'POST', '/task-builder')[0]?.body).toEqual({ seed: 'Pay my water bill' });
  });
});
