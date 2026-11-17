import { agentPolicySpecSchema, type AgentPolicySpec } from './agent-policy.schema';
import { balancedSpec } from './builtin-policies';
import { TASK_DEFAULTS } from '../tasks/task-defaults';

/** The earlier per-task limits, deprecated by agent policies (#401). */
export interface LegacyTaskLimits {
  maxSteps: number;
  maxMinutes: number;
  model: string | null;
}

/** True when the limits are the task defaults and no model is pinned: the task needs no derived policy. */
export function isDefaultLimits(l: LegacyTaskLimits): boolean {
  return l.maxSteps === TASK_DEFAULTS.maxSteps && l.maxMinutes === TASK_DEFAULTS.maxMinutes && l.model === null;
}

/**
 * The spec a task's legacy limits stand for: Balanced with `maxActions =
 * maxSteps` and `maxActiveMinutes = maxMinutes`. A pinned model becomes
 * `models.pins.standard` and caps `maxTier` at standard, so the task keeps
 * exactly the model it had. The SQL data migration `agent_policies` builds the
 * same document; keep them in step (its values are frozen there).
 */
export function legacyTaskSpec(l: LegacyTaskLimits): AgentPolicySpec {
  const spec = balancedSpec();
  spec.budget.maxActions = l.maxSteps;
  spec.budget.maxActiveMinutes = l.maxMinutes;
  if (l.model) {
    spec.models.maxTier = 'standard';
    spec.models.pins = { standard: l.model };
  }
  return agentPolicySpecSchema.parse(spec);
}

/** The name of a task's derived policy. */
export function legacyPolicyName(taskName: string): string {
  return `Task: ${taskName}`.slice(0, 100);
}
