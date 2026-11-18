// The chat stream client (#485): which frames become events, and the URL it follows.
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Options {
  url: string;
  authorization: () => string | null;
  onOpen: () => void;
  onFrame: (f: { event: string; data: string; id: string | null }) => void;
}
const sse = vi.hoisted(() => ({ options: null as Options | null, close: vi.fn() }));
vi.mock('@marinoscar/platform-web/core', () => ({
  connectSse: (options: Options) => {
    sse.options = options;
    return { close: sse.close };
  },
}));
vi.mock('../api', () => ({ api: { getAccessToken: () => 'tok', refreshToken: async () => true } }));

import { subscribeChat, type ChatStreamEvent } from '../live';

const frame = (event: string, data: unknown) => sse.options!.onFrame({ event, data: typeof data === 'string' ? data : JSON.stringify(data), id: null });

describe('subscribeChat', () => {
  beforeEach(() => {
    sse.options = null;
    sse.close.mockReset();
  });

  it('follows the chat from the newest message the page holds, with the bearer token', () => {
    subscribeChat('c1', 7.9, () => undefined);
    expect(sse.options!.url).toBe('/api/chats/c1/stream?afterSeq=7');
    expect(sse.options!.authorization()).toBe('Bearer tok');
    subscribeChat('c2', -3, () => undefined);
    expect(sse.options!.url).toBe('/api/chats/c2/stream?afterSeq=0');
  });

  it('passes on every chat event with its parsed data, and open on each connect', () => {
    const seen: ChatStreamEvent[] = [];
    subscribeChat('c1', 0, (e) => seen.push(e));
    sse.options!.onOpen();
    frame('chat', { title: 'Cinema', status: 'active' });
    frame('message', { seq: 1, role: 'user', kind: 'text', text: 'Book two seats' });
    frame('turn', { thinking: true });
    frame('run', { run: null });
    frame('question', { question: { id: 'q1', input: 'confirm', response: null } });
    frame('heartbeat', {});
    expect(seen).toEqual([
      { type: 'open' },
      { type: 'chat', data: { title: 'Cinema', status: 'active' } },
      { type: 'message', data: { seq: 1, role: 'user', kind: 'text', text: 'Book two seats' } },
      { type: 'turn', data: { thinking: true } },
      { type: 'run', data: { run: null } },
      { type: 'question', data: { question: { id: 'q1', input: 'confirm', response: null } } },
      { type: 'heartbeat', data: {} },
    ]);
  });

  it('ignores an unknown event and a malformed frame, and closes the connection', () => {
    const seen: ChatStreamEvent[] = [];
    const close = subscribeChat('c1', 0, (e) => seen.push(e));
    frame('step', { seq: 1 });
    frame('message', '{not json');
    expect(seen).toEqual([]);
    close();
    expect(sse.close).toHaveBeenCalledTimes(1);
  });
});
