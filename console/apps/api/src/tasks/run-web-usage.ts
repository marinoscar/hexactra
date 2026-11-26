// What a run did on the web (E50.7, #977): the searches and the page reads its steps record, and the ESTIMATED cost of the searches
// (`searches × costPerCallUsd` of the provider that answered when the run started). Shown apart from the AI cost and never added to it.
import { readSnapshotWeb } from '../runner/host/web-availability';
import type { RunPolicySnapshot } from '../policies/policy-snapshot';

export interface RunWebUsage {
  searches: number;
  reads: number;
  /** Null when the provider has no estimate. */
  estimatedSearchCostUsd: number | null;
}

/** Null when the run made no web call (a run without web search, or one that never used it). A refusal before sending is not a call. */
export function runWebUsage(steps: readonly { action: string | null; summary: string }[], snapshot: Pick<RunPolicySnapshot, 'web'> | null): RunWebUsage | null {
  const sent = (action: string) => steps.filter((s) => s.action === action && !s.summary.startsWith('refused')).length;
  const searches = sent('web_search');
  const reads = sent('web_fetch');
  if (searches === 0 && reads === 0) return null;
  const cost = readSnapshotWeb(snapshot)?.costPerCallUsd ?? null;
  return { searches, reads, estimatedSearchCostUsd: cost === null ? null : Math.round(searches * cost * 1_000_000) / 1_000_000 };
}
