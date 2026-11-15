// The buttons of a "needs you" notification (Stop run, Approve), handled in
// the service worker so they work without opening the app: on a desktop, in
// the installed PWA and in the Android app (whose notifications Chrome shows
// through this same worker). No imports: this file is bundled into the worker.
//
// The worker holds no session. The API puts a single-use, hour-long token
// for this run in the notification's link (`/inbox?run=<id>&a=<token>`); a
// button posts it to `POST /api/notification-actions`, which can stop that
// run or approve that plain confirmation and nothing else. A tap on the
// notification itself (no button) keeps the platform's behaviour: it opens
// the link.

export type NotificationButton = 'cancel' | 'approve';

export interface ActionClickEvent {
  readonly action?: string;
  readonly notification: { close(): void; readonly data: unknown };
  waitUntil(p: Promise<unknown>): void;
}

export interface ActionScope {
  readonly registration: { showNotification(title: string, options?: { body?: string; tag?: string; icon?: string; badge?: string }): Promise<void> };
  readonly clients: { openWindow(url: string): Promise<unknown> };
}

const BUTTONS: readonly string[] = ['cancel', 'approve'];

/** The run and the button token of a notification's link, or `null`. */
export function actionTarget(data: unknown): { runId: string; token: string; link: string } | null {
  const link = typeof (data as { link?: unknown })?.link === 'string' ? (data as { link: string }).link : '';
  if (!link.startsWith('/') || link.startsWith('//')) return null;
  const url = new URL(link, 'https://worker.invalid');
  const runId = url.searchParams.get('run');
  const token = url.searchParams.get('a');
  return runId && token ? { runId, token, link } : null;
}

/**
 * Handles a click on one of the buttons; returns `false` for anything else
 * (a tap on the notification, a notification without a token), which the
 * caller hands to the platform's click handler.
 */
export function handleActionClick(scope: ActionScope, event: ActionClickEvent, fetchImpl: typeof fetch = fetch, icons: { icon?: string; badge?: string } = {}): boolean {
  if (!event.action || !BUTTONS.includes(event.action)) return false;
  const target = actionTarget(event.notification.data);
  if (!target) return false;
  const action = event.action as NotificationButton;
  event.notification.close();
  event.waitUntil(
    (async () => {
      let ok = false;
      try {
        const res = await fetchImpl('/api/notification-actions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: target.token, action }),
          credentials: 'omit',
        });
        ok = res.ok;
      } catch {
        ok = false;
      }
      if (ok) {
        await scope.registration.showNotification(action === 'cancel' ? 'Run stopped' : 'Approved', {
          body: action === 'cancel' ? 'The agent stops after its current step.' : 'The agent continues.',
          tag: `run-${target.runId}`,
          ...icons,
        });
      } else {
        // Expired, already used or answered elsewhere: show the run instead.
        await scope.clients.openWindow(`/runs/${encodeURIComponent(target.runId)}`);
      }
    })(),
  );
  return true;
}
