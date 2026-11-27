// The server's check of a proposal (E52.8, #1023). The model's answer is data: it may carry page text that reached a step, and a
// prompt injection in that text could try to add a site, a recipient or a parameter to the goal. Nothing here trusts it: a proposal
// keeps exactly the goal's parameters, adds no host, holds no sensitive value and no run value, and cites only steps that exist.
import { maskSensitive } from '../tasks/mask';
import { paramKey } from '@app/shared/task-params';
import type { ProposalAnswer, ProposalChange, ProposalSiteFact } from './task-improver.schemas';

/** What the validator knows of the task and the runs it read. */
export interface ValidationContext {
  goal: string;
  allowedDomains: readonly string[];
  /** The steps of each run read: its seqs. */
  runs: ReadonlyMap<string, ReadonlySet<number>>;
  /** Every value the runs were given (non-sensitive inputs), to make sure none comes back. */
  runValues: readonly string[];
  /** Hosts the runs visited (registrable domains or hosts), for site facts. */
  visitedSites: readonly string[];
  /** Checks a site fact as the Knowledge Graph does; returns the problems (empty: fine). */
  checkSiteFact(fact: ProposalSiteFact): string[];
}

export interface Validated {
  ok: boolean;
  /** Why it was refused: one line for a retry and for the stored error. */
  reason: string | null;
  proposedGoal: string;
  changes: ProposalChange[];
  siteFacts: ProposalSiteFact[];
  /** The goal is unchanged: "No change proposed". */
  unchanged: boolean;
}

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;
const URL_HOST = /\bhttps?:\/\/([a-z0-9.-]+)(?::\d+)?/gi;

export function placeholderKeys(goal: string): Set<string> {
  return new Set([...goal.matchAll(PLACEHOLDER)].map((m) => paramKey(m[1]!)));
}

function hostsIn(text: string): string[] {
  return [...text.matchAll(URL_HOST)].map((m) => m[1]!.toLowerCase().replace(/\.$/, ''));
}

/** Whether a host is the domain or below it. */
const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

function sensitive(text: string): boolean {
  return Object.values(maskSensitive(text).hits ?? {}).some((n) => Number(n) > 0);
}

/** Text a proposal may not contain: a sensitive value, or a value one of the runs was given (3 characters or more). */
function leaks(text: string, ctx: ValidationContext): string | null {
  if (sensitive(text)) return 'it contains a value that looks sensitive';
  const lower = text.toLowerCase();
  const v = ctx.runValues.find((x) => x.trim().length >= 3 && lower.includes(x.trim().toLowerCase()));
  return v ? 'it contains a value from a run (use the parameter instead)' : null;
}

/** Keep the evidence that names a run that was read and a range inside it. */
function citedOnly<T extends { evidence: { runId: string; seqFrom: number; seqTo: number }[] }>(item: T, ctx: ValidationContext): T {
  const evidence = item.evidence.filter((e) => {
    const seqs = ctx.runs.get(e.runId);
    return !!seqs && e.seqFrom <= e.seqTo && seqs.has(e.seqFrom) && seqs.has(e.seqTo);
  });
  return { ...item, evidence };
}

export function validateProposal(answer: ProposalAnswer, ctx: ValidationContext): Validated {
  const refuse = (reason: string): Validated => ({ ok: false, reason, proposedGoal: ctx.goal, changes: [], siteFacts: [], unchanged: true });
  const proposedGoal = answer.proposedGoal.trim();
  if (!proposedGoal) return refuse('the proposed goal is empty');
  // 1. Exactly the goal's parameters.
  const before = placeholderKeys(ctx.goal);
  const after = placeholderKeys(proposedGoal);
  const added = [...after].filter((k) => !before.has(k));
  const removed = [...before].filter((k) => !after.has(k));
  if (added.length || removed.length) return refuse(`the proposed goal must keep exactly the parameters ${[...before].map((k) => `{{${k}}}`).join(', ') || '(none)'}${added.length ? `; it adds ${added.join(', ')}` : ''}${removed.length ? `; it removes ${removed.join(', ')}` : ''}`);
  // 2. No new site.
  const known = new Set([...hostsIn(ctx.goal), ...ctx.allowedDomains.map((d) => d.toLowerCase())]);
  const foreign = hostsIn(proposedGoal).filter((h) => ![...known].some((k) => under(h, k)));
  if (foreign.length) return refuse(`the proposed goal names a site that is not in the task: ${foreign.join(', ')}`);
  // 3. No sensitive value and no run value, anywhere.
  const all = [proposedGoal, answer.summary, ...answer.changes.flatMap((c) => [c.text, c.why]), ...answer.siteFacts.map((f) => f.text)];
  for (const t of all) {
    const why = leaks(t, ctx);
    if (why) return refuse(`the proposal was refused: ${why}`);
  }
  // 4. Only cited changes; a changed goal needs at least one.
  const changes = answer.changes.map((c) => citedOnly(c, ctx)).filter((c) => c.evidence.length > 0);
  const unchanged = proposedGoal === ctx.goal.trim();
  if (!unchanged && changes.length === 0) return refuse('every change must cite steps of the runs that were read');
  // 5. Site facts: cited, of a visited site, never sign-in, valid as a Knowledge Graph fact.
  const siteFacts = answer.siteFacts
    .map((f) => citedOnly(f, ctx))
    .filter((f) => f.evidence.length > 0 && (f.kind as string) !== 'sign_in' && ctx.visitedSites.some((s) => under(s, f.site.toLowerCase()) || under(f.site.toLowerCase(), s)) && ctx.checkSiteFact(f).length === 0);
  // 6. The same goal: ready, with nothing to apply.
  if (unchanged) return { ok: true, reason: null, proposedGoal: ctx.goal, changes: [], siteFacts, unchanged: true };
  return { ok: true, reason: null, proposedGoal, changes, siteFacts, unchanged: false };
}
