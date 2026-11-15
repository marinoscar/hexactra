// What a phone receives for the console's events: the deep link (the
// notification's `link`), the push extras through the platform's allowlist,
// and the Android app's channel on the events that need a person.
import { sanitizePushExtras, type NotificationEventDef } from '@marinoscar/platform-api/notifications';

import {
  HEXACTRA_NOTIFICATIONS,
  RUN_FINISHED_EVENT,
  RUN_NEEDS_YOU_EVENT,
  SCHEDULE_FAILING_EVENT,
  hexactraPushPayload,
} from '../src/platform/notifications/hexactra.notifications';

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

  it('reaches the Android app (android_app) and Web Push on every console event', () => {
    for (const key of [RUN_NEEDS_YOU_EVENT, RUN_FINISHED_EVENT, SCHEDULE_FAILING_EVENT]) {
      expect(event(key).channels).toEqual(expect.arrayContaining(['push', 'android_app']));
    }
  });

  it('carries no secret: a request names what is asked, never an answer', () => {
    const shown = reg(RUN_NEEDS_YOU_EVENT).browserTemplate!({ runId: RUN, prompt: 'Enter the code', value: '987654' } as never);
    expect(JSON.stringify(shown)).not.toContain('987654');
  });
});
