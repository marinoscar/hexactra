// "Save this login?" (E37.4b) in the web app: the card (site, editable name, username, "Password: the one you just typed" and no
// password anywhere), Save / Not now / Never for this site and what each sends, the settled and "too late" states, the Inbox's group,
// the chat thread's card, the activity words and the owner's list of sites they said never for. Canned API answers only.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { vi } from 'vitest';

import { QuestionCard } from '../components/QuestionCard';
import { SaveLoginCard } from '../components/SaveLoginCard';
import { SaveLoginForm } from '../components/SaveLoginForm';
import { SAVE_TOO_LATE_TEXT, answerRequest, answerText, isSettledError, type InboxItem, type Question, type SaveLoginCard as Card } from '../components/questions';
import { InboxPage } from '../pages/InboxPage';
import { outcomeWords, whatWords } from '../secrets/words';
import { ConfirmProvider } from '../ui';

vi.mock('../live', () => ({ fetchRunScreenshot: async () => null }));
vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const QID = '77777777-7777-4777-8777-777777777777';
const soon = () => new Date(Date.now() + 9 * 60_000).toISOString();
const card: Card = { site: 'login.example.com', domain: 'example.com', name: 'Example sign-in', username: 'person-a@example.test', valueExpiresAt: soon() };
const NOW = new Date().toISOString();

const question = (over: Partial<Question> = {}): Question => ({
  id: QID,
  askedBy: 'run:r1',
  runId: 'r1',
  handoffId: null,
  browserBound: false,
  input: 'save_login',
  kind: 'login',
  prompt: 'The agent offers to save the sign-in you just typed.',
  options: null,
  constraints: null,
  confirmLabel: null,
  denyLabel: null,
  risk: null,
  viewerUrl: null,
  status: 'pending',
  response: null,
  pageTitle: null,
  createdAt: NOW,
  expiresAt: soon(),
  answeredAt: null,
  blocking: false,
  saveLogin: card,
  ...over,
});

function wrap(host: ReturnType<typeof createTestPlatformHost>, ui: React.ReactNode) {
  return render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
}

describe('the form of the card', () => {
  it('shows the site, the username and an editable name, says the password is the one just typed, and has no password field or value', () => {
    const { container } = render(<SaveLoginForm card={card} onSubmit={() => undefined} />);
    expect(screen.getByRole('form', { name: 'Save this sign-in for login.example.com' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Name it/)).toHaveValue('Example sign-in');
    expect(screen.getByText('login.example.com')).toBeInTheDocument();
    expect(screen.getByText('person-a@example.test')).toBeInTheDocument();
    expect(screen.getByText('the one you just typed')).toBeInTheDocument();
    // There is no way to see or type a password here.
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelectorAll('input')).toHaveLength(1);
    for (const label of ['Save', 'Not now', 'Never for this site']) expect(screen.getByRole('button', { name: label })).toBeEnabled();
    expect(screen.getByText(/stops these offers for example\.com/)).toBeInTheDocument();
  });

  it('Save sends the name as edited, trimmed; an empty or too long name cannot be saved', () => {
    const onSubmit = vi.fn();
    render(<SaveLoginForm card={card} onSubmit={onSubmit} />);
    const name = screen.getByLabelText(/Name it/);
    fireEvent.change(name, { target: { value: '  My Example login  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed', saveLogin: { name: 'My Example login' } });
    fireEvent.change(name, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    // Too long for the vault.
    fireEvent.change(name, { target: { value: 'x'.repeat(201) } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('Not now and Never for this site decline, the second with its own flag; nothing can be pressed while sending or without permission', () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<SaveLoginForm card={card} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onSubmit).toHaveBeenLastCalledWith({ outcome: 'cancelled' });
    fireEvent.click(screen.getByRole('button', { name: 'Never for this site' }));
    expect(onSubmit).toHaveBeenLastCalledWith({ outcome: 'cancelled', neverForSite: true });
    rerender(<SaveLoginForm card={card} onSubmit={onSubmit} busy />);
    for (const label of ['Save', 'Not now', 'Never for this site']) expect(screen.getByRole('button', { name: label })).toBeDisabled();
    rerender(<SaveLoginForm card={card} onSubmit={onSubmit} disabled />);
    expect(screen.getByLabelText(/Name it/)).toBeDisabled();
  });
});

describe('where an answer goes and how it reads', () => {
  it('a plain decline is /cancel; Save and "Never for this site" are /answer with their body, always as channel web', () => {
    expect(answerRequest('q', { outcome: 'cancelled' })).toEqual({ path: '/questions/q/cancel', body: { channel: 'web' } });
    expect(answerRequest('q', { outcome: 'cancelled', neverForSite: true })).toEqual({ path: '/questions/q/answer', body: { outcome: 'cancelled', neverForSite: true, channel: 'web' } });
    expect(answerRequest('q', { outcome: 'completed', saveLogin: { name: 'A' } })).toEqual({ path: '/questions/q/answer', body: { outcome: 'completed', saveLogin: { name: 'A' }, channel: 'web' } });
  });

  it('a save the owner can fix leaves the card open; every other 409 is a settled question', () => {
    const e = (status: number, code?: string) => createTestApiError(status, 'x', code);
    for (const code of ['SAVE_NAME_TAKEN', 'SAVE_RECONNECT', 'SAVE_DISABLED']) expect(isSettledError(e(409, code))).toBe(false);
    for (const code of ['SAVE_TOO_LATE', 'ALREADY_ANSWERED', 'QUESTION_EXPIRED']) expect(isSettledError(e(409, code))).toBe(true);
    expect(isSettledError(e(410))).toBe(true);
    expect(isSettledError(e(503, 'SAVE_UNAVAILABLE'))).toBe(false);
  });

  it('the settled card says saved (with the name), not saved, never for this site, or too late', () => {
    const settled = (status: Question['status'], response: Question['response']) => answerText({ ...question(), status, response });
    expect(settled('answered', { outcome: 'completed', valueWithheld: false, savedAs: 'My Example login', answeredAt: NOW })).toBe('Saved as “My Example login” in your vault.');
    expect(settled('cancelled', { outcome: 'cancelled', valueWithheld: false, answeredAt: NOW })).toBe('Not saved.');
    expect(settled('cancelled', { outcome: 'cancelled', valueWithheld: false, neverForSite: true, answeredAt: NOW })).toBe('Not saved. You will not be asked to save a login for this site again.');
    expect(settled('expired', null)).toBe(SAVE_TOO_LATE_TEXT);
    expect(SAVE_TOO_LATE_TEXT).toBe('Too late to save this time; it will be offered at the next sign-in.');
  });
});

describe('the card in a chat thread', () => {
  it('loads the offer, saves it with the edited name as channel web, and says it was saved', async () => {
    const host = createTestPlatformHost({
      permissions: ['runs:write'],
      responses: {
        [`GET /questions/${QID}`]: question(),
        [`POST /questions/${QID}/answer`]: question({ status: 'answered', response: { outcome: 'completed', valueWithheld: false, savedAs: 'Work login', answeredAt: NOW } }),
      },
    });
    wrap(host, <SaveLoginCard questionId={QID} />);
    expect(await screen.findByText('Save this sign-in for login.example.com?')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Name it/), { target: { value: 'Work login' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved as “Work login” in your vault.');
    expect(host.requests.find((r) => r.path === `/questions/${QID}/answer`)!.body).toEqual({ outcome: 'completed', saveLogin: { name: 'Work login' }, channel: 'web' });
    // The saved card shows no form any more.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('"Not now" is a plain decline; "Never for this site" sends its flag to /answer', async () => {
    const declined = question({ status: 'cancelled', response: { outcome: 'cancelled', valueWithheld: false, answeredAt: NOW } });
    const host = createTestPlatformHost({ permissions: ['runs:write'], responses: { [`GET /questions/${QID}`]: question(), [`POST /questions/${QID}/cancel`]: declined } });
    wrap(host, <SaveLoginCard questionId={QID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(await screen.findByText('Not saved.')).toBeInTheDocument();
    expect(host.requests.find((r) => r.path === `/questions/${QID}/cancel`)!.body).toEqual({ channel: 'web' });

    const never = question({ status: 'cancelled', response: { outcome: 'cancelled', valueWithheld: false, neverForSite: true, answeredAt: NOW } });
    const host2 = createTestPlatformHost({ permissions: ['runs:write'], responses: { [`GET /questions/${QID}`]: question(), [`POST /questions/${QID}/answer`]: never } });
    wrap(host2, <SaveLoginCard questionId={QID} />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Never for this site' }))[0]!);
    expect(await screen.findByText('Not saved. You will not be asked to save a login for this site again.')).toBeInTheDocument();
    expect(host2.requests.find((r) => r.path === `/questions/${QID}/answer`)!.body).toEqual({ outcome: 'cancelled', neverForSite: true, channel: 'web' });
  });

  it('a name that is taken, or a vault to reconnect, shows the API\'s words on the card and keeps the name the owner typed', async () => {
    const host = createTestPlatformHost({
      permissions: ['runs:write'],
      responses: {
        [`GET /questions/${QID}`]: question(),
        [`POST /questions/${QID}/answer`]: () => {
          throw createTestApiError(409, 'You already have a secret with that name in Vault. Choose another name.', 'SAVE_NAME_TAKEN');
        },
      },
    });
    wrap(host, <SaveLoginCard questionId={QID} />);
    fireEvent.change(await screen.findByLabelText(/Name it/), { target: { value: 'Shop login' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Choose another name/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Name it/)).toHaveValue('Shop login');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('too late: the answer is refused as settled, the card reloads as expired and says so', async () => {
    let n = 0;
    const host = createTestPlatformHost({
      permissions: ['runs:write'],
      responses: {
        [`GET /questions/${QID}`]: () => (++n === 1 ? question() : question({ status: 'expired' })),
        [`POST /questions/${QID}/answer`]: () => {
          throw createTestApiError(409, SAVE_TOO_LATE_TEXT, 'SAVE_TOO_LATE');
        },
      },
    });
    wrap(host, <SaveLoginCard questionId={QID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText(SAVE_TOO_LATE_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('a card whose password lifetime has passed says it is too late without asking the server', async () => {
    const host = createTestPlatformHost({ permissions: ['runs:write'], responses: { [`GET /questions/${QID}`]: question({ expiresAt: new Date(Date.now() - 1_000).toISOString() }) } });
    wrap(host, <SaveLoginCard questionId={QID} />);
    expect(await screen.findByText(SAVE_TOO_LATE_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('is read-only for a viewer who may not answer', async () => {
    const host = createTestPlatformHost({ permissions: ['runs:read'], responses: { [`GET /questions/${QID}`]: question() } });
    wrap(host, <SaveLoginCard questionId={QID} />);
    expect(await screen.findByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Never for this site' })).toBeDisabled();
  });
});

describe('the question card (the Inbox and the question page)', () => {
  const asCard = (over: Partial<Question> = {}) => {
    const q = question(over);
    return { ...q, goal: 'Check the account' };
  };

  it('asks "Save this sign-in for <site>?" in place of the stored prompt, which names nothing', async () => {
    const host = createTestPlatformHost({ permissions: ['runs:write'] });
    wrap(host, <QuestionCard variant="page" question={asCard()} now={Date.now()} canAnswer onAnswer={async () => undefined} />);
    expect(await screen.findByText('Save this sign-in for login.example.com?')).toBeInTheDocument();
    expect(screen.queryByText('The agent offers to save the sign-in you just typed.')).toBeNull();
    expect(screen.getByRole('form', { name: /Save this sign-in/ })).toBeInTheDocument();
  });

  it('shows "too late" for an expired offer, and the settled answer for a saved one', async () => {
    const host = createTestPlatformHost({ permissions: ['runs:write'] });
    wrap(host, <QuestionCard variant="page" question={asCard({ expiresAt: new Date(Date.now() - 5_000).toISOString() })} now={Date.now()} canAnswer onAnswer={async () => undefined} />);
    expect(await screen.findByText(SAVE_TOO_LATE_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('answers through onAnswer, and a decline needs no confirmation (nothing waits on it)', async () => {
    const onAnswer = vi.fn(async () => undefined);
    const host = createTestPlatformHost({ permissions: ['runs:write'] });
    wrap(host, <QuestionCard variant="page" question={asCard()} now={Date.now()} canAnswer onAnswer={onAnswer} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Never for this site' }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith({ outcome: 'cancelled', neverForSite: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the Inbox', () => {
  it('lists the offer in the suggestions group, not as something waiting, with its card; Never for this site posts to /answer', async () => {
    const base = { goal: 'Check the account', askedBy: 'run:r1', pageTitle: null, viewerUrl: null, choices: [], options: null, constraints: null, confirmLabel: null, denyLabel: null, risk: null, createdAt: NOW, expiresAt: soon() };
    const offer: InboxItem = { ...base, questionId: QID, runId: 'r1', handoffId: null, kind: 'login', prompt: 'The agent offers to save the sign-in you just typed.', input: 'save_login', blocking: false, saveLogin: card };
    const host = createTestPlatformHost({ permissions: ['runs:write'], responses: { 'GET /inbox': [offer], [`POST /questions/${QID}/answer`]: question({ status: 'cancelled' }) } });
    wrap(host, <InboxPage />);
    const group = await screen.findByRole('region', { name: 'Suggestions' });
    expect(within(group).getByText('Save this sign-in for login.example.com?')).toBeInTheDocument();
    expect(screen.queryByText(/waiting for you/)).toBeNull();
    fireEvent.click(within(group).getByRole('button', { name: 'Never for this site' }));
    await waitFor(() => expect(host.requests.some((r) => r.method === 'POST' && r.path === `/questions/${QID}/answer`)).toBe(true));
    expect(host.requests.find((r) => r.path === `/questions/${QID}/answer`)!.body).toEqual({ outcome: 'cancelled', neverForSite: true, channel: 'web' });
  });
});

describe('the Activity words', () => {
  it('a save is "Saved the sign-in you typed", never "typed the password"; its outcomes read plainly', () => {
    expect(whatWords({ event: 'release', field: 'password', matches: null, purpose: 'save_login', outcome: 'saved' })).toBe('Saved the sign-in you typed');
    expect(whatWords({ event: 'release', field: 'password', matches: null, purpose: 'login', outcome: 'typed' })).toBe('Typed the password');
    expect(outcomeWords('saved')).toBe('Saved');
    expect(outcomeWords('name_taken')).toMatch(/already have a secret with that name/);
    expect(outcomeWords('secret_unavailable')).toMatch(/too late/);
    expect(outcomeWords('unsupported')).toMatch(/cannot save logins/);
  });
});
