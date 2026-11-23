// The recovery ladder (E46.15–E46.16): what happens when a step does not match, before the run is handed to the agent. The order and the
// limits are generic and live here; the rungs are supplied by the host or a toolset as `RecoveryStrategy` objects.
//   1. wait again (a longer readiness wait, once)   2. interrupts (a banner, a pop-up, an expired session)
//   3. re-resolve the element with relaxed matching  4. locate with one narrow model call   5. hand over to the agent
import type { Step } from '../schema';

export const RUNGS = ['wait', 'interrupts', 'reresolve', 'locate'] as const;
export type Rung = (typeof RUNGS)[number];

export interface RecoveryFailure {
  step: Step;
  /** `precondition`: nothing was sent (the element was not ready); `failed_check`: the call was made and its check failed. */
  kind: 'precondition' | 'failed_check';
  expected?: unknown;
  observed?: unknown;
}

export interface RecoveryStrategy {
  rung: Rung;
  /** Try to put the page back on the procedure's path. `recovered`: the step may be tried again. */
  attempt(failure: RecoveryFailure): Promise<'recovered' | 'no'>;
}

export const RECOVERY_LIMITS = Object.freeze({
  /** Model-located steps per run before the run is handed to the agent. */
  modelLocatesPerRun: 3,
});

export interface RecoveryOutcome {
  recovered: boolean;
  rung?: Rung;
}

/**
 * One ladder per walk. Each rung at most once per step; a commit-class step whose call was already sent is never tried again (its outcome is
 * the owner's to judge, not a retry's) and never uses the model rung; at most `modelLocatesPerRun` model-located steps per run.
 */
export class RecoveryLadder {
  private readonly tried = new Map<string, Set<Rung>>();
  private locates = 0;
  readonly log: { step: string; rung: Rung; outcome: 'recovered' | 'no' }[] = [];

  constructor(private readonly strategies: readonly RecoveryStrategy[], private readonly limits = RECOVERY_LIMITS) {}

  async recover(f: RecoveryFailure): Promise<RecoveryOutcome> {
    if (f.step.commitClass && f.kind === 'failed_check') return { recovered: false };
    const tried = this.tried.get(f.step.id) ?? new Set<Rung>();
    this.tried.set(f.step.id, tried);
    for (const rung of RUNGS) {
      if (tried.has(rung)) continue;
      if (rung === 'locate' && (f.step.commitClass || this.locates >= this.limits.modelLocatesPerRun)) continue;
      const strategy = this.strategies.find((s) => s.rung === rung);
      if (!strategy) continue;
      tried.add(rung);
      if (rung === 'locate') this.locates++;
      let outcome: 'recovered' | 'no' = 'no';
      try {
        outcome = await strategy.attempt(f);
      } catch {
        outcome = 'no';
      }
      this.log.push({ step: f.step.id, rung, outcome });
      if (outcome === 'recovered') return { recovered: true, rung };
    }
    return { recovered: false };
  }
}
