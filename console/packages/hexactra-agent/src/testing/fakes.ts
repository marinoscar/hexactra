// In-memory fakes of every harness port, and a scripted model. They need no database, no browser and no model: the harness's own tests and a
// second host's tests run on them (E38.5). They are deliberately small and honest: each keeps what it was asked, so a test can read it back.
import { computeEffectiveBudget, type EffectiveBudget } from '../budget';
import type { ModelPort, ModelRequest, ModelResult, ModelStep, OpenedQuestion, Ports, QuestionPort, QuestionSpec, RunStorePort, StepFacts, StepPatch, StoredStep, TelemetryPort } from '../ports';
import type { ApprovalPort } from '../ports';
import type { ControlPort } from '../ports';
import type { HarnessMemory } from '../types';

/** A budget with no limit: only finishing, a stop or a stall ends the run. */
export const UNLIMITED: EffectiveBudget = computeEffectiveBudget(
  { maxActions: null, maxModelCalls: null, maxActiveMinutes: null, maxInputTokens: null, maxOutputTokens: null, maxCostUsd: null, warnAtPercent: 80 },
  null,
);

export class FakeRunStore implements RunStorePort {
  steps = new Map<number, StoredStep & { screenshotKey: string | null; questionId?: string | null }>();
  memory: HarnessMemory | null = null;
  usage = { checkpoints: 0 };
  activities: string[] = [];
  transitions: { to: string; patch?: unknown }[] = [];
  finished: { to: string; patch: unknown } | null = null;
  paused = false;
  confirmed: { seq: number; prompt: string; action: string }[] = [];
  tier: { tier: string; escalations: number } | null = null;
  guidance: string[] = [];
  /** Simulates another job taking the run: every conditional write answers false. */
  lost = false;
  /** Rows a retried job would find: intents left behind by a crash. */
  seed(row: Partial<StoredStep> & { seq: number }): void {
    this.steps.set(row.seq, { kind: 'action', action: null, args: null, ok: true, phase: 'done', summary: '', screenshotKey: null, ...row });
  }
  async holdsRun() {
    return !this.lost;
  }
  async checkpoint(input: { memory: HarnessMemory }) {
    if (this.lost) return false;
    this.memory = structuredClone(input.memory);
    this.usage.checkpoints += 1;
    return true;
  }
  async commitStep({ memory, step, finishesIntent }: Parameters<RunStorePort['commitStep']>[0]) {
    if (this.lost) return false;
    this.memory = structuredClone(memory);
    const prior = this.steps.get(step.seq);
    if (finishesIntent && !prior) throw new Error(`no intent at ${step.seq}`);
    this.steps.set(step.seq, { ...step, args: step.args ?? null, phase: step.phase ?? 'done', screenshotKey: null });
    return true;
  }
  async saveMemory(memory: HarnessMemory) {
    if (this.lost) return false;
    this.memory = structuredClone(memory);
    return true;
  }
  async openIntent(memory: HarnessMemory, step: Parameters<RunStorePort['openIntent']>[1]) {
    if (!(await this.saveMemory(memory))) return false;
    this.steps.set(step.seq, { ...step, args: step.args ?? null, phase: 'intent', screenshotKey: null });
    return true;
  }
  async appendStep(step: Parameters<RunStorePort['appendStep']>[0]) {
    this.steps.set(step.seq, { ...step, args: step.args ?? null, phase: step.phase ?? 'done', screenshotKey: null });
  }
  async getStep(seq: number) {
    return this.steps.get(seq) ?? null;
  }
  async patchStep(seq: number, patch: StepPatch) {
    const row = this.steps.get(seq);
    if (row) this.steps.set(seq, { ...row, ...patch, args: patch.args ?? row.args });
  }
  async newestSeq() {
    return Math.max(0, ...this.steps.keys());
  }
  async stepsToReconcile(afterSeq: number | undefined) {
    return [...this.steps.values()].filter((s) => s.phase === 'intent' || (afterSeq !== undefined && s.seq > afterSeq)).sort((a, b) => a.seq - b.seq);
  }
  async markUnknown(seq: number, summary: string) {
    const row = this.steps.get(seq);
    if (row) this.steps.set(seq, { ...row, phase: 'unknown', ok: false, summary });
  }
  async setActivity(phase: string) {
    this.activities.push(phase);
  }
  async setTier(tier: string, escalations: number) {
    this.tier = { tier, escalations };
  }
  async appendConfirmedAction(entry: { seq: number; prompt: string; action: string }) {
    this.confirmed.push(entry);
  }
  async takeGuidance() {
    return this.guidance.splice(0);
  }
  async transition(to: string, patch?: unknown) {
    this.transitions.push({ to, patch });
  }
  async pause() {
    this.paused = true;
    return true;
  }
  async finish(to: string, patch: unknown) {
    this.finished = { to, patch };
  }
  /** The rows in `seq` order, for a snapshot. */
  rows(): StoredStep[] {
    return [...this.steps.values()].sort((a, b) => a.seq - b.seq);
  }
}

export class FakeControl implements ControlPort {
  requested = false;
  pauseRequested = false;
  readonly abortSignal = new AbortController().signal;
  readonly haltSignal = new AbortController().signal;
  async readFlags() {
    return { cancelRequested: this.requested, pauseRequested: this.pauseRequested };
  }
}

export class FakeQuestions implements QuestionPort {
  opened: QuestionSpec[] = [];
  failToOpen = false;
  /** Ask without a browser (E39.7): the question has no handoff and the run waits on it by its own id. */
  noHandoff = false;
  parse(raw: Record<string, unknown>) {
    if (typeof raw.prompt !== 'string' || !raw.prompt) return { ok: false as const, message: 'prompt: required' };
    return { ok: true as const, spec: raw as unknown as QuestionSpec };
  }
  prepare(spec: QuestionSpec) {
    return spec;
  }
  async open(spec: QuestionSpec): Promise<OpenedQuestion> {
    if (this.failToOpen) throw new Error('nobody to ask');
    this.opened.push(spec);
    return { handoffId: this.noHandoff ? null : `handoff-${this.opened.length}`, expiresAt: null, questionId: `question-${this.opened.length}` };
  }
}

export class FakeApprovals implements ApprovalPort {
  enabled = true;
  rules: { host: string; category: string; label: string; id: string; summary: string }[] = [];
  /** Connection rules (E39.7): the connection, the tool and the approved recipients. */
  connectionRules: { connectionId: string; tool: string; recipients: string[]; id: string; summary: string }[] = [];
  uses: { id: string; stepSeq: number }[] = [];
  async matchGate(t: { host: string; category: string; label: string }) {
    return this.rules.find((r) => r.host === t.host && r.category === t.category && r.label === t.label) ?? null;
  }
  async matchAsk() {
    return null;
  }
  async matchConnection(t: { connectionId: string; tool: string; recipients: readonly string[] }) {
    const covered = (r: { recipients: string[] }, a: string) => r.recipients.includes(a.toLowerCase()) || r.recipients.includes(a.toLowerCase().slice(a.indexOf('@')));
    return this.connectionRules.find((r) => r.connectionId === t.connectionId && r.tool === t.tool && t.recipients.every((a) => covered(r, a))) ?? null;
  }
  async recordUse(rule: { id: string }, use: { stepSeq: number }) {
    this.uses.push({ id: rule.id, stepSeq: use.stepSeq });
  }
  rememberableGate() {
    return null;
  }
  rememberableAsk() {
    return null;
  }
  topicOf() {
    return 'other';
  }
  async askTopicsLine() {
    return null;
  }
}

export class FakeTelemetry implements TelemetryPort {
  calls: string[] = [];
  within<T>(fn: () => Promise<T>) {
    return fn();
  }
  toolCall<T>(name: string, fn: () => Promise<T>) {
    this.calls.push(`tool:${name}`);
    return fn();
  }
  setTier() {}
  chunkStart(n: number) {
    this.calls.push(`chunk:${n}`);
  }
  modelCall(_step: StepFacts) {
    this.calls.push('model');
  }
  modelFailed() {}
  useFallback() {}
  stepRecorded() {}
  toolAttributes(attrs: Record<string, string | number | boolean>) {
    this.calls.push(`attrs:${JSON.stringify(attrs)}`);
  }
  gated(category: string) {
    this.calls.push(`gated:${category}`);
  }
  asked() {}
  answered() {}
}

type Script = ((req: ModelRequest) => Promise<void>) | [name: string, args: unknown][];

/**
 * A model that makes the scripted tool calls, one script per `runTools` call (a chunk). A script is a list of `[tool, arguments]` or a
 * function. It keeps every request, so a test can read the instructions, the input and the tools of each round.
 */
export class ScriptedModel implements ModelPort {
  requests: ModelRequest[] = [];
  outputs: string[] = [];
  constructor(private readonly scripts: Script[]) {}
  async runTools(req: ModelRequest): Promise<ModelResult> {
    this.requests.push(req);
    const script = this.scripts.shift() ?? [];
    if (typeof script === 'function') {
      await script(req);
      return { stopReason: 'steps_exhausted', outputText: '' };
    }
    let n = 0;
    for (const [name, args] of script) {
      const tool = req.tools.find((t) => t.name === name);
      if (!tool) {
        this.outputs.push(`NO TOOL ${name}`);
        continue;
      }
      this.outputs.push(await tool.execute(args as never));
      const step: ModelStep = { response: { usage: { inputTokens: 10, outputTokens: 5 } } };
      n += 1;
      req.onStep(step);
    }
    void n;
    return { stopReason: 'steps_exhausted', outputText: '' };
  }
}

export type { Ports };
