// A saved login refused on a page that is not its site (E37.3, #593): the question the run asks with is a warning
// card that names both addresses; an ordinary login question stays a plain prompt.
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Question } from '../components/questions';
import { QuestionPage } from '../pages/QuestionPage';
import { ConfirmProvider } from '../ui';

vi.mock('../live', () => ({ fetchRunScreenshot: async () => null }));

const WARNING =
  "Warning: the agent was about to sign in with your saved login 'Shop login', but this page is not the site that login is saved for. The page is login.example.test.evil.example.net. The login is saved for login.example.test. Nothing was typed and the agent will not try another saved login.";

const base: Question = {
  id: 'q1',
  askedBy: 'run:r1',
  runId: 'r1',
  handoffId: 'h1',
  browserBound: true,
  kind: 'login',
  input: 'takeover',
  prompt: WARNING,
  options: null,
  constraints: null,
  confirmLabel: null,
  denyLabel: null,
  risk: null,
  status: 'pending',
  response: null,
  pageTitle: null,
  viewerUrl: null,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  answeredAt: null,
};

function renderQuestion(q: Question) {
  const host = createTestPlatformHost({ permissions: ['runs:read', 'runs:write'], responses: { 'GET /questions/q1': q } });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={['/inbox/q/q1']}>
          <Routes>
            <Route path="/inbox/q/:id" element={<QuestionPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
}

afterEach(cleanup);

describe('the saved-login warning card', () => {
  it('shows the prompt as a warning with both addresses', async () => {
    renderQuestion(base);
    const card = await screen.findByTestId('saved-login-warning');
    expect(card).toHaveTextContent('The page is login.example.test.evil.example.net.');
    expect(card).toHaveTextContent('The login is saved for login.example.test.');
    expect(card.textContent).not.toMatch(/^Warning:/);
    expect(card.className).toMatch(/Warning/);
  });

  it('an ordinary sign-in question is a plain prompt, not a warning', async () => {
    renderQuestion({ ...base, prompt: 'Sign in to Shop', input: 'credentials' });
    expect(await screen.findByRole('heading', { name: 'Sign in to Shop' })).toBeInTheDocument();
    expect(screen.queryByTestId('saved-login-warning')).not.toBeInTheDocument();
  });
});
