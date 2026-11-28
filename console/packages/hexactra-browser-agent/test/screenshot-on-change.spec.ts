// A smaller round (E54.3, #1084): with the policy's `screenshotWhen: 'on_change'`, a round whose page has not changed since the last picture
// sends no new image, keeps the page facts for the stall detector, and says so in the log. Absent (every built-in): every round, as before.
import { observeRound, UNCHANGED_NOTE } from '../src/round';
import { fakeBrowserRun } from '../src/testing';

describe('every round (the default)', () => {
  it('takes a picture each round and never reads the page check for it', async () => {
    const run = fakeBrowserRun();
    run.browser.digests = ['aaaa0001'];
    await observeRound(run.ctx);
    const o = await observeRound(run.ctx);
    expect(run.browser.captures).toBe(2);
    expect(run.browser.digestReads).toBe(0);
    expect(o.images.length).toBeGreaterThan(0);
  });
});

describe('on_change', () => {
  const onChange = () => fakeBrowserRun({ policy: { screenshotWhen: 'on_change' } });

  it('sends no new image for an unchanged page, with the same page facts, and says so', async () => {
    const run = onChange();
    run.browser.digests = ['aaaa0001'];
    const first = await observeRound(run.ctx);
    const second = await observeRound(run.ctx);
    expect(run.browser.captures).toBe(1);
    expect(second.images).toEqual([]);
    expect(second.page).toEqual(first.page);
    expect(run.ctx.memory.log.at(-1)).toBe(UNCHANGED_NOTE);
  });

  it('takes a new picture when the page changed', async () => {
    const run = onChange();
    run.browser.digests = ['aaaa0001', 'bbbb0002'];
    await observeRound(run.ctx);
    const second = await observeRound(run.ctx);
    expect(run.browser.captures).toBe(2);
    expect(second.images.length).toBeGreaterThan(0);
  });

  it('always takes one when the model asked to look, or when the page cannot be checked', async () => {
    const run = onChange();
    run.browser.digests = ['aaaa0001'];
    await observeRound(run.ctx);
    run.ctx.memory.look = 'page';
    await observeRound(run.ctx);
    expect(run.browser.captures).toBe(2);
    const blind = onChange();
    await observeRound(blind.ctx);
    await observeRound(blind.ctx);
    expect(blind.browser.captures).toBe(2);
  });
});
