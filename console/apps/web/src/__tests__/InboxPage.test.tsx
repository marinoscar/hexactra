import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';

import { InboxPage, type InboxItem } from '../pages/InboxPage';

const base = {
  goal: 'Find a fare',
  askedBy: 'run:r',
  pageTitle: 'Flights',
  viewerUrl: null,
  choices: [],
  options: null,
  constraints: null,
  confirmLabel: null,
  denyLabel: null,
  risk: null,
  createdAt: '2026-11-15T00:00:00Z',
  expiresAt: '2026-11-15T00:10:00Z',
};
const code: InboxItem = { ...base, questionId: 'q1', runId: 'r1', handoffId: 'h1', kind: 'code', prompt: 'Enter the code sent to your phone', input: 'secret' };
const confirm: InboxItem = { ...base, questionId: 'q2', runId: 'r2', handoffId: 'h2', kind: 'confirmation', prompt: 'Book the 9:00 flight for $120?', input: 'none' };
const freeStanding: InboxItem = {
  ...base,
  questionId: 'q3',
  runId: null,
  handoffId: null,
  goal: 'Which sides?',
  askedBy: 'agent:packer',
  pageTitle: null,
  kind: 'other',
  prompt: 'Which sides?',
  input: 'multi_choice',
  choices: ['a', 'b'],
  options: [
    { id: 'a', label: 'Apples' },
    { id: 'b', label: 'Beans' },
  ],
};

function renderInbox(host: ReturnType<typeof createTestPlatformHost>, at = '/inbox') {
  render(
    <PlatformHostProvider host={host}>
      <MemoryRouter initialEntries={[at]}>
        <InboxPage />
      </MemoryRouter>
    </PlatformHostProvider>,
  );
}

describe('InboxPage', () => {
  it('answers through the question broker: a secret and a confirmation', async () => {
    const host = createTestPlatformHost({
      permissions: ['runs:read', 'runs:write'],
      responses: { 'GET /inbox': [code, confirm], 'POST /questions/q1/answer': {}, 'POST /questions/q2/answer': {} },
    });
    renderInbox(host);
    const secret = await screen.findByLabelText(/Code or secret/);
    expect(secret).toHaveAttribute('type', 'password');
    expect(secret).toHaveAttribute('autocomplete', 'off');
    fireEvent.change(secret, { target: { value: '987654' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    // Dropped from the field at once.
    expect(secret).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(host.requests.filter((r) => r.method === 'POST')).toHaveLength(2));
    const posts = host.requests.filter((r) => r.method === 'POST');
    expect(posts.map((r) => [r.path, r.body])).toEqual(
      expect.arrayContaining([
        ['/questions/q1/answer', { outcome: 'completed', value: '987654', channel: 'web' }],
        ['/questions/q2/answer', { outcome: 'completed', channel: 'web' }],
      ]),
    );
  });

  it('answers a free-standing question (no run) and declines through cancel', async () => {
    const host = createTestPlatformHost({
      permissions: ['runs:read', 'runs:write'],
      responses: { 'GET /inbox': [freeStanding, confirm], 'POST /questions/q3/answer': {}, 'POST /questions/q2/cancel': {} },
    });
    renderInbox(host);
    const card = await screen.findByLabelText('Request: Which sides?');
    expect(card).toHaveTextContent('Asked by packer');
    expect(screen.getByRole('link', { name: 'Find a fare' })).toHaveAttribute('href', '/runs/r2');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Beans' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Apples' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Send' })[0]!);
    await waitFor(() => expect(host.requests.some((r) => r.path === '/questions/q3/answer')).toBe(true));
    expect(host.requests.find((r) => r.path === '/questions/q3/answer')?.body).toEqual({ outcome: 'completed', values: ['a', 'b'], channel: 'web' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Decline' })[1]!);
    await waitFor(() => expect(host.requests.some((r) => r.path === '/questions/q2/cancel')).toBe(true));
    expect(screen.getAllByRole('link', { name: 'Details' }).map((a) => a.getAttribute('href'))).toEqual(['/inbox/q/q3', '/inbox/q/q2']);
  });

  it('says when nothing is waiting', async () => {
    const host = createTestPlatformHost({ permissions: ['runs:read'], responses: { 'GET /inbox': [] } });
    renderInbox(host);
    expect(await screen.findByText('Nothing is waiting for you.')).toBeInTheDocument();
  });

  it('opens a notification deep link with its request first and marked', async () => {
    const host = createTestPlatformHost({ permissions: ['runs:read'], responses: { 'GET /inbox': [code, confirm] } });
    renderInbox(host, '/inbox?run=r2');
    const cards = await screen.findAllByLabelText(/^Request: /);
    expect(cards[0]).toHaveAttribute('aria-label', 'Request: Book the 9:00 flight for $120?');
    expect(cards[0]).toHaveAttribute('aria-current', 'true');
    expect(cards[1]).not.toHaveAttribute('aria-current');
  });

  it('says when the linked request is gone', async () => {
    const host = createTestPlatformHost({ permissions: ['runs:read'], responses: { 'GET /inbox': [code] } });
    renderInbox(host, '/inbox?run=gone');
    expect(await screen.findByText('That request was already answered or expired.')).toBeInTheDocument();
  });
});
