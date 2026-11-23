// The host's rungs of the recovery ladder (E46.16). Rung 2 (interrupts) is interrupts.ts.
//   1. wait again: a longer readiness wait, once.
//   3. re-resolve with relaxed matching (role and name anywhere on the screen), no model.
//   4. locate with one narrow model call (`JudgePort.locate`, the fast tier through the run's routing); the server checks the answer: the
//      number exists and the control's role fits the step. Never for a commit-class step (the ladder skips it).
// A rung-3 or rung-4 success sets the step's selector for the retry and records a proposed fingerprint update (for E46.17's review flow).
import type { BrowserPort } from '@marinoscar/hexactra-browser-agent/browser-port';
import { pageElements, readinessTimeout, relaxedMatch, roleCompatible, waitForElement } from '@marinoscar/hexactra-browser-agent/surface';
import type { JudgePort, ProcedureVersion, RecoveryStrategy } from '@marinoscar/hexactra-kgraph';

import { fingerprintOf } from './surface';

export interface Proposal {
  step: string;
  element: string;
  rung: 'reresolve' | 'locate';
  selector: string;
}

export interface RungDeps {
  browser: BrowserPort;
  version: ProcedureVersion;
  /** Selectors found by a rung, used by the step's retry (the surface invoker reads it). */
  overrides: Map<string, string>;
  judge: JudgePort;
  signal?: AbortSignal;
  propose(p: Proposal): Promise<void>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
  now?: () => number;
}

const elementOf = (d: RungDeps, stepId: string) => {
  const step = d.version.steps.find((s) => s.id === stepId);
  return step?.element ? d.version.elements.find((e) => e.id === step.element) : undefined;
};

export function hostRungs(d: RungDeps): RecoveryStrategy[] {
  return [
    {
      rung: 'wait',
      attempt: async (f) => {
        const el = elementOf(d, f.step.id);
        if (!el || f.kind !== 'precondition') return 'no';
        const r = await waitForElement(d.browser, fingerprintOf(el), { timeoutMs: 2 * readinessTimeout([]), signal: d.signal, ...(d.sleep ? { sleep: d.sleep } : {}), ...(d.now ? { now: d.now } : {}) });
        return r.kind === 'found' ? 'recovered' : 'no';
      },
    },
    {
      rung: 'reresolve',
      attempt: async (f) => {
        const el = elementOf(d, f.step.id);
        if (!el) return 'no';
        const r = relaxedMatch(fingerprintOf(el), (await pageElements(d.browser)) ?? []);
        if (r.kind !== 'found') return 'no';
        d.overrides.set(f.step.id, r.selector);
        await d.propose({ step: f.step.id, element: el.id, rung: 'reresolve', selector: r.selector }).catch(() => undefined);
        return 'recovered';
      },
    },
    {
      rung: 'locate',
      attempt: async (f) => {
        const el = elementOf(d, f.step.id);
        if (!el || !d.judge.locate || f.step.kind !== 'call') return 'no';
        const page = ((await pageElements(d.browser)) ?? []).filter((e) => e.visible !== false && e.enabled !== false);
        const { mark } = await d.judge.locate({ tool: f.step.tool, role: el.role ?? null, label: el.label ?? null, anchor: el.anchor ?? null, elements: page.map((e, i) => ({ n: i + 1, role: e.role, name: e.name, tag: e.tag })) });
        // The server checks the answer before using it.
        const got = mark !== null && Number.isInteger(mark) && mark >= 1 && mark <= page.length ? page[mark - 1]! : null;
        if (!got || !roleCompatible(el.role ?? null, el.tag ?? null, got)) return 'no';
        d.overrides.set(f.step.id, got.selector);
        await d.propose({ step: f.step.id, element: el.id, rung: 'locate', selector: got.selector }).catch(() => undefined);
        return 'recovered';
      },
    },
  ];
}
