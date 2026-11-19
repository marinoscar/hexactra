// EventsPort over the tasks service's metrics and run events, and the owner's notifications.
import type { RunNotifier } from '../../tasks/run-notifier';
import type { TasksService } from '../../tasks/tasks.service';
import type { EventsPort } from '@marinoscar/hexactra-agent';

/** `run` is the run row the notifier is given. */
export function eventsPort(tasks: TasksService, notifier: RunNotifier | undefined, userId: string, run: { id: string }): EventsPort {
  return {
    step: (kind, ok) => tasks.metrics.step(kind, ok),
    tokens: (input, output) => tasks.metrics.tokens(input, output),
    modelCalls: (n) => tasks.metrics.modelCalls(n),
    inputTokensPerCall: (n) => tasks.metrics.inputTokensPerCall(n),
    recovered: (n) => tasks.metrics.recovered(n),
    stepRecorded: async (stepCount) => {
      await tasks.stepRecorded?.(userId, run.id, stepCount);
    },
    overBudget: async (usedOfLimit, label) => {
      await notifier?.overBudget(userId, run as never, usedOfLimit, label);
    },
    needsYou: async (ask, expiresAt, handoffId) => {
      await notifier?.needsYou(userId, { ...run, handoffId } as never, ask.prompt, ask.kind, ask.input, expiresAt);
    },
  };
}
