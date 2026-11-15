import type { BrowserNotificationTemplate, NotificationRegistration } from '@marinoscar/platform-api/notifications';

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
  link: '/inbox',
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
