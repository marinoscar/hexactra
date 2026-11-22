// The executor (E46.8): walks a procedure version without a model and reports exactly where it stopped. Every tool call goes through
// `ToolInvokerPort` (in the console, `executeTool`: Stop, Pause, the gates, the span and intent recording apply as for a model-chosen call);
// `call`, `extract` and `check` steps never call a model; a `judge` step calls `JudgePort` once. It never retries: a failed check, a refusal,
// a Stop or a Pause ends the walk with a resume point (recovery is E46.16). It is restartable from a resume point, and a commit-class step
// whose outcome is unknown is never invoked again.
import type { KgraphPorts, ToolInvocation } from '../ports';
import type { Binding, Check, ProcedureVersion, Step } from '../schema';

export type StepStatus = 'done' | 'skipped' | 'failed_check' | 'refused' | 'stopped' | 'paused' | 'error' | 'needs_owner' | 'agent';
export type ExecutionStatus = 'completed' | 'failed_check' | 'refused' | 'stopped' | 'paused' | 'error' | 'needs_owner' | 'agent' | 'missing_input' | 'halted';

export interface CheckFailure {
  check: Check['kind'];
  expected: unknown;
  observed: unknown;
}

export interface StepReport {
  step: string;
  kind: Step['kind'];
  status: StepStatus;
  /** The invoker's digest of the result (never the result itself). */
  resultDigest?: string;
  durationMs: number;
  /** A failed check: what was expected and what was observed. */
  failed?: CheckFailure;
  /** A check that could not be read (the probe returned null) or drifted within its tolerance. */
  notes?: string[];
  /** For an `error`: a short reason, never page text. */
  reason?: string;
}

/** What a step produced, kept in memory for later bindings. Never stored by the executor. */
export interface StepResult {
  text: string;
  value?: unknown;
  ok: boolean;
}

export interface ResumePoint {
  step: string;
  expected?: unknown;
  observed?: unknown;
}

export interface ExecutionReport {
  status: ExecutionStatus;
  steps: StepReport[];
  outputs: Record<string, unknown>;
  /** The first step not done, or null when the walk completed. */
  resume: ResumePoint | null;
  /** Results of the steps done (in memory, for a restart or the host's answer). */
  results: Record<string, StepResult>;
  judgeCalls: number;
  toolCalls: number;
}

export interface ExecuteOptions {
  /** The task's goal (the owner's words): the only text a judge gets besides its declared inputs. */
  goal: string;
  /** Start here instead of the entry (after an agent step, or on a restart). */
  fromStep?: string;
  /** Steps already done in an earlier walk, with their results (null: done, result not kept — a step that reads it hands over). */
  done?: Record<string, StepResult | null>;
  /** Commit-class steps whose outcome is unknown (a crash between intent and result): never invoked again. */
  unknown?: readonly string[];
  /** Called before a commit-class step is invoked: the host records the intent first. */
  onCommitIntent?(step: Step): Promise<void>;
  /** Called before every step: `stop` ends the walk (budgets, the job's deadline, the lease). */
  before?(step: Step): Promise<'go' | 'stop'> | 'go' | 'stop';
  /** Called after a step is done (the host keeps its resume point). */
  after?(step: Step): Promise<void> | void;
  /** When set, evidence is recorded per step through `ports.store` (best effort). */
  evidence?: { owner: string };
  /** Most steps one walk may take (a loop guard). Default 1000. */
  maxSteps?: number;
}

const MAX_TEXT = 100_000;

/** Turn dotted argument keys (`to.0`, `message.subject`) back into objects and arrays. */
export function unflatten(flat: Record<string, unknown>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let cur: Record<string, unknown> | unknown[] = root;
    parts.forEach((p, i) => {
      const last = i === parts.length - 1;
      const nextIsIndex = !last && /^\d+$/.test(parts[i + 1]!);
      const k = Array.isArray(cur) ? Number(p) : p;
      if (last) (cur as Record<string | number, unknown>)[k] = value;
      else {
        const holder = cur as Record<string | number, unknown>;
        if (holder[k] === undefined || typeof holder[k] !== 'object') holder[k] = nextIsIndex ? [] : {};
        cur = holder[k] as Record<string, unknown> | unknown[];
      }
    });
  }
  return root;
}

/** A field of a structured value by dotted path. */
export function getPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let cur = value;
  for (const p of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function structured(r: StepResult): unknown {
  if (r.value !== undefined) return r.value;
  const t = r.text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** A pattern from a stored procedure is untrusted: bounded length, no nested quantifier. */
export function safePattern(pattern: string): RegExp | null {
  if (pattern.length > 200 || /\([^)]*[+*}][^)]*\)\s*[+*{]/.test(pattern)) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/** `*` matches one path segment, `**` any number. */
export function pathMatches(pattern: string, path: string): boolean {
  if (pattern === '**') return true;
  const re = new RegExp(`^${pattern.split('/').map((seg) => (seg === '**' ? '.*' : seg === '*' ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}/?$`);
  return re.test(path);
}

class Halt {
  constructor(readonly status: ExecutionStatus, readonly report: StepReport, readonly resume: ResumePoint) {}
}

export async function executeProcedure(version: ProcedureVersion, inputs: Record<string, unknown>, ports: KgraphPorts, options: ExecuteOptions): Promise<ExecutionReport> {
  const byId = new Map(version.steps.map((s) => [s.id, s]));
  const kept = Object.fromEntries(Object.entries(options.done ?? {}).filter(([, r]) => r !== null)) as Record<string, StepResult>;
  const report: ExecutionReport = { status: 'completed', steps: [], outputs: {}, resume: null, results: kept, judgeCalls: 0, toolCalls: 0 };
  const unknown = new Set(options.unknown ?? []);
  const nextOf = new Map<string, string>();
  for (const e of version.edges) if (e.type === 'then' && !e.loop && !nextOf.has(e.from)) nextOf.set(e.from, e.to);
  const arrayNext = (id: string) => {
    const i = version.steps.findIndex((s) => s.id === id);
    return version.steps[i + 1]?.id ?? null;
  };
  const follow = (id: string) => (version.edges.some((e) => e.type === 'then') ? nextOf.get(id) ?? null : arrayNext(id));

  // A missing required input fails before the first step.
  const missing = version.parameters.filter((p) => p.required && (inputs[p.id] === undefined || inputs[p.id] === null || inputs[p.id] === ''));
  if (missing.length > 0) {
    report.status = 'missing_input';
    report.resume = { step: options.fromStep ?? version.entry, expected: missing.map((p) => p.id) };
    return report;
  }

  const resolve = (b: Binding, at: Step): unknown => {
    switch (b.kind) {
      case 'literal':
        return b.value;
      case 'parameter':
        return inputs[b.parameter];
      case 'secret':
        return { secretRef: b.ref, field: b.field };
      case 'output': {
        const r = report.results[b.step];
        if (!r) throw new Halt('error', { step: at.id, kind: at.kind, status: 'error', durationMs: 0, reason: `its input from ${b.step} is not available` }, { step: at.id });
        const src = byId.get(b.step);
        if (src?.kind === 'extract' || src?.kind === 'judge') return getPath(r.value, b.path);
        return b.path ? getPath(structured(r), b.path) : r.text;
      }
      case 'judge': {
        const r = report.results[b.step];
        if (!r) throw new Halt('error', { step: at.id, kind: at.kind, status: 'error', durationMs: 0, reason: `its judge ${b.step} has not run` }, { step: at.id });
        return getPath(r.value, b.field);
      }
    }
  };
  const resolveAll = (bindings: Record<string, Binding>, at: Step) => unflatten(Object.fromEntries(Object.entries(bindings).map(([k, b]) => [k, resolve(b, at)])));

  const runChecks = async (s: Step): Promise<{ failed?: CheckFailure; notes: string[] }> => {
    const notes: string[] = [];
    for (const c of s.checks) {
      const verdict = await evaluate(c, ports, report.results);
      if (verdict.note) notes.push(verdict.note);
      if (!verdict.ok) return { failed: { check: c.kind, expected: verdict.expected, observed: verdict.observed }, notes };
    }
    return { notes };
  };

  const evidence = async (step: string, outcome: 'success' | 'failure') => {
    if (!options.evidence) return;
    try {
      await ports.store.recordEvidence(options.evidence.owner, version.id, step, outcome, ports.clock.now().toISOString());
    } catch {
      ports.telemetry.count('kgraph.evidence_errors', 1);
    }
  };

  const runStep = async (s: Step): Promise<string | null> => {
    const started = ports.clock.now().getTime();
    const finish = (status: StepStatus, extra: Partial<StepReport> = {}): StepReport => ({ step: s.id, kind: s.kind, status, durationMs: ports.clock.now().getTime() - started, ...extra });
    if (options.done && s.id in options.done) {
      report.steps.push(finish('skipped'));
      return s.kind === 'branch' ? null : follow(s.id);
    }
    if ((await options.before?.(s)) === 'stop') throw new Halt('halted', finish('stopped', { reason: 'the host stopped the walk' }), { step: s.id });
    switch (s.kind) {
      case 'call': {
        if (s.commitClass && unknown.has(s.id)) throw new Halt('needs_owner', finish('needs_owner', { reason: 'a commit-class step whose outcome is unknown is never sent again' }), { step: s.id });
        const args = resolveAll(s.args, s);
        if (s.commitClass) await options.onCommitIntent?.(s);
        report.toolCalls++;
        let r: ToolInvocation;
        try {
          r = await ports.tools.invoke({ tool: s.tool, args, step: s.id, commitClass: s.commitClass });
        } catch {
          throw new Halt('error', finish('error', { reason: 'the tool call threw' }), { step: s.id });
        }
        if (r.stopped) throw new Halt('stopped', finish('stopped', { resultDigest: r.digest }), { step: s.id });
        if (r.paused) throw new Halt('paused', finish('paused', { resultDigest: r.digest }), { step: s.id });
        if (r.refused) throw new Halt('refused', finish('refused', { resultDigest: r.digest }), { step: s.id });
        report.results[s.id] = { text: r.text.slice(0, MAX_TEXT), ok: r.ok, ...(r.value !== undefined ? { value: r.value } : {}) };
        if (!r.ok) {
          await evidence(s.id, 'failure');
          throw new Halt('failed_check', finish('failed_check', { resultDigest: r.digest, failed: { check: 'result_shape', expected: { ok: true }, observed: { ok: false } } }), { step: s.id, expected: { ok: true }, observed: { ok: false } });
        }
        const c = await runChecks(s);
        if (c.failed) {
          await evidence(s.id, 'failure');
          throw new Halt('failed_check', finish('failed_check', { resultDigest: r.digest, failed: c.failed, ...(c.notes.length ? { notes: c.notes } : {}) }), { step: s.id, expected: c.failed.expected, observed: c.failed.observed });
        }
        await evidence(s.id, 'success');
        report.steps.push(finish('done', { resultDigest: r.digest, ...(c.notes.length ? { notes: c.notes } : {}) }));
        return follow(s.id);
      }
      case 'extract': {
        const src = report.results[s.from];
        if (!src) throw new Halt('error', finish('error', { reason: `its source ${s.from} has not run` }), { step: s.id });
        let value: unknown;
        if (s.path) value = getPath(structured(src), s.path);
        else if (s.pattern) {
          const re = safePattern(s.pattern);
          if (!re) throw new Halt('error', finish('error', { reason: 'an unsafe pattern' }), { step: s.id });
          value = re.exec(src.text.slice(0, MAX_TEXT))?.[0];
        } else value = src.text;
        if (value === undefined || value === null || value === '') throw new Halt('failed_check', finish('failed_check', { failed: { check: 'result_shape', expected: 'a value', observed: null } }), { step: s.id, expected: 'a value', observed: null });
        report.results[s.id] = { text: typeof value === 'string' ? value : JSON.stringify(value), value, ok: true };
        report.steps.push(finish('done'));
        return follow(s.id);
      }
      case 'judge': {
        report.judgeCalls++;
        const r = await ports.judge.judge({ goal: options.goal, inputs: Object.fromEntries(Object.entries(s.inputs).map(([k, b]) => [k, resolve(b, s)])), output: s.output });
        if (!r.ok || !r.value) throw new Halt('error', finish('error', { reason: 'the judge gave no valid answer' }), { step: s.id });
        report.results[s.id] = { text: JSON.stringify(r.value), value: r.value, ok: true };
        report.steps.push(finish('done'));
        return follow(s.id);
      }
      case 'check': {
        const c = await runChecks(s);
        if (c.failed) throw new Halt('failed_check', finish('failed_check', { failed: c.failed }), { step: s.id, expected: c.failed.expected, observed: c.failed.observed });
        report.steps.push(finish('done', c.notes.length ? { notes: c.notes } : {}));
        return follow(s.id);
      }
      case 'ask':
        throw new Halt('needs_owner', finish('needs_owner'), { step: s.id });
      case 'agent':
        throw new Halt('agent', finish('agent'), { step: s.id, expected: s.until });
      case 'branch': {
        const v = await evaluate(s.guard, ports, report.results);
        report.steps.push(finish('done', v.note ? { notes: [v.note] } : {}));
        return v.ok ? s.then : s.else;
      }
      case 'foreach':
        // Loops arrive with E46.18: until then a version holding one is handed to the agent.
        throw new Halt('agent', finish('agent', { reason: 'loops run with the agent' }), { step: s.id });
    }
  };

  let at: string | null = options.fromStep ?? version.entry;
  const max = options.maxSteps ?? 1000;
  try {
    for (let n = 0; at !== null; n++) {
      if (n >= max) throw new Halt('error', { step: at, kind: byId.get(at)?.kind ?? 'call', status: 'error', durationMs: 0, reason: 'too many steps' }, { step: at });
      const s = byId.get(at);
      if (!s) throw new Halt('error', { step: at, kind: 'call', status: 'error', durationMs: 0, reason: 'no such step' }, { step: at });
      at = await ports.telemetry.span('kgraph.step', { step: s.id, kind: s.kind }, () => runStep(s));
      if (report.steps.at(-1)?.status === 'done') await options.after?.(s);
    }
  } catch (err) {
    if (!(err instanceof Halt)) throw err;
    report.status = err.status;
    report.steps.push(err.report);
    report.resume = err.resume;
    ports.telemetry.count('kgraph.walk', 1, { status: err.status });
    return report;
  }
  for (const o of version.outputs) {
    const r = report.results[o.step];
    if (r) report.outputs[o.name] = r.value ?? r.text;
  }
  ports.telemetry.count('kgraph.walk', 1, { status: 'completed' });
  return report;
}

/** One check: ok, or what was expected and observed. A value the probe cannot read is a note, not a failure. */
async function evaluate(c: Check, ports: KgraphPorts, results: Record<string, StepResult>): Promise<{ ok: boolean; expected?: unknown; observed?: unknown; note?: string }> {
  switch (c.kind) {
    case 'location': {
      const loc = await ports.probe.location();
      if (!loc) return { ok: true, note: 'location not readable' };
      let host = '';
      let path = '/';
      try {
        const u = new URL(loc.url);
        host = u.hostname.toLowerCase();
        path = u.pathname;
      } catch {
        return { ok: false, expected: c, observed: { url: 'unparseable' } };
      }
      const want = c.host.toLowerCase();
      const ok = c.tolerance >= 1 || ((host === want || host.endsWith(`.${want}`)) && pathMatches(c.pathPattern, path));
      return ok ? { ok } : { ok, expected: { host: c.host, path: c.pathPattern }, observed: { host, path } };
    }
    case 'view_digest': {
      const d = await ports.probe.viewDigest();
      if (d === null) return { ok: true, note: 'view digest not readable' };
      if (d === c.digest) return { ok: true };
      // A digest is opaque: with a tolerance a change is a note (drift), without one it fails.
      return c.tolerance > 0 ? { ok: true, note: 'view drifted' } : { ok: false, expected: c.digest, observed: d };
    }
    case 'element_present': {
      if (!c.selector) return { ok: true, note: 'element check needs the surface graph' };
      const present = await ports.probe.elementPresent(c.selector);
      if (present === null) return { ok: true, note: 'element not readable' };
      return present || c.tolerance >= 1 ? { ok: true } : { ok: false, expected: { selector: c.selector }, observed: { present: false } };
    }
    case 'result_shape': {
      const r = results[c.step];
      if (!r) return { ok: false, expected: { step: c.step }, observed: null };
      if (r.ok !== c.ok) return { ok: false, expected: { ok: c.ok }, observed: { ok: r.ok } };
      const v = structured(r);
      const missing = c.fields.filter((f) => getPath(v, f) === undefined);
      return missing.length === 0 || c.tolerance >= 1 ? { ok: true } : { ok: false, expected: { fields: c.fields }, observed: { missing } };
    }
  }
}
