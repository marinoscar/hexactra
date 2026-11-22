// E46.15 (#789): the interrupt rung, without a database.
import { FakeBrowser } from '@marinoscar/hexactra-browser-agent/testing';
import { aVersion, call, lit } from '@marinoscar/hexactra-kgraph/testing';
import type { ToolCallRequest, ToolInvocation } from '@marinoscar/hexactra-kgraph';

import { INTERRUPT_LIMITS, interruptStrategy, signInRecipe, type SiteMemory } from '../src/runner/host/kgraph/interrupts';

const ok: ToolInvocation = { ok: true, text: 'ok', digest: 'd', refused: false, stopped: false, paused: false };
const step = aVersion([call('s1', 'click', { selector: lit('#go') })]).steps[0]!;
const el = (o: Record<string, unknown>) => ({ selector: '#x', selectors: ['#x'], role: null, name: null, tag: 'button', inputType: null, anchor: null, ...o });

function setup(site: SiteMemory | null, surface: Record<string, unknown>[], snap: { title?: string; text?: string } = {}) {
  const browser = new FakeBrowser();
  browser.surface = surface;
  browser.snapshot = snap;
  const calls: ToolCallRequest[] = [];
  const strategy = interruptStrategy({ browser, invoke: { invoke: async (r) => (calls.push(r), ok) }, site: async () => site });
  return { strategy, calls };
}

describe('interrupt handlers', () => {
  const banner = [el({ selector: '#accept', name: 'Accept all', anchor: 'We use cookies' }), el({ selector: '#reject', name: 'Reject all', anchor: 'We use cookies' })];
  it("consent: repeats the owner's recorded choice", async () => {
    const t = setup({ consent: { role: null, name: 'Reject all', tag: 'button', inputType: null, selectors: ['#reject'], anchor: 'We use cookies' } }, banner);
    expect(await t.strategy.attempt({ step, kind: 'precondition' })).toBe('recovered');
    expect(t.calls).toEqual([expect.objectContaining({ tool: 'click', args: { selector: '#reject', reason: "repeat the owner's earlier cookie choice" } })]);
  });
  it('consent with no recorded choice hands over, never choosing for the owner', async () => {
    const t = setup(null, banner);
    expect(await t.strategy.attempt({ step, kind: 'precondition' })).toBe('no');
    expect(t.calls).toEqual([]);
  });
  it('signed out: signs in with the recorded reference; no secret in the call', async () => {
    const t = setup({ signIn: { ref: 'login-1', username_selector: '#u', password_selector: '#p', submit: true } }, [el({ selector: '#p', tag: 'input', inputType: 'password' }), el({ selector: '#in', name: 'Sign in' })], { title: 'Sign in' });
    expect(await t.strategy.attempt({ step, kind: 'precondition' })).toBe('recovered');
    expect(t.calls).toEqual([expect.objectContaining({ tool: 'sign_in_with_saved_login', args: { ref: 'login-1', username_selector: '#u', password_selector: '#p', submit: true } })]);
    expect(signInRecipe({ ref: 'login-1', username_selector: '#u', password_selector: '#p', password: 'hunter2' })).toEqual({ ref: 'login-1', username_selector: '#u', password_selector: '#p', submit: false });
  });
  it('a CAPTCHA page always hands over', async () => {
    const t = setup({ signIn: { ref: 'l', username_selector: '#u', password_selector: '#p', submit: true } }, banner, { title: 'Security check', text: 'Verify you are human' });
    expect(await t.strategy.attempt({ step, kind: 'precondition' })).toBe('no');
    expect(t.calls).toEqual([]);
  });
  it('limits: at most 2 per step and 5 per run', async () => {
    const t = setup(null, [el({ role: 'dialog', name: 'Promo', tag: 'div' }), el({ selector: '#close', name: 'Close', anchor: 'Promo' })]);
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await t.strategy.attempt({ step, kind: 'precondition' }));
    expect(results).toEqual(['recovered', 'recovered', 'no']);
    for (const id of ['a', 'b', 'c', 'd']) results.push(await t.strategy.attempt({ step: { ...step, id }, kind: 'precondition' }));
    expect(t.calls).toHaveLength(INTERRUPT_LIMITS.perRun);
  });
});
