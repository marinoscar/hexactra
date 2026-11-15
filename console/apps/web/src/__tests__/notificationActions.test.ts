import { describe, expect, it, vi } from 'vitest';

import { actionTarget, handleActionClick, withRunRenotify, type ActionClickEvent, type ActionScope } from '../notificationActions';

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
