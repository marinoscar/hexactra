// Run findings (E52.6, #1021): where a run spent effort it did not need, computed from its recorded steps alone. Pure and deterministic:
// no I/O, no clock, no model. It reads the step rows the runner wrote (server-recorded facts: the tool, its redacted arguments, ok, the
// summary) and never `reasoning`, which is the model's own words. Every text it returns is masked by the caller's masking function.
import { describeAction, normalizeArgs, OBSERVATION_TYPES, type RunBudgetView } from '@marinoscar/hexactra-agent';

export type RunFindingCode = 'loop' | 'selector_miss' | 'repeated_click' | 'observation_heavy' | 'slow_start' | 'waited_for_owner' | 'budget_pressure' | 'failures' | 'unknown_outcome';

export interface RunFinding {
  code: RunFindingCode;
  severity: 'info' | 'warn';
  /** One line for a person. */
  title: string;
  /** One or two sentences, facts only. */
  detail: string;
  seqFrom: number | null;
  seqTo: number | null;
  /** Steps attributable to it; 0 when not applicable. */
  stepsSpent: number;
  evidence: Record<string, string | number | boolean | number[]>;
}

/** A step as the diagnostics read it: the columns of `run_steps`, never `reasoning`. */
export interface DiagnosticStep {
  seq: number;
  kind: string;
  action: string | null;
  args: unknown;
  ok: boolean;
  summary: string;
  phase?: string | null;
  createdAt: Date;
}

export interface DiagnosticRun {
  startedAt: Date | null;
  /** The run's budget view (the same one the run page shows); null without a policy snapshot. */
  budget: RunBudgetView | null;
}

/** The thresholds, each proved by a unit test. */
export const DIAGNOSTICS = {
  /** Most actions in one repeated block of a loop. */
  maxLoopBlock: 8,
  /** Laps before a block counts as a loop. */
  minLoopLaps: 3,
  /** Selector misses before a selector_miss is a warning. */
  selectorMissWarn: 3,
  /** Steps a repeated click may be apart. */
  repeatedClickWithin: 12,
  /** Steps before observation_heavy is judged, and observations per page-changing action above which it is. */
  observationHeavyMinSteps: 20,
  observationHeavyRatio: 2,
  /** Seconds before the first step after which the start was slow. */
  slowStartSeconds: 30,
  /** Percent of any budget at which there is pressure. */
  budgetPressurePercent: 80,
  /** Failed actions from which they are worth a line. */
  failuresMin: 3,
  /** Characters of a selector kept in a finding. */
  selectorChars: 120,
} as const;

const CLICKS = new Set(['click', 'click_at', 'click_mark']);
const NO_MATCH = 'no element matches ';

const isAction = (s: DiagnosticStep) => s.kind === 'action' && !!s.action;
const isObservation = (s: DiagnosticStep) => (isAction(s) && OBSERVATION_TYPES.has(s.action!)) || (s.kind === 'observe' && s.action === 'look');
const argsOf = (s: DiagnosticStep): Record<string, unknown> => (s.args && typeof s.args === 'object' && !Array.isArray(s.args) ? (s.args as Record<string, unknown>) : {});
const clipSel = (sel: string) => (sel.length > DIAGNOSTICS.selectorChars ? `${sel.slice(0, DIAGNOSTICS.selectorChars)}…` : sel);

/** What a step did, as a short label and a signature that ignores a pixel or two, typed text and a URL's query. */
function signatureOf(s: DiagnosticStep): { label: string; sig: string } {
  const type = s.action ?? s.kind;
  const args = normalizeArgs(type, argsOf(s));
  return { label: describeAction(type, argsOf(s)), sig: JSON.stringify([type, args, s.ok]) };
}

/** The findings of one run, most useful first: warnings before information, then by steps spent. */
export function diagnoseRun(run: DiagnosticRun, steps: readonly DiagnosticStep[]): RunFinding[] {
  const ordered = [...steps].sort((a, b) => a.seq - b.seq);
  const out: RunFinding[] = [...loops(ordered), ...selectorMisses(ordered), ...repeatedClicks(ordered), ...observationHeavy(ordered), ...slowStart(run, ordered), ...waitedForOwner(ordered), ...budgetPressure(run), ...failures(ordered), ...unknownOutcome(ordered)];
  return out.sort((a, b) => (a.severity === b.severity ? b.stepsSpent - a.stepsSpent : a.severity === 'warn' ? -1 : 1));
}

interface Acted {
  i: number;
  seq: number;
  sig: string;
  label: string;
}

/**
 * `loop`: the longest stretch where one block of 1 to 8 page-changing actions repeats at least 3 times in a row, one foreign action
 * allowed between two laps. Up to 3 such stretches that do not overlap. A block of one action whose laps each read something different
 * (the read's summary changed: "next page" through a list) is information, not a warning.
 */
function loops(steps: readonly DiagnosticStep[]): RunFinding[] {
  const acted: Acted[] = [];
  steps.forEach((s, i) => {
    if (isAction(s) && !isObservation(s)) acted.push({ i, seq: s.seq, ...signatureOf(s) });
  });
  type Cand = { start: number; len: number; laps: number; end: number };
  const cands: Cand[] = [];
  for (let len = 1; len <= DIAGNOSTICS.maxLoopBlock; len += 1) {
    for (let start = 0; start + len * DIAGNOSTICS.minLoopLaps <= acted.length; start += 1) {
      const block = acted.slice(start, start + len).map((a) => a.sig);
      // A block that is itself one action repeated is the len-1 block's business.
      if (len > 1 && block.every((b) => b === block[0])) continue;
      const same = (at: number) => at + len <= acted.length && block.every((b, k) => acted[at + k]!.sig === b);
      let laps = 1;
      let at = start + len;
      for (;;) {
        if (same(at)) at += len;
        else if (same(at + 1)) at += len + 1;
        else break;
        laps += 1;
      }
      if (laps >= DIAGNOSTICS.minLoopLaps) cands.push({ start, len, laps, end: at - 1 });
    }
  }
  const spent = (c: Cand) => acted[c.end]!.i - acted[c.start]!.i + 1;
  cands.sort((a, b) => spent(b) - spent(a) || a.len - b.len);
  const taken: Cand[] = [];
  for (const c of cands) {
    if (taken.length >= 3) break;
    if (taken.some((t) => !(c.end < t.start || c.start > t.end))) continue;
    taken.push(c);
  }
  const total = steps.length;
  return taken.map((c) => {
    const first = acted[c.start]!;
    const last = acted[c.end]!;
    const stepsSpent = last.i - first.i + 1;
    const labels = acted.slice(c.start, c.start + c.len).map((a) => a.label);
    const progressing = c.len === 1 && lapsReadNew(steps, acted, c);
    const pct = total ? Math.round((stepsSpent / total) * 100) : 0;
    const what = c.len === 1 ? `the same action (${labels[0]})` : `the same ${c.len} actions (${labels.join('; ')})`;
    return {
      code: 'loop' as const,
      severity: progressing ? ('info' as const) : ('warn' as const),
      title: `Repeated ${what} ${c.laps} times`,
      detail: `${stepsSpent} steps, ${pct}% of the run.${progressing ? ' Each repetition read something new, so it may have been moving through pages.' : ''}`,
      seqFrom: first.seq,
      seqTo: last.seq,
      stepsSpent,
      evidence: { laps: c.laps, blockLength: c.len, percentOfRun: pct, progressing },
    };
  });
}

/** Whether, between the laps of a one-action loop, the reads returned something different each time (their summaries differ). */
function lapsReadNew(steps: readonly DiagnosticStep[], acted: Acted[], c: { start: number; end: number }): boolean {
  const lapIdx = acted.filter((_, k) => k >= c.start && k <= c.end).map((a) => a.i);
  const reads: string[] = [];
  for (let k = 0; k < lapIdx.length - 1; k += 1) {
    const between = steps.slice(lapIdx[k]! + 1, lapIdx[k + 1]!).filter((s) => isObservation(s) && s.ok).map((s) => s.summary);
    if (between.length === 0) return false;
    reads.push(between.join('|'));
  }
  return new Set(reads).size === reads.length;
}

/** `selector_miss`: failed steps whose selector matched nothing, by selector. */
function selectorMisses(steps: readonly DiagnosticStep[]): RunFinding[] {
  const by = new Map<string, number[]>();
  for (const s of steps) {
    if (s.ok || !s.summary.startsWith(NO_MATCH)) continue;
    const sel = clipSel(s.summary.slice(NO_MATCH.length));
    by.set(sel, [...(by.get(sel) ?? []), s.seq]);
  }
  return [...by.entries()].map(([sel, seqs]) => ({
    code: 'selector_miss' as const,
    severity: seqs.length >= DIAGNOSTICS.selectorMissWarn ? ('warn' as const) : ('info' as const),
    title: `A selector matched nothing ${seqs.length} ${seqs.length === 1 ? 'time' : 'times'}`,
    detail: `\`${sel}\` was not on the page at steps ${seqs.join(', ')}.`,
    seqFrom: seqs[0]!,
    seqTo: seqs[seqs.length - 1]!,
    stepsSpent: seqs.length,
    evidence: { selector: sel, seqs },
  }));
}

/** The same point or selector of a click, as two clicks compare: a selector, or a position rounded to 10 pixels. */
function clickTarget(s: DiagnosticStep): string | null {
  const a = argsOf(s);
  if (typeof a.label === 'string' && a.label) return `label:${a.label}`;
  if (typeof a.selector === 'string') return `sel:${a.selector}`;
  if (typeof a.x === 'number' && typeof a.y === 'number') return `at:${Math.round(a.x / 10) * 10},${Math.round(a.y / 10) * 10}`;
  if (typeof a.mark === 'number') return null;
  return null;
}

/** `repeated_click`: the same control clicked again within 12 steps with only reads of the page between. */
function repeatedClicks(steps: readonly DiagnosticStep[]): RunFinding[] {
  const out: RunFinding[] = [];
  let i = 0;
  while (i < steps.length) {
    const s = steps[i]!;
    const target = isAction(s) && CLICKS.has(s.action!) && s.ok ? clickTarget(s) : null;
    if (!target) {
      i += 1;
      continue;
    }
    const seqs = [s.seq];
    let last = i;
    let noChange = s.summary.endsWith('no change seen on the page');
    for (let j = i + 1; j < steps.length && steps[j]!.seq - steps[last]!.seq <= DIAGNOSTICS.repeatedClickWithin; j += 1) {
      const t = steps[j]!;
      if (isObservation(t) || !isAction(t)) continue;
      if (CLICKS.has(t.action!) && t.ok && clickTarget(t) === target) {
        seqs.push(t.seq);
        last = j;
        noChange ||= t.summary.endsWith('no change seen on the page');
        continue;
      }
      break;
    }
    if (seqs.length >= 2) {
      out.push({
        code: 'repeated_click',
        severity: 'warn',
        title: `Clicked the same control ${seqs.length} times`,
        detail: `${describeAction(s.action!, argsOf(s))}, at steps ${seqs.join(', ')}, with only reads of the page between.${noChange ? ' The page did not change after a click.' : ''}`,
        seqFrom: seqs[0]!,
        seqTo: seqs[seqs.length - 1]!,
        stepsSpent: steps.slice(i, last + 1).length,
        evidence: { seqs, noChangeSeen: noChange },
      });
    }
    i = last + 1;
  }
  return out;
}

/** `observation_heavy`: more than two reads of the page per action that changes it. */
function observationHeavy(steps: readonly DiagnosticStep[]): RunFinding[] {
  if (steps.length < DIAGNOSTICS.observationHeavyMinSteps) return [];
  const obs = steps.filter(isObservation).length;
  const acts = steps.filter((s) => isAction(s) && !isObservation(s)).length;
  if (acts === 0 || obs / acts <= DIAGNOSTICS.observationHeavyRatio) return [];
  const ratio = Math.round((obs / acts) * 10) / 10;
  return [{ code: 'observation_heavy', severity: 'info', title: `Read the page ${ratio} times per action`, detail: `${obs} reads of the page (text, elements, scripts, looks) for ${acts} actions that changed it.`, seqFrom: null, seqTo: null, stepsSpent: Math.max(0, obs - acts * DIAGNOSTICS.observationHeavyRatio), evidence: { observations: obs, actions: acts, ratio } }];
}

/** `slow_start`: more than 30 seconds before the first step. */
function slowStart(run: DiagnosticRun, steps: readonly DiagnosticStep[]): RunFinding[] {
  const first = steps[0];
  if (!run.startedAt || !first) return [];
  const sec = Math.round((first.createdAt.getTime() - run.startedAt.getTime()) / 1000);
  if (sec <= DIAGNOSTICS.slowStartSeconds) return [];
  return [{ code: 'slow_start', severity: 'info', title: `${sec} s before the first step`, detail: 'The run started, then waited before it did anything (a browser starting, a page loading, or a model slow to answer).', seqFrom: first.seq, seqTo: first.seq, stepsSpent: 0, evidence: { seconds: sec } }];
}

/** `waited_for_owner`: the time between each question and its answer. */
function waitedForOwner(steps: readonly DiagnosticStep[]): RunFinding[] {
  let waitedMs = 0;
  let questions = 0;
  let open: DiagnosticStep | null = null;
  let from: number | null = null;
  let to: number | null = null;
  for (const s of steps) {
    if (s.kind !== 'handoff') continue;
    if (s.action === 'answered') {
      if (open) waitedMs += Math.max(0, s.createdAt.getTime() - open.createdAt.getTime());
      to = s.seq;
      open = null;
    } else {
      questions += 1;
      from ??= s.seq;
      open = s;
    }
  }
  if (questions === 0) return [];
  const sec = Math.round(waitedMs / 1000);
  const human = sec >= 60 ? `${Math.floor(sec / 60)} min ${sec % 60} s` : `${sec} s`;
  return [{ code: 'waited_for_owner', severity: 'info', title: `Waited ${human} for you`, detail: `${questions} ${questions === 1 ? 'question' : 'questions'} to the owner.`, seqFrom: from, seqTo: to, stepsSpent: 0, evidence: { seconds: sec, questions } }];
}

/** `budget_pressure`: a budget used to 80% or more. */
function budgetPressure(run: DiagnosticRun): RunFinding[] {
  const b = run.budget;
  if (!b) return [];
  const over = (Object.entries(b.percent) as [string, number | null][]).filter(([, p]) => p !== null && p >= DIAGNOSTICS.budgetPressurePercent);
  return over.map(([key, p]) => ({ code: 'budget_pressure' as const, severity: 'warn' as const, title: `Used ${p}% of the ${key} budget`, detail: `The run came close to, or reached, its ${key} limit.`, seqFrom: null, seqTo: null, stepsSpent: 0, evidence: { budget: key, percent: p! } }));
}

/** `failures`: three or more failed actions. */
function failures(steps: readonly DiagnosticStep[]): RunFinding[] {
  const failed = steps.filter((s) => isAction(s) && !s.ok);
  if (failed.length < DIAGNOSTICS.failuresMin) return [];
  return [{ code: 'failures', severity: 'info', title: `${failed.length} actions failed`, detail: `Failed at steps ${failed.slice(0, 20).map((s) => s.seq).join(', ')}${failed.length > 20 ? ', …' : ''}.`, seqFrom: failed[0]!.seq, seqTo: failed[failed.length - 1]!.seq, stepsSpent: failed.length, evidence: { count: failed.length, seqs: failed.slice(0, 50).map((s) => s.seq) } }];
}

/** `unknown_outcome`: a step that may or may not have happened (a job died while it was being sent). */
function unknownOutcome(steps: readonly DiagnosticStep[]): RunFinding[] {
  const unknown = steps.filter((s) => s.phase === 'intent' || s.phase === 'unknown');
  if (unknown.length === 0) return [];
  return [{ code: 'unknown_outcome', severity: 'warn', title: `${unknown.length} ${unknown.length === 1 ? 'step' : 'steps'} with an unknown outcome`, detail: `Steps ${unknown.map((s) => s.seq).join(', ')} were being sent when the run's job stopped: they may or may not have happened.`, seqFrom: unknown[0]!.seq, seqTo: unknown[unknown.length - 1]!.seq, stepsSpent: unknown.length, evidence: { seqs: unknown.map((s) => s.seq) } }];
}
