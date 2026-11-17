import type { BrowserNotificationTemplate, NotificationRegistration, PushPayloadHook } from '@marinoscar/platform-api/notifications';

import { isSliceEnabled } from '../slices/manifest';

/** Web Push to the Android app exists only with its slice. */
const PUSH = isSliceEnabled('android-app') ? (['push', 'android_app'] as const) : (['push'] as const);

/** Event keys. Permanent. */
export const RUN_NEEDS_YOU_EVENT = 'runs.needs_you';
export const RUN_FINISHED_EVENT = 'runs.finished';
export const SCHEDULE_FAILING_EVENT = 'schedules.failing';
export const RUN_REMINDER_EVENT = 'runs.needs_you_reminder';
export const QUESTION_ASKED_EVENT = 'questions.asked';
/** Run retention (#422): the default rule is about to delete runs for the first time. */
export const RUN_RETENTION_NOTICE_EVENT = 'runs.retention_notice';

const str = (d: unknown, k: string) => (typeof (d as Record<string, unknown>)[k] === 'string' ? String((d as Record<string, unknown>)[k]) : '');
const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The Inbox link of a request, with the buttons' token (shared by the request and its reminders). */
const inboxLink = (d: unknown) =>
  str(d, 'runId') ? `/inbox?run=${encodeURIComponent(str(d, 'runId'))}${str(d, 'actionToken') ? `&a=${encodeURIComponent(str(d, 'actionToken'))}` : ''}` : '/inbox';

const needsYou: BrowserNotificationTemplate = (d) => ({
  title: 'An agent needs you',
  body: trim(str(d, 'prompt') || 'Answer its request in the Inbox.', 180),
  // A deep link to this run's request: the web app, the installed PWA and the
  // Android app all open the Inbox with it in front.
  // `a`: the notification buttons' single-use token (RunActionTokens), read by
  // the service worker (apps/web/src/sw.ts); the Inbox ignores it.
  link: inboxLink(d),
});
const reminder: BrowserNotificationTemplate = (d) => {
  const left = Number((d as { minutesLeft?: unknown }).minutesLeft);
  const final = (d as { final?: unknown }).final === true && Number.isFinite(left);
  return {
    title: final ? `Expires in ${Math.max(1, Math.round(left))} min: an agent needs you` : 'Still waiting for you',
    body: trim(str(d, 'prompt') || str(d, 'goal') || 'An agent is waiting for your answer in the Inbox.', 180),
    link: inboxLink(d),
  };
};
const asked: BrowserNotificationTemplate = (d) => {
  const id = str(d, 'questionId');
  // A deep link to the question (/inbox/q/<id>); `a`: the quick-answer
  // buttons' single-use token, read by the service worker, ignored by the page.
  const token = str(d, 'actionToken');
  return {
    title: 'A question for you',
    body: trim(str(d, 'prompt') || 'Answer it in the Inbox.', 180),
    link: id ? `/inbox/q/${encodeURIComponent(id)}${token ? `?a=${encodeURIComponent(token)}` : ''}` : '/inbox',
  };
};
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

const retentionNotice: BrowserNotificationTemplate = (d) => {
  const days = Number((d as { days?: unknown }).days);
  return {
    title: 'Old runs will be removed',
    body: `Runs older than ${Number.isFinite(days) && days > 0 ? days : 90} days will be removed starting tomorrow. Change this in Settings → Run history.`,
    link: '/settings/run-history',
  };
};

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
      key: RUN_REMINDER_EVENT,
      label: 'Reminders while an agent waits',
      description: 'If you have not answered a request, a reminder before it expires (and when you asked to be reminded later).',
      channels: ['browser', ...PUSH],
      defaultEnabled: true,
    },
    browserTemplate: reminder,
  },
  {
    event: {
      key: QUESTION_ASKED_EVENT,
      label: 'A question for you',
      description: 'An agent or your automation asks you something outside a browser run.',
      channels: ['browser', ...PUSH, 'email'],
      defaultEnabled: true,
    },
    emailTemplate: 'question-asked',
    browserTemplate: asked,
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
  {
    event: {
      key: RUN_RETENTION_NOTICE_EVENT,
      label: 'Run history cleanup',
      description: 'Once, before the default retention rule removes old runs of yours for the first time.',
      channels: ['browser'],
      defaultEnabled: true,
    },
    browserTemplate: retentionNotice,
  },
];

/**
 * Push extras of the console's events (`NotificationsModule.forRoot({ pushPayload })`):
 * one notification per run on the device (a newer one replaces it: `tag`),
 * and the push service's high urgency when a person must act (a request,
 * a failed run), so a phone in Doze still shows it.
 */
/**
 * The buttons of a request and its reminders (browsers show two at most), only
 * when the notification carries their token. A one-tap answer (a plain
 * confirmation) offers it: Approve, Stop run. Anything that needs the app (a
 * code, a password, a choice, a sign-in) offers to come back to it: Remind me
 * in 15 min (while there is time for it), Stop run.
 */
export function requestActions(data: unknown): { action: string; title: string }[] {
  if (!str(data, 'actionToken')) return [];
  const flag = (k: string) => (data as Record<string, unknown>)[k] === true;
  if (flag('approvable')) return [{ action: 'approve', title: 'Approve' }, { action: 'cancel', title: 'Stop run' }];
  return [...(flag('snoozable') ? [{ action: 'snooze', title: 'Remind me in 15 min' }] : []), { action: 'cancel', title: 'Stop run' }];
}

/**
 * Push extras of the console's events (`NotificationsModule.forRoot({ pushPayload })`):
 * one notification per run on the device (a newer one replaces it: `tag`;
 * the service worker re-alerts on a replacement), and the push service's high
 * urgency when a person must act (a request, its reminders, a failed run), so
 * a phone in Doze still shows it.
 */
export const hexactraPushPayload: PushPayloadHook = (event, data) => {
  const runId = str(data, 'runId');
  if (event.key === RUN_NEEDS_YOU_EVENT || event.key === RUN_REMINDER_EVENT) {
    const actions = requestActions(data);
    return { tag: runId ? `run-${runId}` : 'run', urgency: 'high', ...(actions.length ? { actions } : {}) };
  }
  if (event.key === QUESTION_ASKED_EVENT) {
    // Quick answers only when the notification carries their token (a low-risk
    // confirm, a two-option choice): never for a secret or a high-risk confirm.
    const quick = (data as { quickActions?: unknown }).quickActions;
    const actions =
      str(data, 'actionToken') && Array.isArray(quick)
        ? quick
            .filter((a): a is { action: string; title: string } => typeof a?.action === 'string' && typeof a?.title === 'string')
            .slice(0, 2)
            .map((a) => ({ action: a.action, title: a.title.slice(0, 64) }))
        : [];
    const id = str(data, 'questionId');
    return { tag: id ? `question-${id}`.slice(0, 64) : 'question', urgency: 'high', ...(actions.length ? { actions } : {}) };
  }
  if (event.key === RUN_FINISHED_EVENT) return { tag: runId ? `run-${runId}` : 'run', urgency: str(data, 'status') === 'failed' ? 'high' : 'normal' };
  if (event.key === SCHEDULE_FAILING_EVENT) return { tag: `schedule-${str(data, 'scheduleId') || 'failing'}`, urgency: 'normal' };
  return null;
};
