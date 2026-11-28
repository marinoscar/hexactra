// What changed, with each action's result (E54.2, #1083). Off by default: the page check's script and every text are as before. With the
// policy's `actionResults: 'delta'`, a click or key press that changed the page says where the page is now, from the same check (no extra
// call), and the round can name the open tabs.
import { GatePipeline } from '@marinoscar/hexactra-agent';
import { executeTool } from '@marinoscar/hexactra-agent/engine';

import { digestScript, placeNote, tabsLine } from '../src/page';
import { fakeBrowserRun } from '../src/testing';
import { click } from '../src/tools/click';

type Run = ReturnType<typeof fakeBrowserRun>;
const call = (run: Run, tool: unknown, args: unknown) => executeTool(run.ctx, tool as never, args, new GatePipeline(run.gates as never) as never);

describe('off (the default)', () => {
  it('sends the page check exactly as before and adds nothing to a click', async () => {
    expect(digestScript()).toBe(digestScript(false));
    expect(digestScript()).not.toContain('location.href.slice');
    const run = fakeBrowserRun();
    run.browser.digests = ['aaaa0001', 'bbbb0002'];
    expect(await call(run, click, { selector: '#go', reason: 'go' })).toBe('ok');
  });
});

describe('delta', () => {
  const delta = () => fakeBrowserRun({ policy: { actionResults: 'delta' } });

  it('says where the page is after a click that changed it, from the same check', async () => {
    const run = delta();
    run.browser.url = 'https://shop.example.test/results';
    run.browser.snapshot.title = 'Results';
    run.browser.digests = ['aaaa0001', 'bbbb0002'];
    expect(await call(run, click, { selector: '#go', reason: 'go' })).toBe('ok Now at https://shop.example.test/results — "Results".');
    // One check before and one after: no extra read for the place.
    expect(run.browser.digestReads).toBe(2);
  });

  it('names an open dialog', async () => {
    const run = delta();
    run.browser.dialogs = 1;
    run.browser.digests = ['aaaa0001', 'bbbb0002'];
    expect(await call(run, click, { selector: '#go', reason: 'go' })).toMatch(/; a dialog is open\.$/);
  });

  it('adds nothing when the page did not change, or could not be asked after', async () => {
    const same = delta();
    same.browser.digests = ['aaaa0001'];
    expect(await call(same, click, { selector: '#go', reason: 'go' })).toMatch(/^ok, but nothing changed on the page/);
    const gone = delta();
    gone.browser.digests = ['aaaa0001', null];
    expect(await call(gone, click, { selector: '#go', reason: 'go' })).toBe('ok');
  });

  it('quotes a long title short and the address as the browser reports it', () => {
    expect(placeNote({ url: 'https://a.example.test/x', title: 'T'.repeat(200), dialogs: 0 })).toBe(` Now at https://a.example.test/x — "${'T'.repeat(120)}…".`);
    expect(placeNote({ url: 'https://a.example.test/x', title: '', dialogs: 2 })).toBe(' Now at https://a.example.test/x; a dialog is open.');
  });
});

describe('the tabs line', () => {
  it('names the open tabs and the active one, and says nothing for a single tab', async () => {
    const run = fakeBrowserRun({ policy: { actionResults: 'delta' } });
    expect(await tabsLine(run.ctx)).toBeNull();
    run.browser.results.set('tabs', { tabs: [{ id: 1, active: false, url: 'https://a.example.test/', title: 'A' }, { id: 2, active: true, url: 'https://b.example.test/pay', title: 'Pay' }] });
    expect(await tabsLine(run.ctx)).toBe('Tabs: 2 open; active: "Pay" at https://b.example.test/pay. switch_tab changes it; you do not need tabs to find out.');
  });
});
