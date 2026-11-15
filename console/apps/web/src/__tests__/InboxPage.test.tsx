import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';

import { InboxPage, type InboxItem } from '../pages/InboxPage';

const base = { goal: 'Find a fare', pageTitle: 'Flights', viewerUrl: null, choices: [], createdAt: '2026-11-15T00:00:00Z', expiresAt: '2026-11-15T00:10:00Z' };
const code: InboxItem = { ...base, runId: 'r1', handoffId: 'h1', kind: 'code', prompt: 'Enter the code sent to your phone', input: 'secret' };
const confirm: InboxItem = { ...base, runId: 'r2', handoffId: 'h2', kind: 'confirmation', prompt: 'Book the 9:00 flight for $120?', input: 'none' };

describe('InboxPage', () => {
  it('sends a secret and approves a confirmation', async () => {
    const host = createTestPlatformHost({
      permissions: ['runs:read', 'runs:write'],
      responses: { 'GET /inbox': [code, confirm], 'POST /inbox/r1/respond': { ok: true }, 'POST /inbox/r2/respond': { ok: true } },
    });
    render(
      <PlatformHostProvider host={host}>
        <MemoryRouter>
          <InboxPage />
        </MemoryRouter>
      </PlatformHostProvider>,
    );
    const secret = await screen.findByLabelText(/Code or secret/);
    expect(secret).toHaveAttribute('type', 'password');
    fireEvent.change(secret, { target: { value: '987654' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByText('Book the 9:00 flight for $120?');
    const posts = host.requests.filter((r) => r.method === 'POST');
    expect(posts.map((r) => [r.path, r.body])).toEqual(
      expect.arrayContaining([
        ['/inbox/r1/respond', { outcome: 'completed', value: '987654' }],
        ['/inbox/r2/respond', { outcome: 'completed' }],
      ]),
    );
  });

  it('says when nothing is waiting', async () => {
    const host = createTestPlatformHost({ permissions: ['runs:read'], responses: { 'GET /inbox': [] } });
    render(
      <PlatformHostProvider host={host}>
        <MemoryRouter>
          <InboxPage />
        </MemoryRouter>
      </PlatformHostProvider>,
    );
    expect(await screen.findByText('Nothing is waiting for you.')).toBeInTheDocument();
  });
});
