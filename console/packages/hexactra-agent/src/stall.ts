/**
 * Stall detection (#405): is the run going round in circles? Pure and
 * deterministic, no I/O: the runner feeds it every recorded action and the
 * page state at the start of every chunk, and acts on the signal it returns.
 * Always on, whatever the budget (an Unlimited policy still stalls out).
 *
 * What it keeps (`StallState`) lives in the run memory between chunks, jobs
 * and handoffs. It holds only short digests, normalised selectors and URLs
 * without a query: never typed text (only its length), never a secret value,
 * never an image. Secret typing is not fed to it at all. A read's `contentHash`
 * (12 hex characters of a sha256) enters its fingerprint, and is already kept
 * in `seen`: it stores no text.
 */
import { createHash } from 'node:crypto';

import { redactActionArgs } from './redact';

/** Fingerprints looked at for the repeated-action signal. */
export const FINGERPRINT_WINDOW = 10;
/** Successful, progressing actions on an escalated tier before the run returns to its start tier. */
export const DE_ESCALATE_AFTER = 5;
/** Recent returned-content digests kept (new content is progress). */
const SEEN_CAP = 40;
/** Actions that change the page counted over the whole run (E52.2): the least recently used beyond this are dropped. */
export const COUNTS_CAP = 64;
/** Stable page digests remembered (E52.2): a page seen again is no progress. */
const STABLE_SEEN_CAP = 40;
/** Rounds in a row that record not one action before the run counts as stalled. */
export const MAX_IDLE_CHUNKS = 3;
/** Most times one run asks a person because of a stall; after that it fails. */
export const MAX_STALL_HANDOFFS = 3;

/** What a policy says about a stall: when it counts, what to do, and how often a run may escalate. */
export interface StallSettings {
  maxConsecutiveFailures: number;
  maxRepeatedAction: number;
  noProgressActions: number;
  onStall: 'nudge_then_escalate' | 'escalate' | 'ask_human' | 'fail';
  maxEscalations: number;
}
export type StallThresholds = Pick<StallSettings, 'maxConsecutiveFailures' | 'maxRepeatedAction' | 'noProgressActions'>;

/** What the runner knows of the page: URL, title and a digest of how it looks. */
export interface PageState {
  url: string | null;
  title: string | null;
  /** Digest of the page's visible structure (its numbered elements); the screenshot's own digest when it has none. */
  view: string | null;
  /**
   * The page without what moves on its own (E52.2): the marks' selectors and text, without positions, with clock and relative times
   * blanked ({@link stableText}). Null when the page has no marks: the rules then fall back to `view`.
   */
  stable?: string | null;
}

/** One action that changes the page, counted over the whole run (E52.2). `told` is the count the last signal was given at. */
export interface ActionCount {
  fp: string;
  label: string;
  n: number;
  told: number;
}

interface RecentAction {
  fp: string;
  label: string;
  ok: boolean;
}

export interface StallState {
  /** The last {@link FINGERPRINT_WINDOW} actions, newest last. */
  recent: RecentAction[];
  failures: number;
  /** Actions since the page last visibly changed or new content was read. */
  sinceProgress: number;
  page: PageState | null;
  /** Whether the page state is measured (a screenshot is taken each chunk). */
  observable: boolean;
  /** Digests of recently returned content. */
  seen: string[];
  /** Successful actions that change the page, by fingerprint, over the whole run (E52.2): a cycle of any length repeats here. */
  counts: ActionCount[];
  /** Stable digests of the pages seen (E52.2): coming back to one is no progress. */
  stableSeen: string[];
}

export function newStallState(): StallState {
  return { recent: [], failures: 0, sinceProgress: 0, page: null, observable: false, seen: [], counts: [], stableSeen: [] };
}

/** A state parsed from the run memory; a fresh one when absent or malformed. */
export function readStallState(value: unknown): StallState {
  const v = value as Partial<StallState> | null | undefined;
  if (!v || typeof v !== 'object' || !Array.isArray(v.recent) || !Array.isArray(v.seen)) return newStallState();
  return {
    recent: v.recent.filter((r): r is RecentAction => !!r && typeof r.fp === 'string' && typeof r.label === 'string').slice(-FINGERPRINT_WINDOW),
    failures: Number.isInteger(v.failures) ? Math.max(0, v.failures as number) : 0,
    sinceProgress: Number.isInteger(v.sinceProgress) ? Math.max(0, v.sinceProgress as number) : 0,
    page: v.page && typeof v.page === 'object' ? { url: v.page.url ?? null, title: v.page.title ?? null, view: v.page.view ?? null, stable: v.page.stable ?? null } : null,
    observable: v.observable === true,
    seen: v.seen.filter((s): s is string => typeof s === 'string').slice(-SEEN_CAP),
    // A run memory written before E52.2 has neither: empty.
    counts: (Array.isArray(v.counts) ? v.counts : [])
      .filter((c): c is ActionCount => !!c && typeof c.fp === 'string' && typeof c.label === 'string' && Number.isInteger(c.n) && Number.isInteger(c.told))
      .slice(-COUNTS_CAP),
    stableSeen: (Array.isArray(v.stableSeen) ? v.stableSeen : []).filter((s): s is string => typeof s === 'string').slice(-STABLE_SEEN_CAP),
  };
}

/**
 * A handoff, a request for a person or a human answer: every counter starts over, and the page is
 * measured afresh (the person may have changed it).
 */
export function resetStall(state: StallState): void {
  state.recent = [];
  state.failures = 0;
  state.sinceProgress = 0;
  state.page = null;
  state.seen = [];
  state.counts = [];
  state.stableSeen = [];
}

/**
 * After a stall was answered (nudge, escalation): the evidence is spent, the page baseline stays. The run-wide counts and the pages seen
 * stay too (E52.2): one more repeat after a nudge signals again, so the policy moves on to escalate, then to ask.
 */
export function clearStallEvidence(state: StallState): void {
  state.recent = [];
  state.failures = 0;
  state.sinceProgress = 0;
}

export type StallKind = 'failures' | 'repeat' | 'no_progress' | 'idle';

export interface StallSignal {
  kind: StallKind;
  /** One short phrase for the model, the activity and the log: "repeated click on #submit". */
  reason: string;
}

/** What one recorded action tells the detector. */
export interface ActionObservation {
  /** The fabric action type, or `look`. */
  type: string;
  /** The arguments as the runner passed them (redacted here, before anything is hashed). */
  args: Record<string, unknown>;
  ok: boolean;
  /** The page URL the action ended on, when it reports one (navigate, tabs). */
  url?: string | null;
  title?: string | null;
  /** What distinguishes two runs of the same call: the scroll position, a digest of returned content. */
  resultKey?: string | null;
  /** A digest of content the action returned (read_text, observe_elements, run_javascript). */
  contentHash?: string | null;
  /** Secret typing: ignored entirely. */
  secret?: boolean;
}

/** Action types that read the page and change nothing. */
export const OBSERVATION_TYPES: ReadonlySet<string> = new Set(['text', 'elements', 'evaluate', 'tabs', 'screenshot', 'look', 'wait_for', 'scroll', 'scroll_at', 'desktop_scroll', 'mouse']);

export function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

const round10 = (n: number) => Math.round(n / 10) * 10;

const CLOCK = /\b\d{1,2}:\d{2}(:\d{2})?(\s?[ap]\.?m\.?)?(?![\w])/gi;
const RELATIVE = /\b\d+\s?(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|wk|wks|weeks?)\b(\s+ago)?/gi;
const WHOLE_TIME_WORD = /^(now|just now|today|yesterday)$/;

/**
 * Text as the stable page digest keeps it (E52.2): lower case, whitespace collapsed, clock times ("9:41", "11:02 PM") and relative
 * times ("2 min", "3 hours ago") blanked to "#", and a whole text of "now", "just now", "today" or "yesterday" too. Other digits stay:
 * a quantity, a page number or a price must keep two pages different.
 */
export function stableText(text: string | null | undefined): string {
  const t = String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (WHOLE_TIME_WORD.test(t)) return '#';
  return t.replace(CLOCK, '#').replace(RELATIVE, '#');
}

/** The stable digest of a page's marks (E52.2): selectors and stable text, sorted and unique, no position. Null without marks. */
export function stableDigest(marks: ReadonlyArray<{ selector?: string | null; text?: string | null }>): string | null {
  if (marks.length === 0) return null;
  const items = [...new Set(marks.map((m) => JSON.stringify([m.selector ?? '', stableText(m.text)])))].sort();
  return digest(items.join('\n'));
}
const POSITION_KEYS = new Set(['x', 'y', 'from_x', 'from_y', 'to_x', 'to_y']);

/** The URL without its query and fragment. */
function urlNoQuery(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '[invalid url]';
  }
}

/**
 * The arguments as they enter a fingerprint: redacted first (typed text becomes its length, long strings
 * are cut), then URLs lose their query and positions are rounded, so two clicks a pixel apart are one.
 */
export function normalizeArgs(type: string, args: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactActionArgs(type, args);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(redacted).sort()) {
    const value = redacted[key];
    if (key === 'url' && typeof args.url === 'string') out.url = urlNoQuery(args.url);
    else if (POSITION_KEYS.has(key) && typeof value === 'number') out[key] = round10(value);
    else out[key] = value;
  }
  return out;
}

/**
 * What an action returned, as it enters its fingerprint: the result key (a scroll's position), else, for a read
 * (`text`, `elements`, `evaluate`, …), the digest of what it read. Reading a page that changed is therefore a new
 * action, and reading the same content again is the same one (#909). `page.view` is only measured once per chunk,
 * and an SPA keeps its URL, so without this every read in a chunk looked alike whatever it returned.
 */
function resultOf(obs: ActionObservation): string {
  return obs.resultKey ?? (OBSERVATION_TYPES.has(obs.type) ? obs.contentHash : null) ?? '';
}

/** The fingerprint of an action: `hash(type, normalised args, ok, resulting URL, result (key or read content), page view)`. */
export function fingerprint(obs: ActionObservation, page: PageState | null): string {
  const resultingUrl = obs.url ?? page?.url ?? '';
  return digest(JSON.stringify([obs.type, normalizeArgs(obs.type, obs.args), obs.ok, resultingUrl ? urlNoQuery(resultingUrl) : '', resultOf(obs), page?.stable ?? page?.view ?? '']));
}

/** A few words for an action: "click on #submit", "click at 120,300", "navigate to https://shop.example.test/cart". */
export function describeAction(type: string, args: Record<string, unknown>): string {
  const a = args;
  if (typeof a.selector === 'string') return `${type} on ${a.selector.slice(0, 80)}`;
  if (typeof a.url === 'string') return `${type} to ${urlNoQuery(a.url).slice(0, 120)}`;
  if (typeof a.x === 'number' && typeof a.y === 'number') return `${type.replace(/_at$/, '')} at ${a.x},${a.y}`;
  if (typeof a.mark === 'number') return `${type} on mark ${a.mark}`;
  if (typeof a.key === 'string') return `${type} ${a.key.slice(0, 40)}`;
  if (typeof a.screen === 'string') return `${type} the ${a.screen}`;
  return type;
}

/** What `observeAction` found. */
export interface ActionVerdict {
  /** The action was successful and not a repeat of a recent one: it moved the run along. */
  progressing: boolean;
  signal: StallSignal | null;
}

/**
 * Feed one recorded action. Returns whether it was progressing (for de-escalation) and the stall signal, if
 * any. While the page is measured (`state.observable`), "no progress" is judged only at the next chunk
 * boundary by {@link observePage}, because the screenshot that shows what changed is only taken then.
 */
export function observeAction(state: StallState, th: StallThresholds, obs: ActionObservation): ActionVerdict {
  if (obs.secret) return { progressing: false, signal: null };
  const fp = fingerprint(obs, state.page);
  const label = describeAction(obs.type, obs.args);
  const novel = !state.recent.some((r) => r.fp === fp);

  let moved = false;
  if (obs.ok) {
    if (obs.url && obs.url !== state.page?.url) {
      state.page = { url: obs.url, title: obs.title ?? state.page?.title ?? null, view: state.page?.view ?? null };
      moved = true;
    } else if (obs.title && obs.title !== state.page?.title) {
      state.page = { url: state.page?.url ?? null, title: obs.title, view: state.page?.view ?? null };
      moved = true;
    }
    // Observations alone are no progress; new returned content is.
    if (obs.contentHash && !state.seen.includes(obs.contentHash)) {
      state.seen.push(obs.contentHash);
      if (state.seen.length > SEEN_CAP) state.seen.shift();
      moved = true;
    }
    // Without a measured page, a new successful change of the page is the best sign there is.
    if (!state.observable && !OBSERVATION_TYPES.has(obs.type) && novel) moved = true;
  }

  // A successful action that changes the page counts over the whole run (E52.2); reading a page a few times is normal and is judged
  // in the window only.
  if (obs.ok && !OBSERVATION_TYPES.has(obs.type)) countAction(state, fp, label);

  state.recent.push({ fp, label, ok: obs.ok });
  if (state.recent.length > FINGERPRINT_WINDOW) state.recent.shift();
  state.failures = obs.ok ? 0 : state.failures + 1;
  state.sinceProgress = moved ? 0 : state.sinceProgress + 1;

  const progressing = obs.ok && novel;
  return { progressing, signal: judge(state, th, label) };
}

/** Count one action that changes the page (E52.2), most recently used last. */
function countAction(state: StallState, fp: string, label: string): void {
  const i = state.counts.findIndex((c) => c.fp === fp);
  const entry = i >= 0 ? state.counts.splice(i, 1)[0]! : { fp, label, n: 0, told: 0 };
  entry.n += 1;
  state.counts.push(entry);
  if (state.counts.length > COUNTS_CAP) state.counts.shift();
}

function judge(state: StallState, th: StallThresholds, label: string): StallSignal | null {
  if (state.failures >= th.maxConsecutiveFailures) return { kind: 'failures', reason: `${state.failures} actions failed in a row` };
  const last = state.recent[state.recent.length - 1];
  if (last) {
    const same = state.recent.filter((r) => r.fp === last.fp).length;
    if (same >= th.maxRepeatedAction) {
      const c = last.ok ? state.counts.find((x) => x.fp === last.fp) : undefined;
      if (c) c.told = c.n;
      return { kind: 'repeat', reason: `repeated ${label} ${same} times` };
    }
  }
  // The same action from the same page, however far apart (E52.2): a cycle of any length. Signalled once per new repeat.
  const counted = last?.ok ? state.counts.find((c) => c.fp === last.fp) : undefined;
  if (counted && counted.n >= th.maxRepeatedAction && counted.n > counted.told) {
    counted.told = counted.n;
    return { kind: 'repeat', reason: `repeated ${counted.label} ${counted.n} times from the same page` };
  }
  if (!state.observable && state.sinceProgress >= th.noProgressActions) return { kind: 'no_progress', reason: `${state.sinceProgress} actions without progress` };
  return null;
}

/**
 * The page as measured at the start of a chunk (`null`: nothing could be measured, vision is off).
 * A change of URL, title or view is progress. Returns the no-progress signal when the page stayed the
 * same for `noProgressActions` actions.
 */
export function observePage(state: StallState, th: StallThresholds, page: PageState | null): StallSignal | null {
  state.observable = page !== null;
  if (!page) return null;
  const before = state.page;
  const stable = page.stable ?? null;
  const changed = before !== null && (before.url !== page.url || before.title !== page.title || before.view !== page.view);
  // A changed page is progress, unless it is a page the run has already been on (E52.2): going round in a circle shows a new
  // page every round.
  if (changed && (stable === null || !state.stableSeen.includes(stable))) state.sinceProgress = 0;
  if (stable !== null && !state.stableSeen.includes(stable)) {
    state.stableSeen.push(stable);
    if (state.stableSeen.length > STABLE_SEEN_CAP) state.stableSeen.shift();
  }
  state.page = page;
  if (state.sinceProgress >= th.noProgressActions) return { kind: 'no_progress', reason: `${state.sinceProgress} actions without visible progress` };
  return null;
}

/** The last `n` actions as one line: "click on #a (ok); click on #a (failed)". */
export function lastActions(state: StallState, n = 5): string {
  return state.recent
    .slice(-n)
    .map((r) => `${r.label}${r.ok ? '' : ' (failed)'}`)
    .join('; ');
}

/** The text the next round's input carries after a first stall. */
export function nudgeText(reason: string, last: string): string {
  return `You appear stuck: ${reason}${last ? ` (last actions: ${last})` : ''}. Do not repeat the same action. Try a different approach (another selector, position, keyboard, run_javascript, or a different page), or call finish if the goal is impossible.`;
}

/** The instruction of the last call of a run that stalled out (the model may only call `finish`). */
export function stallWrapUpInstruction(reason: string): string {
  return `The run is stuck (${reason}) and is being ended. Call finish now: success only if the goal is fully done; otherwise summarise exactly what was done and what remains.`;
}

/** The prompt of the handoff that asks a person to unstick the run. */
export function stallHandoffPrompt(reason: string, last: string): string {
  return `The agent is stuck: ${reason}.${last ? ` Its last actions: ${last}.` : ''} Take over the browser to get it moving, then press Done.`.slice(0, 1_500);
}

export type StallResponse = 'nudge' | 'escalate' | 'ask' | 'fail';

/**
 * What to do about a stall under `onStall`. `stallsHere` counts the stalls since the run last escalated
 * (or started): the first is nudged, the next escalates. When there is nothing left to escalate to, the
 * run asks a person if one may be asked, else fails.
 */
export function decideStall(input: { mode: StallSettings['onStall']; stallsHere: number; canEscalate: boolean; canAsk: boolean }): StallResponse {
  const exhausted: StallResponse = input.canAsk ? 'ask' : 'fail';
  switch (input.mode) {
    case 'fail':
      return 'fail';
    case 'ask_human':
      return input.canAsk ? 'ask' : 'fail';
    case 'escalate':
      return input.canEscalate ? 'escalate' : 'fail';
    case 'nudge_then_escalate':
      if (input.stallsHere === 0) return 'nudge';
      return input.canEscalate ? 'escalate' : exhausted;
  }
}
