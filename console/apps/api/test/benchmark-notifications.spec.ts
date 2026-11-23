// A benchmark's trial runs notify nobody (#883): no run event (finished, needs you, a reminder, still paused, over budget, saved
// approvals or a saved login used, a card used or its amount) and no owner card (a suggested memory, an offer to save a sign-in) of a
// run started with `trigger: 'benchmark'`. Webhooks are unchanged. Other runs notify as before.
import type { ConfigService } from '@nestjs/config';

import { NotificationsQuestionChannel } from '../src/questions/channels/notifications.channel';
import { QuestionChannelRegistry } from '../src/questions/channels/question-channel';
import type { QuestionView } from '../src/questions/questions.service';
import type { ActionTokenStore } from '../src/tasks/action-token-store';
import { RunActionTokens } from '../src/tasks/run-action-token';
import { RunNotifier, isQuietRun, type RunRef } from '../src/tasks/run-notifier';

const OWNER = '44444444-4444-4444-8444-444444444444';
const config = { get: () => 'https://console.example.test' } as unknown as ConfigService;
const store = { spendOnce: async () => true, issue: async () => 'token-abcdefghijkl' } as unknown as ActionTokenStore;

function notifier() {
  const notify = jest.fn(async () => undefined);
  const emitForUser = jest.fn(async () => undefined);
  const n = new RunNotifier(config, { notify } as never, { emitForUser } as never);
  return { n, notify, emitForUser };
}

/** Every run event the notifier sends, for one run. */
async function everyEvent(n: RunNotifier, run: RunRef): Promise<void> {
  await n.finished(OWNER, run, 'failed', 'It did not work');
  await n.finished(OWNER, run, 'succeeded', 'Done');
  await n.needsYou(OWNER, { ...run, handoffId: 'h1' }, 'Which one?', 'other', 'text');
  await n.reminder(OWNER, { ...run, handoffId: 'h1' }, { prompt: 'Which one?', kind: 'other', input: 'text' }, { expiresAt: null, reminderCount: 1, now: new Date() });
  await n.stillPaused(OWNER, run);
  await n.overBudget(OWNER, run, '$2 of $1', 'cost');
  await n.savedApprovalsUsed(OWNER, run, 'Press Pay');
  await n.savedLoginUsed(OWNER, run, ['example.test']);
  await n.cardUsed(OWNER, run, 'Paid with Visa');
  await n.cardAmountMismatch(OWNER, run, 'Asked $5, the page said $6');
}

describe("a benchmark's trial runs notify nobody (#883)", () => {
  const run = (trigger: string): RunRef => ({ id: 'r1', goal: 'Look up the record', taskId: null, trigger });

  it('isQuietRun: only a benchmark run', () => {
    expect(isQuietRun({ trigger: 'benchmark' })).toBe(true);
    for (const t of ['manual', 'schedule', 'chat', 'api', undefined, null]) expect(isQuietRun({ trigger: t })).toBe(false);
    expect(isQuietRun(null)).toBe(false);
  });

  it('sends no notification for any run event of a benchmark run, but still emits its webhooks', async () => {
    const { n, notify, emitForUser } = notifier();
    await everyEvent(n, run('benchmark'));
    expect(notify).not.toHaveBeenCalled();
    // finished (twice) and needs-you keep their webhooks, which carry the trigger.
    expect(emitForUser).toHaveBeenCalledTimes(3);
    expect(emitForUser).toHaveBeenCalledWith(OWNER, expect.any(String), expect.objectContaining({ trigger: 'benchmark' }));
  });

  it('notifies as before for any other run', async () => {
    const { n, notify } = notifier();
    await everyEvent(n, run('manual'));
    expect(notify).toHaveBeenCalledTimes(10);
    expect(notify.mock.calls.map((c) => (c as unknown[])[0])).toEqual(expect.arrayContaining(['runs.finished', 'runs.needs_you', 'runs.needs_you_reminder']));
  });

  it('a schedule that keeps failing still notifies (it is not a run)', async () => {
    const { n, notify } = notifier();
    await n.scheduleFailing(OWNER, { scheduleId: 's1', taskId: 't1', taskName: 'Daily', failures: 3 });
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe("a benchmark run's owner card notifies nobody (#883)", () => {
  const card = (runId: string | null): QuestionView =>
    ({
      id: '33333333-3333-4333-8333-333333333333',
      askedBy: 'agent:test',
      runId,
      kind: 'other',
      input: 'memory',
      prompt: 'Remember that the order number is on the first page?',
      choices: null,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }) as unknown as QuestionView;

  function channel(trigger: string | null) {
    const notify = jest.fn(async () => undefined);
    const findUnique = jest.fn(async () => (trigger === null ? null : { trigger }));
    const c = new NotificationsQuestionChannel(new QuestionChannelRegistry(), config, { run: { findUnique } } as never, new RunActionTokens(store), { notify } as never);
    return { c, notify, findUnique };
  }

  it("is not announced for a benchmark run's suggested memory", async () => {
    const { c, notify, findUnique } = channel('benchmark');
    await c.deliver(card('r1'), { ownerUserId: OWNER } as never);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'r1' }, select: { trigger: true } });
    expect(notify).not.toHaveBeenCalled();
  });

  it("is announced for another run's suggested memory, and for a free-standing question", async () => {
    const manual = channel('manual');
    await manual.c.deliver(card('r1'), { ownerUserId: OWNER } as never);
    expect(manual.notify).toHaveBeenCalledTimes(1);
    const free = channel(null);
    await free.c.deliver({ ...card(null), input: 'text' } as QuestionView, { ownerUserId: OWNER } as never);
    expect(free.notify).toHaveBeenCalledTimes(1);
    expect(free.findUnique).not.toHaveBeenCalled();
  });
});
