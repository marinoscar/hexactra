import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { SYSTEM_DEFAULT_POLICY_REF } from './builtin-policies';
import { PoliciesService, type PolicyRecord } from './policies.service';
import type { PolicySource, RunPolicySnapshot } from './policy-snapshot';

/** What decides a run's policy, most specific first. */
export interface PolicyResolveInput {
  userId: string;
  /** The run's task, when it has one. */
  taskId?: string | null;
  /**
   * The reference stored on the run before its first advance: the run override
   * (`policyId` on the start request), or the schedule's policy for a scheduled
   * run. `policySource` says which.
   */
  policyRef?: string | null;
  policySource?: PolicySource | null;
  /** The task's own `policy_ref`, when the caller already holds it (saves a read). */
  taskPolicyRef?: string | null;
}

/** The policy a run resolved to, and why. */
export interface ResolvedPolicy {
  policy: PolicyRecord;
  source: PolicySource;
  /** Fall-through notes (a level that named a deleted or foreign policy), for the run's first log line. */
  notes: string[];
}

const LEVEL_LABEL: Record<PolicySource, string> = {
  run: 'the run request',
  schedule: 'the schedule',
  task: 'the task',
  user_default: 'your default policy',
  system_default: 'the system default',
};

/**
 * Which agent policy a run runs under (#401). Pure apart from reads. The order:
 *
 *  1. the run override (`policyId` on `POST /runs` or `POST /tasks/:id/runs`),
 *  2. the schedule's `policy_ref`, for a scheduled run,
 *  3. the task's `policy_ref`,
 *  4. the user's `browserAgent.defaultPolicyRef`,
 *  5. `builtin:balanced`.
 *
 * A reference to a deleted or foreign policy falls through to the next level.
 * That is logged at warn and returned in `notes` (the runner writes it to the
 * run's first log line). It never fails the run.
 */
@Injectable()
export class PolicyResolver {
  private readonly log = new Logger(PolicyResolver.name);

  constructor(
    private readonly policies: PoliciesService,
    private readonly prisma: PrismaService,
  ) {}

  /** Resolve the policy for a run (or a run about to start). */
  async forRun(input: PolicyResolveInput): Promise<ResolvedPolicy> {
    const notes: string[] = [];
    const levels: { source: PolicySource; ref: string | null }[] = [];
    const stored = input.policyRef ?? null;
    levels.push({ source: 'run', ref: input.policySource === 'run' ? stored : null });
    levels.push({ source: 'schedule', ref: input.policySource === 'schedule' ? stored : null });
    levels.push({ source: 'task', ref: input.taskPolicyRef !== undefined ? input.taskPolicyRef : await this.taskRef(input) });

    for (const level of levels) {
      if (level.ref === null) continue;
      const policy = await this.tryFind(input.userId, level.ref, level.source, notes);
      if (policy) return { policy, source: level.source, notes };
    }

    const userRef = await this.policies.readDefaultRef(input.userId);
    if (userRef !== null) {
      const policy = await this.tryFind(input.userId, userRef, 'user_default', notes);
      if (policy) return { policy, source: 'user_default', notes };
    }
    // Always resolvable: a built-in is code.
    const policy = (await this.policies.find(input.userId, SYSTEM_DEFAULT_POLICY_REF))!;
    return { policy, source: 'system_default', notes };
  }

  /**
   * The policy that would apply to a run of each task started now with no
   * override: the task's own, else the user's default, else `builtin:balanced`
   * (levels 3 to 5 of `forRun`). For a page of tasks, in two reads whatever the
   * page size. `isDefault` says the policy is the one the user's default
   * resolves to. Nothing is logged: a list is read often, and a run of the
   * task logs the fall-through when it happens.
   */
  async forTasks(userId: string, tasks: readonly { id: string; policyRef: string | null }[]): Promise<Map<string, { policy: PolicyRecord; source: PolicySource; isDefault: boolean }>> {
    const out = new Map<string, { policy: PolicyRecord; source: PolicySource; isDefault: boolean }>();
    if (tasks.length === 0) return out;
    const userRef = await this.policies.readDefaultRef(userId);
    const refs = new Set<string>([SYSTEM_DEFAULT_POLICY_REF]);
    if (userRef !== null) refs.add(userRef);
    for (const t of tasks) if (t.policyRef !== null) refs.add(t.policyRef);
    const found = await this.policies.findMany(userId, refs);
    const userDefault = userRef !== null ? found.get(userRef) : undefined;
    const fallback: { policy: PolicyRecord; source: PolicySource } | null = userDefault
      ? { policy: userDefault, source: 'user_default' }
      : found.has(SYSTEM_DEFAULT_POLICY_REF)
        ? { policy: found.get(SYSTEM_DEFAULT_POLICY_REF)!, source: 'system_default' }
        : null;
    for (const t of tasks) {
      const own = t.policyRef !== null ? found.get(t.policyRef) : undefined;
      const chosen = own ? { policy: own, source: 'task' as const } : fallback;
      if (chosen) out.set(t.id, { ...chosen, isDefault: fallback !== null && chosen.policy.id === fallback.policy.id });
    }
    return out;
  }

  private async taskRef(input: PolicyResolveInput): Promise<string | null> {
    if (!input.taskId) return null;
    const task = await this.prisma.task.findFirst({ where: { id: input.taskId, userId: input.userId }, select: { policyRef: true } });
    return task?.policyRef ?? null;
  }

  private async tryFind(userId: string, ref: string, source: PolicySource, notes: string[]): Promise<PolicyRecord | null> {
    try {
      const policy = await this.policies.find(userId, ref);
      if (policy) return policy;
    } catch (e) {
      this.log.warn(`policy ${ref} (${LEVEL_LABEL[source]}) could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
    const note = `Policy ${ref} named by ${LEVEL_LABEL[source]} no longer exists or is not yours; using the next level.`;
    this.log.warn(note);
    notes.push(note);
    return null;
  }

  /** The snapshot a run stores for a resolved policy (`runs.policy_snapshot`). */
  snapshot(resolved: ResolvedPolicy, now = new Date()): RunPolicySnapshot {
    const { policy, source } = resolved;
    return { schemaVersion: 1, ref: policy.id, name: policy.name, version: policy.version, builtin: policy.builtin, source, spec: policy.spec, tiers: null, takenAt: now.toISOString() };
  }
}
