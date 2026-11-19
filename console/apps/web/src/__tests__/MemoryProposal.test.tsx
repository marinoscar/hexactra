// Memories at work (#553) in the web app: the "Remember this?" card (edit,
// save, not now, the supersede view, the settled states, the secret refusal on
// the card), the Inbox's suggestions group, the "Used" line of a run, and the
// "Suggest memories" setting. Canned API answers only.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';
import { vi } from 'vitest';

import { MemoryProposalCard, proposalSettledText } from '../components/MemoryProposalCard';
import type { InboxItem, Question } from '../components/questions';
import { answerText } from '../components/questions';
import { SuggestMemoriesSwitch } from '../memories/SuggestMemoriesSwitch';
import { InboxPage } from '../pages/InboxPage';
import { UsedMemories } from '../pages/RunDetailPage';
import { ConfirmProvider } from '../ui';

vi.mock('../live', () => ({ fetchRunScreenshot: async () => null }));
vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const QID = '55555555-5555-4555-8555-555555555555';
const OLD = '66666666-6666-4666-8666-666666666666';
const later = () => new Date(Date.now() + 7 * 24 * 3600_000).toISOString();

const question = (over: Partial<Question> = {}): Question => ({
  id: QID,
  askedBy: 'chat:c1',
  runId: null,
  handoffId: null,
  browserBound: false,
  input: 'memory',
  kind: 'memory',
  prompt: 'The agent suggests remembering something.',
  options: null,
  constraints: null,
  confirmLabel: null,
  denyLabel: null,
  risk: null,
  viewerUrl: null,
  status: 'pending',
  response: null,
  pageTitle: null,
  createdAt: new Date().toISOString(),
  expiresAt: later(),
  answeredAt: null,
  blocking: false,
  proposal: { kind: 'person', label: 'My wife', aliases: ['wife'], attributes: { name: 'Person A', phone: '555-010-6020' }, supersedes: null },
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

describe('the "Remember this?" card (#553)', () => {
  it('shows the proposal as editable fields and saves what the owner edited, as channel web', async () => {
    const host = createTestPlatformHost({
      permissions: ['runs:write'],
      responses: {
        [`GET /questions/${QID}`]: question(),
        [`POST /questions/${QID}/answer`]: (r: TestApiRequest) => question({ status: 'answered', response: { outcome: 'completed', valueWithheld: false, memoryId: 'm1', answeredAt: new Date().toISOString() }, ...(r.body ? {} : {}) }),
      },
    });
    wrap(host, <MemoryProposalCard questionId={QID} />);
    expect(await screen.findByText('Remember this?')).toBeInTheDocument();
    expect(screen.getByText('Saved to your Memories. You can change or delete it there.')).toBeInTheDocument();
    const name = screen.getByDisplayValue('Person A');
    fireEvent.change(name, { target: { value: 'Person A. Example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(host.requests.some((r) => r.method === 'POST' && r.path === `/questions/${QID}/answer`)).toBe(true));
    const body = host.requests.find((r) => r.path === `/questions/${QID}/answer`)!.body as Record<string, unknown>;
    expect(body).toEqual({ outcome: 'completed', channel: 'web', memory: { kind: 'person', label: 'My wife', aliases: ['wife'], attributes: { name: 'Person A. Example', phone: '555-010-6020' } } });
    expect(await screen.findByRole('link', { name: 'Saved to Memories' })).toHaveAttribute('href', '/settings/memories');
  });

  it('"Not now" declines it, and the card says it was not saved', async () => {
    const host = createTestPlatformHost({
      permissions: ['runs:write'],
      responses: { [`GET /questions/${QID}`]: question(), [`POST /questions/${QID}/cancel`]: question({ status: 'cancelled', response: { outcome: 'cancelled', valueWithheld: false, answeredAt: new Date().toISOString() } }) },
    });
    wrap(host, <MemoryProposalCard questionId={QID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(await screen.findByText('Not saved')).toBeInTheDocument();
    expect(host.requests.find((r) => r.path === `/questions/${QID}/cancel`)!.body).toEqual({ channel: 'web' });
  });

  it('shows the secret check of the API on the card and keeps what was typed', async () => {
    const host = createTestPlatformHost({
      permissions: ['runs:write'],
      responses: {
        [`GET /questions/${QID}`]: question(),
        [`POST /questions/${QID}/answer`]: () => {
          throw createTestApiError(422, 'Memories never hold passwords, codes or full card, account or Social Security numbers. Keep only the last four digits, for example "ending 0659".', 'MEMORY_HOLDS_SECRET');
        },
      },
    });
    wrap(host, <MemoryProposalCard questionId={QID} />);
    fireEvent.change(await screen.findByDisplayValue('555-010-6020'), { target: { value: '4111 1111 1111 1111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Keep only the last four digits/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('4111 1111 1111 1111')).toBeInTheDocument();
  });

  it('for a changed value, shows what is remembered now next to the new value', async () => {
    const host = createTestPlatformHost({
      permissions: ['runs:write'],
      responses: {
        [`GET /questions/${QID}`]: question({ proposal: { kind: 'person', label: 'My wife', aliases: [], attributes: { phone: '555-010-7777' }, supersedes: OLD } }),
        [`GET /memories/${OLD}`]: { id: OLD, attributes: { phone: '555-010-6020' } },
      },
    });
    wrap(host, <MemoryProposalCard questionId={QID} />);
    expect(await screen.findByTestId('memory-current')).toHaveTextContent('Now remembered: 555-010-6020 → new: 555-010-7777');
  });

  it('is read-only for a viewer who may not answer, and an expired one says so', async () => {
    const host = createTestPlatformHost({ permissions: ['runs:read'], responses: { [`GET /questions/${QID}`]: question() } });
    wrap(host, <MemoryProposalCard questionId={QID} />);
    expect(await screen.findByRole('button', { name: 'Save' })).toBeDisabled();
    expect(proposalSettledText({ status: 'expired', response: null })).toBe('This suggestion expired. Nothing was saved.');
    expect(answerText({ ...question(), status: 'answered', response: { outcome: 'completed', valueWithheld: false, answeredAt: '' } })).toBe('Saved to Memories.');
  });
});

describe('the Inbox lists suggestions in their own group (#553)', () => {
  it('below the requests a run waits on, and does not count them as waiting', async () => {
    const base = { goal: 'x', askedBy: 'run:r', pageTitle: null, viewerUrl: null, choices: [], options: null, constraints: null, confirmLabel: null, denyLabel: null, risk: null, createdAt: new Date().toISOString(), expiresAt: later() };
    const request: InboxItem = { ...base, questionId: 'q1', runId: 'r1', handoffId: 'h1', kind: 'other', prompt: 'Which account?', input: 'text', blocking: true };
    const suggestion: InboxItem = { ...base, questionId: QID, runId: null, handoffId: null, askedBy: 'chat:c1', kind: 'memory', prompt: 'The agent suggests remembering something.', input: 'memory', blocking: false, proposal: question().proposal };
    const host = createTestPlatformHost({ permissions: ['runs:write'], responses: { 'GET /inbox': [suggestion, request] } });
    wrap(host, <InboxPage />);
    const group = await screen.findByRole('region', { name: 'Suggestions' });
    expect(within(group).getByDisplayValue('Person A')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Requests')).getByText('Which account?')).toBeInTheDocument();
    expect(screen.getByText('1 waiting for you')).toBeInTheDocument();
  });
});

describe('a run says which memories it used (#553)', () => {
  it('"Used: …" with a link to each', () => {
    render(
      <MemoryRouter>
        <UsedMemories memories={[{ id: 'm1', label: 'My wife', status: 'active' }, { id: 'm2', label: 'Checking account', status: 'active' }]} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('used-memories')).toHaveTextContent('Used: My wife, Checking account');
    expect(screen.getByRole('link', { name: 'My wife' })).toHaveAttribute('href', '/settings/memories?memory=m1');
    const { container } = render(<UsedMemories memories={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('"Suggest memories" (#553)', () => {
  it('reads the setting and saves a change at once', async () => {
    const host = createTestPlatformHost({
      permissions: [],
      responses: { 'GET /user-settings': { version: 1, memories: { suggest: true } }, 'PATCH /user-settings': (r: TestApiRequest) => ({ version: 2, memories: (r.body as { memories: unknown }).memories }) },
    });
    wrap(host, <SuggestMemoriesSwitch />);
    const toggle = await screen.findByRole('switch', { name: 'Suggest memories' });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(host.requests.some((r) => r.method === 'PATCH')).toBe(true));
    expect(host.requests.find((r) => r.method === 'PATCH')!.body).toEqual({ memories: { suggest: false } });
    await waitFor(() => expect(toggle).not.toBeChecked());
  });
});
