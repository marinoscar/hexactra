// The buttons of a notification, handled in the service worker so they work
// without opening the app: on a desktop, in the installed PWA and in the
// Android app (whose notifications Chrome shows through this same worker).
// No imports: this file is bundled into the worker.
//
// - A "needs you" notification and its reminders (`/inbox?run=<id>&a=<token>`):
//   Stop run, Approve and Remind me in 15 min (`cancel`, `approve`, `snooze`).
// - A question (`/inbox/q/<id>?a=<token>`): its quick answers (`answer-0`,
//   `answer-1`: Approve/Deny of a low-risk confirm, or one of two options).
//
// The worker holds no session. The API puts a single-use token in the
// notification's link; a button posts it to `POST /api/notification-actions`,
// which does what that token allows and nothing else. A tap on the
// notification itself (no button) keeps the platform's behaviour: it opens
// the link.

export type NotificationButton = 'cancel' | 'approve' | 'snooze' | 'answer-0' | 'answer-1';

export interface ActionClickEvent {
  readonly action?: string;
  readonly notification: { close(): void; readonly data: unknown };
  waitUntil(p: Promise<unknown>): void;
}

export interface ActionScope {
  readonly registration: { showNotification(title: string, options?: { body?: string; tag?: string; icon?: string; badge?: string }): Promise<void> };
  readonly clients: { openWindow(url: string): Promise<unknown> };
}

const RUN_BUTTONS: readonly string[] = ['cancel', 'approve', 'snooze'];
const QUESTION_BUTTONS: readonly string[] = ['answer-0', 'answer-1'];
const QUESTION_PATH = /^\/inbox\/q\/([0-9a-fA-F-]{36})$/;

export type ActionTarget = { runId: string; token: string; link: string } | { questionId: string; token: string; link: string };

/** The run or question and the button token of a notification's link, or `null`. */
export function actionTarget(data: unknown): ActionTarget | null {
  const link = typeof (data as { link?: unknown })?.link === 'string' ? (data as { link: string }).link : '';
  if (!link.startsWith('/') || link.startsWith('//')) return null;
  const url = new URL(link, 'https://worker.invalid');
  const token = url.searchParams.get('a');
  if (!token) return null;
  const question = QUESTION_PATH.exec(url.pathname);
  if (question) return { questionId: question[1]!, token, link };
  const runId = url.searchParams.get('run');
  return runId ? { runId, token, link } : null;
}

/**
 * Handles a click on one of the buttons; returns `false` for anything else
 * (a tap on the notification, a notification without a token), which the
 * caller hands to the platform's click handler.
 */
export function handleActionClick(scope: ActionScope, event: ActionClickEvent, fetchImpl: typeof fetch = fetch, icons: { icon?: string; badge?: string } = {}): boolean {
  if (!event.action || ![...RUN_BUTTONS, ...QUESTION_BUTTONS].includes(event.action)) return false;
  const target = actionTarget(event.notification.data);
  if (!target) return false;
  const isQuestion = 'questionId' in target;
  // A run's buttons on a run's notification, a question's on a question's.
  if ((isQuestion ? QUESTION_BUTTONS : RUN_BUTTONS).includes(event.action) === false) return false;
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
      if (isQuestion) {
        const id = encodeURIComponent(target.questionId);
        if (ok) await scope.registration.showNotification('Answered', { body: 'Your answer was sent.', tag: `question-${target.questionId}`, ...icons });
        // Expired, already used or answered elsewhere: show the question instead.
        else await scope.clients.openWindow(`/inbox/q/${id}`);
        return;
      }
      if (ok && action === 'snooze') {
        // Snoozed: nothing on screen until the reminder comes back.
      } else if (ok) {
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

/** Options of `showNotification` as the platform's push handler passes them. */
type ShowOptions = Record<string, unknown> & { tag?: string; data?: unknown };

/**
 * A scope whose `showNotification` re-alerts (`renotify`) when a pushed
 * notification replaces one of the same run (`run-<id>` tag): a reminder, or a
 * run that finished after asking for help, makes sound and vibrates instead of
 * replacing the old one silently. The platform's push handler has no
 * `renotify` extra yet (seam request upstream); this wraps only the push path.
 */
export function withRunRenotify<S extends { readonly registration: { showNotification(title: string, options?: never): Promise<void> } }>(scope: S): S {
  const registration = scope.registration as unknown as { showNotification(title: string, options?: ShowOptions): Promise<void> };
  const show = (title: string, options?: ShowOptions) =>
    registration.showNotification(title, options && typeof options.tag === 'string' && options.tag.startsWith('run-') ? { ...options, renotify: true } : options);
  return new Proxy(scope, {
    get(target, prop, receiver) {
      if (prop === 'registration') {
        return new Proxy(registration, { get: (r, p, rr) => (p === 'showNotification' ? show : Reflect.get(r, p, rr)) });
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

const CHAT_PATH = /^\/chat\/([0-9a-fA-F-]{36})$/;

/** The chat a notification leads to (`/chat/<id>` links, #488), or null. */
export function chatOfNotification(data: unknown): string | null {
  const link = typeof (data as { link?: unknown })?.link === 'string' ? (data as { link: string }).link : '';
  if (!link.startsWith('/') || link.startsWith('//')) return null;
  return CHAT_PATH.exec(new URL(link, 'https://worker.invalid').pathname)?.[1] ?? null;
}

/** A window of the app, as `clients.matchAll({ type: 'window' })` lists it. */
export interface WindowLike {
  readonly url: string;
  readonly focused?: boolean;
  readonly visibilityState?: string;
}

/** Whether the person is looking at that chat right now: a focused, visible window on its page. */
export function chatIsInFront(windows: readonly WindowLike[], chatId: string): boolean {
  return windows.some((w) => {
    if (w.focused !== true || w.visibilityState !== 'visible') return false;
    try {
      return CHAT_PATH.exec(new URL(w.url).pathname)?.[1]?.toLowerCase() === chatId.toLowerCase();
    } catch {
      return false;
    }
  });
}

/**
 * A scope whose `showNotification` shows nothing for a chat the person has
 * open and in front (#488): the request is already on their screen, in the
 * thread. Any other case shows the notification: another page, another chat, a
 * hidden or unfocused window, no window at all, or windows that cannot be
 * listed. (A browser allows a push without a notification while a window of
 * the site is visible, which is exactly this case.) Wraps only the push path.
 */
export function withFocusedChatQuiet<
  S extends { readonly registration: { showNotification(title: string, options?: never): Promise<void> }; readonly clients: object },
>(scope: S): S {
  const registration = scope.registration as unknown as { showNotification(title: string, options?: ShowOptions): Promise<void> };
  const clients = scope.clients as unknown as { matchAll?(options: { type: 'window'; includeUncontrolled: boolean }): Promise<readonly WindowLike[]> };
  const show = async (title: string, options?: ShowOptions) => {
    const chatId = chatOfNotification(options?.data);
    if (chatId && clients.matchAll) {
      const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true }).catch(() => [] as readonly WindowLike[]);
      if (chatIsInFront(windows, chatId)) return;
    }
    return registration.showNotification(title, options);
  };
  return new Proxy(scope, {
    get(target, prop, receiver) {
      if (prop === 'registration') {
        return new Proxy(registration, { get: (r, p, rr) => (p === 'showNotification' ? show : Reflect.get(r, p, rr)) });
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
