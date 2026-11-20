// A request kept in the chat thread (E40.1, #685): its outcome after a reload,
// a waiting one checked again until it settles, and never a secret's value.
import { configure, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { vi } from 'vitest';

import { ChatRequestRecord, requestMeta } from '../components/ChatRequestRecord';
import { previewLine } from '../components/chatThread';
import type { Question } from '../components/questions';
import { outcomeChip, outcomeOf } from '../components/requestOutcome';
import type { ChatMessage } from '../types/chat';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 8_000 });

const QID = '55555555-5555-4555-8555-555555555555';
const SECRET = '918273';
const msg = (meta: Record<string, unknown>): ChatMessage => ({ id: 'm9', seq: 9, role: 'assistant', kind: 'request', text: 'Enter the code we sent', runId: 'r1', meta: { questionId: QID, input: 'secret', questionKind: 'code', ...meta }, createdAt: '2026-11-20T10:00:00Z' });
const question = (over: Partial<Question> = {}): Question =>
  ({ id: QID, askedBy: 'run:r1', runId: 'r1', handoffId: 'h1', browserBound: true, input: 'secret', kind: 'code', prompt: 'Enter the code we sent', options: null, constraints: null, confirmLabel: null, denyLabel: null, risk: null, viewerUrl: null, status: 'pending', response: null, pageTitle: null, createdAt: '2026-11-20T10:00:00Z', expiresAt: new Date(Date.now() + 600_000).toISOString(), answeredAt: null, blocking: true, ...over }) as Question;

const wrap = (host: ReturnType<typeof createTestPlatformHost>, m: ChatMessage) =>
  render(
    <PlatformHostProvider host={host}>
      <MemoryRouter>
        <ChatRequestRecord message={m} />
      </MemoryRouter>
    </PlatformHostProvider>,
  );

describe('a request kept in the chat thread (E40.1)', () => {
  it('shows a settled request from the thread alone, without loading the question', () => {
    const host = createTestPlatformHost({ responses: {} });
    wrap(host, msg({ outcome: 'provided' }));
    expect(screen.getByText('Code needed')).toBeInTheDocument();
    expect(screen.getByText('Enter the code we sent')).toBeInTheDocument();
    expect(screen.getByText('Provided')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Details' })).toHaveAttribute('href', `/inbox/q/${QID}`);
    expect(host.requests).toHaveLength(0);
  });

  it('checks a waiting request again and shows that it was provided, never the value', async () => {
    const host = createTestPlatformHost({ responses: { [`GET /questions/${QID}`]: question({ status: 'answered', response: { outcome: 'completed', valueWithheld: true, channel: 'web', answeredAt: '2026-11-20T10:01:00Z' } }) } });
    const { container } = wrap(host, msg({ outcome: 'waiting for the owner' }));
    expect(await screen.findByText('Provided')).toBeInTheDocument();
    expect(container.textContent).not.toContain(SECRET);
  });

  it('names every outcome', () => {
    expect(outcomeChip('expired without an answer').label).toBe('Expired');
    expect(outcomeChip('denied').label).toBe('Denied');
    expect(outcomeChip(undefined).label).toBe('No longer kept');
    expect(outcomeOf({ status: 'answered', input: 'confirm', response: { outcome: 'completed', valueWithheld: false, answeredAt: '' } } as Question)).toBe('allowed');
    expect(outcomeOf({ status: 'cancelled', input: 'text', response: null })).toBe('declined');
    expect(requestMeta({ kind: 'text', meta: null })).toBeNull();
    expect(previewLine({ preview: { role: 'assistant', kind: 'request', text: 'Which seat?' } })).toBe('Asked you: Which seat?');
  });
});
