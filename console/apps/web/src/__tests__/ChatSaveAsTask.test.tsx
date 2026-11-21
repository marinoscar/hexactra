// Saving a chat as a task (#489): the button on a result, the card of a
// drafted task, the task form prefilled from the draft, and the line that
// links the saved task.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost, type TestApiRequest, type TestPlatformHost } from '@marinoscar/platform-web/testing';

vi.mock('../live', () => ({ subscribeChat: () => () => undefined, subscribeRun: () => () => undefined, fetchRunScreenshot: async () => null }));

import { draftOf } from '../components/ChatMessages';
import { ChatPage } from '../pages/ChatPage';
import { TaskCreatePage, valuesFromDraft } from '../pages/TaskCreatePage';
import type { ChatDetail, ChatMessage, ChatTaskDraft } from '../types/chat';
import { ConfirmProvider, ToastHost, dismissToast } from '../ui';
import { mockViewport } from './matchMedia';
import { POLICY_READS } from './policyFixtures';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const ALL = ['chat:read', 'chat:write', 'tasks:read', 'tasks:write', 'runs:read', 'runs:write', 'agent_policies:read', 'fleet:read'];
const CHAT_ID = '88888888-8888-4888-8888-888888888888';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const TASK_ID = '11111111-1111-4111-8111-111111111111';
const DRAFT: ChatTaskDraft = { name: 'Cinema tickets', goal: 'Book 2 tickets for the 7:30 PM showing at the usual cinema, middle rows.', profile: 'default', hostId: null, hostFallback: true, policyId: null, allowedDomains: ['cinema.example.test'], confirmRiskyActions: true };

const message = (seq: number, over: Partial<ChatMessage> = {}): ChatMessage => ({ id: `m${seq}`, seq, role: 'assistant', kind: 'text', text: `message ${seq}`, runId: null, meta: null, createdAt: '2026-11-17T10:00:00Z', ...over });
const result = (status = 'succeeded') => message(3, { kind: 'result', text: 'Booked seats F7 and F8.', runId: RUN_ID, meta: { status, stopReason: status === 'succeeded' ? 'finished' : 'error', costUsd: 0.2, costKnown: true, stepCount: 9 } });
const chat = (messages: ChatMessage[]): ChatDetail => ({
  id: CHAT_ID, title: 'Cinema', status: 'active', profile: 'default', hostId: null, hostFallback: true, policyId: null, allowedDomains: [], confirmRiskyActions: true,
  lastMessageAt: '2026-11-17T10:05:00Z', createdAt: '2026-11-17T10:00:00Z', updatedAt: '2026-11-17T10:05:00Z', messages, hasMore: false, liveRun: null, thinking: false,
});
const THREAD = [message(1, { role: 'user', text: 'Book two cinema tickets' }), message(2, { kind: 'run', text: 'Book 2 tickets.', runId: RUN_ID }), result()];

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

/** Where the router is, and what state it carries (the draft travels there, not in the URL). */
function Where() {
  const location = useLocation();
  return <div data-testid="where" data-state={JSON.stringify(location.state ?? null)}>{`${location.pathname}${location.search}`}</div>;
}

interface MountOptions {
  entry?: string | { pathname: string; state: unknown };
  messages?: ChatMessage[];
  responses?: Record<string, unknown>;
  permissions?: string[];
}
function mount({ entry = `/chat/${CHAT_ID}`, messages = THREAD, responses = {}, permissions = ALL }: MountOptions = {}): TestPlatformHost {
  restoreViewport = mockViewport(1440);
  const host = createTestPlatformHost({
    permissions,
    responses: {
      ...POLICY_READS,
      'GET /fleet/hosts': [],
      'GET /chats': { items: [], nextCursor: null },
      [`GET /chats/${CHAT_ID}`]: chat(messages),
      [`POST /chats/${CHAT_ID}/task-draft`]: DRAFT,
      [`POST /chats/${CHAT_ID}/task-link`]: message(9, { role: 'system', text: 'Saved as the task "Cinema tickets".', meta: { taskId: TASK_ID } }),
      'POST /tasks': (req: TestApiRequest) => ({ id: TASK_ID, ...(req.body as object) }),
      ...responses,
    },
  });
  render(
    <PlatformHostProvider host={host}>
      <MemoryRouter initialEntries={[entry]}>
        <ConfirmProvider>
          <Routes>
            <Route path="/chat/:id" element={<ChatPage />} />
            <Route path="/tasks/new" element={<TaskCreatePage />} />
            <Route path="/tasks/:id" element={<div>task page</div>} />
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
const where = () => screen.getByTestId('where');
const stateOf = () => JSON.parse(where().getAttribute('data-state') ?? 'null') as unknown;

describe('Save as task, on a result', () => {
  it('asks the AI for a draft, then opens the task form with it, in the router state and not in the URL', async () => {
    const host = mount();
    fireEvent.click(within(await screen.findByRole('article', { name: 'Result' })).getByRole('button', { name: 'Save as task' }));
    await waitFor(() => expect(where()).toHaveTextContent('/tasks/new'));
    expect(sent(host, 'POST', `/chats/${CHAT_ID}/task-draft`)).toHaveLength(1);
    expect(where().textContent).toBe('/tasks/new');
    expect(stateOf()).toEqual({ chatDraft: DRAFT, chatId: CHAT_ID });

    // The form holds every field of the draft.
    expect(await screen.findByLabelText(/^Name/)).toHaveValue('Cinema tickets');
    expect(screen.getByLabelText(/^Goal/)).toHaveValue(DRAFT.goal);
    expect(screen.getByText('cinema.example.test')).toBeInTheDocument();
    expect(screen.getByText('Drafted from your chat. Check it, change what you like, then save.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Chat/ })).toHaveAttribute('href', `/chat/${CHAT_ID}`);
  });

  it('is offered only on a run that succeeded, and only to someone who may write tasks', async () => {
    mount({ messages: [THREAD[0]!, THREAD[1]!, result('failed')] });
    expect(within(await screen.findByRole('article', { name: 'Result' })).queryByRole('button', { name: 'Save as task' })).not.toBeInTheDocument();
  });

  it('is not offered without tasks:write', async () => {
    mount({ permissions: ALL.filter((p) => p !== 'tasks:write') });
    const card = await screen.findByRole('article', { name: 'Result' });
    expect(within(card).queryByRole('button', { name: 'Save as task' })).not.toBeInTheDocument();
    // The rest of the card is unchanged.
    expect(within(card).getByRole('button', { name: 'Run again' })).toBeInTheDocument();
  });

  it('stays on the chat and says why when the draft could not be written', async () => {
    mount({ responses: { [`POST /chats/${CHAT_ID}/task-draft`]: () => Promise.reject(createTestApiError(500, 'The draft could not be written')) } });
    fireEvent.click(within(await screen.findByRole('article', { name: 'Result' })).getByRole('button', { name: 'Save as task' }));
    expect(await screen.findByText('The draft could not be written')).toBeInTheDocument();
    expect(where()).toHaveTextContent(`/chat/${CHAT_ID}`);
    expect(await within(screen.getByRole('article', { name: 'Result' })).findByRole('button', { name: 'Save as task' })).toBeEnabled();
  });
});

describe('a task the assistant drafted', () => {
  const draftMessage = message(4, { kind: 'task_draft', text: DRAFT.goal, meta: { ...DRAFT } });

  it('shows its name and goal, and Review and save opens the form with it', async () => {
    const host = mount({ messages: [...THREAD, draftMessage] });
    const card = await screen.findByRole('article', { name: 'Task draft' });
    expect(card).toHaveTextContent('Cinema tickets');
    expect(card).toHaveTextContent(DRAFT.goal);
    fireEvent.click(within(card).getByRole('button', { name: 'Review and save' }));
    await waitFor(() => expect(where()).toHaveTextContent('/tasks/new'));
    expect(stateOf()).toEqual({ chatDraft: DRAFT, chatId: CHAT_ID });
    // The draft is in the message: no second request to the AI.
    expect(sent(host, 'POST', `/chats/${CHAT_ID}/task-draft`)).toHaveLength(0);
  });

  it('has no button without tasks:write', async () => {
    mount({ messages: [...THREAD, draftMessage], permissions: ALL.filter((p) => p !== 'tasks:write') });
    expect(within(await screen.findByRole('article', { name: 'Task draft' })).queryByRole('button', { name: 'Review and save' })).not.toBeInTheDocument();
  });

  it('reads a draft from the message, with safe defaults for what an older or odd message lacks', () => {
    expect(draftOf(draftMessage)).toEqual(DRAFT);
    expect(draftOf(message(4, { kind: 'task_draft', text: 'Do the thing', meta: null }))).toEqual({ name: '', goal: 'Do the thing', profile: 'default', hostId: null, hostFallback: true, policyId: null, allowedDomains: [], confirmRiskyActions: false });
    expect(draftOf(message(4, { kind: 'task_draft', text: 'x', meta: { goal: 'y', allowedDomains: ['a.test', 7], hostId: 5 } }))).toMatchObject({ goal: 'y', allowedDomains: ['a.test'], hostId: null });
    expect(draftOf(message(4, { kind: 'task_draft', text: '  ', meta: null }))).toBeNull();
    expect(draftOf(message(4, { kind: 'text', text: 'hello' }))).toBeNull();
  });
});

describe('the task form, opened from a chat', () => {
  it('saves the task as drafted, tells the chat, and goes to the task', async () => {
    const host = mount({ entry: { pathname: '/tasks/new', state: { chatDraft: DRAFT, chatId: CHAT_ID } } });
    expect(await screen.findByLabelText(/^Name/)).toHaveValue('Cinema tickets');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent(host, 'POST', '/tasks')).toHaveLength(1));
    expect(sent(host, 'POST', '/tasks')[0]!.body).toMatchObject({ name: 'Cinema tickets', goal: DRAFT.goal, profile: 'default', hostFallback: true, allowedDomains: ['cinema.example.test'], confirmRiskyActions: true });
    await waitFor(() => expect(sent(host, 'POST', `/chats/${CHAT_ID}/task-link`)[0]?.body).toEqual({ taskId: TASK_ID }));
    await waitFor(() => expect(where()).toHaveTextContent(`/tasks/${TASK_ID}`));
  });

  it('still saves the task when the chat cannot be told', async () => {
    const host = mount({ entry: { pathname: '/tasks/new', state: { chatDraft: DRAFT, chatId: CHAT_ID } }, responses: { [`POST /chats/${CHAT_ID}/task-link`]: () => Promise.reject(createTestApiError(500, 'chat is away')) } });
    await screen.findByLabelText(/^Name/);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(where()).toHaveTextContent(`/tasks/${TASK_ID}`));
    expect(sent(host, 'POST', '/tasks')).toHaveLength(1);
  });

  it('opened without a chat is the plain new-task form, and tells no chat', async () => {
    const host = mount({ entry: '/tasks/new?goal=Read%20my%20balance' });
    expect(await screen.findByLabelText(/^Goal/)).toHaveValue('Read my balance');
    expect(screen.queryByText(/Drafted from your chat/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Tasks/ })).toHaveAttribute('href', '/tasks');
    expect(host.requests.some((r) => r.path.includes('task-link'))).toBe(false);
  });

  it('preselects the accounts the chat used (E41.5), says where they came from, and lists them only when saved', async () => {
    const CONN = '55555555-5555-4555-8555-555555555555';
    const draft = { ...DRAFT, connections: [{ connectionId: CONN, access: 'read_write' as const }] };
    expect(valuesFromDraft(draft).connections).toEqual([{ connectionId: CONN, access: 'read_write' }]);
    expect(valuesFromDraft(DRAFT).connections).toEqual([]);
    const host = mount({ entry: { pathname: '/tasks/new', state: { chatDraft: draft, chatId: CHAT_ID } } });
    expect(await screen.findByText('Taken from the chat: check which accounts this task may use.')).toBeInTheDocument();
    // Nothing is written until Save.
    expect(sent(host, 'POST', '/tasks')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent(host, 'POST', '/tasks')).toHaveLength(1));
    expect(sent(host, 'POST', '/tasks')[0]!.body).toMatchObject({ connections: [{ connectionId: CONN, access: 'read_write' }] });
  });

  it('maps a draft to form values, clipping what is too long and ignoring what is not a draft', () => {
    expect(valuesFromDraft(DRAFT)).toMatchObject({ name: 'Cinema tickets', goal: DRAFT.goal, allowedDomains: ['cinema.example.test'], confirmRiskyActions: true, schedules: [] });
    const long = valuesFromDraft({ ...DRAFT, name: 'n'.repeat(500), goal: 'g'.repeat(9000) });
    expect(long.name).toHaveLength(200);
    expect(long.goal).toHaveLength(4000);
  });
});

describe('the saved task, in the thread', () => {
  it('is a line that links to the task', async () => {
    mount({ messages: [...THREAD, message(5, { role: 'system', text: 'Saved as the task "Cinema tickets".', meta: { taskId: TASK_ID } })] });
    const line = await screen.findByText(/Saved as the task "Cinema tickets"\./);
    expect(within(line).getByRole('link', { name: 'Open the task' })).toHaveAttribute('href', `/tasks/${TASK_ID}`);
  });

  it('a plain system line has no link', async () => {
    mount({ messages: [...THREAD, message(5, { role: 'system', text: 'The AI could not answer.' })] });
    const line = await screen.findByText('The AI could not answer.');
    expect(within(line).queryByRole('link')).not.toBeInTheDocument();
  });
});
