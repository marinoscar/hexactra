// The browser toolset's tools and gates, each alone, against a fake context and a fake browser (E38.5, #586): no database, no fabric, no loop.
import { GatePipeline } from '@marinoscar/hexactra-agent';
import { executeTool } from '@marinoscar/hexactra-agent/engine';
import { fakeBrowserRun } from '../src/testing';
import { browserTools } from '../src/tools';
import { finish } from '../src/tools/finish';
import { navigate, newTab } from '../src/tools/navigate';
import { click } from '../src/tools/click';
import { look } from '../src/tools/look';
import { saveScreenshot } from '../src/tools/save-screenshot';
import { requestHuman } from '../src/tools/request-human';
import { answerLine } from '../src/request-human-spec';
import { typeHandoffSecret } from '../src/tools/type-secret';
import { observeElements } from '../src/tools/observe';
import { pressKey, typeText } from '../src/tools/type';
import { digestScript } from '../src/page';

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

describe('click: how the extension clicked (E52.1, #1016)', () => {
  it('reads a real mouse click, and a result from an older extension without a method, as before', async () => {
    const run = fakeBrowserRun();
    run.browser.results.set('click', { method: 'pointer', x: 120, y: 40, disabled: false });
    expect(await call(run, click, { selector: '#send', reason: 'send' })).toBe('ok');
    run.browser.results.set('click', {});
    expect(await call(run, click, { selector: '#send', reason: 'send' })).toBe('ok');
    expect(run.store.rows().map((r) => r.summary)).toEqual(['done', 'done']);
  });

  it('tells the model and the owner when it clicked by script, and when the element is disabled', async () => {
    const run = fakeBrowserRun();
    run.browser.results.set('click', { method: 'synthetic', why: 'covered', disabled: false });
    expect(await call(run, click, { selector: '#send', reason: 'send' })).toBe(
      'ok (clicked by script because the element is covered or off screen; the page may ignore that. If nothing changed, use click_mark or click_at.)',
    );
    run.browser.results.set('click', { method: 'pointer', x: 1, y: 1, disabled: true });
    expect(await call(run, click, { selector: '#send', reason: 'send' })).toBe('ok. The element is disabled.');
    expect(run.store.rows().map((r) => r.summary)).toEqual(['done (clicked by script: the element could not be reached with the mouse)', 'done. The element is disabled.']);
    expect(run.store.rows().every((r) => r.ok)).toBe(true);
  });
});

describe('press_key: how the extension pressed (E52.12, #1030)', () => {
  it('reads a real key press and an older result as before, and says when the key was pressed by script', async () => {
    const run = fakeBrowserRun();
    run.browser.results.set('press', { method: 'keys' });
    expect(await call(run, pressKey, { key: 'Enter' })).toBe('ok');
    run.browser.results.set('press', {});
    expect(await call(run, pressKey, { key: 'Enter' })).toBe('ok');
    run.browser.results.set('press', { method: 'synthetic' });
    expect(await call(run, pressKey, { key: 'Enter' })).toBe('ok (pressed by script, because the debugger was not available; the page may ignore it. If nothing changed, click the control instead.)');
    expect(run.store.rows().map((r) => r.summary)).toEqual(['done', 'done', 'done (pressed by script: the page may ignore it)']);
  });

  it('says when type_text submitted by script, and reads a real Enter as before', async () => {
    const run = fakeBrowserRun();
    run.browser.results.set('type', { submitted: 'keys' });
    expect(await call(run, typeText, { selector: '#msg', text: 'See you at 7', submit: true })).toBe('ok');
    run.browser.results.set('type', { submitted: 'synthetic' });
    expect(await call(run, typeText, { selector: '#msg', text: 'See you at 7', submit: true })).toMatch(/^ok, typed; the Enter that submits was sent by script/);
    expect(run.store.rows().map((r) => r.summary)).toEqual(['done', 'typed; submitted by script (the page may ignore it)']);
  });
});

describe('a click or key press that changes nothing says so (E52.3, #1018)', () => {
  const NO_CHANGE = 'ok, but nothing changed on the page after this (it may have been ignored, or the change is inside a frame or a drawing this check cannot see). Do not repeat it blindly: look at the page, then try click_mark or click_at at the element, or the keyboard.';

  it('reports a click after which the page digest never changed, in one step that stays ok', async () => {
    const run = fakeBrowserRun();
    run.browser.digests = ['aaaa0001'];
    expect(await call(run, click, { selector: '#send', reason: 'send' })).toBe(NO_CHANGE);
    expect(run.store.rows()).toMatchObject([{ action: 'click', ok: true, summary: 'done; no change seen on the page' }]);
    // Once before, then the four reads after.
    expect(run.browser.digestReads).toBe(5);
    expect(run.browser.actions.filter((a) => a.type === 'evaluate')).toEqual([]);
  });

  it('stops reading at the first change, and reads as before', async () => {
    const run = fakeBrowserRun();
    run.browser.digests = ['aaaa0001', 'aaaa0001', 'bbbb0002'];
    expect(await call(run, click, { selector: '#send', reason: 'send' })).toBe('ok');
    expect(run.browser.digestReads).toBe(3);
    expect(run.store.rows()).toMatchObject([{ summary: 'done' }]);
  });

  it('does not poll when the page could not be asked before, and a page that cannot be asked after is "changed"', async () => {
    const run = fakeBrowserRun();
    expect(await call(run, click, { selector: '#send', reason: 'send' })).toBe('ok');
    expect(run.browser.digestReads).toBe(1);
    const gone = fakeBrowserRun();
    gone.browser.digests = ['aaaa0001', null];
    expect(await call(gone, click, { selector: '#send', reason: 'send' })).toBe('ok');
    expect(gone.browser.digestReads).toBe(2);
  });

  it('does not read after a failed action', async () => {
    const run = fakeBrowserRun();
    run.browser.digests = ['aaaa0001'];
    run.browser.failNext = { state: 'failed', error: 'no element matches #send' };
    expect(await call(run, click, { selector: '#send', reason: 'send' })).toBe('Failed (failed): no element matches #send');
    expect(run.browser.digestReads).toBe(1);
  });

  it('stops reading at once when the owner presses Stop while it waits, and claims nothing', async () => {
    const run = fakeBrowserRun();
    run.browser.digests = ['aaaa0001'];
    const act = run.browser.act.bind(run.browser);
    run.browser.act = async (a: Record<string, unknown>) => {
      const op = await act(a);
      // Stop lands right after the first read that follows the click.
      if (run.browser.digestReads === 2) run.control.requested = true;
      return op;
    };
    expect(await call(run, click, { selector: '#send', reason: 'send' })).toBe('ok');
    expect(run.browser.digestReads).toBe(2);
  });

  it('covers press_key too', async () => {
    const run = fakeBrowserRun();
    run.browser.digests = ['aaaa0001'];
    expect(await call(run, pressKey, { key: 'Enter' })).toBe(NO_CHANGE);
    expect(run.store.rows()).toMatchObject([{ action: 'press', ok: true, summary: 'done; no change seen on the page' }]);
  });

  it('a commit-class click that changed nothing is recorded once, its intent closed, and is not sent again', async () => {
    const run = fakeBrowserRun({ confirmRisky: true, memory: { confirmedTarget: { category: 'payment', label: 'Pay now', host: 'shop.example.test' } } });
    run.browser.targets.set('#pay', { tag: 'button', label: 'Pay now', role: null });
    run.browser.digests = ['aaaa0001'];
    expect(await call(run, click, { selector: '#pay', reason: 'pay' })).toBe(NO_CHANGE);
    expect(run.browser.actions.filter((a) => a.type === 'click')).toEqual([{ type: 'click', selector: '#pay' }]);
    expect(run.store.rows()).toMatchObject([{ seq: 1, action: 'click', phase: 'done', ok: true, summary: 'done; no change seen on the page' }]);
  });

  it('the digest script returns only a hash: no page text or field value leaves the page', () => {
    const script = digestScript();
    expect(script.startsWith('/* hexactra:page-digest */')).toBe(true);
    expect(script).toMatch(/return \{ h: /);
    expect(script).not.toMatch(/return \{[^}]*text/);
    // Fields are hashed by length only.
    expect(script).toContain('add(String(v == null ? \'\' : v).length)');
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

  // #924: a code on the screen is scanned from the owner's phone; the source travels, the picture and the address are the server's.
  it('request_human asks for a scan with its source, or refuses a desktop scan the machine cannot serve', async () => {
    const args = { kind: 'passkey', prompt: 'Scan the passkey code with your phone', input: 'scan', choices: null, options: null, constraints: null, confirm_label: null, deny_label: null, risk: null, remember_label: null, topic: null, scan_source: 'desktop' };
    const run = fakeBrowserRun();
    expect(await call(run, requestHuman, args)).toBe('Waiting for the person.');
    expect(run.questions.opened).toMatchObject([{ input: 'scan', kind: 'passkey', scanSource: 'desktop' }]);
    expect(run.questions.scanChecks).toEqual(['desktop']);
    expect(await call(fakeBrowserRun(), requestHuman, { ...args, kind: 'login', scan_source: null })).toBe('Waiting for the person.');

    const noBluetooth = fakeBrowserRun();
    noBluetooth.questions.scanRefusal = 'This computer has no Bluetooth: ask for a takeover (kind passkey) instead.';
    expect(await call(noBluetooth, requestHuman, args)).toBe('This computer has no Bluetooth: ask for a takeover (kind passkey) instead.');
    expect(noBluetooth.questions.opened).toEqual([]);
    expect(noBluetooth.ctx.state.stop).not.toBe('pause');
    expect(answerLine({ input: 'scan', kind: 'passkey', options: null, unit: null })).toMatch(/^The person scanned the code .* pressed Done\. Check the page and continue/);
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

describe('a code split into boxes (E49.2, #959)', () => {
  const withSecret = () => {
    const run = fakeBrowserRun();
    run.ctx.memory.secretHandoffId = 'handoff-9';
    return run;
  };

  it('type_handoff_secret says how many boxes the fabric filled, and records it', async () => {
    const run = withSecret();
    run.browser.secretOp = { state: 'succeeded', result: { boxes: 6, filled: 6, method: 'keys' } };
    expect(await call(run, typeHandoffSecret, { selector: '#txtCode1', submit: false, parameter: null })).toBe('Typed the secret into 6 code boxes.');
    expect(run.store.rows()).toMatchObject([{ action: 'type', ok: true, summary: 'typed the secret into 6 code boxes' }]);
  });

  it('type_handoff_secret says when the page moved on after the last character', async () => {
    const run = withSecret();
    run.browser.secretOp = { state: 'succeeded', result: { gone: true } };
    expect(await call(run, typeHandoffSecret, { selector: '#txtCode1', submit: false, parameter: null })).toBe('Typed the secret; the page moved on after the last character.');
  });

  it('a code the boxes refused says to look at the page before asking for a new one', async () => {
    const run = withSecret();
    run.browser.secretOp = { state: 'failed', error: 'the code field has 6 boxes and took 1 of 6 characters' };
    expect(await call(run, typeHandoffSecret, { selector: '#txtCode1', submit: false, parameter: null })).toBe(
      'Failed: the code field has 6 boxes and took 1 of 6 characters. Look at the page: ask the person for a new code only if the page says this one was wrong or has expired.',
    );
    // Any other failure reads as before.
    const other = withSecret();
    other.browser.secretOp = { state: 'failed', error: 'no element matches #x' };
    expect(await call(other, typeHandoffSecret, { selector: '#x', submit: false, parameter: null })).toBe('Failed: no element matches #x');
  });

  it('type_text reports code boxes too, and a plain field still reads "ok"', async () => {
    const run = fakeBrowserRun();
    expect(await call(run, typeText, { selector: '#q', text: 'shoes', submit: false })).toBe('ok');
    run.browser.results.set('type', { boxes: 4, filled: 4, method: 'boxes' });
    expect(await call(run, typeText, { selector: '#c1', text: 'AB12', submit: false })).toBe('typed into 4 code boxes');
    expect(run.store.rows().map((r) => r.summary)).toEqual(['done', 'typed into 4 code boxes']);
  });

  it('the tools and the instructions tell the model to pass the first box and never read a typed field back', () => {
    expect(typeHandoffSecret.description).toMatch(/pass the first box/);
    expect(typeText.description).toMatch(/pass the first box/);
  });
});

describe('the browser toolset as offered to the model', () => {
  it('lists the tools in the order the model has always seen them, ending with finish', () => {
    expect([...browserTools.core.map((t) => t.name), browserTools.typeSecret.name, browserTools.finish.name]).toEqual([
      'observe_elements', 'read_text', 'navigate', 'click', 'type_text', 'press_key', 'scroll', 'wait_for', 'go_back', 'look', 'save_screenshot', 'click_mark', 'click_at', 'hover_at', 'drag', 'scroll_at',
      'type_keys', 'key', 'run_javascript', 'tabs', 'switch_tab', 'new_tab', 'desktop_click', 'desktop_type', 'desktop_key', 'desktop_scroll', 'desktop_drag', 'request_human', 'type_handoff_secret', 'finish',
    ]);
    expect(browserTools.core.filter((t) => t.group === 'desktop')).toHaveLength(5);
    expect(browserTools.typeSecret.commits).toBe(true);
  });
});

describe('tool families (E41.2)', () => {
  it('every tool of the toolset names its family', () => {
    const all = [...browserTools.core, browserTools.typeSecret, browserTools.finish];
    expect(all.filter((t) => !t.family).map((t) => t.name)).toEqual([]);
    const byFamily = (f: string) => all.filter((t) => t.family === f).map((t) => t.name);
    expect(byFamily('human')).toEqual(['request_human']);
    expect(byFamily('control')).toEqual(['finish']);
    expect(byFamily('desktop')).toEqual(['desktop_click', 'desktop_type', 'desktop_key', 'desktop_scroll', 'desktop_drag']);
  });
});

describe('save_screenshot (E41.4)', () => {
  const withPictures = (run: Run, picture: { shot?: unknown; note?: string }) => {
    const attached: { seq: number; moment: string }[] = [];
    const moments: string[] = [];
    (run.ctx.ports as { pictures?: unknown }).pictures = {
      capture: async (moment: string) => (moments.push(moment), picture),
      attach: async (seq: number, moment: string) => void attached.push({ seq, moment }),
    };
    return { attached, moments };
  };

  it('keeps a masked picture at moment "saved" on its own step and returns the step number', async () => {
    const run = fakeBrowserRun();
    const p = withPictures(run, { shot: { bytes: 'x' } });
    const out = await call(run, saveScreenshot, { reason: 'for the email' });
    const seq = run.store.rows().at(-1)!.seq;
    expect(out).toBe(`Saved as the screenshot of step ${seq}.`);
    expect(p.moments).toEqual(['saved']);
    expect(p.attached).toEqual([{ seq, moment: 'saved' }]);
    expect(run.store.rows().at(-1)).toMatchObject({ kind: 'action', action: 'save_screenshot', ok: true });
  });

  it('says why when there is no store, and takes no picture while a secret waits to be typed', async () => {
    const run = fakeBrowserRun();
    withPictures(run, { note: 'no_storage' });
    expect(await call(run, saveScreenshot, { reason: null })).toBe('Screenshots are not stored on this deployment, so there is nothing to attach.');
    expect(run.store.rows().at(-1)).toMatchObject({ action: 'save_screenshot', ok: false });
    const secret = fakeBrowserRun();
    const p = withPictures(secret, { shot: { bytes: 'x' } });
    secret.ctx.memory.secretHandoffId = 'h-1';
    expect(await call(secret, saveScreenshot, { reason: null })).toMatch(/A secret is being asked for/);
    expect(p.moments).toEqual([]);
  });
});
