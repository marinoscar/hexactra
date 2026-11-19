// The browser toolset's tools and gates, each alone, against a fake context and a fake browser (E38.5, #586): no database, no fabric, no loop.
import { GatePipeline } from '../src/runner/harness';
import { executeTool } from '../src/runner/harness/engine';
import { fakeBrowserRun } from '../src/runner/browser/testing/fake-browser';
import { browserTools } from '../src/runner/browser/tools';
import { finish } from '../src/runner/browser/tools/finish';
import { navigate, newTab } from '../src/runner/browser/tools/navigate';
import { click } from '../src/runner/browser/tools/click';
import { look } from '../src/runner/browser/tools/look';
import { requestHuman } from '../src/runner/browser/tools/request-human';
import { typeHandoffSecret } from '../src/runner/browser/tools/type-secret';
import { observeElements } from '../src/runner/browser/tools/observe';

type Run = ReturnType<typeof fakeBrowserRun>;
const call = (run: Run, tool: unknown, args: unknown) => executeTool(run.ctx, tool as never, args, new GatePipeline(run.gates as never) as never);

describe('navigate and new_tab: the site gate', () => {
  it('refuses a URL outside the allowed sites, records the refusal and sends nothing', async () => {
    const run = fakeBrowserRun({ allowedDomains: ['shop.example.test'] });
    expect(await call(run, navigate, { url: 'https://elsewhere.example.test/', reason: 'detour' })).toBe('Refused: that site is not allowed for this task (shop.example.test).');
    expect(await call(run, navigate, { url: 'javascript:alert(1)', reason: 'script' })).toBe('Refused: use run_javascript instead of a javascript: URL.');
    expect(await call(run, newTab, { url: 'https://elsewhere.example.test/' })).toBe('Refused: that site is not allowed for this task (shop.example.test).');
    expect(run.browser.actions).toEqual([]);
    expect(run.store.rows().map((r) => `${r.action}:${r.ok}:${r.summary}`)).toEqual(['navigate:false:refused by policy: site not allowed', 'navigate:false:refused by policy: site not allowed', 'new_tab:false:refused by policy: site not allowed']);
  });

  it('opens an allowed URL, tells the model the real address and stores it without its query', async () => {
    const run = fakeBrowserRun({ allowedDomains: ['shop.example.test'] });
    run.browser.results.set('navigate', { url: 'https://shop.example.test/item?ref=abc', title: 'Item' });
    expect(await call(run, navigate, { url: 'https://shop.example.test/item?ref=abc', reason: 'open it' })).toBe('at https://shop.example.test/item?ref=abc — Item');
    expect(run.browser.actions).toEqual([{ type: 'navigate', url: 'https://shop.example.test/item?ref=abc' }]);
    expect(run.store.rows()).toMatchObject([{ action: 'navigate', ok: true, summary: 'at https://shop.example.test/item (query removed) — Item', args: { url: 'https://shop.example.test/item (query removed)' } }]);
    // A new tab with no URL is not gated.
    expect(await call(run, newTab, { url: null })).toBe('opened tab ?');
  });
});

describe('click: the risk gate and the saved approvals', () => {
  const payRun = (extra: Parameters<typeof fakeBrowserRun>[0] = {}) => {
    const run = fakeBrowserRun({ confirmRisky: true, ...extra });
    run.browser.targets.set('#pay', { tag: 'button', label: 'Pay now', role: null });
    return run;
  };

  it('refuses a commitment, remembers what it stopped for the next confirmation, and sends nothing', async () => {
    const run = payRun();
    expect(await call(run, click, { selector: '#pay', reason: 'pay' })).toMatch(/^Refused: a button labelled 'Pay now' is a payment step\. Call request_human with kind "confirmation"/);
    expect(run.ctx.memory.gatePending).toEqual({ category: 'payment', label: 'Pay now', host: 'shop.example.test' });
    expect(run.browser.actions.filter((a) => a.type === 'click')).toEqual([]);
    expect(run.store.rows()).toMatchObject([{ action: 'click', ok: false, args: { selector: '#pay', category: 'payment', label: 'Pay now' }, summary: "paused by policy: needs a person's confirmation (payment: a button labelled 'Pay now')" }]);
    expect(run.telemetry.calls).toContain('gated:payment');
  });

  it('lets the approved click through once: its intent is written first, and the approval is spent', async () => {
    const run = payRun({ memory: { confirmedTarget: { category: 'payment', label: 'Pay now', host: 'shop.example.test' } } });
    expect(await call(run, click, { selector: '#pay', reason: 'pay' })).toBe('ok');
    expect(run.browser.actions.filter((a) => a.type === 'click')).toEqual([{ type: 'click', selector: '#pay' }]);
    expect(run.store.rows()).toMatchObject([{ seq: 1, kind: 'action', action: 'click', phase: 'done', ok: true }]);
    expect(run.ctx.memory.confirmedTarget).toBeNull();
    // The same click again needs its own confirmation.
    expect(await call(run, click, { selector: '#pay', reason: 'pay again' })).toMatch(/^Refused:/);
  });

  it('lets a click through on the owner\'s saved approval, and records which rule allowed it', async () => {
    const run = payRun();
    run.approvals!.rules.push({ host: 'shop.example.test', category: 'payment', label: 'Pay now', id: 'rule-1', summary: 'Pay now on shop.example.test' });
    expect(await call(run, click, { selector: '#pay', reason: 'pay' })).toBe('ok');
    expect(run.store.rows()[0]).toMatchObject({ ok: true, args: { selector: '#pay', approval: { ruleId: 'rule-1' } }, summary: 'allowed by a saved approval: Pay now on shop.example.test' });
    expect(run.approvals!.uses).toEqual([{ id: 'rule-1', stepSeq: 1 }]);
    expect(run.store.confirmed).toMatchObject([{ seq: 1, prompt: 'by saved approval: Pay now on shop.example.test', action: 'click' }]);
  });

  it('does not gate an ordinary click, and never gates when the task does not ask for confirmation', async () => {
    const run = fakeBrowserRun({ confirmRisky: true });
    run.browser.targets.set('#menu', { tag: 'button', label: 'Menu', role: null });
    expect(await call(run, click, { selector: '#menu', reason: 'open the menu' })).toBe('ok');
    const off = fakeBrowserRun({ confirmRisky: false });
    off.browser.targets.set('#pay', { tag: 'button', label: 'Pay now', role: null });
    expect(await call(off, click, { selector: '#pay', reason: 'pay' })).toBe('ok');
    expect(off.browser.actions).toEqual([{ type: 'click', selector: '#pay' }]);
  });
});

describe('look, request_human, finish, observe_elements and type_handoff_secret', () => {
  it('look takes the screenshot next round: it ends the chunk, or says screenshots are off', async () => {
    const run = fakeBrowserRun();
    expect(await call(run, look, { screen: 'desktop', reason: 'a dialog' })).toBe('Looking; the screenshot comes with the next turn.');
    expect(run.ctx.state.stop).toBe('look');
    expect(run.ctx.memory.look).toBe('desktop');
    const off = fakeBrowserRun({ memory: { visionOff: true } });
    expect(await call(off, look, { screen: 'page', reason: 'x' })).toMatch(/^Screenshots are not available/);
    expect(off.store.rows()).toEqual([]);
  });

  it('request_human gives the model the validation message, attaches the gate the server stopped, and opens the question', async () => {
    const run = fakeBrowserRun({ memory: { gatePending: { category: 'payment', label: 'Pay now', host: 'shop.example.test' } } });
    const args = { kind: 'confirmation', prompt: 'Pay 10 USD at the shop?', input: 'confirm', choices: null, options: null, constraints: null, confirm_label: null, deny_label: null, risk: null, remember_label: null, topic: null };
    expect(await call(run, requestHuman, { ...args, prompt: '' })).toMatch(/^Invalid request_human: prompt: required\. Fix it and call request_human again\.$/);
    expect(await call(run, requestHuman, args)).toBe('Waiting for the person.');
    expect(run.questions.opened).toMatchObject([{ kind: 'confirmation', prompt: 'Pay 10 USD at the shop?', gate: { host: 'shop.example.test', category: 'payment', label: 'Pay now' } }]);
    expect(run.ctx.memory.gatePending).toBeNull();
    expect(run.ctx.memory.askedPrompt).toBe('Pay 10 USD at the shop?');
    expect(run.ctx.state).toMatchObject({ stop: 'pause', handoffId: 'handoff-1' });
    expect(run.store.rows()).toMatchObject([{ kind: 'handoff', ok: true, summary: 'asked a person (confirmation): Pay 10 USD at the shop?' }]);
  });

  it('finish ends the run with its result', async () => {
    const run = fakeBrowserRun();
    expect(await call(run, finish, { success: true, result: 'Booked.' })).toBe('Finished.');
    expect(run.ctx.state).toMatchObject({ stop: 'finish', finished: { success: true, result: 'Booked.' } });
    expect(run.store.rows()).toMatchObject([{ kind: 'finish', ok: true, summary: 'Booked.' }]);
  });

  it('observe_elements lists the elements, remembers their labels for the gate and records what it saw', async () => {
    const run = fakeBrowserRun();
    run.browser.results.set('elements', { elements: [{ selector: '#buy', tag: 'button', text: 'Place order' }] });
    expect(await call(run, observeElements, {})).toBe('[{"selector":"#buy","tag":"button","text":"Place order"}]');
    expect(run.ctx.ext.state.labels.get('#buy')).toMatchObject({ label: 'Place order', tag: 'button' });
    expect(run.store.rows()).toMatchObject([{ action: 'elements', summary: '1 interactive elements' }]);
  });

  it('type_handoff_secret types the answer once, intent-recorded first, and never stores or shows it', async () => {
    const run = fakeBrowserRun();
    expect(await call(run, typeHandoffSecret, { selector: '#otp', submit: true, parameter: null })).toBe('No secret is available: call request_human with input "secret" first.');
    run.ctx.memory.secretHandoffId = 'handoff-9';
    expect(await call(run, typeHandoffSecret, { selector: '#otp', submit: true, parameter: null })).toBe('Typed the secret.');
    expect(run.browser.actions).toEqual([{ type: 'type_secret', handoff_id: 'handoff-9', selector: '#otp' }]);
    expect(run.store.rows()).toMatchObject([{ seq: 1, action: 'type', phase: 'done', ok: true, summary: 'typed the secret', args: { selector: '#otp', submit: true } }]);
    expect(run.ctx.memory.secretHandoffId).toBeNull();
    expect(await call(run, typeHandoffSecret, { selector: '#otp', submit: true, parameter: null })).toMatch(/^No secret is available/);
  });
});

describe('the browser toolset as offered to the model', () => {
  it('lists the tools in the order the model has always seen them, ending with finish', () => {
    expect([...browserTools.core.map((t) => t.name), browserTools.typeSecret.name, browserTools.finish.name]).toEqual([
      'observe_elements', 'read_text', 'navigate', 'click', 'type_text', 'press_key', 'scroll', 'wait_for', 'go_back', 'look', 'click_mark', 'click_at', 'hover_at', 'drag', 'scroll_at',
      'type_keys', 'key', 'run_javascript', 'tabs', 'switch_tab', 'new_tab', 'desktop_click', 'desktop_type', 'desktop_key', 'desktop_scroll', 'desktop_drag', 'request_human', 'type_handoff_secret', 'finish',
    ]);
    expect(browserTools.core.filter((t) => t.group === 'desktop')).toHaveLength(5);
    expect(browserTools.typeSecret.commits).toBe(true);
  });
});
