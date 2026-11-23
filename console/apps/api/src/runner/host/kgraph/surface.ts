// The surface graph's host side (E46.13): what to fingerprint after a click or type, and how a replayed browser step finds its element again.
// Page queries only (never a model), through the run's own browser; labels pass the trace masking table before they are stored.
import type { BrowserPort } from '@marinoscar/hexactra-browser-agent/browser-port';
import type { BrowserState } from '@marinoscar/hexactra-browser-agent/context';
import { captureFingerprint, pacingDelay, readinessTimeout, seededRandom, waitForElement, waitUntil, abortableSleep, type ElementFingerprint, type PacingMode } from '@marinoscar/hexactra-browser-agent/surface';
import type { ProcedureVersion, ToolInvocation, ToolInvokerPort } from '@marinoscar/hexactra-kgraph';

import { maskSensitive } from '../../../tasks/mask';

/** The element a click, type or select acted on, as the page describes it now. */
export async function surfaceCapture(browser: BrowserPort, state: BrowserState, tool: string, args: unknown): Promise<Omit<ElementFingerprint, 'frame'> | null> {
  const a = (args ?? {}) as Record<string, unknown>;
  const mark = tool === 'click_mark' && typeof a.n === 'number' ? state.marks.get(a.n) : undefined;
  const where = typeof a.selector === 'string' ? { selector: a.selector } : mark ? { selector: mark.selector } : typeof a.x === 'number' && typeof a.y === 'number' ? { x: a.x, y: a.y } : null;
  if (!where) return null;
  const fp = await captureFingerprint(browser, where, { mask: (t) => maskSensitive(t).text });
  if (!fp) return null;
  const { frame: _frame, ...rest } = fp;
  return rest;
}

/** The fingerprint of a version's element, preferring the owner's shared (possibly repaired) copy. */
export function fingerprintOf(el: ProcedureVersion['elements'][number], shared?: Partial<ElementFingerprint> | null): ElementFingerprint {
  return {
    role: shared?.role ?? el.role ?? null,
    name: shared?.name ?? el.label ?? null,
    tag: shared?.tag ?? el.tag ?? null,
    inputType: shared?.inputType ?? el.inputType ?? null,
    selectors: shared?.selectors?.length ? shared.selectors : el.selectors,
    anchor: shared?.anchor ?? el.anchor ?? null,
    frame: 'top',
  };
}

export interface SurfaceInvokerOptions {
  /** The tool's family (`browser`, `accounts`, `mcp:…`): only browser steps are paced and wait for the page. */
  familyOf(tool: string): string;
  pacing: PacingMode;
  /** Stop and Pause end a wait at once. */
  signal?: AbortSignal;
  /** The page's URL now (a page query), for postconditions. */
  location(): Promise<string | null>;
  /** Selectors a recovery rung found for a step (E46.16): used instead of resolving again. */
  overrides?: Map<string, string>;
  /** Injected for tests. */
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
}

const hostPathOf = (url: string | null) => {
  try {
    const u = new URL(url ?? '');
    return { host: u.hostname.toLowerCase(), path: u.pathname };
  } catch {
    return null;
  }
};
const pathFits = (pattern: string, path: string) => pattern === '**' || new RegExp(`^${pattern.split('/').map((s) => (s === '**' ? '.*' : s === '*' ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}/?$`).test(path);

/**
 * A replayed browser step (E46.13, E46.14): a paced gap after the previous browser action (none for account and MCP steps), then a wait until
 * its element resolves to exactly one visible, enabled match (otherwise the step fails: no call is made), then the same tool call through the
 * wrapped invoker (`executeTool`), then a wait until its location check holds. Waits end at once on Stop or Pause.
 */
export function surfaceInvoker(inner: ToolInvokerPort, version: ProcedureVersion, browser: BrowserPort, shared: (elementId: string) => Promise<Partial<ElementFingerprint> | null>, o: SurfaceInvokerOptions): ToolInvokerPort {
  const random = o.random ?? seededRandom(Date.now() & 0xffff);
  const sleep = o.sleep ?? abortableSleep;
  let browserActions = 0;
  let lastWasNavigation = false;
  const miss = (text: string, kind: string): ToolInvocation => ({ ok: false, text, digest: `element:${kind}`, refused: false, stopped: false, paused: false });
  return {
    invoke: async (req) => {
      const step = version.steps.find((s) => s.id === req.step);
      if (o.familyOf(req.tool) !== 'browser' || !step) return inner.invoke(req);
      if (browserActions > 0 && !(await sleep(pacingDelay(random, o.pacing, lastWasNavigation), o.signal))) return { ...miss('stopped while waiting', 'aborted'), stopped: true };
      let args = req.args;
      const el = step.element ? version.elements.find((e) => e.id === step.element) : undefined;
      const override = o.overrides?.get(req.step);
      if (override) {
        o.overrides!.delete(req.step);
        args = { ...args, selector: override };
      } else if (el) {
        const ready = await waitForElement(browser, fingerprintOf(el, await shared(el.id).catch(() => null)), { timeoutMs: readinessTimeout([]), signal: o.signal, sleep });
        if (ready.kind === 'aborted') return { ...miss('stopped while waiting', 'aborted'), stopped: true };
        if (ready.kind !== 'found') return miss(`the element "${el.label ?? el.role ?? 'element'}" was ${ready.kind === 'ambiguous' ? 'ambiguous' : ready.kind === 'timeout' ? 'not ready in time' : 'not found'}`, ready.kind);
        args = { ...args, selector: ready.selector };
      }
      const result = await inner.invoke({ ...req, args });
      browserActions++;
      lastWasNavigation = req.tool === 'navigate';
      const loc = step.checks.find((c) => c.kind === 'location');
      if (result.ok && loc && loc.kind === 'location') {
        await waitUntil(async () => {
          const at = hostPathOf(await o.location());
          return at !== null && (at.host === loc.host || at.host.endsWith(`.${loc.host}`)) && pathFits(loc.pathPattern, at.path);
        }, { timeoutMs: readinessTimeout([]), signal: o.signal, sleep });
      }
      return result;
    },
  };
}
