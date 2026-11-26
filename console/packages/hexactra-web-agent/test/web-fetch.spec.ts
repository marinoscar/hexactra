// web_fetch alone, against the fakes (E50.4): through `executeTool` and the web site gate. No network, no loop.
import { GatePipeline, STOPPED_TEXT } from '@marinoscar/hexactra-agent';
import { executeTool } from '@marinoscar/hexactra-agent/engine';
import { WEB_TOOL_ERROR_CODES } from '../src/ports';
import { PAGE_OPEN, WEB_CLOSE, WEB_SENTENCES } from '../src/results';
import { fakeWebRun } from '../src/testing';
import { webFetch } from '../src/tools/web-fetch';

type Run = ReturnType<typeof fakeWebRun>;
const call = (run: Run, args: unknown) => executeTool(run.ctx, webFetch as never, args, new GatePipeline(run.gates as never) as never);
const NUL = String.fromCharCode(0);
const ZWSP = String.fromCharCode(0x200b);

describe('web_fetch: what it is', () => {
  it('has the exact description and a strict schema', () => {
    expect(webFetch.name).toBe('web_fetch');
    expect(webFetch.family).toBe('web');
    expect(webFetch.description).toBe('Read a public web page as text, without the browser. It cannot sign in, run scripts, click or fill a form. If a page needs any of that, open it in the browser.');
    const p = webFetch.parameters;
    expect(p.safeParse({ url: 'https://a.example.test/', max_chars: null }).success).toBe(true);
    expect(p.safeParse({ url: 'https://a.example.test/' }).success).toBe(false);
    expect(p.safeParse({ url: 'https://a.example.test/', max_chars: 999 }).success).toBe(false);
    expect(p.safeParse({ url: 'https://a.example.test/', max_chars: 50_001 }).success).toBe(false);
    expect(Object.keys(webFetch.gated ?? {})).toEqual(['web_site']);
  });
});

describe('web_fetch: a page', () => {
  it('returns the title, the final address and the text inside the wrapper; the step names host and path only', async () => {
    const run = fakeWebRun();
    run.fetch.pages.set('https://docs.example.test/guide?token=abc#top', { title: '<i>The</i> guide', text: `Para one.${NUL}\r\n\r\n\r\n\r\nPara ${ZWSP}two.` });
    const text = await call(run, { url: 'https://docs.example.test/guide?token=abc#top', max_chars: null });
    expect(text).toBe([PAGE_OPEN, 'The guide — https://docs.example.test/guide?token=abc#top', 'Para one.\n\nPara  two.', WEB_CLOSE].join('\n'));
    expect(run.fetch.calls).toEqual([{ url: 'https://docs.example.test/guide?token=abc#top', maxChars: 12_000 }]);
    const [row] = run.store.rows();
    expect(row).toMatchObject({ action: 'web_fetch', ok: true, summary: 'read docs.example.test/guide', args: { url: 'https://docs.example.test/guide (query removed)', max_chars: null } });
    expect(row!.summary).not.toContain('token');
    expect(JSON.stringify(row)).not.toContain('Para one');
  });

  it('says where the text was cut, and caps max_chars at the run limit', async () => {
    const run = fakeWebRun({ limits: { maxFetchChars: 2_000 } });
    run.fetch.pages.set('https://docs.example.test/long', { title: null, text: 'x'.repeat(5_000) });
    const text = await call(run, { url: 'https://docs.example.test/long', max_chars: 40_000 });
    expect(run.fetch.calls[0]!.maxChars).toBe(2_000);
    const lines = text.split('\n');
    expect(lines[1]).toBe('(no title) — https://docs.example.test/long');
    expect(lines[2]!.length).toBe(2_000);
    expect(lines[3]).toBe('(cut at 2000 characters)');
  });

  it('follows the port\'s redirects and shows the final address', async () => {
    const run = fakeWebRun();
    run.fetch.redirects.set('https://a.example.test/old', 'https://a.example.test/new');
    run.fetch.pages.set('https://a.example.test/new', { title: 'New', text: 'Moved here.' });
    expect((await call(run, { url: 'https://a.example.test/old', max_chars: null })).split('\n')[1]).toBe('New — https://a.example.test/new');
  });
});

describe('web_fetch: refusals', () => {
  it('refuses http, a non-web address and an address that holds secret material, and sends nothing', async () => {
    const run = fakeWebRun();
    expect(await call(run, { url: 'http://a.example.test/', max_chars: null })).toBe(WEB_SENTENCES.notHttps);
    expect(await call(run, { url: 'ftp://a.example.test/', max_chars: null })).toBe(WEB_SENTENCES.notHttps);
    expect(await call(run, { url: 'not a url', max_chars: null })).toBe(WEB_SENTENCES.notAUrl);
    expect(await call(run, { url: 'https://a.example.test/reset?key=sk-abcdefghijklmnop', max_chars: null })).toBe(WEB_SENTENCES.sensitiveUrl);
    expect(run.fetch.calls).toEqual([]);
    expect(JSON.stringify(run.store.rows())).not.toContain('abcdefghijklmnop');
    expect(run.store.rows().map((r) => r.summary)).toEqual(['refused: only https addresses are read', 'refused: only https addresses are read', 'refused: not a web address', 'refused: the address looks like it holds secret material']);
  });

  it('refuses an address outside the allowed sites with the browser site gate\'s words and records the refusal', async () => {
    const run = fakeWebRun({ allowedHosts: ['shop.example.test'] });
    expect(await call(run, { url: 'https://elsewhere.example.test/', max_chars: null })).toBe('Refused: that site is not allowed for this task (shop.example.test).');
    expect(run.fetch.calls).toEqual([]);
    expect(run.store.rows()).toMatchObject([{ action: 'web_fetch', ok: false, summary: 'refused by policy: site not allowed', args: { url: 'https://elsewhere.example.test/' } }]);
    run.fetch.pages.set('https://shop.example.test/item', { title: 'Item', text: 'ok' });
    expect(await call(run, { url: 'https://shop.example.test/item', max_chars: null })).toContain('Item — https://shop.example.test/item');
  });

  it('refuses a page whose final address left the allowed sites, and shows none of it', async () => {
    const run = fakeWebRun({ allowedHosts: ['shop.example.test'] });
    run.fetch.redirects.set('https://shop.example.test/out', 'https://evil.example.test/landing');
    run.fetch.pages.set('https://evil.example.test/landing', { title: 'Evil', text: 'secret plans' });
    const text = await call(run, { url: 'https://shop.example.test/out', max_chars: null });
    expect(text).toBe('Refused: that site is not allowed for this task (shop.example.test).');
    expect(run.store.rows()).toMatchObject([{ ok: false, summary: 'read shop.example.test/out: refused by policy: redirected to a site not allowed' }]);
  });
});

describe('web_fetch: errors and Stop', () => {
  const unreadable = 'That page could not be read this way. Open it in the browser.';
  const expected: Record<string, string> = {
    NOT_CONFIGURED: WEB_SENTENCES.fetchNotConfigured,
    AUTH_REFUSED: WEB_SENTENCES.fetchUnavailable,
    RATE_LIMITED: WEB_SENTENCES.fetchUnavailable,
    QUOTA_EXCEEDED: WEB_SENTENCES.fetchUnavailable,
    UNAVAILABLE: WEB_SENTENCES.fetchUnavailable,
    BLOCKED: unreadable,
    UNSUPPORTED_TYPE: unreadable,
    TOO_LARGE: unreadable,
    NOT_ALLOWED: 'Refused: that site is not allowed for this task (a.example.test).',
    LIMIT_REACHED: WEB_SENTENCES.fetchLimit,
    ABORTED: WEB_SENTENCES.fetchStopped,
  };

  it.each([...WEB_TOOL_ERROR_CODES])('%s becomes one fixed sentence and a failed step', async (code) => {
    const run = fakeWebRun({ allowedHosts: ['a.example.test'] });
    run.fetch.failNext(code);
    expect(await call(run, { url: 'https://a.example.test/p?q=1', max_chars: null })).toBe(expected[code]);
    expect(run.store.rows()).toMatchObject([{ action: 'web_fetch', ok: false, summary: `read a.example.test/p: failed (${code})` }]);
  });

  it('Stop before the call: the port is not called', async () => {
    const run = fakeWebRun();
    run.stop.requested = true;
    expect(await call(run, { url: 'https://a.example.test/', max_chars: null })).toBe(STOPPED_TEXT);
    expect(run.fetch.calls).toEqual([]);
  });

  it('Stop while the page is read: the wait is cut off and the run is stopped', async () => {
    const run = fakeWebRun();
    run.fetch.latencyMs = 10_000;
    run.fetch.pages.set('https://a.example.test/', { title: 'A', text: 'a' });
    const pending = call(run, { url: 'https://a.example.test/', max_chars: null });
    await new Promise((r) => setTimeout(r, 10));
    run.stop.stop();
    expect(await pending).toBe(STOPPED_TEXT);
    expect(run.ctx.state.stop).toBe('cancel');
  });
});
