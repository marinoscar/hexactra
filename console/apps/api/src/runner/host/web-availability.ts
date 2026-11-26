// Whether a run gets web search (E50.7, #977): the web half of the one rule (E50.17, #987). A tool that is set up and switched on is always
// available: web search is set up when a search provider has a usable key, and switched on when the deployment's switch (`webSearch.enabled`)
// and the owner's (`webSearch.enabled` in their settings) are both on. Then every run and chat of the owner is offered `web_search`, and
// `web_fetch` with it while the administrator leaves `webSearch.fetch.enabled` on. Nothing else turns it on or off: not a task, a chat, a task
// parameter, a model or a page. The run of a hosted AI app gets it only while the owner's `allowWebSearch` limit for that app is on (on by
// default). Allowed sites do NOT switch it off: they bind `web_fetch` and filter `web_search` (the web site gate), never remove a tool.
//
// Decided once, at the run's first advance, and written onto the policy snapshot (`web`), so a switch flipped mid-run never alters that run.
// The twin of `runConnections`; guarded by `test/tools-always-available.db.spec.ts`.
import type { RunPolicySnapshot, SnapshotAppLimits } from '../../policies/policy-snapshot';
import type { HostDeps } from './deps';

/** The facts the rule reads, each as it is now. */
export interface WebAvailabilityInputs {
  /** A search provider is installed, switched on, listed and has a key the owner may use (or needs none). */
  providerUsable: boolean;
  /** The administrator's `webSearch.enabled`. */
  deploymentOn: boolean;
  /** The owner's own `webSearch.enabled`. */
  userOn: boolean;
  /** The administrator's `webSearch.fetch.enabled`: `web_fetch` on the console server. */
  fetchOn: boolean;
  /** The AI app that started the run: its owner's `allowWebSearch` limit. Null: no app started it. */
  appAllows: boolean | null;
}

/** What a run is offered: `fetch` only with `search`. */
export interface WebAvailability {
  search: boolean;
  fetch: boolean;
}

/** The rule, as a table (`test/web-availability.spec.ts` has a row per line). */
export function webAvailability(i: WebAvailabilityInputs): WebAvailability {
  const search = i.providerUsable && i.deploymentOn && i.userOn && i.appAllows !== false;
  return { search, fetch: search && i.fetchOn };
}

/** What the snapshot keeps (`policy_snapshot.web`); absent on a run without web search. */
export interface SnapshotWeb extends WebAvailability {
  /** The run's web call budget (`budget.maxWebCalls` of its policy): one search or one page read counts one. Null: unlimited. */
  maxCalls: number | null;
  /** The ESTIMATED cost of one search of the provider that answers, in USD, for the run's summary. Never added to the AI cost. */
  costPerCallUsd: number | null;
}

/** The snapshot's web field, read defensively: off when absent or malformed. */
export function readSnapshotWeb(snapshot: Pick<RunPolicySnapshot, 'web'> | null | undefined): SnapshotWeb | null {
  const w = snapshot?.web as Partial<SnapshotWeb> | null | undefined;
  if (!w || w.search !== true) return null;
  return { search: true, fetch: w.fetch === true, maxCalls: typeof w.maxCalls === 'number' ? w.maxCalls : null, costPerCallUsd: typeof w.costPerCallUsd === 'number' ? w.costPerCallUsd : null };
}

/**
 * Whether the owner's run gets web search now, and the estimate of a search's cost. Null: off (and nothing is written to the snapshot). A
 * failed read is off: web search never fails a run.
 */
export async function runWeb(d: Pick<HostDeps, 'webSearch' | 'log'>, run: { userId: string; orgId: string | null }, appLimits: Pick<SnapshotAppLimits, 'allowWebSearch'> | null, maxCalls: number | null): Promise<SnapshotWeb | null> {
  if (!d.webSearch) return null;
  try {
    const who = { userId: run.userId, orgId: run.orgId };
    const [s, user] = await Promise.all([d.webSearch.system(), d.webSearch.userSettings(run.userId)]);
    // The key lookup only when the switches are on: a run of an owner who switched it off never reads a credential status.
    const candidates = s.enabled && user.enabled && appLimits?.allowWebSearch !== false ? await d.webSearch.candidates(who, s, user) : [];
    const on = webAvailability({ providerUsable: candidates.length > 0, deploymentOn: s.enabled, userOn: user.enabled, fetchOn: s.fetch.enabled, appAllows: appLimits ? appLimits.allowWebSearch : null });
    if (!on.search) return null;
    return { ...on, maxCalls, costPerCallUsd: d.webSearch.costOf(s, candidates[0]!.provider) };
  } catch (e) {
    d.log.warn(`run: web search availability could not be read (${e instanceof Error ? e.name : 'error'}): off for this run`);
    return null;
  }
}
