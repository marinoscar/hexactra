import { describe, expect, it, vi } from 'vitest';

import { actionTarget, handleActionClick, type ActionClickEvent, type ActionScope } from '../notificationActions';

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
