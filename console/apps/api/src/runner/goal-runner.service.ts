import { Injectable, Logger, Optional } from '@nestjs/common';
import { AiService, defineTool, type AiDefinedTool, type AiToolLoopResult } from '@marinoscar/platform-api/ai';
import { z } from 'zod';

import { FabricClient, FabricError } from '../fabric/fabric.client';
import { PrismaService } from '../prisma/prisma.service';
import { redactActionArgs, redactUrl } from '../tasks/redact';
import { RunNotifier } from '../tasks/run-notifier';
import { TasksService } from '../tasks/tasks.service';
import { BROWSER_AGENT_FEATURE_ID } from './browser-agent.feature';
import { FabricSession } from './fabric-session';
import { domainAllowed, looksRisky } from './policy';

/** Round-trips per `runTools` call (the platform's cap is 20). */
const CHUNK_STEPS = 20;
/** Lines of the step log handed back to the model each chunk. */
const LOG_LINES = 60;
const OBSERVATION_CHARS = 6_000;

/** What the run keeps between chunks and across a handoff (`runs.transcript`). Never secrets. */
export interface RunMemory {
  log: string[];
  /** A secret handoff whose value `type_handoff_secret` may type (once). */
  secretHandoffId?: string | null;
  /** A person approved one risky action. */
  confirmationGranted?: boolean;
  chunks: number;
}

export type RunOutcome = 'succeeded' | 'failed' | 'cancelled' | 'waiting_human' | 'requeue';

/** Ends a chunk early: the loop is stopped from `onStep`. */
class StopLoop extends Error {
  constructor(readonly reason: 'finish' | 'pause' | 'cancel' | 'budget') {
    super(reason);
  }
}

const INSTRUCTIONS = `You operate a real web browser for the user to reach their goal.
- Observe with observe_elements (interactive elements with CSS selectors) and read_text before acting. Use the selectors you were given.
- Act with navigate, click, type_text, press_key, scroll, wait_for and go_back. One action at a time; check the page after each.
- If a CAPTCHA, a one-time code, a passkey, a login you have no credentials for, or an approval is needed, call request_human. Never try to bypass or solve a bot check yourself.
- For a code or password the person gives you, call type_handoff_secret: you never see secret values.
- Before buying, paying, booking or submitting something irreversible, call request_human with kind "confirmation" unless you were told it was approved.
- Stay on the allowed sites. When done, or when the goal is impossible, call finish with a short, factual result.`;

function trim(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

@Injectable()
export class GoalRunnerService {
  private readonly log = new Logger(GoalRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly fabric: FabricClient,
    private readonly ai: AiService,
    @Optional() private readonly notifier?: RunNotifier,
  ) {}

  /**
   * Advance a run: start it, resume it after a handoff, or finish it.
   * Returns what the caller (the job) should do next.
   */
  async advance(runId: string, userId: string, orgId: string | null): Promise<RunOutcome> {
    const db = this.prisma.forUser({ userId });
    const run = await db.run.findFirst({ where: { id: runId }, include: { task: true } });
    if (!run) return 'failed';
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') return run.status;
    const session = new FabricSession(this.fabric);
    const memory: RunMemory = (run.transcript as unknown as RunMemory | null) ?? { log: [], chunks: 0 };

    if (run.cancelRequested) {
      await this.finish(userId, run.id, run.sessionId, session, 'cancelled', { error: 'Cancelled by the user' });
      return 'cancelled';
    }

    // Resume after a handoff: fold the person's answer into the memory.
    if (run.status === 'waiting_human') {
      if (!run.handoffId) {
        await this.tasks.transition(userId, run.id, 'failed', { error: 'Waiting for a person without a handoff' });
        return 'failed';
      }
      const h = await session.getHandoff(run.handoffId);
      if (h.status === 'pending') return 'waiting_human';
      if (h.status === 'completed' && h.response?.outcome === 'completed') {
        if (h.input === 'secret') {
          memory.secretHandoffId = h.id;
          memory.log.push('The person provided the secret. Type it with type_handoff_secret(selector).');
        } else if (h.input === 'text' || h.input === 'choice') {
          memory.log.push(`The person answered: ${trim(h.response.value ?? '', 500)}`);
        } else {
          memory.log.push(`The person completed the ${h.kind} step. Check the page and continue.`);
        }
        if (h.kind === 'confirmation') memory.confirmationGranted = true;
      } else {
        memory.log.push(`The person did not help (handoff ${h.status}${h.response?.outcome === 'cancelled' ? ', declined' : ''}). Do not retry the same request; finish if you cannot continue.`);
      }
      await this.tasks.transition(userId, run.id, 'running', { handoffId: null, transcript: memory as never });
    } else {
      await this.tasks.transition(userId, run.id, 'running');
      await this.notifier?.started?.(userId, run);
    }

    let sessionId = run.sessionId;
    if (!sessionId) {
      try {
        sessionId = await session.create({ profile: run.profile, hostId: run.hostId, label: `run ${run.id}` });
      } catch (e) {
        await this.finish(userId, run.id, null, session, 'failed', { error: `No browser available: ${e instanceof Error ? e.message : String(e)}` });
        return 'failed';
      }
      await db.run.updateMany({ where: { id: run.id }, data: { sessionId } });
    }

    const policy = {
      allowedDomains: run.task?.allowedDomains ?? [],
      maxSteps: run.task?.maxSteps ?? 40,
      deadline: (run.startedAt ?? new Date()).getTime() + (run.task?.maxMinutes ?? 15) * 60_000,
      confirmRisky: run.task?.confirmRiskyActions ?? true,
      model: run.task?.model ?? undefined,
    };
    const state = {
      stepCount: run.stepCount,
      stop: null as StopLoop['reason'] | null,
      finished: null as { success: boolean; result: string } | null,
      handoffId: null as string | null,
      handoffExpiresAt: null as Date | null,
      handoffAsk: null as { prompt: string; kind: string; input: string } | null,
      labels: new Map<string, string>(),
    };

    const record = async (kind: string, action: string | null, args: Record<string, unknown> | null, ok: boolean, summary: string, started: number, reasoning?: string) => {
      state.stepCount += 1;
      this.tasks.metrics.step(kind, ok);
      await this.prisma.runStep.create({
        data: {
          runId: run.id,
          seq: state.stepCount,
          kind,
          action,
          args: args ? (redactActionArgs(action ?? '', args) as never) : undefined,
          ok,
          summary: trim(summary, 1_900),
          reasoning: reasoning ? trim(reasoning, 1_900) : null,
          durationMs: Date.now() - started,
        },
      });
      await db.run.updateMany({ where: { id: run.id }, data: { stepCount: state.stepCount } });
      memory.log.push(`${state.stepCount}. ${action ?? kind}${args ? ` ${JSON.stringify(redactActionArgs(action ?? '', args))}` : ''} → ${ok ? 'ok' : 'FAILED'}: ${trim(summary, 300)}`);
    };

    /** Run one fabric action under the policy, record it, and return what the model sees. */
    const act = async (action: Record<string, unknown>, reason?: string): Promise<string> => {
      const started = Date.now();
      const type = String(action.type);
      if (state.stepCount >= policy.maxSteps) {
        state.stop = 'budget';
        return 'Step budget exhausted.';
      }
      let op;
      try {
        op = await session.act(sessionId!, action);
      } catch (e) {
        const msg = e instanceof FabricError ? e.message : String(e);
        await record('action', type, action, false, msg, started, reason);
        return `Error: ${msg}`;
      }
      if (op.state !== 'succeeded') {
        const msg = op.error ?? op.state;
        await record('action', type, action, false, msg, started, reason);
        return `Failed (${op.state}): ${msg}`;
      }
      const result = op.result ?? {};
      let summary = 'done';
      let forModel = 'ok';
      if (type === 'navigate') {
        // The model needs the real URL; the stored step gets it without its query.
        forModel = `at ${String(result.url ?? '')} — ${String(result.title ?? '')}`;
        summary = `at ${redactUrl(String(result.url ?? ''))} — ${trim(String(result.title ?? ''), 200)}`;
      }
      if (type === 'text') {
        const text = String(result.text ?? '');
        summary = `read ${text.length} characters`;
        forModel = trim(text, OBSERVATION_CHARS);
      }
      if (type === 'elements') {
        const els = (result.elements as Array<Record<string, unknown>> | undefined) ?? [];
        state.labels.clear();
        for (const el of els) state.labels.set(String(el.selector), `${String(el.text ?? '')} ${String(el.aria_label ?? el.name ?? '')}`);
        summary = `${els.length} interactive elements`;
        forModel = trim(JSON.stringify(els.map((el) => ({ selector: el.selector, tag: el.tag, role: el.role, text: el.text, type: el.type, name: el.name }))), OBSERVATION_CHARS);
      }
      if (type === 'scroll') summary = forModel = `scrolled to ${String(result.y ?? '?')}`;
      await record('action', type, action, true, summary, started, reason);
      return forModel;
    };

    const tools: AiDefinedTool[] = [
      defineTool({
        name: 'observe_elements',
        description: 'List the interactive elements of the current page with CSS selectors.',
        parameters: z.object({}),
        execute: () => act({ type: 'elements', max_elements: 80 }),
      }),
      defineTool({
        name: 'read_text',
        description: 'Read the visible text of the page, or of one element.',
        parameters: z.object({ selector: z.string().max(2000).nullable() }),
        execute: ({ selector }) => act({ type: 'text', ...(selector ? { selector } : {}), max_chars: OBSERVATION_CHARS }),
      }),
      defineTool({
        name: 'navigate',
        description: 'Open a URL in the current tab.',
        parameters: z.object({ url: z.string().max(2000), reason: z.string().max(500) }),
        execute: async ({ url, reason }) => {
          if (!domainAllowed(url, policy.allowedDomains)) {
            await record('action', 'navigate', { url }, false, 'refused by policy: site not allowed', Date.now(), reason);
            return `Refused: ${new URL(url, 'https://x.invalid').hostname} is not an allowed site (${policy.allowedDomains.join(', ') || 'http(s) only'}).`;
          }
          return act({ type: 'navigate', url }, reason);
        },
      }),
      defineTool({
        name: 'click',
        description: 'Click the element matching a CSS selector.',
        parameters: z.object({ selector: z.string().max(2000), reason: z.string().max(500) }),
        execute: async ({ selector, reason }) => {
          if (policy.confirmRisky && !memory.confirmationGranted && looksRisky(selector, state.labels.get(selector), reason)) {
            await record('action', 'click', { selector }, false, 'paused by policy: needs a person\'s confirmation', Date.now(), reason);
            return 'Refused: this looks like a purchase, payment or irreversible submission. Call request_human with kind "confirmation" describing exactly what will happen, then try again.';
          }
          const out = await act({ type: 'click', selector }, reason);
          if (looksRisky(selector, state.labels.get(selector), reason)) memory.confirmationGranted = false;
          return out;
        },
      }),
      defineTool({
        name: 'type_text',
        description: 'Type text into an input (not secrets: use type_handoff_secret for those).',
        parameters: z.object({ selector: z.string().max(2000), text: z.string().max(10_000), submit: z.boolean() }),
        execute: ({ selector, text, submit }) => act({ type: 'type', selector, text, clear: true, submit }),
      }),
      defineTool({
        name: 'press_key',
        description: 'Press a key such as Enter, Tab or Escape.',
        parameters: z.object({ key: z.string().max(40) }),
        execute: ({ key }) => act({ type: 'press', key }),
      }),
      defineTool({
        name: 'scroll',
        description: 'Scroll the page vertically by a number of pixels (negative scrolls up).',
        parameters: z.object({ dy: z.number().int().min(-20000).max(20000) }),
        execute: ({ dy }) => act({ type: 'scroll', dy }),
      }),
      defineTool({
        name: 'wait_for',
        description: 'Wait until an element matching a selector appears (up to 15 s).',
        parameters: z.object({ selector: z.string().max(2000) }),
        execute: ({ selector }) => act({ type: 'wait_for', selector, timeout_ms: 15_000 }),
      }),
      defineTool({
        name: 'go_back',
        description: 'Go back one page.',
        parameters: z.object({}),
        execute: () => act({ type: 'back' }),
      }),
      defineTool({
        name: 'request_human',
        description: 'Ask the person for help: a CAPTCHA, a one-time code, a passkey, a login, a choice, or a confirmation before an irreversible step. The run pauses until they answer.',
        parameters: z.object({
          kind: z.enum(['captcha', 'code', 'passkey', 'login', 'confirmation', 'other']),
          prompt: z.string().min(1).max(1500),
          input: z.enum(['none', 'text', 'secret', 'choice']),
          choices: z.array(z.string().max(200)).max(10).nullable(),
        }),
        execute: async ({ kind, prompt, input, choices }) => {
          const started = Date.now();
          try {
            const h = await session.openHandoff(sessionId!, { kind, prompt, input, choices: choices ?? [] });
            state.handoffId = h.id;
            state.handoffExpiresAt = h.expiresAt;
          } catch (e) {
            await record('handoff', null, null, false, `could not ask a person: ${e instanceof Error ? e.message : String(e)}`, started);
            return 'Could not reach a person right now.';
          }
          await record('handoff', null, { kind, input }, true, `asked a person (${kind}): ${trim(prompt, 300)}`, started);
          state.handoffAsk = { prompt, kind, input };
          state.stop = 'pause';
          return 'Waiting for the person.';
        },
      }),
      defineTool({
        name: 'type_handoff_secret',
        description: 'Type the secret (code or password) the person gave through request_human into an input. You never see the value.',
        parameters: z.object({ selector: z.string().max(2000), submit: z.boolean() }),
        execute: async ({ selector, submit }) => {
          const started = Date.now();
          if (!memory.secretHandoffId) return 'No secret is available: call request_human with input "secret" first.';
          let value: string;
          try {
            value = await session.claimSecret(memory.secretHandoffId);
          } catch {
            memory.secretHandoffId = null;
            await record('action', 'type', { selector, secret: '' }, false, 'the secret was already used or expired', started);
            return 'The secret is no longer available; ask the person again if needed.';
          }
          memory.secretHandoffId = null;
          let op;
          try {
            op = await session.act(sessionId!, { type: 'type', selector, text: value, clear: true, submit });
          } finally {
            value = '';
          }
          const ok = op.state === 'succeeded';
          await record('action', 'type', { selector, submit }, ok, ok ? 'typed the secret' : (op.error ?? op.state), started);
          return ok ? 'Typed the secret.' : `Failed: ${op.error ?? op.state}`;
        },
      }),
      defineTool({
        name: 'finish',
        description: 'End the run with a short factual result.',
        parameters: z.object({ success: z.boolean(), result: z.string().min(1).max(4000) }),
        execute: async ({ success, result }) => {
          state.finished = { success, result };
          state.stop = 'finish';
          await record('finish', null, null, success, trim(result, 1_900), Date.now());
          return 'Finished.';
        },
      }),
    ];

    const goal = run.goal;
    const remainingChunks = Math.max(1, Math.ceil(policy.maxSteps / 4));
    let usage = { input: 0, output: 0 };
    for (let chunk = 0; chunk < remainingChunks; chunk++) {
      memory.chunks += 1;
      const input = [
        `Goal: ${goal}`,
        `Allowed sites: ${policy.allowedDomains.join(', ') || 'any http(s) site'}. Steps used: ${state.stepCount} of ${policy.maxSteps}.`,
        memory.log.length ? `Progress so far (latest last):\n${memory.log.slice(-LOG_LINES).join('\n')}` : 'Nothing has been done yet. Start by navigating or observing the page.',
        memory.confirmationGranted ? 'The person approved the next irreversible step.' : '',
        'Continue toward the goal.',
      ]
        .filter(Boolean)
        .join('\n\n');
      let result: AiToolLoopResult | null = null;
      try {
        result = await this.ai.forUser(userId, { feature: BROWSER_AGENT_FEATURE_ID, ...(orgId ? { orgId } : {}) }).runTools({
          ...(policy.model ? { model: policy.model } : {}),
          instructions: INSTRUCTIONS,
          input,
          tools,
          maxSteps: CHUNK_STEPS,
          onStep: (step) => {
            usage = { input: usage.input + (step.response.usage.inputTokens ?? 0), output: usage.output + (step.response.usage.outputTokens ?? 0) };
            if (Date.now() > policy.deadline) state.stop = 'budget';
            if (state.stop) throw new StopLoop(state.stop);
          },
        });
      } catch (e) {
        if (!(e instanceof StopLoop)) {
          await this.saveMemory(userId, run.id, memory, usage);
          throw e;
        }
      }
      await this.saveMemory(userId, run.id, memory, usage);
      usage = { input: 0, output: 0 };

      const fresh = await db.run.findFirst({ where: { id: run.id }, select: { cancelRequested: true } });
      if (fresh?.cancelRequested) {
        await this.finish(userId, run.id, sessionId, session, 'cancelled', { error: 'Cancelled by the user' });
        return 'cancelled';
      }
      if (state.stop === 'pause' && state.handoffId) {
        await this.tasks.transition(userId, run.id, 'waiting_human', { handoffId: state.handoffId, handoffExpiresAt: state.handoffExpiresAt });
        await this.notifier?.needsYou(userId, { ...run, handoffId: state.handoffId ?? null }, state.handoffAsk?.prompt ?? 'The agent needs you.', state.handoffAsk?.kind ?? 'other', state.handoffAsk?.input ?? 'none', state.handoffExpiresAt);
        return 'waiting_human';
      }
      if (state.stop === 'finish' && state.finished) {
        const to = state.finished.success ? 'succeeded' : 'failed';
        await this.finish(userId, run.id, sessionId, session, to, state.finished.success ? { result: state.finished.result } : { result: state.finished.result, error: 'The agent could not reach the goal' });
        return to;
      }
      if (state.stop === 'budget') {
        await this.finish(userId, run.id, sessionId, session, 'failed', { error: Date.now() > policy.deadline ? 'Time budget exhausted' : 'Step budget exhausted' });
        return 'failed';
      }
      if (result && result.stopReason === 'completed') {
        // The model answered without calling finish: take its answer as the result.
        await this.finish(userId, run.id, sessionId, session, 'succeeded', { result: trim(result.final.outputText || 'Done.', 7_900) });
        return 'succeeded';
      }
      // steps_exhausted: another chunk.
    }
    await this.finish(userId, run.id, sessionId, session, 'failed', { error: 'The agent did not finish within its budget' });
    return 'failed';
  }

  private async saveMemory(userId: string, runId: string, memory: RunMemory, usage: { input: number; output: number }) {
    memory.log = memory.log.slice(-200);
    this.tasks.metrics.tokens(usage.input, usage.output);
    await this.prisma.forUser({ userId }).run.updateMany({
      where: { id: runId },
      data: { transcript: memory as never, inputTokens: { increment: usage.input }, outputTokens: { increment: usage.output } },
    });
  }

  private async finish(
    userId: string,
    runId: string,
    sessionId: string | null,
    session: FabricSession,
    to: 'succeeded' | 'failed' | 'cancelled',
    patch: { result?: string; error?: string },
  ) {
    if (sessionId) await session.end(sessionId);
    const done = await this.tasks.transition(userId, runId, to, patch);
    this.log.log(`run ${runId}: ${to}`);
    await this.notifier?.finished(userId, done, to, patch.result ?? patch.error);
  }
}
