// The host's ways of leaving a run: ending it, pausing it before the loop started, saving its memory, and the question broker mirror.
import { ConflictException } from '@nestjs/common';

import type { RunMemory } from './run-memory';
import { savedApprovalsLine } from '../../approvals/approval-runner';
import { LeaseLost, type RunLease } from '../lease';
import { hostOf } from '@marinoscar/hexactra-browser-agent/policy';
import type { FabricSession, CreatedHandoff } from '../fabric-session';
import type { RunPatch } from '../../tasks/tasks.service';
import type { QuestionSpec } from '../../questions/questions.contract';
import { answerSummary } from '../trace';
import { readUsedSavedLogins } from '../saved-logins';
import { RunUsage, type RunStopReason, type RunOutcome, type UsageDelta } from '@marinoscar/hexactra-agent';
import type { HostDeps } from './deps';

/** Record the handoff in the question broker (the inbox and the channels read it there). Never fails the run. Returns the question's id, so the step that asked it links to it (#541); null without the broker or on a failure. */
export async function mirror(d: HostDeps, userId: string, runId: string, sessionId: string, created: CreatedHandoff, spec: QuestionSpec): Promise<string | null> {
  if (!d.questions) return null;
  try {
    const q = await d.questions.mirrorHandoff({ id: userId }, spec, created, { askedBy: `run:${runId}`, runId, fabricSessionId: sessionId });
    return q.id ?? null;
  } catch (e) {
    d.log.warn(`run ${runId}: could not mirror handoff ${created.id}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** The owner's answer as a step of the trace (#541): after the run's last step; not an action. Never fails the run. */
export async function recordAnswer(d: HostDeps, runId: string, questionId: string | null, facts: Parameters<typeof answerSummary>[0]): Promise<void> {
  try {
    // Once per question: a retried job that folds the same answer again (it died before the run left `waiting_human`) adds no second step (E38.3).
    if (questionId && (await d.prisma.runStep.count({ where: { runId, kind: 'handoff', action: 'answered', questionId } })) > 0) return;
    const last = await d.prisma.runStep.aggregate({ where: { runId }, _max: { seq: true } });
    await d.prisma.runStep.create({
      data: { runId, seq: (last._max.seq ?? 0) + 1, kind: 'handoff', action: 'answered', ok: facts.completed, summary: answerSummary(facts), durationMs: 0, ...(questionId ? { questionId } : {}) },
    });
  } catch (e) {
    d.log.warn(`run ${runId}: could not record the answer step: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Saves the memory and the usage of the chunk, conditional on the lease: a job that lost the run throws `LeaseLost` and writes nothing (E38.3). */
export async function saveMemoryRaw(d: HostDeps, userId: string, runId: string, memory: RunMemory, usage: UsageDelta, lease: RunLease): Promise<boolean> {
  memory.log = memory.log.slice(-200);
  const { count } = await d.prisma.forUser({ userId }).run.updateMany({
    where: { id: runId, ...lease.guard },
    data: {
      transcript: memory as never,
      inputTokens: { increment: usage.inputTokens },
      outputTokens: { increment: usage.outputTokens },
      cachedInputTokens: { increment: usage.cachedInputTokens },
      modelCalls: { increment: usage.modelCalls },
      costUsd: { increment: usage.costUsd },
      // Only ever flips to false: one unpriced call makes the whole figure a lower bound.
      ...(usage.costKnown ? {} : { costKnown: false }),
    },
  });
  return count > 0;
}

/**
 * Pauses the run this job holds (E38.2): the memory and the usage of the chunk are saved, the status becomes `paused` (active time stops, as for
 * `waiting_human`) and the browser session is kept: it stays where it is. The job ends; Resume starts a new one. A run stopped or failed in the
 * meantime is not paused (`superseded`: the job has nothing more to do).
 */
export async function pauseRunRaw(d: HostDeps, userId: string, runId: string, patch: RunPatch): Promise<boolean> {
  try {
    await d.tasks.transition(userId, runId, 'paused', patch);
  } catch (e) {
    if (e instanceof ConflictException) return false;
    throw e;
  }
  d.log.log(`run ${runId}: paused`);
  return true;
}

/** Pauses a run before the loop started: nothing was used yet. */
export async function pauseEarly(d: HostDeps, userId: string, runId: string, memory: RunMemory, lease: RunLease, patch: RunPatch = {}): Promise<RunOutcome> {
  if (!(await saveMemoryRaw(d, userId, runId, memory, new RunUsage().drain(), lease))) throw new LeaseLost(runId);
  return (await pauseRunRaw(d, userId, runId, patch)) ? 'paused' : 'superseded';
}

export async function finishRun(d: HostDeps, userId: string, runId: string, sessionId: string | null, session: FabricSession, to: 'succeeded' | 'failed' | 'cancelled', patch: { result?: string; error?: string; stopReason?: RunStopReason; outputs?: Record<string, { value: unknown; ok: boolean; note?: string }>; outputsComplete?: boolean }): Promise<void> {
  if (sessionId) await session.end(sessionId);
  const done = await d.tasks.transition(userId, runId, to, patch as RunPatch);
  d.log.log(`run ${runId}: ${to}`);
  // The saved result: it leads with a confirmed step the run carried out (#540).
  await d.notifier?.finished(userId, done, to, done.result ?? patch.error);
  // A scheduled run that signed in with a saved login (E37.3): one notification at the end of the run, grouped by site.
  try {
    const used = readUsedSavedLogins((done as { usedSavedLogins?: unknown }).usedSavedLogins);
    if (used.length > 0 && (done as { trigger?: string }).trigger === 'schedule') {
      await d.notifier?.savedLoginUsed?.(userId, done, used.map((u) => hostOf(u.origin) ?? u.origin));
    }
  } catch (e) {
    d.log.warn(`run ${runId}: could not tell the owner about the saved login: ${e instanceof Error ? e.message : String(e)}`);
  }
  // The Knowledge Graph (E46.7): a captured run that succeeded is compiled by a queue job. Never fails the run.
  await d.kgraphAfterRun?.finished(userId, runId, to).catch(() => undefined);
  // Site facts given in the run's block and named by its steps are marked used (E46.32). Never fails the run.
  await d.kgraphSiteFacts?.afterRun(userId, runId).catch(() => undefined);
  // Steps that went ahead on saved approvals (#555): one notification at the end of the run. Ask rules do not notify.
  try {
    const line = savedApprovalsLine((await d.approvals?.gateUsesOfRun(userId, runId)) ?? []);
    if (line) await d.notifier?.savedApprovalsUsed?.(userId, done, line);
  } catch (e) {
    d.log.warn(`run ${runId}: could not tell the owner about saved approvals: ${e instanceof Error ? e.message : String(e)}`);
  }
}
