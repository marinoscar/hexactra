// Interrupt handlers (E46.15): rung 2 of the recovery ladder. On a failed precondition or check, the page is read (in memory only) and:
//   consent    → repeat the choice the owner's own run made on that site (kept on the site); none recorded → hand over.
//   overlay    → click its one close control.
//   signed_out → sign in again with the saved-login tool and the reference the owner's run used (the fabric types the password; the
//                origin is read from the browser at the moment of typing, as today); none recorded → hand over.
//   blocked    → never automated: hand over (the agent asks the owner).
// Every action is a tool call through `executeTool` (the site and risk gates apply) and an ordinary step. At most 2 per step, 5 per run.
import type { BrowserPort } from '@marinoscar/hexactra-browser-agent/browser-port';
import { detectInterrupt, pageSnapshot, resolveFingerprint, type ElementFingerprint } from '@marinoscar/hexactra-browser-agent/surface';
import type { RecoveryStrategy, ToolInvokerPort } from '@marinoscar/hexactra-kgraph';

/** What the owner's own runs taught about a site: their consent choice and how they signed in (references only, never a secret). */
export interface SiteMemory {
  consent?: Omit<ElementFingerprint, 'frame'>;
  signIn?: { ref: string; username_selector: string; password_selector: string; submit: boolean };
}

export const INTERRUPT_LIMITS = Object.freeze({ perStep: 2, perRun: 5 });

export function interruptStrategy(o: { browser: BrowserPort; invoke: ToolInvokerPort; site(url: string | null): Promise<SiteMemory | null> }): RecoveryStrategy {
  const perStep = new Map<string, number>();
  let perRun = 0;
  const act = async (stepId: string, tool: string, args: Record<string, unknown>) => {
    const r = await o.invoke.invoke({ tool, args, step: `${stepId}:interrupt`, commitClass: false });
    return r.ok && !r.refused && !r.stopped && !r.paused;
  };
  return {
    rung: 'interrupts',
    attempt: async (f) => {
      const n = perStep.get(f.step.id) ?? 0;
      if (n >= INTERRUPT_LIMITS.perStep || perRun >= INTERRUPT_LIMITS.perRun) return 'no';
      const snap = await pageSnapshot(o.browser);
      const found = snap ? detectInterrupt(snap) : null;
      if (!found || found.kind === 'blocked') return 'no';
      perStep.set(f.step.id, n + 1);
      perRun++;
      if (found.kind === 'overlay') return (await act(f.step.id, 'click', { selector: found.close, reason: 'close a pop-up over the page' })) ? 'recovered' : 'no';
      const site = await o.site(snap?.url ?? null).catch(() => null);
      if (found.kind === 'consent') {
        if (!site?.consent) return 'no';
        const choice = await resolveFingerprint(o.browser, { ...site.consent, frame: 'top' });
        if (choice.kind !== 'found') return 'no';
        return (await act(f.step.id, 'click', { selector: choice.selector, reason: "repeat the owner's earlier cookie choice" })) ? 'recovered' : 'no';
      }
      // signed_out
      if (!site?.signIn) return 'no';
      return (await act(f.step.id, 'sign_in_with_saved_login', { ...site.signIn })) ? 'recovered' : 'no';
    },
  };
}

/** The sign-in recipe of an owner's run, when its arguments are only a reference and selectors (never a secret). */
export function signInRecipe(args: unknown): SiteMemory['signIn'] | null {
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a.ref !== 'string' || typeof a.username_selector !== 'string' || typeof a.password_selector !== 'string') return null;
  return { ref: a.ref.slice(0, 200), username_selector: a.username_selector.slice(0, 500), password_selector: a.password_selector.slice(0, 500), submit: a.submit === true };
}
