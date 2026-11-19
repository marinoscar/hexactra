// The run's policy, snapshotted once at its first advance (#401), and the deployment's price table and budget ceilings.
import { Prisma } from '@prisma/client';

import { balancedSpec, builtinPolicy, SYSTEM_DEFAULT_POLICY_REF } from '../../policies/builtin-policies';
import { readAppLimits, readSnapshot, type RunPolicySnapshot } from '../../policies/policy-snapshot';
import type { PrismaService } from '../../prisma/prisma.service';
import { priceTableOf } from '../agent-pricing.settings';
import { computeEffectiveBudget, enforcementFor, isUnlimited, UNLIMITED_LOG_LINE, type BudgetCeilings } from '@marinoscar/hexactra-agent';
import type { PriceTable } from '@marinoscar/hexactra-agent';
import type { RunMemory } from './run-memory';
import { runConnections } from './connections/run-connections';
import type { HostDeps } from './deps';

  /** The admin's price table; empty when unreadable (calls are then unpriced, never free). */
export async function priceTable(d: HostDeps): Promise<PriceTable> {
    try {
      return priceTableOf(await d.systemSettings?.getNamespace('agentPricing'));
    } catch (e) {
      d.log.warn(`could not read the agent price table: ${e instanceof Error ? e.message : String(e)}`);
      return {};
    }
  }
  /** The deployment's budget ceilings; none when unreadable or when no settings service is wired. */
export async function ceilings(d: HostDeps): Promise<BudgetCeilings> {
    try {
      return (await d.systemSettings?.getNamespace('browserAgentCeilings')) ?? {};
    } catch (e) {
      d.log.warn(`could not read the budget ceilings: ${e instanceof Error ? e.message : String(e)}`);
      return {};
    }
  }

  /**
   * The agent policy the run runs under (#401), snapshotted onto the run at its
   * FIRST advance and never again: a later edit of the policy or of the user's
   * settings does not change a live run. Fall-through notes (a level that named
   * a deleted or foreign policy) go to the run's first log line.
   */
export async function policySnapshot(
  d: HostDeps,
  db: ReturnType<PrismaService['forUser']>, run: { id: string; userId: string; taskId: string | null; conversationId?: string | null; policyRef: string | null; policySource: RunPolicySnapshot['source'] | null; policySnapshot: Prisma.JsonValue | null; appLimits?: Prisma.JsonValue | null; trigger?: string | null; task: { policyRef: string | null } | null }, memory: RunMemory): Promise<RunPolicySnapshot> {
    const stored = readSnapshot(run.policySnapshot);
    if (stored) {
      // Upgrade an older snapshot once, then never change it: the effective budget (#404) and the model tiers (#403).
      let upgraded = stored;
      if (!upgraded.effectiveBudget) upgraded = { ...upgraded, effectiveBudget: computeEffectiveBudget(upgraded.spec.budget, await ceilings(d), enforcementFor(run.trigger)) };
      if (upgraded.resolvedTiers === undefined && d.modelTiers) upgraded = await withTiers(d, run.userId, upgraded);
      if (upgraded !== stored) await db.run.updateMany({ where: { id: run.id }, data: { policySnapshot: upgraded as never } });
      return upgraded;
    }
    let snapshot: RunPolicySnapshot;
    let notes: string[] = [];
    if (d.policies) {
      const resolved = await d.policies.forRun({
        userId: run.userId,
        taskId: run.taskId,
        policyRef: run.policyRef,
        policySource: run.policySource,
        taskPolicyRef: run.task ? run.task.policyRef : null,
      });
      snapshot = d.policies.snapshot(resolved);
      notes = resolved.notes;
      snapshot = await withTiers(d, run.userId, snapshot);
    } else {
      // Without a resolver (a runner built by hand): the system default.
      const b = builtinPolicy(SYSTEM_DEFAULT_POLICY_REF)!;
      snapshot = { schemaVersion: 1, ref: b.id, name: b.name, version: b.version, builtin: true, source: 'system_default', spec: balancedSpec(), tiers: null, takenAt: new Date().toISOString() };
      snapshot = await withTiers(d, run.userId, snapshot);
    }
    // What the run is held to: the policy's budget under the deployment's ceilings, fixed for the run (#404).
    // A chat run is interactive: the owner is present, so its budgets are soft, shown and never enforced (#537).
    snapshot = { ...snapshot, effectiveBudget: computeEffectiveBudget(snapshot.spec.budget, await ceilings(d), enforcementFor(run.trigger)) };
    // The limits of the AI app that started it (#464), recorded on the run at its start: the snapshot keeps them.
    const appLimits = readAppLimits(run.appLimits);
    if (appLimits) snapshot = { ...snapshot, appLimits };
    // The connections it may use (E39.7), as the task or chat lists them now: fixed for the run.
    const connections = await runConnections(d, run, appLimits);
    if (connections.length > 0) snapshot = { ...snapshot, connections };
    // Compare-and-set: only the first writer's snapshot stands (a retried job re-reads it).
    const { count } = await db.run.updateMany({
      where: { id: run.id, policySnapshot: { equals: Prisma.DbNull } },
      data: { policyRef: snapshot.ref, policyVersion: snapshot.version, policySource: snapshot.source, policySnapshot: snapshot as never },
    });
    if (count === 0) {
      const fresh = await db.run.findFirst({ where: { id: run.id }, select: { policySnapshot: true } });
      const winner = readSnapshot(fresh?.policySnapshot);
      if (winner) return winner;
    }
    if (isUnlimited(snapshot.effectiveBudget!)) memory.log.unshift(UNLIMITED_LOG_LINE);
    for (const n of notes) memory.log.push(n);
    return snapshot;
  }

  /** The snapshot with its three model tiers resolved (#403): the models of the run are fixed here, once. */
export async function withTiers(d: HostDeps, userId: string, snapshot: RunPolicySnapshot): Promise<RunPolicySnapshot> {
    if (!d.modelTiers) return snapshot;
    try {
      const resolvedTiers = await d.modelTiers.resolve(userId, snapshot.spec);
      const tiers = Object.fromEntries(Object.entries(resolvedTiers).map(([t, r]) => [t, { provider: r.provider, model: r.modelId ?? r.model }]));
      return { ...snapshot, resolvedTiers, tiers };
    } catch (e) {
      // Without resolved tiers the platform's target resolver picks the model, as before.
      d.log.warn(`run: the model tiers could not be resolved: ${e instanceof Error ? e.message : String(e)}`);
      return snapshot;
    }
  }
