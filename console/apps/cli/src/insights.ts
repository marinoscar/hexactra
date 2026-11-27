// What the insights commands print (E52.10, #1025): a run's findings, a task's consistency, and a proposal for a better goal. Pure:
// the commands fetch, these words them, and the tests read them.

export interface Finding {
  code: string;
  severity: 'info' | 'warn';
  title: string;
  detail: string;
  seqFrom: number | null;
  seqTo: number | null;
}

export interface Spread {
  min: number;
  median: number;
  max: number;
  ratio: number;
}

export interface Consistency {
  runs: number;
  succeeded: number;
  label: 'not_enough_runs' | 'steady' | 'varies' | 'erratic';
  steps: Spread | null;
  costUsd: Spread | null;
  activeMs: Spread | null;
  perRun: { runId: string; status: string; stepCount: number; findings: { code: string; severity: string }[] }[];
}

export interface Improvement {
  id: string;
  taskId: string;
  status: string;
  runIds: string[];
  goalBefore: string;
  proposedGoal: string | null;
  summary: string | null;
  changes?: { kind: string; text: string; why: string; evidence: { runId: string; seqFrom: number; seqTo: number }[] }[];
  siteFacts?: { site: string; kind: string; text: string }[];
  confidence: string | null;
  error: string | null;
  createdAt: string;
}

const steps = (f: Pick<Finding, 'seqFrom' | 'seqTo'>) => (f.seqFrom === null ? '' : f.seqTo !== null && f.seqTo !== f.seqFrom ? `steps ${f.seqFrom}-${f.seqTo}` : `step ${f.seqFrom}`);

/** One line per finding: severity, code, steps, title and detail. */
export function findingsLines(findings: Finding[]): string[] {
  if (findings.length === 0) return ['No findings: nothing in the steps points to wasted effort.'];
  return findings.map((f) => `${(f.severity === 'warn' ? 'WARN' : 'info').padEnd(5)} ${f.code.padEnd(18)} ${steps(f).padEnd(15)} ${f.title}. ${f.detail}`);
}

const LABEL: Record<Consistency['label'], string> = { steady: 'Steady', varies: 'Varies', erratic: 'Erratic', not_enough_runs: 'Not enough runs yet' };
const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;
const usd = (n: number) => `$${n.toFixed(4)}`;

/** The label, the ranges and one line per run. */
export function consistencyLines(c: Consistency): string[] {
  const out = [`${LABEL[c.label]}: ${c.succeeded} of ${c.runs} runs succeeded.`];
  if (c.steps) out.push(`Steps: median ${c.steps.median}, ${c.steps.min} to ${c.steps.max} (largest ${c.steps.ratio}x the median)`);
  if (c.costUsd) out.push(`Cost: median ${usd(c.costUsd.median)}, ${usd(c.costUsd.min)} to ${usd(c.costUsd.max)}`);
  if (c.activeMs) out.push(`Working time: median ${seconds(c.activeMs.median)}, ${seconds(c.activeMs.min)} to ${seconds(c.activeMs.max)}`);
  for (const r of c.perRun) {
    const warn = r.findings.filter((f) => f.severity === 'warn').map((f) => f.code);
    out.push(`  ${r.runId.slice(0, 8)}  ${r.status.padEnd(10)} ${String(r.stepCount).padStart(4)} steps${warn.length ? `  ${warn.join(', ')}` : ''}`);
  }
  return out;
}

/** A proposal: its status, summary, changes with their evidence and the proposed goal; how to use it. */
export function improvementLines(p: Improvement): string[] {
  const out = [`Proposal ${p.id.slice(0, 8)}: ${p.status}${p.confidence ? ` (confidence ${p.confidence})` : ''}, ${p.runIds.length} run(s) read`];
  if (p.status === 'failed') return [...out, `Failed: ${p.error ?? 'the proposal could not be made'}`];
  if (p.status === 'queued' || p.status === 'running') return [...out, 'Still being made. Run this again in a minute, or pass --wait.'];
  if (p.summary) out.push('', p.summary);
  if (p.changes?.length) {
    out.push('', 'Changes:');
    for (const c of p.changes) out.push(`  ${c.kind}: ${c.text} (${c.why}) [${c.evidence.map((e) => `${e.runId.slice(0, 8)} steps ${e.seqFrom}-${e.seqTo}`).join('; ')}]`);
  }
  if (p.siteFacts?.length) {
    out.push('', 'Site facts to keep (add them in the console):');
    for (const f of p.siteFacts) out.push(`  ${f.site} (${f.kind}): ${f.text}`);
  }
  if (p.proposedGoal) {
    out.push('', p.proposedGoal.trim() === p.goalBefore.trim() ? 'No change proposed to the goal.' : 'Proposed goal:', ...(p.proposedGoal.trim() === p.goalBefore.trim() ? [] : [p.proposedGoal]));
  }
  if (p.status === 'ready') out.push('', 'To use it: open the task in the console and save the goal.');
  return out;
}
