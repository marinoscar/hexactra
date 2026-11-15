import type { BrowserNotificationTemplate, NotificationRegistration, PushPayloadHook } from '@marinoscar/platform-api/notifications';

import { isSliceEnabled } from '../slices/manifest';

/** Web Push to the Android app exists only with its slice. */
const PUSH = isSliceEnabled('android-app') ? (['push', 'android_app'] as const) : (['push'] as const);

/** Event keys. Permanent. */
export const RUN_NEEDS_YOU_EVENT = 'runs.needs_you';
export const RUN_FINISHED_EVENT = 'runs.finished';
export const SCHEDULE_FAILING_EVENT = 'schedules.failing';

const str = (d: unknown, k: string) => (typeof (d as Record<string, unknown>)[k] === 'string' ? String((d as Record<string, unknown>)[k]) : '');
const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

const needsYou: BrowserNotificationTemplate = (d) => ({
  title: 'An agent needs you',
  body: trim(str(d, 'prompt') || 'Answer its request in the Inbox.', 180),
  // A deep link to this run's request: the web app, the installed PWA and the
  // Android app all open the Inbox with it in front.
  // `a`: the notification buttons' single-use token (RunActionTokens), read by
  // the service worker (apps/web/src/sw.ts); the Inbox ignores it.
  link: str(d, 'runId') ? `/inbox?run=${encodeURIComponent(str(d, 'runId'))}${str(d, 'actionToken') ? `&a=${encodeURIComponent(str(d, 'actionToken'))}` : ''}` : '/inbox',
});
const finished: BrowserNotificationTemplate = (d) => ({
  title: str(d, 'status') === 'succeeded' ? 'Run finished' : `Run ${str(d, 'status') || 'ended'}`,
  body: trim(`${str(d, 'goal')}${str(d, 'result') ? ` — ${str(d, 'result')}` : ''}`, 180),
  link: `/runs/${str(d, 'runId')}`,
});
const failing: BrowserNotificationTemplate = (d) => ({
  title: 'A schedule keeps failing',
  body: trim(`"${str(d, 'taskName')}" failed ${String((d as { failures?: number }).failures ?? 3)} times in a row.`, 180),
  link: '/tasks',
});

/** What the console tells people about their browser agents. */
export const HEXACTRA_NOTIFICATIONS: readonly NotificationRegistration[] = [
  {
    event: {
      key: RUN_NEEDS_YOU_EVENT,
      label: 'An agent needs you',
      description: 'A run is waiting for a CAPTCHA, a code, a sign-in or your confirmation.',
      channels: ['browser', ...PUSH, 'email'],
      defaultEnabled: true,
    },
    emailTemplate: 'run-needs-you',
    browserTemplate: needsYou,
  },
  {
    event: {
      key: RUN_FINISHED_EVENT,
      label: 'Run finished',
      description: 'A run of yours succeeded, failed or was cancelled.',
      channels: ['browser', ...PUSH],
      defaultEnabled: true,
    },
    browserTemplate: finished,
  },
  {
    event: {
      key: SCHEDULE_FAILING_EVENT,
      label: 'Schedule failing',
      description: 'A scheduled task failed three times in a row.',
      channels: ['browser', ...PUSH],
      defaultEnabled: true,
    },
    browserTemplate: failing,
  },
];

/**
 * Push extras of the console's events (`NotificationsModule.forRoot({ pushPayload })`):
 * one notification per run on the device (a newer one replaces it: `tag`),
 * and the push service's high urgency when a person must act (a request,
 * a failed run), so a phone in Doze still shows it.
 */
export const hexactraPushPayload: PushPayloadHook = (event, data) => {
  const runId = str(data, 'runId');
  if (event.key === RUN_NEEDS_YOU_EVENT) {
    // Buttons only when the notification carries their token.
    const actions = str(data, 'actionToken')
      ? [...((data as { approvable?: boolean }).approvable ? [{ action: 'approve', title: 'Approve' }] : []), { action: 'cancel', title: 'Stop run' }]
      : [];
    return { tag: runId ? `run-${runId}` : 'run', urgency: 'high', ...(actions.length ? { actions } : {}) };
  }
  if (event.key === RUN_FINISHED_EVENT) return { tag: runId ? `run-${runId}` : 'run', urgency: str(data, 'status') === 'failed' ? 'high' : 'normal' };
  if (event.key === SCHEDULE_FAILING_EVENT) return { tag: `schedule-${str(data, 'scheduleId') || 'failing'}`, urgency: 'normal' };
  return null;
};
