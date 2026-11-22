// Derived site facts (E46.30): proposals about a site read deterministically from server-recorded facts, with no model. The inputs are the
// run's neutral trace (tool names, argument provenance, post-state: never page text or reasoning), the owner's surface graph (screens and
// elements whose labels the host masked before it stored them) and the interrupt handlers that fired (E46.15). Each proposal carries its
// evidence (the run, its calls, the screens) and passes `validateSiteFact`; one that fails it is dropped. Every proposal is `derived` and is
// only a proposal: the owner's own act makes it active.
import type { Element, Screen } from '../schema/core';
import { siteFactKey, type SiteFactEvidence, type SiteFactKind, type SiteFactProposal } from '../schema/site-fact';
import { validateSiteFact, type SecretCheckPort } from '../validate/site-fact';
import { elementId, OBSERVE_TOOLS, pathPattern, registrableDomain, screenIdOf } from './compile';
import type { TraceBinding, TraceEvent } from './trace';

/** One call of the trace, with how long it took when the host knows it (from its step row; never a value). */
export type SiteTraceEvent = TraceEvent & { durationMs?: number };

/** A run's trace, as `deriveSiteFacts` reads it. */
export interface SiteFactTrace {
  runId?: string | null;
  events: readonly SiteTraceEvent[];
}

/** The owner's surface graph (E46.13), or the part of it for the run's sites. Element labels are already masked. */
export interface SurfaceSnapshot {
  screens: readonly Screen[];
  elements: readonly Element[];
}

/** One interrupt handler that fired (E46.15): what it found and where. Never page text. */
export interface InterruptFiring {
  kind: 'consent' | 'overlay' | 'signed_out' | 'blocked';
  /** The page's host when it fired. */
  host: string;
  /** The page's path, for the screen it was on. */
  path?: string;
  /** The trace call the handler ran for, when known. */
  seq?: number;
}

export interface DeriveSiteFactsOptions {
  /** The host's secret rules (default: the package's). A proposal whose text fails them is dropped. */
  secretCheck?: SecretCheckPort;
  /** A browser call slower than this is a `timing` fact. Default 5 000 ms. */
  slowMs?: number;
}

export const SITE_FACT_DERIVE_DEFAULTS = Object.freeze({ slowMs: 5_000, maxPathClicks: 6, maxLabel: 60 });

/** Clicks whose element leads from one screen to the next. */
const CLICK_TOOLS = new Set(['click', 'click_mark', 'click_at']);

const QUIRK_TEXT: Readonly<Record<InterruptFiring['kind'], string>> = Object.freeze({
  consent: 'A cookie banner appears on first visit',
  overlay: 'A pop-up can cover the page',
  signed_out: 'The session can expire and ask to sign in again',
  blocked: 'The site can show a check that only a person can pass',
});

const ONE_TIME_CODE = 'Sign-in asks for a one-time code';

const stepId = (seq: number) => `s${seq}`;
const literal = (b: TraceBinding | undefined) => (b && b.kind === 'literal' ? b.value : undefined);

/** A path segment as words ("billing-history" → "Billing history"), or null when it is not a plain word. */
function segmentName(path: string | undefined): string | null {
  if (!path) return null;
  const segs = pathPattern(path).split('/').filter((s) => s && s !== '*');
  const last = segs[segs.length - 1];
  if (!last || !/^[a-z][a-z0-9_-]{1,39}$/i.test(last) || /^(index|home|default|main)$/i.test(last)) return null;
  const words = last.replace(/[-_]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const cleanLabel = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, SITE_FACT_DERIVE_DEFAULTS.maxLabel);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Proposals from one run. Deterministic: the same inputs give the same list, sorted by site, kind and text, each identity (site, kind and
 * normalised text) once.
 * - `navigation`: a chain of two or more clicks on one site whose elements are in the surface graph: "Invoices: Billing → History" (the
 *   screen reached, named from its path, then the masked labels clicked).
 * - `sign_in`: a handoff of kind `code` (a one-time code) or a saved authenticator code typed on the site.
 * - `quirk`: an interrupt handler that fired.
 * - `timing`: a browser call slower than `slowMs`, per screen, rounded to seconds.
 */
export function deriveSiteFacts(trace: SiteFactTrace, surface: SurfaceSnapshot, handlers: readonly InterruptFiring[] = [], options: DeriveSiteFactsOptions = {}): SiteFactProposal[] {
  const slowMs = options.slowMs ?? SITE_FACT_DERIVE_DEFAULTS.slowMs;
  const runId = trace.runId ?? undefined;
  const elements = new Map(surface.elements.map((e) => [e.id, e]));
  const found = new Map<string, SiteFactProposal>();

  const add = (site: string, kind: SiteFactKind, text: string, ev: { stepIds?: string[]; screenIds?: string[] }) => {
    const evidence: SiteFactEvidence = {
      ...(runId ? { runId } : {}),
      ...(ev.stepIds?.length ? { stepIds: [...new Set(ev.stepIds)].slice(0, 50) } : {}),
      ...(ev.screenIds?.length ? { screenIds: [...new Set(ev.screenIds)].slice(0, 50) } : {}),
    };
    const p: SiteFactProposal = { site, kind, text, source: 'derived', evidence };
    if (validateSiteFact(p, { secretCheck: options.secretCheck }).length > 0) return;
    const key = siteFactKey(p);
    const prev = found.get(key);
    if (!prev) {
      found.set(key, p);
      return;
    }
    // The same fact seen again in this run: one proposal, its evidence merged.
    const merge = (a?: string[], b?: string[]) => {
      const all = [...new Set([...(a ?? []), ...(b ?? [])])].slice(0, 50);
      return all.length ? all : undefined;
    };
    const stepIds = merge(prev.evidence.stepIds, evidence.stepIds);
    const screenIds = merge(prev.evidence.screenIds, evidence.screenIds);
    prev.evidence = { ...(runId ? { runId } : {}), ...(stepIds ? { stepIds } : {}), ...(screenIds ? { screenIds } : {}) };
  };

  // ---- navigation
  type Click = { seq: number; label: string; screen: string; path: string };
  let chain: Click[] = [];
  let chainSite: string | null = null;
  const flush = () => {
    if (chainSite && chain.length >= 2) {
      const clicks = chain.slice(-SITE_FACT_DERIVE_DEFAULTS.maxPathClicks);
      const labels = clicks.map((c) => c.label);
      let dest = segmentName(clicks[clicks.length - 1]!.path);
      if (dest && same(dest, labels[labels.length - 1]!)) labels.pop();
      if (!dest) dest = labels.pop() ?? null;
      if (dest && labels.length > 0) add(chainSite, 'navigation', `${dest}: ${labels.join(' → ')}`, { stepIds: clicks.map((c) => stepId(c.seq)), screenIds: clicks.map((c) => c.screen) });
    }
    chain = [];
    chainSite = null;
  };

  // ---- one pass over the trace
  let lastHost: string | null = null;
  const slow = new Map<string, { site: string; ms: number; seqs: number[]; screen: string; name: string | null }>();
  for (const e of trace.events) {
    const navigatedTo = e.tool === 'navigate' ? literal(e.bindings.url) : undefined;
    if (e.post.host) lastHost = e.post.host;
    else if (typeof navigatedTo === 'string') {
      try {
        lastHost = new URL(navigatedTo).hostname.toLowerCase();
      } catch {
        /* not a URL: the host stays */
      }
    }
    const ran = e.ok && e.outcome === 'ran';

    // navigation: clicks in a row, on one site, each on an element of the surface graph
    if (OBSERVE_TOOLS.has(e.tool)) {
      /* reading the page does not break a path */
    } else if (CLICK_TOOLS.has(e.tool) && ran && e.post.element && e.post.host) {
      const site = registrableDomain(e.post.host);
      const el = elements.get(elementId(`site:${site}`, e.post.element));
      const label = cleanLabel(el?.label);
      if (!el || !label || (chainSite !== null && chainSite !== site)) flush();
      if (el && label) {
        chainSite = site;
        const path = e.post.path ?? '/';
        chain.push({ seq: e.seq, label, screen: screenIdOf(`site:${site}`, pathPattern(path)), path });
      }
    } else {
      flush();
    }

    // sign_in: a one-time code was asked for, or a saved authenticator code was typed
    const site = e.post.host ? registrableDomain(e.post.host) : lastHost ? registrableDomain(lastHost) : null;
    if (site && e.outcome !== 'refused') {
      const kind = literal(e.bindings.kind);
      if ((e.tool === 'request_human' && (kind === 'code' || kind === 'otp')) || (e.tool === 'type_saved_code' && ran)) add(site, 'sign_in', ONE_TIME_CODE, { stepIds: [stepId(e.seq)] });
    }

    // timing: a slow browser call, per screen
    if (e.family === 'browser' && ran && e.post.host && typeof e.durationMs === 'number' && e.durationMs >= slowMs) {
      const s = registrableDomain(e.post.host);
      const pattern = pathPattern(e.post.path ?? '/');
      const screen = screenIdOf(`site:${s}`, pattern);
      const name = segmentName(e.post.path);
      const key = `${s}|${name ?? ''}`;
      const prev = slow.get(key);
      if (!prev) slow.set(key, { site: s, ms: e.durationMs, seqs: [e.seq], screen, name });
      else {
        prev.ms = Math.max(prev.ms, e.durationMs);
        prev.seqs.push(e.seq);
      }
    }
  }
  flush();

  for (const t of slow.values()) {
    const seconds = Math.max(1, Math.round(t.ms / 1000));
    const text = t.name ? `The ${t.name.toLowerCase()} page loads slowly (about ${seconds} s)` : `Pages on this site load slowly (about ${seconds} s)`;
    add(t.site, 'timing', text, { stepIds: t.seqs.map(stepId), screenIds: [t.screen] });
  }

  // ---- quirk: the interrupt handlers that fired
  for (const h of handlers) {
    const text = QUIRK_TEXT[h.kind];
    if (!text || !h.host) continue;
    const site = registrableDomain(h.host);
    add(site, 'quirk', text, { stepIds: h.seq !== undefined ? [stepId(h.seq)] : [], screenIds: h.path !== undefined ? [screenIdOf(`site:${site}`, pathPattern(h.path))] : [] });
  }

  return [...found.values()].sort((a, b) => (a.site !== b.site ? (a.site < b.site ? -1 : 1) : a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1) : a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
}
