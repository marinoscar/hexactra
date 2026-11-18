import { describe, expect, it, vi } from 'vitest';

import { actionTarget, chatIsInFront, chatOfNotification, handleActionClick, withFocusedChatQuiet, withRunRenotify, type ActionClickEvent, type ActionScope } from '../notificationActions';

const RUN = '11111111-1111-4111-8111-111111111111';
const link = `/inbox?run=${RUN}&a=tok.sig`;

function setup(action: string | undefined, data: unknown, ok = true) {
  const waits: Promise<unknown>[] = [];
  const event: ActionClickEvent = { action, notification: { close: vi.fn(), data }, waitUntil: (p) => void waits.push(p) };
  const scope: ActionScope = { registration: { showNotification: vi.fn(async () => {}) }, clients: { openWindow: vi.fn(async () => null) } };
  const fetchImpl = vi.fn(async () => new Response(ok ? '{"data":{"ok":true}}' : '{}', { status: ok ? 200 : 401 }));
  return { event, scope, fetchImpl, waits };
}

describe('notification buttons in the service worker', () => {
  it('reads the run and the token from the link', () => {
    expect(actionTarget({ link })).toEqual({ runId: RUN, token: 'tok.sig', link });
    expect(actionTarget({ link: '/inbox' })).toBeNull();
    expect(actionTarget({ link: '//evil.example.test/?run=x&a=y' })).toBeNull();
  });

  it('Stop run posts the token, without a session, and confirms', async () => {
    const t = setup('cancel', { id: 'n1', link });
    expect(handleActionClick(t.scope, t.event, t.fetchImpl as never)).toBe(true);
    await Promise.all(t.waits);
    expect(t.fetchImpl).toHaveBeenCalledWith('/api/notification-actions', expect.objectContaining({ method: 'POST', credentials: 'omit', body: JSON.stringify({ token: 'tok.sig', action: 'cancel' }) }));
    expect(t.event.notification.close).toHaveBeenCalled();
    expect(t.scope.registration.showNotification).toHaveBeenCalledWith('Run stopped', expect.objectContaining({ tag: `run-${RUN}` }));
    expect(t.scope.clients.openWindow).not.toHaveBeenCalled();
  });

  it('an expired or used button opens the run instead', async () => {
    const t = setup('approve', { link }, false);
    handleActionClick(t.scope, t.event, t.fetchImpl as never);
    await Promise.all(t.waits);
    expect(t.scope.clients.openWindow).toHaveBeenCalledWith(`/runs/${RUN}`);
  });

  it('leaves a plain tap, and notifications without a token, to the platform', () => {
    expect(handleActionClick(setup(undefined, { link }).scope, setup(undefined, { link }).event)).toBe(false);
    const t = setup('cancel', { link: '/runs/x' });
    expect(handleActionClick(t.scope, t.event, t.fetchImpl as never)).toBe(false);
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  describe('a question\'s quick answers', () => {
    const Q = '22222222-2222-4222-8222-222222222222';
    const qlink = `/inbox/q/${Q}?a=qtok.sig`;

    it('reads the question and the token from its deep link', () => {
      expect(actionTarget({ link: qlink })).toEqual({ questionId: Q, token: 'qtok.sig', link: qlink });
      expect(actionTarget({ link: `/inbox/q/${Q}` })).toBeNull();
    });

    it('answer-0 posts the token without a session and confirms', async () => {
      const t = setup('answer-0', { link: qlink });
      expect(handleActionClick(t.scope, t.event, t.fetchImpl as never)).toBe(true);
      await Promise.all(t.waits);
      expect(t.fetchImpl).toHaveBeenCalledWith('/api/notification-actions', expect.objectContaining({ credentials: 'omit', body: JSON.stringify({ token: 'qtok.sig', action: 'answer-0' }) }));
      expect(t.scope.registration.showNotification).toHaveBeenCalledWith('Answered', expect.objectContaining({ tag: `question-${Q}` }));
    });

    it('a refused answer opens the question; run buttons do nothing on a question', async () => {
      const t = setup('answer-1', { link: qlink }, false);
      handleActionClick(t.scope, t.event, t.fetchImpl as never);
      await Promise.all(t.waits);
      expect(t.scope.clients.openWindow).toHaveBeenCalledWith(`/inbox/q/${Q}`);
      const c = setup('cancel', { link: qlink });
      expect(handleActionClick(c.scope, c.event, c.fetchImpl as never)).toBe(false);
      const a = setup('answer-0', { link });
      expect(handleActionClick(a.scope, a.event, a.fetchImpl as never)).toBe(false);
    });
  });
});

describe('Remind me in 15 min', () => {
  it('posts the token and shows nothing until the reminder comes back', async () => {
    const t = setup('snooze', { link });
    expect(handleActionClick(t.scope, t.event, t.fetchImpl as never)).toBe(true);
    await Promise.all(t.waits);
    expect(t.fetchImpl).toHaveBeenCalledWith('/api/notification-actions', expect.objectContaining({ body: JSON.stringify({ token: 'tok.sig', action: 'snooze' }) }));
    expect(t.event.notification.close).toHaveBeenCalled();
    expect(t.scope.registration.showNotification).not.toHaveBeenCalled();
    expect(t.scope.clients.openWindow).not.toHaveBeenCalled();
  });

  it('a refused snooze (too late, already answered) opens the run', async () => {
    const t = setup('snooze', { link }, false);
    handleActionClick(t.scope, t.event, t.fetchImpl as never);
    await Promise.all(t.waits);
    expect(t.scope.clients.openWindow).toHaveBeenCalledWith(`/runs/${RUN}`);
  });
});

describe('pushed run notifications re-alert', () => {
  it('adds renotify to a run-tagged notification only', async () => {
    const show = vi.fn(async (_title: string, _options?: unknown) => {});
    const scope = withRunRenotify({ registration: { showNotification: show }, other: 1 } as never) as unknown as { registration: { showNotification: typeof show }; other: number };
    await scope.registration.showNotification('Still waiting for you', { tag: `run-${RUN}`, body: 'x' } as never);
    await scope.registration.showNotification('Signed in', { tag: 'n1' } as never);
    expect(show).toHaveBeenNthCalledWith(1, 'Still waiting for you', { tag: `run-${RUN}`, body: 'x', renotify: true });
    expect(show).toHaveBeenNthCalledWith(2, 'Signed in', { tag: 'n1' });
    expect(scope.other).toBe(1);
  });
});

// A chat's run (#488): its notifications lead to the chat, the buttons still
// find their run, and nothing pops while that chat is open and in front.
describe('notifications of a chat run in the service worker', () => {
  const CHAT = '88888888-8888-4888-8888-888888888888';
  const chatLink = `/chat/${CHAT}?run=${RUN}&a=tok.sig`;
  const page = (path: string, focused = true, visibilityState = 'visible') => ({ url: `https://console.example.test${path}`, focused, visibilityState });

  it('reads the run and the token from a chat link, so the buttons work as on an Inbox link', async () => {
    expect(actionTarget({ link: chatLink })).toEqual({ runId: RUN, token: 'tok.sig', link: chatLink });
    const t = setup('approve', { id: 'n1', link: chatLink });
    expect(handleActionClick(t.scope, t.event, t.fetchImpl as never)).toBe(true);
    await Promise.all(t.waits);
    expect(t.scope.registration.showNotification).toHaveBeenCalledWith('Approved', expect.objectContaining({ tag: `run-${RUN}` }));
  });

  it('names the chat a notification leads to, and no chat for any other link', () => {
    expect(chatOfNotification({ link: chatLink })).toBe(CHAT);
    expect(chatOfNotification({ link: `/chat/${CHAT}` })).toBe(CHAT);
    for (const link of [`/inbox?run=${RUN}`, `/runs/${RUN}`, '/chat', '/chat/new', `//evil.example.test/chat/${CHAT}`, undefined]) expect(chatOfNotification({ link })).toBeNull();
  });

  it('counts a chat as in front only for a focused, visible window on that chat', () => {
    expect(chatIsInFront([page(`/chat/${CHAT}`)], CHAT)).toBe(true);
    expect(chatIsInFront([page('/tasks'), page(`/chat/${CHAT.toUpperCase()}?run=${RUN}`)], CHAT)).toBe(true);
    expect(chatIsInFront([page(`/chat/${CHAT}`, false)], CHAT)).toBe(false);
    expect(chatIsInFront([page(`/chat/${CHAT}`, true, 'hidden')], CHAT)).toBe(false);
    expect(chatIsInFront([page('/chat/88888888-8888-4888-8888-888888888881')], CHAT)).toBe(false);
    expect(chatIsInFront([page('/inbox')], CHAT)).toBe(false);
    expect(chatIsInFront([{ url: 'not a url', focused: true, visibilityState: 'visible' }], CHAT)).toBe(false);
    expect(chatIsInFront([], CHAT)).toBe(false);
  });

  function pushScope(windows: unknown[] | Error) {
    const showNotification = vi.fn(async () => {});
    const matchAll = vi.fn(async () => {
      if (windows instanceof Error) throw windows;
      return windows;
    });
    const scope = withFocusedChatQuiet({ registration: { showNotification }, clients: { matchAll } } as never) as unknown as { registration: { showNotification(title: string, options?: unknown): Promise<void> } };
    return { scope, showNotification, matchAll };
  }
  const options = { body: 'Enter the code', tag: `run-${RUN}`, data: { link: chatLink } };

  it('shows nothing while that chat is open and in front', async () => {
    const t = pushScope([page(`/chat/${CHAT}`)]);
    await t.scope.registration.showNotification('An agent needs you', options);
    expect(t.showNotification).not.toHaveBeenCalled();
    expect(t.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
  });

  it.each([
    ['the window is hidden', [page(`/chat/${CHAT}`, true, 'hidden')]],
    ['the window is not focused', [page(`/chat/${CHAT}`, false)]],
    ['another page is open', [page('/tasks')]],
    ['another chat is open', [page('/chat/88888888-8888-4888-8888-888888888881')]],
    ['no window is open', []],
    ['the windows cannot be listed', new Error('no clients')],
  ])('shows the notification when %s', async (_name, windows) => {
    const t = pushScope(windows as never);
    await t.scope.registration.showNotification('An agent needs you', options);
    expect(t.showNotification).toHaveBeenCalledWith('An agent needs you', options);
  });

  it('never holds back a notification that is not about a chat, and does not look at the windows for it', async () => {
    const t = pushScope([page(`/chat/${CHAT}`)]);
    const other = { body: 'x', data: { link: `/inbox?run=${RUN}` } };
    await t.scope.registration.showNotification('An agent needs you', other);
    expect(t.showNotification).toHaveBeenCalledWith('An agent needs you', other);
    expect(t.matchAll).not.toHaveBeenCalled();
  });

  it('composes with the re-alert of a replaced run notification', async () => {
    const showNotification = vi.fn(async () => {});
    const scope = withFocusedChatQuiet(withRunRenotify({ registration: { showNotification }, clients: { matchAll: async () => [] } } as never)) as unknown as { registration: { showNotification(title: string, options?: unknown): Promise<void> } };
    await scope.registration.showNotification('Still waiting for you', options);
    expect(showNotification).toHaveBeenCalledWith('Still waiting for you', { ...options, renotify: true });
  });
});
