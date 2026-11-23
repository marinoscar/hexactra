// In-memory fakes of every port. Deterministic; no timers unless a test asks for them.
import type { SiteFactStorePort, ClockPort, EvidenceOutcome, IdPort, JudgePort, JudgeRequest, JudgeResult, ProbedLocation, ProcedureStorePort, StateProbePort, TelemetryAttributes, TelemetryPort, ToolCallRequest, ToolInvocation, ToolInvokerPort } from '../ports';
import { canMoveSiteFact, canTransition, emptyEvidence, type Evidence, type NewSiteFact, type Procedure, type ProcedureVersion, type SiteFact, siteFactKey, siteFactSchema, type SiteFactStatus, type VersionState } from '../schema';

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
  async activate(owner: string, id: string, from: 'candidate' | 'verified' | 'suspended') {
    const v = this.versions.get(id);
    if (!v || v.owner !== owner || v.version.state !== from) return false;
    if (from === 'candidate' ? false : !canTransition(from, 'active')) return false;
    for (const other of this.versions.values()) if (other.owner === owner && other.version.procedure === v.version.procedure && other.version.state === 'active' && other.version.id !== id) other.version.state = 'retired';
    v.version.state = 'active';
    const p = this.procedures.get(v.version.procedure);
    if (p) this.procedures.set(p.id, { ...p, activeVersion: id });
    return true;
  }
  async recordEvidence(owner: string, id: string, step: string | null, outcome: EvidenceOutcome, at: string) {
    const v = this.versions.get(id);
    if (!v || v.owner !== owner) throw new Error('version not found for this owner');
    v.version.evidence = bump(v.version.evidence, outcome, at);
    if (step !== null) v.version.stepEvidence[step] = bump(v.version.stepEvidence[step] ?? emptyEvidence(), outcome, at);
    return clone(v.version.evidence);
  }
  async listActiveProceduresForSites(owner: string, sites: readonly string[]) {
    const wanted = new Set(sites);
    const out: { procedure: Procedure; version: ProcedureVersion }[] = [];
    if (wanted.size === 0) return out;
    for (const p of this.procedures.values()) {
      if (p.owner !== owner || p.activeVersion === null) continue;
      const v = this.versions.get(p.activeVersion);
      if (!v || v.owner !== owner || v.version.procedure !== p.id || v.version.state !== 'active') continue;
      if (v.version.sites.some((s) => wanted.has(s.domain))) out.push({ procedure: clone(p), version: clone(v.version) });
    }
    return out.sort((a, b) => (a.procedure.id < b.procedure.id ? -1 : a.procedure.id > b.procedure.id ? 1 : 0));
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

/** A `SiteFactStorePort` in memory, keeping every guarantee of the port (owner isolation, one fact per identity, compare-and-set). */
export class InMemorySiteFactStore implements SiteFactStorePort {
  private readonly facts = new Map<string, { owner: string; fact: SiteFact }>();

  async proposeSiteFact(owner: string, input: NewSiteFact) {
    const key = siteFactKey(input);
    for (const f of this.facts.values()) if (f.owner === owner && siteFactKey(f.fact) === key) return { fact: clone(f.fact), created: false };
    if (this.facts.has(input.id)) throw new Error(`site fact ${input.id} exists`);
    const fact = siteFactSchema.parse({ ...input, status: 'proposed', lastUsedAt: null });
    this.facts.set(fact.id, { owner, fact });
    return { fact: clone(fact), created: true };
  }
  async listSiteFacts(owner: string, sites: readonly string[], status: SiteFactStatus | readonly SiteFactStatus[]) {
    const statuses: readonly SiteFactStatus[] = typeof status === 'string' ? [status] : status;
    return [...this.facts.values()]
      .filter((f) => f.owner === owner && sites.includes(f.fact.site) && statuses.includes(f.fact.status))
      .map((f) => clone(f.fact))
      .sort((a, b) => (a.site !== b.site ? (a.site < b.site ? -1 : 1) : a.createdAt !== b.createdAt ? (a.createdAt < b.createdAt ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  async setSiteFactStatus(owner: string, id: string, expected: SiteFactStatus, next: SiteFactStatus) {
    const f = this.facts.get(id);
    if (!f || f.owner !== owner || f.fact.status !== expected || !canMoveSiteFact(expected, next)) return false;
    f.fact.status = next;
    return true;
  }
  async touchSiteFacts(owner: string, ids: readonly string[], at: string) {
    let n = 0;
    for (const id of new Set(ids)) {
      const f = this.facts.get(id);
      if (f && f.owner === owner) {
        f.fact.lastUsedAt = at;
        n++;
      }
    }
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
