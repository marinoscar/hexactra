/** A skeleton of a scripted replay scenario, and what is left for a person to finish (E38.6, #587). */
export interface ScenarioSkeleton {
  /** A scenario file's content: valid against `apps/api/test/scenarios/scenario.schema.json`, with `TODO` markers where the trace cannot say. */
  scenario: Record<string, unknown>;
  /** What a person still has to do, one line each. */
  todo: string[];
}

/**
 * Turns a parsed run trace (`hexactra.run-trace`) into a scripted scenario skeleton: the goal, the policy, the owner's answers and the
 * action sequence as the script, with a fake site guessed from the steps. Hosts become `site-N.example.test`; masked values stay masked
 * and a typed value is a `TODO`. Throws for anything that is not a run trace.
 */
export declare function scenarioFromTrace(trace: unknown): ScenarioSkeleton;
