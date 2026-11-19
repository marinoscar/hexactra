// The one call a host makes to run a goal (E38.9): its ports, the run's facts and a loop profile in, the run's outcome out. A host that
// wants full control builds the context itself with `createRunContext`; this builds the plain-state parts every host starts from.
import { BudgetTracker } from './budget';
import { RunUsage, type PriceTable } from './cost';
import { createRunContext } from './create-context';
import type { LoopProfile } from './loop-profile';
import type { Ports } from './ports';
import type { RunContext, RunInfo } from './run-context';
import { runLoop } from './run-loop';
import { newStallState, type StallState } from './stall';
import type { ActiveClock } from './active-time';
import type { HarnessMemory, RunOutcome, RunState, Tier } from './types';

/** How long a job works before it hands the run on to a new job, when the host says nothing (a little under ten minutes). */
export const DEFAULT_HOP_AFTER_MS = 10 * 60_000;

export interface RunLoopOptions<M extends HarnessMemory, X> {
  run: RunInfo;
  /** What the run kept in earlier jobs (a new run: `{ log: [], chunks: 0 }`). */
  memory: M;
  /** What the toolset and the host add to the context (a browser, a site list, ...). */
  ext: X;
  /** The counters of earlier jobs; defaults to a new run. */
  state?: Partial<RunState>;
  tier?: Tier;
  /** The tier a run drops back to when it de-escalates; defaults to the policy's start tier. */
  startTier?: Tier;
  /** When this job started, in the clock's time; defaults to now. Drives the hop to a new job. */
  startedAt?: number;
  tracker?: BudgetTracker;
  stall?: StallState;
  active?: ActiveClock;
  prices?: PriceTable;
  hopAfterMs?: number;
}

export interface RunLoop<M extends HarnessMemory, X> {
  /** The run's context: what the toolset's tools receive. Build the profile's tools and gates against it. */
  readonly context: RunContext<M, X>;
  /** Runs chunks until the run finishes, waits for a person, pauses, is stopped, or hands itself on. */
  run(profile: LoopProfile<RunContext<M, X>>): Promise<RunOutcome>;
}

/**
 * Binds a run to its ports. The tier defaults to the policy's start tier, the budget tracker to the policy's effective budget with
 * nothing used, the time to the ports' clock.
 */
export function createRunLoop<M extends HarnessMemory, X>(ports: Ports, options: RunLoopOptions<M, X>): RunLoop<M, X> {
  const { policy } = ports.policy;
  const tier = options.tier ?? policy.startTier;
  const context = createRunContext<M, X>({
    run: options.run,
    ports,
    memory: options.memory,
    state: {
      stepCount: 0,
      seq: 0,
      stall: null,
      stop: null,
      budgetKey: null,
      finished: null,
      wrappingUp: false,
      handoffId: null,
      handoffExpiresAt: null,
      handoffAsk: null,
      ...options.state,
    },
    tracker: options.tracker ?? new BudgetTracker(policy.effectiveBudget, {}),
    stall: options.stall ?? newStallState(),
    tier,
    startTier: options.startTier ?? policy.startTier,
    active: options.active ?? { activeMs: 0, activeSince: null },
    usage: new RunUsage(),
    prices: options.prices ?? {},
    hopAfterMs: options.hopAfterMs ?? DEFAULT_HOP_AFTER_MS,
    startedAt: options.startedAt ?? ports.clock.now(),
    ext: options.ext,
  });
  return { context, run: (profile) => runLoop(context as never, profile as never) };
}
