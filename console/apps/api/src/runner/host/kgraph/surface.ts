// The surface graph's host side (E46.13): what to fingerprint after a click or type, and how a replayed browser step finds its element again.
// Page queries only (never a model), through the run's own browser; labels pass the trace masking table before they are stored.
import type { BrowserPort } from '@marinoscar/hexactra-browser-agent/browser-port';
import type { BrowserState } from '@marinoscar/hexactra-browser-agent/context';
import { captureFingerprint, resolveFingerprint, type ElementFingerprint } from '@marinoscar/hexactra-browser-agent/surface';
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

/**
 * A browser step that names an element resolves it first: exactly one confident match replaces the step's selector; otherwise the step fails
 * (no call is made) and the executor stops with a resume point. Then the same tool call goes through the wrapped invoker (`executeTool`).
 */
export function surfaceInvoker(inner: ToolInvokerPort, version: ProcedureVersion, browser: BrowserPort, shared: (elementId: string) => Promise<Partial<ElementFingerprint> | null>): ToolInvokerPort {
  return {
    invoke: async (req) => {
      const step = version.steps.find((s) => s.id === req.step);
      const el = step?.element ? version.elements.find((e) => e.id === step.element) : undefined;
      if (!el) return inner.invoke(req);
      const found = await resolveFingerprint(browser, fingerprintOf(el, await shared(el.id).catch(() => null)));
      if (found.kind !== 'found') {
        const miss: ToolInvocation = { ok: false, text: `the element "${el.label ?? el.role ?? 'element'}" was ${found.kind === 'ambiguous' ? 'ambiguous' : 'not found'}`, digest: `element:${found.kind}`, refused: false, stopped: false, paused: false };
        return miss;
      }
      return inner.invoke({ ...req, args: { ...req.args, selector: found.selector } });
    },
  };
}
