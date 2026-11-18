// The chat page (#486): the list, the new-chat screen, the thread and its
// composer, the live updates, rename / archive / delete, permissions and the
// layout at a phone, a tablet and a desktop width.
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost, type TestApiRequest, type TestPlatformHost } from '@marinoscar/platform-web/testing';

import type { ChatStreamEvent } from '../live';

// The page's event stream, driven by the test: `stream.emit` is what the server would send.
const stream = vi.hoisted(() => ({ listeners: new Map<string, (e: unknown) => void>(), afterSeq: new Map<string, number>(), closed: [] as string[] }));
vi.mock('../live', () => ({
  subscribeChat: (id: string, afterSeq: number, onEvent: (e: unknown) => void) => {
    stream.listeners.set(id, onEvent);
    stream.afterSeq.set(id, afterSeq);
    return () => {
      stream.listeners.delete(id);
      stream.closed.push(id);
    };
  },
  subscribeRun: () => () => undefined,
  fetchRunScreenshot: async () => null,
}));

import { ChatPage } from '../pages/ChatPage';
import type { Chat, ChatDetail, ChatListItem, ChatMessage } from '../types/chat';
import { ConfirmProvider, ToastHost, dismissToast } from '../ui';
import { mockViewport } from './matchMedia';
import { POLICY_READS } from './policyFixtures';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const ALL = ['chat:read', 'chat:write', 'runs:read', 'agent_policies:read', 'fleet:read'];
const CHAT_ID = '88888888-8888-4888-8888-888888888888';
const OTHER_ID = '88888888-8888-4888-8888-888888888881';
const NEW_ID = '88888888-8888-4888-8888-88888888888f';

const base: Chat = { id: CHAT_ID, title: 'Cinema tickets', status: 'active', profile: 'default', hostId: null, hostFallback: true, policyId: null, allowedDomains: [], confirmRiskyActions: true, lastMessageAt: '2026-11-17T10:05:00Z', createdAt: '2026-11-17T10:00:00Z', updatedAt: '2026-11-17T10:05:00Z' };
const message = (seq: number, over: Partial<ChatMessage> = {}): ChatMessage => ({ id: `m${seq}`, seq, role: 'user', kind: 'text', text: `message ${seq}`, runId: null, meta: null, createdAt: '2026-11-17T10:00:00Z', ...over });
const THREAD = [message(1, { text: 'Book two cinema tickets' }), message(2, { role: 'assistant', kind: 'clarify', text: 'Which showing?', meta: { options: ['4:30 PM', '7:30 PM'] } })];
const detail = (over: Partial<ChatDetail> = {}): ChatDetail => ({ ...base, messages: THREAD, hasMore: false, liveRun: null, thinking: false, ...over });
const row = (over: Partial<ChatListItem> = {}): ChatListItem => ({ ...base, preview: { role: 'assistant', kind: 'clarify', text: 'Which showing?' }, liveRun: null, ...over });
const ROWS = [row(), row({ id: OTHER_ID, title: '', preview: null, liveRun: { id: 'r1', status: 'running' } })];

let restoreViewport: (() => void) | null = null;
beforeAll(() => {
  // jsdom has no layout: the thread's "scroll to the end" has nothing to do.
  Element.prototype.scrollTo = () => undefined;
});
afterEach(() => {
  restoreViewport?.();
  restoreViewport = null;
  stream.listeners.clear();
  stream.afterSeq.clear();
  stream.closed.length = 0;
  dismissToast();
});

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname}</div>;
}

interface MountOptions {
  entry?: string;
  responses?: Record<string, unknown>;
  permissions?: string[];
  width?: number;
}
function mount({ entry = `/chat/${CHAT_ID}`, responses = {}, permissions = ALL, width = 1440 }: MountOptions = {}): TestPlatformHost {
  restoreViewport = mockViewport(width);
  let seq = 100;
  const host = createTestPlatformHost({
    permissions,
    responses: {
      ...POLICY_READS,
      'GET /fleet/hosts': [],
      'GET /chats': (req: TestApiRequest) => ({ items: req.path.includes('status=archived') ? [] : ROWS, nextCursor: null }),
      [`GET /chats/${CHAT_ID}`]: detail(),
      [`GET /chats/${NEW_ID}`]: detail({ id: NEW_ID, title: 'Find a stroller', messages: [message(1, { text: 'Find a stroller' })] }),
      'POST /chats': { ...base, id: NEW_ID, title: '' },
      [`POST /chats/${CHAT_ID}/messages`]: (req: TestApiRequest) => message(++seq, { text: (req.body as { text: string }).text }),
      [`POST /chats/${NEW_ID}/messages`]: (req: TestApiRequest) => message(1, { text: (req.body as { text: string }).text }),
      [`PATCH /chats/${CHAT_ID}`]: (req: TestApiRequest) => ({ ...base, ...(req.body as Partial<Chat>) }),
      [`DELETE /chats/${CHAT_ID}`]: null,
      ...responses,
    },
  });
  render(
    <PlatformHostProvider host={host}>
      <MemoryRouter initialEntries={[entry]}>
        <ConfirmProvider>
          <Routes>
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/chat/new" element={<ChatPage />} />
            <Route path="/chat/:id" element={<ChatPage />} />
            <Route path="/runs/:id" element={<div>run page</div>} />
          </Routes>
          <Where />
        </ConfirmProvider>
        <ToastHost />
      </MemoryRouter>
    </PlatformHostProvider>,
  );
  return host;
}

const emit = (id: string, event: ChatStreamEvent) => act(() => stream.listeners.get(id)?.(event));
const sent = (host: TestPlatformHost, method: string, path: string) => host.requests.filter((r) => r.method === method && r.path === path);
const composer = () => screen.getByRole('textbox', { name: 'Message' });
const type = (text: string) => fireEvent.change(composer(), { target: { value: text } });
const thread = () => screen.getByRole('log', { name: 'Messages' });

describe('the thread', () => {
  it('shows the messages, follows the stream from the newest one it holds, and adds what arrives once', async () => {
    mount();
    expect(await within(thread()).findByText('Book two cinema tickets')).toBeInTheDocument();
    expect(within(thread()).getByText('Which showing?')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Cinema tickets' })).toBeInTheDocument();
    await waitFor(() => expect(stream.afterSeq.get(CHAT_ID)).toBe(2));

    emit(CHAT_ID, { type: 'message', data: message(3, { role: 'assistant', text: 'On it.' }) });
    // A reconnect resends from where the page subscribed: the same message again changes nothing.
    emit(CHAT_ID, { type: 'message', data: message(3, { role: 'assistant', text: 'On it.' }) });
    expect(within(thread()).getAllByText('On it.')).toHaveLength(1);

    emit(CHAT_ID, { type: 'chat', data: { title: 'Tickets for tonight', status: 'active' } });
    expect(screen.getByRole('heading', { level: 1, name: 'Tickets for tonight' })).toBeInTheDocument();
  });

  it('sends a message with Enter, clears the field, shows the message and the typing indicator until an answer arrives', async () => {
    const host = mount();
    await within(thread()).findByText('Which showing?');
    type('7:30 PM please');
    fireEvent.keyDown(composer(), { key: 'Enter' });

    expect(await within(thread()).findByText('7:30 PM please')).toBeInTheDocument();
    expect(sent(host, 'POST', `/chats/${CHAT_ID}/messages`)[0]!.body).toEqual({ text: '7:30 PM please' });
    expect(composer()).toHaveValue('');
    expect(screen.getByRole('status', { name: 'The assistant is working' })).toBeInTheDocument();

    emit(CHAT_ID, { type: 'message', data: message(200, { role: 'assistant', text: 'Booking it now.' }) });
    await waitFor(() => expect(screen.queryByRole('status', { name: 'The assistant is working' })).not.toBeInTheDocument());
  });

  it('breaks the line with Shift+Enter, and sends nothing for an empty message', async () => {
    const host = mount();
    await within(thread()).findByText('Which showing?');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    type('first line');
    fireEvent.keyDown(composer(), { key: 'Enter', shiftKey: true });
    type('   ');
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(sent(host, 'POST', `/chats/${CHAT_ID}/messages`)).toHaveLength(0);
  });

  it('follows the turn event: the typing indicator and the line under the title', async () => {
    mount({ responses: { [`GET /chats/${CHAT_ID}`]: detail({ thinking: true }) } });
    expect(await screen.findByRole('status', { name: 'The assistant is working' })).toBeInTheDocument();
    expect(screen.getByText('Thinking…')).toBeInTheDocument();
    emit(CHAT_ID, { type: 'turn', data: { thinking: false } });
    expect(screen.queryByRole('status', { name: 'The assistant is working' })).not.toBeInTheDocument();
    emit(CHAT_ID, { type: 'run', data: { run: { id: 'r1', status: 'running' } } });
    expect(screen.getByText('Working in the browser…')).toBeInTheDocument();
    emit(CHAT_ID, { type: 'run', data: { run: { id: 'r1', status: 'waiting_human' } } });
    expect(screen.getByText('Waiting for you')).toBeInTheDocument();
  });

  it('answers a clarifying question with one of its chips; only the newest message offers them', async () => {
    const host = mount();
    const chips = await screen.findByRole('group', { name: 'Suggested answers' });
    fireEvent.click(within(chips).getByRole('button', { name: '7:30 PM' }));
    await waitFor(() => expect(sent(host, 'POST', `/chats/${CHAT_ID}/messages`)[0]?.body).toEqual({ text: '7:30 PM' }));
    // Answered: the question is no longer the newest message, so its chips are no longer buttons.
    await within(thread()).findByText('7:30 PM', { selector: 'p' });
    expect(within(chips).queryByRole('button', { name: '4:30 PM' })).not.toBeInTheDocument();
  });

  it('renders a run, its result and a system line, each with what it is', async () => {
    mount({
      responses: {
        [`GET /chats/${CHAT_ID}`]: detail({
          messages: [
            message(1, { role: 'assistant', kind: 'run', text: 'Book 2 tickets for 7:30 PM', runId: 'run-1' }),
            message(2, { role: 'assistant', kind: 'result', text: 'Booked seats F7 and F8.', runId: 'run-1', meta: { status: 'succeeded' } }),
            message(3, { role: 'assistant', kind: 'result', text: 'The site was down.', runId: null, meta: { status: 'failed' } }),
            message(4, { role: 'system', text: 'The AI could not answer (rate_limited).' }),
          ],
        }),
      },
    });
    expect(await screen.findByText('Started a browser run')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('Could not finish')).toBeInTheDocument();
    expect(screen.getByText('The AI could not answer (rate_limited).')).toHaveAttribute('role', 'status');
    // A link to the run while the message still has one (a deleted run leaves the text).
    expect(screen.getAllByRole('link', { name: /Open run/ }).map((a) => a.getAttribute('href'))).toEqual(['/runs/run-1', '/runs/run-1']);
  });

  it('says so when the chat does not exist, and shows a load error', async () => {
    mount({ responses: { [`GET /chats/${CHAT_ID}`]: () => Promise.reject(createTestApiError(404, 'Chat not found', 'CHAT_NOT_FOUND')) } });
    expect(await screen.findByText('This chat does not exist')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start a new chat' })).toHaveAttribute('href', '/chat/new');
  });

  it('keeps what was typed and shows why when a send fails', async () => {
    mount({ responses: { [`POST /chats/${CHAT_ID}/messages`]: () => Promise.reject(createTestApiError(500, 'The database is away')) } });
    await within(thread()).findByText('Which showing?');
    type('7:30 PM');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('The database is away')).toBeInTheDocument();
    expect(composer()).toHaveValue('7:30 PM');
  });
});

describe('a new chat', () => {
  it('offers examples that fill the field, and its first message creates the chat and opens it', async () => {
    const host = mount({ entry: '/chat' });
    expect(await screen.findByRole('heading', { name: 'What should I do?' })).toBeInTheDocument();
    const examples = screen.getByRole('group', { name: 'Examples' });
    fireEvent.click(within(examples).getAllByRole('button')[1]!);
    expect(composer()).toHaveValue('Check when my next electricity bill is due and how much it is.');

    type('Find a stroller');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`/chat/${NEW_ID}`));
    expect(sent(host, 'POST', '/chats')).toHaveLength(1);
    expect(sent(host, 'POST', `/chats/${NEW_ID}/messages`)[0]!.body).toEqual({ text: 'Find a stroller' });
    expect(await within(thread()).findByText('Find a stroller')).toBeInTheDocument();
  });
});

describe('the list', () => {
  it('lists the chats with a preview and the live dot, marks the open one, and filters archived', async () => {
    const host = mount();
    const nav = await screen.findByRole('navigation', { name: 'Chats' });
    const open = await within(nav).findByRole('link', { name: /Cinema tickets/ });
    expect(open).toHaveAttribute('aria-current', 'page');
    expect(open).toHaveTextContent('Which showing?');
    // An untitled chat is called "New chat", like the button above the list: find its row by where it goes.
    const untitled = within(nav).getAllByRole('link').find((a) => a.getAttribute('href') === `/chat/${OTHER_ID}`)!;
    expect(untitled).toHaveTextContent('New chat');
    expect(untitled).toHaveTextContent('No messages yet');
    expect(within(untitled).getByRole('img', { name: 'A run is live' })).toBeInTheDocument();

    fireEvent.click(within(nav).getByRole('button', { name: 'Archived' }));
    expect(await within(nav).findByText('No archived chats')).toBeInTheDocument();
    expect(host.requests.some((r) => r.path.startsWith('/chats?status=archived'))).toBe(true);
  });

  it('renames from a row menu', async () => {
    const host = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Cinema tickets' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename chat' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Friday film' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent(host, 'PATCH', `/chats/${CHAT_ID}`)[0]?.body).toEqual({ title: 'Friday film' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Friday film' })).toBeInTheDocument();
  });
});

describe('the chat menu', () => {
  const openMenu = async () => fireEvent.click(await screen.findByRole('button', { name: 'Chat actions' }));

  it('archives: the composer gives way to a read-only note with Unarchive', async () => {
    const host = mount();
    await openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(sent(host, 'PATCH', `/chats/${CHAT_ID}`)[0]?.body).toEqual({ status: 'archived' }));
    expect(await screen.findByText('This chat is archived. It is read-only.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
    // Under the title (the list has an "Archived" filter of its own).
    expect(within(screen.getByRole('region', { name: 'Cinema tickets' })).getByText('Archived')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
    await waitFor(() => expect(sent(host, 'PATCH', `/chats/${CHAT_ID}`)[1]?.body).toEqual({ status: 'active' }));
    expect(await screen.findByRole('textbox', { name: 'Message' })).toBeInTheDocument();
  });

  it('opens an archived chat read-only, with chips that cannot be tapped', async () => {
    mount({ responses: { [`GET /chats/${CHAT_ID}`]: detail({ status: 'archived' }) } });
    expect(await screen.findByText('This chat is archived. It is read-only.')).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Suggested answers' })).queryByRole('button')).not.toBeInTheDocument();
  });

  it('deletes after a confirmation and leaves for the new-chat screen; cancel deletes nothing', async () => {
    const host = mount();
    await openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    let dialog = await screen.findByRole('dialog', { name: 'Delete this chat?' });
    expect(dialog).toHaveTextContent('"Cinema tickets", its messages and its runs are deleted.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete this chat?' })).not.toBeInTheDocument());
    expect(sent(host, 'DELETE', `/chats/${CHAT_ID}`)).toHaveLength(0);

    await openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    dialog = await screen.findByRole('dialog', { name: 'Delete this chat?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(sent(host, 'DELETE', `/chats/${CHAT_ID}`)).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/chat/new'));
  });

  it('says why a chat with a live run cannot be deleted', async () => {
    mount({ responses: { [`DELETE /chats/${CHAT_ID}`]: () => Promise.reject(createTestApiError(409, 'A run of this chat is still live. Stop it first', 'CHAT_RUN_LIVE')) } });
    await openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete this chat?' })).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('A run of this chat is still live. Stop it first')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent(`/chat/${CHAT_ID}`);
  });

  it('saves the chat settings: the purchase confirmation and the rest of the run settings', async () => {
    const host = mount();
    await openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Chat settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Chat settings' });
    const confirmSwitch = within(dialog).getByRole('switch', { name: /Ask me before a purchase/ });
    expect(confirmSwitch).toBeChecked();
    fireEvent.click(confirmSwitch);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent(host, 'PATCH', `/chats/${CHAT_ID}`)[0]?.body).toEqual({ profile: 'default', hostId: null, hostFallback: true, policyId: null, allowedDomains: [], confirmRiskyActions: false }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Chat settings' })).not.toBeInTheDocument());
  });
});

describe('permissions', () => {
  it('without chat:write there is no composer, no New chat, no menus and no chips to tap', async () => {
    mount({ permissions: ['chat:read'] });
    await within(thread()).findByText('Which showing?');
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New chat' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Chat actions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Actions for/ })).not.toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Suggested answers' })).queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('layout', () => {
  it('on a phone, /chat is the list alone and a chat is the thread alone with a way back', async () => {
    mount({ entry: '/chat', width: 390 });
    expect(await screen.findByRole('navigation', { name: 'Chats' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New chat' })).toHaveAttribute('href', '/chat/new');

    fireEvent.click(await screen.findByRole('link', { name: /Cinema tickets/ }));
    await within(await screen.findByRole('log', { name: 'Messages' })).findByText('Which showing?');
    expect(screen.queryByRole('navigation', { name: 'Chats' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to chats' })).toHaveAttribute('href', '/chat');
    expect(composer()).toBeInTheDocument();
  });

  it('on a phone, /chat/new is the new-chat screen, and Enter breaks the line instead of sending', async () => {
    const host = mount({ entry: '/chat/new', width: 390 });
    expect(await screen.findByRole('heading', { name: 'What should I do?' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Chats' })).not.toBeInTheDocument();
    type('Find a stroller');
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(sent(host, 'POST', '/chats')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sent(host, 'POST', '/chats')).toHaveLength(1));
  });

  it('on a tablet the list is a drawer behind "Show chats"', async () => {
    mount({ width: 768 });
    await within(thread()).findByText('Which showing?');
    expect(screen.queryByRole('navigation', { name: 'Chats' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show chats' }));
    expect(await screen.findByRole('navigation', { name: 'Chats' })).toBeInTheDocument();
  });

  it('on a desktop the list is beside the thread', async () => {
    mount({ width: 1440 });
    await within(thread()).findByText('Which showing?');
    expect(screen.getByRole('navigation', { name: 'Chats' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show chats' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Back to chats' })).not.toBeInTheDocument();
  });

  it('closes the stream of the chat it leaves', async () => {
    mount();
    await waitFor(() => expect(stream.listeners.has(CHAT_ID)).toBe(true));
    fireEvent.click(await screen.findByRole('link', { name: 'New chat' }));
    await waitFor(() => expect(stream.closed).toContain(CHAT_ID));
  });
});
