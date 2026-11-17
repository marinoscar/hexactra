// What a phone receives for the console's events: the deep link (the
// notification's `link`), the push extras through the platform's allowlist,
// and the Android app's channel on the events that need a person.
import { sanitizePushExtras, type NotificationEventDef } from '@marinoscar/platform-api/notifications';

import {
  HEXACTRA_NOTIFICATIONS,
  RUN_FINISHED_EVENT,
  RUN_NEEDS_YOU_EVENT,
  RUN_REMINDER_EVENT,
  SCHEDULE_FAILING_EVENT,
  hexactraPushPayload,
} from '../src/platform/notifications/hexactra.notifications';

import { RunNotifier } from '../src/tasks/run-notifier';

const RUN = '11111111-1111-4111-8111-111111111111';
const reg = (key: string) => HEXACTRA_NOTIFICATIONS.find((n) => n.event.key === key)!;
const event = (key: string) => reg(key).event as NotificationEventDef;

describe('push payloads of the console events', () => {
  it('a request deep-links to its Inbox entry, high urgency, one per run', () => {
    const data = { runId: RUN, goal: 'Find a fare', prompt: 'Enter the code sent to your phone', kind: 'code' };
    const shown = reg(RUN_NEEDS_YOU_EVENT).browserTemplate!(data as never);
    expect(shown).toEqual({ title: 'An agent needs you', body: 'Enter the code sent to your phone', link: `/inbox?run=${RUN}` });
    expect(sanitizePushExtras(hexactraPushPayload(event(RUN_NEEDS_YOU_EVENT), data))).toEqual({ payload: { tag: `run-${RUN}` }, urgency: 'high' });
  });

  it('a finished run deep-links to the run; a failure is urgent, a success is not', () => {
    const failed = { runId: RUN, goal: 'Find a fare', status: 'failed', result: '' };
    expect(reg(RUN_FINISHED_EVENT).browserTemplate!(failed as never)).toMatchObject({ title: 'Run failed', link: `/runs/${RUN}` });
    expect(sanitizePushExtras(hexactraPushPayload(event(RUN_FINISHED_EVENT), failed)).urgency).toBe('high');
    expect(sanitizePushExtras(hexactraPushPayload(event(RUN_FINISHED_EVENT), { ...failed, status: 'succeeded' })).urgency).toBe('normal');
  });

  it('a failing schedule collapses per schedule; other events get no extras', () => {
    expect(sanitizePushExtras(hexactraPushPayload(event(SCHEDULE_FAILING_EVENT), { scheduleId: 's1', taskName: 'x', failures: 3 })).payload).toEqual({ tag: 'schedule-s1' });
    expect(hexactraPushPayload({ key: 'auth.signed_in' } as NotificationEventDef, {})).toBeNull();
  });

  it("a failing schedule deep-links to its task's schedules (#428): the browser notice and the payload's tasksUrl", async () => {
    const TASK = '22222222-2222-4222-8222-222222222222';
    const data = { scheduleId: 's1', taskId: TASK, taskName: 'Daily report', failures: 3 };
    expect(reg(SCHEDULE_FAILING_EVENT).browserTemplate!(data as never)).toEqual({
      title: 'A schedule keeps failing',
      body: '"Daily report" failed 3 times in a row.',
      link: `/tasks/${TASK}#schedule`,
    });
    // A notice queued before the task id was carried still opens the Tasks list.
    expect(reg(SCHEDULE_FAILING_EVENT).browserTemplate!({ scheduleId: 's1', taskName: 'Daily report', failures: 3 } as never).link).toBe('/tasks');

    const sent: { event: string; userId: string; data: Record<string, unknown> }[] = [];
    const notifications = { notify: async (event: string, userId: string, payload: Record<string, unknown>) => void sent.push({ event, userId, data: payload }) };
    const config = { get: () => 'https://console.example.test/' };
    const notifier = new RunNotifier(config as never, notifications as never, undefined as never, undefined as never);
    await notifier.scheduleFailing('user-1', data);
    expect(sent).toEqual([{ event: SCHEDULE_FAILING_EVENT, userId: 'user-1', data: { ...data, tasksUrl: `https://console.example.test/tasks/${TASK}#schedule` } }]);
  });

  it('reaches the Android app (android_app) and Web Push on every console event', () => {
    for (const key of [RUN_NEEDS_YOU_EVENT, RUN_REMINDER_EVENT, RUN_FINISHED_EVENT, SCHEDULE_FAILING_EVENT]) {
      expect(event(key).channels).toEqual(expect.arrayContaining(['push', 'android_app']));
    }
  });

  it('carries no secret: a request names what is asked, never an answer', () => {
    const shown = reg(RUN_NEEDS_YOU_EVENT).browserTemplate!({ runId: RUN, prompt: 'Enter the code', value: '987654' } as never);
    expect(JSON.stringify(shown)).not.toContain('987654');
  });

  it('carries the buttons: Approve only for a plain confirmation, Stop run always, the token in the link', () => {
    const data = { runId: RUN, prompt: 'Book the 9:00 table?', kind: 'confirmation', actionToken: 'tok.sig', approvable: true };
    expect(reg(RUN_NEEDS_YOU_EVENT).browserTemplate!(data as never)).toMatchObject({ link: `/inbox?run=${RUN}&a=tok.sig` });
    expect(sanitizePushExtras(hexactraPushPayload(event(RUN_NEEDS_YOU_EVENT), data)).payload.actions).toEqual([
      { action: 'approve', title: 'Approve' },
      { action: 'cancel', title: 'Stop run' },
    ]);
    const code = { ...data, kind: 'code', approvable: false };
    expect(sanitizePushExtras(hexactraPushPayload(event(RUN_NEEDS_YOU_EVENT), code)).payload.actions).toEqual([{ action: 'cancel', title: 'Stop run' }]);
  });

  it('a request that needs the app offers Remind me in 15 min while there is time for it', () => {
    const code = { runId: RUN, prompt: 'Enter the code', kind: 'code', actionToken: 'tok.sig', approvable: false, snoozable: true };
    expect(sanitizePushExtras(hexactraPushPayload(event(RUN_NEEDS_YOU_EVENT), code)).payload.actions).toEqual([
      { action: 'snooze', title: 'Remind me in 15 min' },
      { action: 'cancel', title: 'Stop run' },
    ]);
    // A one-tap answer keeps Approve and Stop run (two buttons at most).
    const confirm = { ...code, kind: 'confirmation', approvable: true };
    expect(sanitizePushExtras(hexactraPushPayload(event(RUN_NEEDS_YOU_EVENT), confirm)).payload.actions!.map((a: { action: string }) => a.action)).toEqual(['approve', 'cancel']);
  });

  it('a reminder replaces the request (same tag), urgent, says when it expires, with fresh buttons', () => {
    const data = { runId: RUN, goal: 'Find a fare', prompt: 'Enter the code', kind: 'code', minutesLeft: 5, final: true, actionToken: 'tok2.sig', approvable: false, snoozable: false };
    expect(reg(RUN_REMINDER_EVENT).browserTemplate!(data as never)).toEqual({
      title: 'Expires in 5 min: an agent needs you',
      body: 'Enter the code',
      link: `/inbox?run=${RUN}&a=tok2.sig`,
    });
    expect(sanitizePushExtras(hexactraPushPayload(event(RUN_REMINDER_EVENT), data))).toEqual({
      payload: { tag: `run-${RUN}`, actions: [{ action: 'cancel', title: 'Stop run' }] },
      urgency: 'high',
    });
    expect(reg(RUN_REMINDER_EVENT).browserTemplate!({ runId: RUN, prompt: 'Solve the CAPTCHA' } as never).title).toBe('Still waiting for you');
    expect(event(RUN_REMINDER_EVENT).channels).not.toContain('email');
  });
});
