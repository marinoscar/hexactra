import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost } from '@marinoscar/platform-web/testing';

import type { Question } from '../components/questions';
import { QuestionPage } from '../pages/QuestionPage';
import { ConfirmProvider } from '../ui';

// The run's browser thumbnail: no network in a test.
vi.mock('../live', () => ({ fetchRunScreenshot: async () => null }));

const pending: Question = {
  id: 'q1',
  askedBy: 'agent:packer',
  runId: 'r1',
  handoffId: 'h1',
  browserBound: true,
  kind: 'other',
  input: 'choice',
  prompt: 'Which seat?',
  options: [
    { id: 'w', label: 'Window' },
    { id: 'a', label: 'Aisle' },
  ],
  constraints: null,
  confirmLabel: null,
  denyLabel: null,
  risk: null,
  status: 'pending',
  response: null,
  pageTitle: 'Seat map',
  viewerUrl: null,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  answeredAt: null,
};

function renderAt(host: ReturnType<typeof createTestPlatformHost>, id = 'q1') {
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[`/inbox/q/${id}`]}>
          <Routes>
            <Route path="/inbox/q/:id" element={<QuestionPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
}

describe('QuestionPage (/inbox/q/:id)', () => {
  it('shows the question with its context and answers it', async () => {
    const answered: Question = { ...pending, status: 'answered', response: { outcome: 'completed', value: 'w', valueWithheld: false, channel: 'web', answeredAt: new Date().toISOString() } };
    const host = createTestPlatformHost({ permissions: ['runs:read', 'runs:write'], responses: { 'GET /questions/q1': pending, 'POST /questions/q1/answer': answered } });
    renderAt(host);
    expect(await screen.findByRole('heading', { name: 'Which seat?' })).toBeInTheDocument();
    const card = screen.getByLabelText('Question: Which seat?');
    expect(card).toHaveTextContent('Asked by packer');
    expect(screen.getByTitle('Seat map')).toHaveTextContent('on “Seat map”');
    expect(within(card).getByText('Waiting for you')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Inbox/ })).toHaveAttribute('href', '/inbox');
    expect(screen.getByRole('link', { name: 'its run' })).toHaveAttribute('href', '/runs/r1');
    expect(screen.getByLabelText('Time left')).toHaveTextContent(/min .* left/);
    fireEvent.click(screen.getByRole('radio', { name: 'Window' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Answered (from web): Window')).toBeInTheDocument();
    expect(host.requests.find((r) => r.method === 'POST')).toMatchObject({ path: '/questions/q1/answer', body: { outcome: 'completed', value: 'w', channel: 'web' } });
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });

  it('declines through /cancel', async () => {
    const host = createTestPlatformHost({
      permissions: ['runs:read', 'runs:write'],
      responses: { 'GET /questions/q1': pending, 'POST /questions/q1/cancel': { ...pending, status: 'cancelled', response: { outcome: 'cancelled', valueWithheld: false, answeredAt: '' } } },
    });
    renderAt(host);
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    // Browser-bound: declining leaves its run without an answer, so it asks first.
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('The agent will be told you said no.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Decline' }));
    expect(await screen.findByText('Declined.')).toBeInTheDocument();
    expect(host.requests.find((r) => r.method === 'POST')).toMatchObject({ path: '/questions/q1/cancel', body: { channel: 'web' } });
  });

  it('shows the final state of an answered or expired question, never a secret', async () => {
    const secret: Question = { ...pending, input: 'secret', options: null, status: 'answered', response: { outcome: 'completed', valueWithheld: true, channel: 'android_app', answeredAt: new Date().toISOString() } };
    const host = createTestPlatformHost({ permissions: ['runs:read', 'runs:write'], responses: { 'GET /questions/q1': secret, 'GET /questions/q2': { ...pending, id: 'q2', status: 'expired' } } });
    renderAt(host);
    expect(await screen.findByText(/The secret went to the agent and is not shown/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^(Code|Password|Secret)$/)).not.toBeInTheDocument();
  });

  it('an expired question offers no form', async () => {
    const host = createTestPlatformHost({ permissions: ['runs:read', 'runs:write'], responses: { 'GET /questions/q2': { ...pending, id: 'q2', status: 'expired' } } });
    renderAt(host, 'q2');
    expect(await screen.findByText('This question expired before anyone answered.')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('a free-standing question has no run link; a viewer cannot answer', async () => {
    const host = createTestPlatformHost({ permissions: ['runs:read'], responses: { 'GET /questions/q1': { ...pending, runId: null, handoffId: null, browserBound: false, pageTitle: null } } });
    renderAt(host);
    expect(await screen.findByText('You can see this question but not answer it.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'its run' })).not.toBeInTheDocument();
  });

  it('says when the question is not there', async () => {
    const host = createTestPlatformHost({ permissions: ['runs:read'], responses: {
        'GET /questions/nope': () => {
          throw createTestApiError(404, 'Question not found');
        },
      } });
    renderAt(host, 'nope');
    await waitFor(() => expect(screen.getByText('This question does not exist or is not yours.')).toBeInTheDocument());
  });

  it('a question that runs out while the page is open swaps to the expired state without a poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const host = createTestPlatformHost({ permissions: ['runs:read', 'runs:write'], responses: { 'GET /questions/q1': { ...pending, expiresAt: new Date(Date.now() + 3_000).toISOString() } } });
      renderAt(host);
      expect(await screen.findByRole('radio', { name: 'Window' })).toBeInTheDocument();
      expect(screen.getByLabelText('Time left')).toHaveTextContent(/^\d s left$/);
      await vi.advanceTimersByTimeAsync(3_500);
      expect(await screen.findByText('This request expired.')).toBeInTheDocument();
      expect(screen.queryByRole('radio')).not.toBeInTheDocument();
      expect(screen.getByText('Expired')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an answer refused because it was answered on another device shows the final state from a reload, not an error', async () => {
    let answeredElsewhere = false;
    const settled: Question = { ...pending, status: 'answered', response: { outcome: 'completed', value: 'a', valueWithheld: false, channel: 'android_app', answeredAt: new Date().toISOString() } };
    const host = createTestPlatformHost({
      permissions: ['runs:read', 'runs:write'],
      responses: {
        'GET /questions/q1': () => (answeredElsewhere ? settled : pending),
        'POST /questions/q1/answer': () => {
          answeredElsewhere = true;
          throw createTestApiError(409, 'This question was already answered', 'ALREADY_ANSWERED');
        },
      },
    });
    renderAt(host);
    fireEvent.click(await screen.findByRole('radio', { name: 'Window' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Answered (from android_app): Aisle')).toBeInTheDocument();
    expect(screen.queryByText('This question was already answered')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });

  it('a failed answer shows its error in the card and keeps the choice', async () => {
    const host = createTestPlatformHost({
      permissions: ['runs:read', 'runs:write'],
      responses: {
        'GET /questions/q1': pending,
        'POST /questions/q1/answer': () => {
          throw createTestApiError(500, 'The broker is not reachable');
        },
      },
    });
    renderAt(host);
    fireEvent.click(await screen.findByRole('radio', { name: 'Window' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await within(screen.getByLabelText('Question: Which seat?')).findByRole('alert')).toHaveTextContent('The broker is not reachable');
    expect(screen.getByRole('radio', { name: 'Window' })).toBeChecked();
  });
});
