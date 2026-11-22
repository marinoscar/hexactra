// In-memory fakes of every port. Deterministic; no timers unless a test asks for them.
import type { ClockPort, EvidenceOutcome, IdPort, JudgePort, JudgeRequest, JudgeResult, ProbedLocation, ProcedureStorePort, StateProbePort, TelemetryAttributes, TelemetryPort, ToolCallRequest, ToolInvocation, ToolInvokerPort } from '../ports';
import { canTransition, emptyEvidence, type Evidence, type Procedure, type ProcedureVersion, type VersionState } from '../schema';

const clone = <T>(v: T): T => structuredClone(v);

function bump(e: Evidence, outcome: EvidenceOutcome, at: string): Evidence {
  if (outcome === 'success') return { ...e, successes: e.successes + 1, lastSuccessAt: at };
  if (outcome === 'failure') return { ...e, failures: e.failures + 1, lastFailureAt: at };
  return { ...e, repairs: e.repairs + 1 };
}

/** A `ProcedureStorePort` in memory, keeping every guarantee of the port (owner isolation, immutable versions, compare-and-set). */
export class InMemoryProcedureStore implements ProcedureStorePort {
  private readonly procedures = new Map<string, Procedure>();
  private readonly versions = new Map<string, { owner: string; version: ProcedureVersion }>();

  async getProcedure(owner: string, id: string) {
    const p = this.procedures.get(id);
    return p && p.owner === owner ? clone(p) : null;
  }
  async findProcedureForTask(owner: string, task: string) {
    for (const p of this.procedures.values()) if (p.owner === owner && p.task === task) return clone(p);
    return null;
  }
  async listProcedures(owner: string) {
    return [...this.procedures.values()].filter((p) => p.owner === owner).map(clone);
  }
  async putProcedure(procedure: Procedure) {
    const existing = this.procedures.get(procedure.id);
    if (existing && existing.owner !== procedure.owner) throw new Error('procedure belongs to another owner');
    this.procedures.set(procedure.id, clone(procedure));
  }
  async getVersion(owner: string, id: string) {
    const v = this.versions.get(id);
    return v && v.owner === owner ? clone(v.version) : null;
  }
  async listVersions(owner: string, procedure: string) {
    return [...this.versions.values()]
      .filter((v) => v.owner === owner && v.version.procedure === procedure)
      .map((v) => clone(v.version))
      .sort((a, b) => b.number - a.number);
  }
  async putVersion(owner: string, version: ProcedureVersion) {
    if (this.versions.has(version.id)) throw new Error(`version ${version.id} exists`);
    const p = this.procedures.get(version.procedure);
    if (!p || p.owner !== owner) throw new Error('procedure not found for this owner');
    this.versions.set(version.id, { owner, version: clone(version) });
  }
  async setVersionState(owner: string, id: string, expected: VersionState, next: VersionState) {
    const v = this.versions.get(id);
    if (!v || v.owner !== owner || v.version.state !== expected || !canTransition(expected, next)) return false;
    v.version.state = next;
    return true;
  }
  async recordEvidence(owner: string, id: string, step: string | null, outcome: EvidenceOutcome, at: string) {
    const v = this.versions.get(id);
    if (!v || v.owner !== owner) throw new Error('version not found for this owner');
    v.version.evidence = bump(v.version.evidence, outcome, at);
    if (step !== null) v.version.stepEvidence[step] = bump(v.version.stepEvidence[step] ?? emptyEvidence(), outcome, at);
    return clone(v.version.evidence);
  }
  async deleteAll(owner: string) {
    let n = 0;
    for (const [id, p] of this.procedures) if (p.owner === owner) {
      this.procedures.delete(id);
      n++;
    }
    for (const [id, v] of this.versions) if (v.owner === owner) this.versions.delete(id);
    return n;
  }
}

/** One scripted reply: a full invocation, or a function of the request. */
export type ScriptedReply = Partial<ToolInvocation> | ((request: ToolCallRequest) => Partial<ToolInvocation> | Promise<Partial<ToolInvocation>>);

/** A `ToolInvokerPort` that answers from a script per tool name (in order; the last reply repeats) and records every call. */
export class ScriptedToolInvoker implements ToolInvokerPort {
  readonly calls: ToolCallRequest[] = [];
  private readonly script = new Map<string, ScriptedReply[]>();

  constructor(script: Record<string, ScriptedReply | ScriptedReply[]> = {}) {
    for (const [tool, r] of Object.entries(script)) this.script.set(tool, Array.isArray(r) ? [...r] : [r]);
  }
  on(tool: string, ...replies: ScriptedReply[]): this {
    this.script.set(tool, [...(this.script.get(tool) ?? []), ...replies]);
    return this;
  }
  async invoke(request: ToolCallRequest): Promise<ToolInvocation> {
    this.calls.push(clone(request));
    const queue = this.script.get(request.tool);
    if (!queue || queue.length === 0) return { ok: false, text: `no scripted reply for ${request.tool}`, digest: 'none', refused: false, stopped: false, paused: false };
    const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
    const r = typeof reply === 'function' ? await reply(request) : reply;
    return { ok: true, text: '', digest: `d:${request.tool}`, refused: false, stopped: false, paused: false, ...r };
  }
}

/** Replies for the scripted invoker: a gate refusal, the owner's Stop or Pause, a failed call, a crash (the call throws). */
export const replies = {
  ok: (text = '', value?: unknown): Partial<ToolInvocation> => ({ ok: true, text, ...(value !== undefined ? { value } : {}) }),
  refused: (): Partial<ToolInvocation> => ({ ok: false, text: 'refused by a gate', refused: true }),
  stopped: (): Partial<ToolInvocation> => ({ ok: false, text: 'stopped', stopped: true }),
  paused: (): Partial<ToolInvocation> => ({ ok: false, text: 'paused', paused: true }),
  failed: (text = 'failed'): Partial<ToolInvocation> => ({ ok: false, text }),
  /** A crash between the intent and the result: the call never returns. */
  crash: (): ScriptedReply => () => {
    throw new Error('crashed between intent and result');
  },
};

/** A `StateProbePort` over a mutable state a test sets. */
export class FakeStateProbe implements StateProbePort {
  location_: ProbedLocation | null = null;
  /** Set the page the probe reports (a test moves it as the scripted tools would). */
  at(url: string | null): this {
    this.location_ = url === null ? null : { url };
    return this;
  }
  digest: string | null = null;
  present = new Set<string>();
  async location() {
    return this.location_;
  }
  async viewDigest() {
    return this.digest;
  }
  async elementPresent(selector: string) {
    return this.present.has(selector);
  }
}

/** A `JudgePort` that answers from a function and records every request. */
export class FakeJudge implements JudgePort {
  readonly requests: JudgeRequest[] = [];
  constructor(private readonly answer: (r: JudgeRequest) => JudgeResult = () => ({ ok: false })) {}
  async judge(request: JudgeRequest) {
    this.requests.push(clone(request));
    return this.answer(request);
  }
}

/** A `ClockPort` whose time moves only when a test (or `sleep`) moves it. */
export class FakeClock implements ClockPort {
  private t: number;
  readonly sleeps: number[] = [];
  constructor(start = '2026-01-01T00:00:00.000Z') {
    this.t = Date.parse(start);
  }
  now() {
    return new Date(this.t);
  }
  advance(ms: number) {
    this.t += ms;
  }
  async sleep(ms: number) {
    this.sleeps.push(ms);
    this.t += ms;
  }
}

/** An `IdPort` counting up per prefix: `p1`, `p2`, ... */
export class SequentialIds implements IdPort {
  private readonly n = new Map<string, number>();
  next(prefix: string) {
    const i = (this.n.get(prefix) ?? 0) + 1;
    this.n.set(prefix, i);
    return `${prefix}${i}`;
  }
}

/** A `TelemetryPort` that keeps what it saw. */
export class RecordingTelemetry implements TelemetryPort {
  readonly spans: { name: string; attributes: TelemetryAttributes }[] = [];
  readonly counts: { name: string; value: number; attributes?: TelemetryAttributes }[] = [];
  readonly logs: { level: string; message: string; attributes?: TelemetryAttributes }[] = [];
  async span<T>(name: string, attributes: TelemetryAttributes, fn: () => Promise<T>) {
    this.spans.push({ name, attributes });
    return fn();
  }
  count(name: string, value: number, attributes?: TelemetryAttributes) {
    this.counts.push({ name, value, attributes });
  }
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, attributes?: TelemetryAttributes) {
    this.logs.push({ level, message, attributes });
  }
}
