// "Signed in with: <login name>" on the chat's Browser card (E37.4, #593): the saved logins the chat's run used, by
// name and site, while it is live and after it ends. Never a username, password or code.
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { BrowserCard } from '../components/ChatBrowser';
import type { ChatMessage, ChatRun } from '../types/chat';

const message: ChatMessage = { id: 'm1', seq: 2, role: 'assistant', kind: 'run', text: 'Sign in to the shop', runId: 'r1', meta: null, createdAt: '2026-11-19T10:00:00.000Z' };
const run = (over: Partial<ChatRun> = {}): ChatRun => ({
  id: 'r1', status: 'succeeded', goal: 'Sign in to the shop', stepCount: 3, activity: null, result: 'Done', error: null, stopReason: null, cancelRequested: false, hostId: null, costUsd: 0, costKnown: true,
  createdAt: '2026-11-19T10:00:00.000Z', startedAt: '2026-11-19T10:00:01.000Z', finishedAt: '2026-11-19T10:01:00.000Z', ...over,
});

function card(r: ChatRun | null) {
  render(
    <MemoryRouter>
      <BrowserCard message={message} run={r} frame={{ url: null, loading: false } as never} frameHidden={false} now={Date.now()} paneOpen={false} onOpen={() => undefined} onVisible={() => undefined} />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('the chat Browser card', () => {
  it('says which saved login the run signed in with, by name and site', () => {
    card(run({ usedSavedLogins: [{ itemName: 'Shop login', origin: 'https://app.example.test' }] }));
    expect(screen.getByTestId('used-saved-logins')).toHaveTextContent('Signed in with: Shop login (app.example.test)');
  });

  it('says it while the run is live too', () => {
    card(run({ status: 'running', finishedAt: null, usedSavedLogins: [{ itemName: 'Shop login', origin: 'https://app.example.test' }] }));
    expect(screen.getByTestId('used-saved-logins')).toBeInTheDocument();
  });

  it('says nothing when no saved login was used, or the console is older', () => {
    card(run({ usedSavedLogins: [] }));
    expect(screen.queryByTestId('used-saved-logins')).not.toBeInTheDocument();
    cleanup();
    card(run());
    expect(screen.queryByTestId('used-saved-logins')).not.toBeInTheDocument();
  });
});
