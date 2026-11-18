// The agent's requests in the chat (#488): an approval, a code or a password,
// a choice and a takeover are answered in the thread; a secret leaves nothing
// behind; a request that ends some other way says so where it was.
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost, type TestPlatformHost } from '@marinoscar/platform-web/testing';

import type { ChatStreamEvent } from '../live';

const live = vi.hoisted(() => ({ chat: new Map<string, (e: unknown) => void>(), shots: 0 }));
vi.mock('../live', () => ({
  subscribeChat: (id: string, _afterSeq: number, onEvent: (e: unknown) => void) => {
    live.chat.set(id, onEvent);
    return () => void live.chat.delete(id);
  },
  subscribeRun: () => () => undefined,
  fetchRunScreenshot: async () => {
    live.shots += 1;
    return 'blob:frame';
  },
}));

import { requestTitle, settledText } from '../components/ChatRequest';
import type { Question } from '../components/questions';
import { ChatPage } from '../pages/ChatPage';
import type { ChatDetail, ChatMessage } from '../types/chat';
import { ConfirmProvider, ToastHost, dismissToast } from '../ui';
import { mockViewport } from './matchMedia';
import { POLICY_READS } from './policyFixtures';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const ALL = ['chat:read', 'chat:write', 'runs:read', 'runs:write', 'fleet:read', 'fleet:desktop'];
const CHAT_ID = '88888888-8888-4888-8888-888888888888';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const Q_ID = '55555555-5555-4555-8555-555555555555';
const SECRET = '918273';

const message = (seq: number, over: Partial<ChatMessage> = {}): ChatMessage => ({ id: `m${seq}`, seq, role: 'assistant', kind: 'text', text: `message ${seq}`, runId: null, meta: null, createdAt: '2026-11-17T10:00:00Z', ...over });
const CHAT: ChatDetail = {
  id: CHAT_ID, title: 'Cinema tickets', status: 'active', profile: 'default', hostId: null, hostFallback: true, policyId: null, allowedDomains: [], confirmRiskyActions: true,
  lastMessageAt: '2026-11-17T10:05:00Z', createdAt: '2026-11-17T10:00:00Z', updatedAt: '2026-11-17T10:05:00Z',
  messages: [message(1, { role: 'user', text: 'Book two cinema tickets' }), message(2, { kind: 'run', text: 'Book 2 tickets.', runId: RUN_ID })],
  hasMore: false, liveRun: { id: RUN_ID, status: 'waiting_human' }, thinking: false,
};
const question = (over: Partial<Question> = {}): Question => ({
  id: Q_ID, askedBy: `run:${RUN_ID}`, runId: RUN_ID, handoffId: 'h1', browserBound: true, prompt: 'Place the order for $28.00?', status: 'pending', response: null, pageTitle: 'Checkout · cinema.example.test',
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), answeredAt: null,
  kind: 'confirmation', input: 'confirm', options: null, constraints: null, confirmLabel: 'Allow', denyLabel: 'Deny', risk: 'low', viewerUrl: null, ...over,
});

let restoreViewport: (() => void) | null = null;
beforeAll(() => {
  Element.prototype.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  URL.revokeObjectURL = () => undefined;
});
afterEach(() => {
  restoreViewport?.();
  restoreViewport = null;
  live.chat.clear();
  live.shots = 0;
  dismissToast();
});

function mount(responses: Record<string, unknown> = {}, permissions: string[] = ALL, width = 1440): TestPlatformHost {
  restoreViewport = mockViewport(width);
  const host = createTestPlatformHost({
    permissions,
    responses: {
      ...POLICY_READS,
      'GET /fleet/hosts': [],
      'GET /chats': { items: [], nextCursor: null },
      [`GET /chats/${CHAT_ID}`]: CHAT,
      [`POST /questions/${Q_ID}/answer`]: {},
      [`POST /questions/${Q_ID}/cancel`]: {},
      [`GET /runs/${RUN_ID}/viewer`]: { hostId: null, hostName: null, desktop: false },
      ...responses,
    },
  });
  render(
    <PlatformHostProvider host={host}>
      <MemoryRouter initialEntries={[`/chat/${CHAT_ID}`]}>
        <ConfirmProvider>
          <Routes>
            <Route path="/chat/:id" element={<ChatPage />} />
            <Route path="*" element={<div>elsewhere</div>} />
          </Routes>
        </ConfirmProvider>
        <ToastHost />
      </MemoryRouter>
    </PlatformHostProvider>,
  );
  return host;
}

const emit = (event: ChatStreamEvent) => act(() => live.chat.get(CHAT_ID)?.(event));
const ask = async (q: Question) => {
  await screen.findByRole('article', { name: 'Browser run' });
  emit({ type: 'question', data: { question: q } });
  return screen.findByRole('article', { name: `Request: ${q.prompt}` });
};
const sent = (host: TestPlatformHost, path: string) => host.requests.filter((r) => r.method === 'POST' && r.path === path);

describe('an approval', () => {
  it('shows what is asked, on which page, a picture of it and Deny / Allow; Allow answers in the thread', async () => {
    const host = mount();
    const card = await ask(question());
    expect(card).toHaveTextContent('Approval needed');
    expect(card).toHaveTextContent('Place the order for $28.00?');
    expect(card).toHaveTextContent('on “Checkout · cinema.example.test”');
    expect(within(card).getByLabelText('Time left')).toHaveTextContent(/left$/);
    expect(await within(card).findByRole('img', { name: 'The browser right now' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Deny' })).toBeInTheDocument();

    fireEvent.click(within(card).getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(sent(host, `/questions/${Q_ID}/answer`)[0]?.body).toEqual({ outcome: 'completed', value: 'approve', channel: 'web' }));
    // The card gives way to one line; the form does not come back while the server still lists the request.
    expect(await screen.findByText('Allowed')).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: /^Request:/ })).not.toBeInTheDocument();
    emit({ type: 'question', data: { question: null } });
    expect(screen.getByText('Allowed')).toBeInTheDocument();
  });

  it('Deny answers no; a high-risk approval is marked and asks twice', async () => {
    const host = mount();
    const card = await ask(question({ risk: 'high' }));
    expect(within(card).getByText('High risk')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Allow' }));
    expect(sent(host, `/questions/${Q_ID}/answer`)).toHaveLength(0);
    fireEvent.click(await within(card).findByRole('button', { name: 'Yes, Allow' }));
    await waitFor(() => expect(sent(host, `/questions/${Q_ID}/answer`)).toHaveLength(1));
  });

  it('Review opens the browser large', async () => {
    mount();
    const card = await ask(question());
    fireEvent.click(await within(card).findByRole('button', { name: 'Review' }));
    expect(await screen.findByRole('region', { name: 'Browser' })).toBeInTheDocument();
  });
});

describe('a code or a password', () => {
  const code = () => question({ kind: 'code', input: 'secret', prompt: 'Enter the code sent to your phone', confirmLabel: null, denyLabel: null, risk: null, pageTitle: 'Sign in · bank.example.test', viewerUrl: 'https://console.example.test/fleet/hosts/44444444-4444-4444-8444-444444444444/desktop' });

  it('is asked in the thread; the value goes to the answer route once and is nowhere on the page after', async () => {
    const host = mount();
    const card = await ask(code());
    expect(card).toHaveTextContent('Code needed');
    expect(card).toHaveTextContent('on “Sign in · bank.example.test”');
    // No picture of the page while a secret is asked for, in this card or in the Browser card.
    expect(screen.queryByRole('img', { name: 'The browser right now' })).not.toBeInTheDocument();
    const field = within(card).getByLabelText(/Code/);
    expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    fireEvent.change(field, { target: { value: SECRET } });
    fireEvent.click(within(card).getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(sent(host, `/questions/${Q_ID}/answer`)[0]?.body).toEqual({ outcome: 'completed', value: SECRET, channel: 'web' }));
    expect(await screen.findByText('Provided')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect([...document.querySelectorAll('input, textarea')].some((el) => (el as HTMLInputElement).value === SECRET)).toBe(false);
    // Sent once, to that one route.
    expect(host.requests.filter((r) => JSON.stringify(r.body ?? '').includes(SECRET))).toHaveLength(1);
  });

  it('asks for a sign-in username as its own card, with a field a password manager can fill (#524)', async () => {
    const host = mount();
    const card = await ask(question({ kind: 'login', input: 'text', prompt: 'Your Example Bank username', confirmLabel: null, denyLabel: null, risk: null, pageTitle: 'Sign in · bank.example.test' }));
    expect(card).toHaveTextContent('Sign-in needed');
    const field = within(card).getByLabelText('Username or email');
    expect(field).toHaveAttribute('autocomplete', 'username');
    expect(field).toHaveAttribute('autocapitalize', 'none');
    fireEvent.change(field, { target: { value: 'oscar' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sent(host, `/questions/${Q_ID}/answer`)[0]?.body).toEqual({ outcome: 'completed', value: 'oscar', channel: 'web' }));
  });

  it('asks for the password as a masked field that the browser does not offer to save', async () => {
    mount();
    const card = await ask(question({ kind: 'login', input: 'secret', prompt: 'Your Example Bank password', confirmLabel: null, denyLabel: null, risk: null }));
    expect(card).toHaveTextContent('Password needed');
    const field = within(card).getByLabelText(/Password/);
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('autocomplete', 'new-password');
  });

  it('asks for a sign-in in one card: username, password and the site\'s "remember me", ticked by default (#527)', async () => {
    const host = mount();
    const card = await ask(question({ kind: 'login', input: 'credentials', prompt: 'Sign in to Example Bank', confirmLabel: null, denyLabel: null, risk: null, pageTitle: 'Log in · bank.example.test', rememberLabel: 'Keep me signed in' }));
    expect(card).toHaveTextContent('Sign-in needed');
    // No picture of the page while a sign-in is asked for.
    expect(screen.queryByRole('img', { name: 'The browser right now' })).not.toBeInTheDocument();
    const user = within(card).getByLabelText('Username or email');
    const pass = within(card).getByLabelText(/^Password/);
    expect(user).toHaveAttribute('autocomplete', 'username');
    expect(pass).toHaveAttribute('type', 'password');
    // The phone's password manager may fill a site's password here.
    expect(pass).toHaveAttribute('autocomplete', 'current-password');
    const remember = within(card).getByRole('checkbox', { name: 'Keep me signed in' });
    expect(remember).toBeChecked();
    const signIn = within(card).getByRole('button', { name: 'Sign in' });
    expect(signIn).toBeDisabled();
    fireEvent.change(user, { target: { value: ' oscar ' } });
    expect(signIn).toBeDisabled();
    fireEvent.change(pass, { target: { value: SECRET } });
    fireEvent.click(signIn);

    await waitFor(() => expect(sent(host, `/questions/${Q_ID}/answer`)[0]?.body).toEqual({ outcome: 'completed', value: 'oscar', secret: SECRET, remember: true, channel: 'web' }));
    expect(await screen.findByText('Provided · Remembered on this device')).toBeInTheDocument();
    // Neither value stays on the page.
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(document.body.innerHTML).not.toContain('oscar');
    expect(host.requests.filter((r) => JSON.stringify(r.body ?? '').includes(SECRET))).toHaveLength(1);
  });

  it('sends "remember me" unticked when the person unticks it, and no choice when the site offered none', async () => {
    const host = mount();
    let card = await ask(question({ kind: 'login', input: 'credentials', prompt: 'Sign in to Example Bank', confirmLabel: null, denyLabel: null, risk: null, rememberLabel: 'Remember me' }));
    fireEvent.click(within(card).getByRole('checkbox', { name: 'Remember me' }));
    fireEvent.change(within(card).getByLabelText('Username or email'), { target: { value: 'oscar' } });
    fireEvent.change(within(card).getByLabelText(/^Password/), { target: { value: SECRET } });
    fireEvent.click(within(card).getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(sent(host, `/questions/${Q_ID}/answer`)[0]?.body).toMatchObject({ remember: false }));
    expect(await screen.findByText('Provided')).toBeInTheDocument();

    emit({ type: 'question', data: { question: null } });
    card = await ask(question({ id: 'q-2', kind: 'login', input: 'credentials', prompt: 'Sign in to Other Bank', confirmLabel: null, denyLabel: null, risk: null, rememberLabel: null }));
    expect(within(card).queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('offers "Trust this device" on a code card when the site has it', async () => {
    const host = mount();
    const card = await ask(question({ kind: 'code', input: 'secret', prompt: 'Enter the code sent to your phone', confirmLabel: null, denyLabel: null, risk: null, rememberLabel: 'Trust this device' }));
    expect(within(card).getByRole('checkbox', { name: 'Trust this device' })).toBeChecked();
    fireEvent.change(within(card).getByLabelText(/Code/), { target: { value: '424242' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sent(host, `/questions/${Q_ID}/answer`)[0]?.body).toEqual({ outcome: 'completed', value: '424242', remember: true, channel: 'web' }));
  });

  it('offers to do the step in the browser instead', async () => {
    mount();
    const card = await ask(code());
    expect(within(card).getByRole('button', { name: /browser/i })).toBeInTheDocument();
  });

  it('keeps the card and says why when the answer could not be sent', async () => {
    mount({ [`POST /questions/${Q_ID}/answer`]: () => Promise.reject(createTestApiError(500, 'The agent could not be reached')) });
    const card = await ask(code());
    fireEvent.change(within(card).getByLabelText(/Code/), { target: { value: SECRET } });
    fireEvent.click(within(card).getByRole('button', { name: 'Send' }));
    expect(await within(card).findByText('The agent could not be reached')).toBeInTheDocument();
    expect(screen.queryByText('Provided')).not.toBeInTheDocument();
  });
});

describe('a choice and a decline', () => {
  it('answers with the chosen option', async () => {
    const host = mount();
    const card = await ask(question({ kind: 'other', input: 'choice', prompt: 'Which showing?', options: [{ id: 'a', label: '4:30 PM' }, { id: 'b', label: '7:30 PM' }], confirmLabel: null, denyLabel: null, risk: null }));
    expect(card).toHaveTextContent('A question for you');
    fireEvent.click(within(card).getByRole('radio', { name: '7:30 PM' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sent(host, `/questions/${Q_ID}/answer`)[0]?.body).toEqual({ outcome: 'completed', value: 'b', channel: 'web' }));
    expect(await screen.findByText('Sent')).toBeInTheDocument();
  });

  it('Decline asks first (the run cannot go on without an answer), then cancels the request', async () => {
    const host = mount();
    const card = await ask(question({ kind: 'other', input: 'text', prompt: 'Which name on the booking?', confirmLabel: null, denyLabel: null, risk: null }));
    fireEvent.click(within(card).getByRole('button', { name: 'Decline' }));
    let dialog = await screen.findByRole('dialog', { name: 'Decline?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Decline?' })).not.toBeInTheDocument());
    expect(sent(host, `/questions/${Q_ID}/cancel`)).toHaveLength(0);

    fireEvent.click(within(card).getByRole('button', { name: 'Decline' }));
    dialog = await screen.findByRole('dialog', { name: 'Decline?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(sent(host, `/questions/${Q_ID}/cancel`)[0]?.body).toEqual({ channel: 'web' }));
    expect(await screen.findByText('Declined')).toBeInTheDocument();
  });
});

describe('a request that ends some other way', () => {
  it('says so in place when it is answered elsewhere, cancelled or expired on the server', async () => {
    mount();
    await ask(question());
    emit({ type: 'question', data: { question: null } });
    expect(await screen.findByText('This request was answered elsewhere, cancelled or expired.')).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: /^Request:/ })).not.toBeInTheDocument();
  });

  it('says so when the answer arrives too late (the API answers 409)', async () => {
    mount({ [`POST /questions/${Q_ID}/answer`]: () => Promise.reject(createTestApiError(409, 'Already answered', 'QUESTION_SETTLED')) });
    const card = await ask(question());
    fireEvent.click(within(card).getByRole('button', { name: 'Allow' }));
    expect(await screen.findByText('This request was already answered or expired.')).toBeInTheDocument();
  });

  it('shows an expired request as expired, with no form', async () => {
    mount();
    const card = await ask(question({ expiresAt: new Date(Date.now() - 1_000).toISOString() }));
    expect(within(card).getByText('This request expired.')).toBeInTheDocument();
    expect(within(card).getByLabelText('Time left')).toHaveTextContent('expired');
    expect(within(card).queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
  });

  it('a new request replaces what was said about the last one', async () => {
    mount();
    const card = await ask(question());
    fireEvent.click(within(card).getByRole('button', { name: 'Allow' }));
    await screen.findByText('Allowed');
    emit({ type: 'question', data: { question: null } });
    emit({ type: 'question', data: { question: question({ id: '55555555-5555-4555-8555-555555555556', prompt: 'Also add popcorn?' }) } });
    expect(await screen.findByRole('article', { name: 'Request: Also add popcorn?' })).toBeInTheDocument();
    expect(screen.queryByText('Allowed')).not.toBeInTheDocument();
  });
});

describe('who may answer', () => {
  it('without runs:write the request is shown but cannot be answered', async () => {
    mount({}, ALL.filter((p) => p !== 'runs:write'));
    const card = await ask(question());
    expect(within(card).getByText('You can see this request but not answer it.')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
  });
});

describe('the words of a request', () => {
  it('names what is needed', () => {
    expect(requestTitle({ input: 'confirm', kind: 'confirmation' })).toBe('Approval needed');
    expect(requestTitle({ input: 'secret', kind: 'code' })).toBe('Code needed');
    expect(requestTitle({ input: 'secret', kind: 'login' })).toBe('Password needed');
    expect(requestTitle({ input: 'takeover', kind: 'captcha' })).toBe('Your help is needed in the browser');
    expect(requestTitle({ input: 'text', kind: 'other' })).toBe('A question for you');
    expect(requestTitle({ input: 'text', kind: 'login' })).toBe('Sign-in needed');
    expect(requestTitle({ input: 'credentials', kind: 'login' })).toBe('Sign-in needed');
  });

  it('says how it was answered, and never repeats a secret', () => {
    expect(settledText({ input: 'secret' }, { outcome: 'completed', value: SECRET })).toBe('Provided');
    expect(settledText({ input: 'confirm' }, { outcome: 'completed', value: 'approve' })).toBe('Allowed');
    expect(settledText({ input: 'confirm' }, { outcome: 'completed', value: 'deny' })).toBe('Denied');
    expect(settledText({ input: 'text' }, { outcome: 'completed', value: 'Marin' })).toBe('Sent');
    expect(settledText({ input: 'takeover' }, { outcome: 'completed' })).toBe('Done');
    expect(settledText({ input: 'secret' }, { outcome: 'cancelled' })).toBe('Declined');
  });
});
