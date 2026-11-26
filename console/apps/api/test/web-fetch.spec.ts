// web_fetch in the host (E50.6, #976), against the in-process fake web: the binding of `WebFetchPort` (HTML, plain text, JSON, PDF,
// truncation, redirects, every error code), every SSRF case refused before a byte reaches the target, the headers that leave (no cookie,
// no Authorization, no referrer), Stop, the run's allowed sites through the tool's own context, the cache, the extraction and the
// challenge markers. No network.
import { GatePipeline } from '@marinoscar/hexactra-agent';
import { executeTool } from '@marinoscar/hexactra-agent/engine';
import { WebToolError, isWebToolError, webFetch, type WebFetchPort, type WebSites } from '@marinoscar/hexactra-web-agent';
import { fakeSites, fakeWebRun } from '@marinoscar/hexactra-web-agent/testing';
import type { HostResolver } from '@marinoscar/platform-api/core';

import { PinnedOutboundHttp } from '../src/oauth-client/outbound-http';
import { CHALLENGE_MARKERS, challengeOf } from '../src/web-search/fetch/challenge';
import { classify, cleanTitle, extractHtml, extractPdf, PDF_MAX_PAGES } from '../src/web-search/fetch/extract';
import { FetchCache } from '../src/web-search/fetch/fetch-cache';
import { fetchOutcomeOf } from '../src/web-search/fetch/web-fetch.metrics';
import { hopRefusal, WEB_FETCH_ACCEPT, WebFetchService } from '../src/web-search/fetch/web-fetch.service';
import { FAKE_PUBLIC_ADDRESS, FakeWeb } from '../src/web-search/testing/fake-web';
import type { WebSearchService } from '../src/web-search/web-search.service';
import { mergeWebSearchSystemSettings, resolveWebSearchSystemSettings, type WebSearchSystemSettings } from '../src/web-search/web-search.settings';
import { tinyPdf } from './helpers/tiny-pdf';

const USER = 'u-alice';
const signal = () => new AbortController().signal;

function service(settings: WebSearchSystemSettings = {}, http: FakeWeb | PinnedOutboundHttp = new FakeWeb()) {
  const current = { value: settings };
  const webSearch = { system: async () => resolveWebSearchSystemSettings(current.value) } as unknown as WebSearchService;
  const calls: { key: string; attrs: unknown }[] = [];
  const metrics = { add: (key: string, _n: number, attrs: unknown) => calls.push({ key, attrs }), record: () => undefined };
  const svc = new WebFetchService(http as never, webSearch, metrics as never);
  return { svc, web: http as FakeWeb, current, metrics: calls };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'none';
  } catch (e) {
    expect(isWebToolError(e)).toBe(true);
    expect((e as Error).message).toBe((e as WebToolError).code);
    return (e as WebToolError).code;
  }
}

const read = (svc: WebFetchService, url: string, sites: WebSites | null = null, maxChars = 12_000) => svc.fetch(USER, { url, maxChars, signal: signal() }, sites);

const ARTICLE = `<!doctype html><html><head><title>  The   widget guide </title><style>body{color:red}</style><script>alert('x')</script></head>
<body>
  <header><a href="/">Home</a> | <a href="/shop">Shop</a></header>
  <nav><ul><li><a href="/a">Nav A</a></li></ul></nav>
  <main>
    <h1>Widgets</h1>
    <p>Widgets are <b>small</b> &amp; useful. See <a href="/specs?id=1">the specs</a>.</p>
    <h2>Kinds</h2>
    <ul><li>Round</li><li>Square <a href="https://other.example.test/sq">square page</a></li></ul>
    <div hidden>Hidden text</div>
    <div style="display: none">Invisible text</div>
    <span aria-hidden="true">Decor</span>
    <form><input value="secret"><button>Send</button></form>
    <script>document.write('injected')</script>
    <noscript>Enable JS</noscript>
    <p><a href="javascript:alert(1)">Bad link</a> and <a href="#top">Top</a></p>
    <pre>line one
  line two</pre>
  </main>
  <aside>Related ads</aside>
  <footer>Copyright</footer>
</body></html>`;

describe('extraction', () => {
  it('reads the main content: headings and list items as lines, links as text (url), scripts, styles, navigation, forms and hidden elements dropped', () => {
    const { title, text } = extractHtml(ARTICLE, 'https://docs.example.test/guide');
    expect(title).toBe('The widget guide');
    expect(text).toBe(
      [
        'Widgets',
        '',
        'Widgets are small & useful. See the specs (https://docs.example.test/specs?id=1).',
        '',
        'Kinds',
        '',
        '- Round',
        '- Square square page (https://other.example.test/sq)',
        '',
        'Bad link and Top',
        '',
        'line one',
        '  line two',
      ].join('\n'),
    );
    for (const gone of ['alert', 'color:red', 'Home', 'Nav A', 'Hidden text', 'Invisible text', 'Decor', 'secret', 'Send', 'injected', 'Enable JS', 'Related ads', 'Copyright']) expect(text).not.toContain(gone);
  });

  it('falls back to the one article, then the body, and the title to the first heading; caps the title at 200 characters', () => {
    expect(extractHtml('<body><nav>menu</nav><article><h1>Only</h1><p>Body text.</p></article><p>outside</p></body>', 'https://a.example.test/').text).toBe('Only\n\nBody text.');
    const body = extractHtml('<body><h1>Head line</h1><p>One.</p><p>Two.</p></body>', 'https://a.example.test/');
    expect(body).toEqual({ title: 'Head line', text: 'Head line\n\nOne.\n\nTwo.' });
    expect(extractHtml(`<title>${'t'.repeat(500)}</title><p>x</p>`, 'https://a.example.test/').title).toHaveLength(200);
    expect(cleanTitle(`a${String.fromCharCode(0x200b)}b${String.fromCharCode(7)}c`)).toBe('a b c');
    expect(cleanTitle('   ')).toBeNull();
  });

  it('classifies by media type, else by the first bytes', () => {
    expect(classify('text/html', Buffer.from(''))).toBe('html');
    expect(classify('application/xhtml+xml', Buffer.from(''))).toBe('html');
    expect(classify('text/plain', Buffer.from(''))).toBe('text');
    expect(classify('application/ld+json', Buffer.from(''))).toBe('json');
    expect(classify('application/pdf', Buffer.from(''))).toBe('pdf');
    expect(classify('', Buffer.from('%PDF-1.4'))).toBe('pdf');
    expect(classify('', Buffer.from('<!DOCTYPE html><p>x'))).toBe('html');
    expect(classify('image/png', Buffer.from('<html>'))).toBe('other');
  });

  it('reads the text of the first 50 pages of a PDF and its title', async () => {
    const one = await extractPdf(tinyPdf(['Hello from page one.', 'And page two.'], 'A report'), signal());
    expect(one.title).toBe('A report');
    expect(one.pages).toBe(2);
    expect(one.text).toContain('Hello from page one.');
    expect(one.text).toContain('And page two.');
    const many = await extractPdf(
      tinyPdf(Array.from({ length: 55 }, (_, i) => `Page number ${i + 1}.`)),
      signal(),
    );
    expect(many.text).toContain(`Page number ${PDF_MAX_PAGES}.`);
    expect(many.text).not.toContain(`Page number ${PDF_MAX_PAGES + 1}.`);
    expect(many.text).toContain('(Only the first 50 of 55 pages were read.)');
    expect(await codeOf(extractPdf(Buffer.from('%PDF-1.4 not really a pdf'), signal()))).toBe('UNSUPPORTED_TYPE');
  });

  it('Stop ends the PDF worker at once', async () => {
    const stop = new AbortController();
    const p = extractPdf(tinyPdf(Array.from({ length: 50 }, (_, i) => `Page ${i}.`)), stop.signal);
    stop.abort();
    const started = Date.now();
    expect(await codeOf(p)).toBe('ABORTED');
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('challenge pages', () => {
  it.each(CHALLENGE_MARKERS.map((m) => [m.service, m.marker]))('%s: %s', async (service, marker) => {
    expect(challengeOf(`<html><head>${marker.toUpperCase()}</head></html>`)).toBe(service);
    const { svc, web } = serviceWithPage(`<html><head>${marker}</head><body>Checking your browser</body></html>`);
    expect(await codeOf(read(svc, 'https://docs.example.test/p'))).toBe('BLOCKED');
    expect(web.requests).toHaveLength(1);
  });

  it('an ordinary page with a contact form\'s reCAPTCHA is not a challenge', () => {
    expect(challengeOf('<html><body><div class="g-recaptcha"></div><p>Contact us</p></body></html>')).toBeNull();
  });

  it('a 503 that is a challenge page is BLOCKED; a plain 503 is UNAVAILABLE', async () => {
    const { svc, web } = service();
    web.page('https://docs.example.test/cf', { status: 503, headers: { 'content-type': 'text/html' }, body: '<title>Just a moment...</title>' });
    web.page('https://docs.example.test/down', { status: 503, headers: { 'content-type': 'text/html' }, body: '<p>Down for maintenance</p>' });
    expect(await codeOf(read(svc, 'https://docs.example.test/cf'))).toBe('BLOCKED');
    expect(await codeOf(read(svc, 'https://docs.example.test/down'))).toBe('UNAVAILABLE');
  });
});

function serviceWithPage(html: string) {
  const s = service();
  s.web.html('https://docs.example.test/p', html);
  return s;
}

describe('the binding: pages', () => {
  it('reads an HTML page: title, text, the final address, the media type', async () => {
    const { svc, web, metrics } = service();
    web.html('https://docs.example.test/guide', ARTICLE);
    const page = await read(svc, 'https://docs.example.test/guide');
    expect(page).toMatchObject({ finalUrl: 'https://docs.example.test/guide', title: 'The widget guide', truncated: false, contentType: 'text/html' });
    expect(page.text.startsWith('Widgets\n\nWidgets are small & useful.')).toBe(true);
    expect(metrics).toEqual([{ key: 'webFetchCalls', attrs: { outcome: 'ok' } }]);
  });

  it('decodes the charset the header or a meta names', async () => {
    const { svc, web } = service();
    web.page('https://docs.example.test/latin', { headers: { 'content-type': 'text/html' }, body: Buffer.concat([Buffer.from('<meta charset="iso-8859-1"><p>caf'), Buffer.from([0xe9]), Buffer.from('</p>')]) });
    web.page('https://docs.example.test/plain', { headers: { 'content-type': 'text/plain; charset=windows-1252' }, body: Buffer.from([0x93, 0x68, 0x69, 0x94]) });
    expect((await read(svc, 'https://docs.example.test/latin')).text).toBe('café');
    expect((await read(svc, 'https://docs.example.test/plain')).text).toBe('“hi”');
  });

  it('reads plain text and JSON as they are, cleaned of control and invisible characters', async () => {
    const { svc, web } = service();
    web.page('https://docs.example.test/notes.txt', { headers: { 'content-type': 'text/plain' }, body: `Line one${String.fromCharCode(0)}\r\nLine${String.fromCharCode(0x200b)}two` });
    web.page('https://api.example.test/data', { headers: { 'content-type': 'application/json' }, body: '{"a": [1, 2], "b": "x"}' });
    expect(await read(svc, 'https://docs.example.test/notes.txt')).toEqual({ finalUrl: 'https://docs.example.test/notes.txt', title: null, text: 'Line one\nLine two', truncated: false, contentType: 'text/plain' });
    expect(await read(svc, 'https://api.example.test/data')).toMatchObject({ text: '{"a": [1, 2], "b": "x"}', contentType: 'application/json' });
  });

  it('reads a PDF', async () => {
    const { svc, web } = service();
    web.page('https://docs.example.test/r.pdf', { headers: { 'content-type': 'application/pdf' }, body: tinyPdf(['Quarterly numbers.'], 'Q3') });
    expect(await read(svc, 'https://docs.example.test/r.pdf')).toMatchObject({ title: 'Q3', text: 'Quarterly numbers.', contentType: 'application/pdf' });
  });

  it('cuts the text at maxChars and says so', async () => {
    const { svc, web } = service();
    web.page('https://docs.example.test/long', { headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(3_000) });
    expect(await read(svc, 'https://docs.example.test/long', null, 1_000)).toMatchObject({ text: 'x'.repeat(1_000), truncated: true });
    web.page('https://docs.example.test/huge', { headers: { 'content-type': 'text/plain' }, body: 'y'.repeat(80_000) });
    const huge = await read(svc, 'https://docs.example.test/huge', null, 100_000);
    expect(huge.text).toHaveLength(50_000);
    expect(huge.truncated).toBe(true);
  });

  it('refuses another type: UNSUPPORTED_TYPE', async () => {
    const { svc, web, metrics } = service();
    web.page('https://docs.example.test/logo.png', { headers: { 'content-type': 'image/png' }, body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    expect(await codeOf(read(svc, 'https://docs.example.test/logo.png'))).toBe('UNSUPPORTED_TYPE');
    expect(metrics.at(-1)).toEqual({ key: 'webFetchCalls', attrs: { outcome: 'unsupported' } });
  });

  it('gives each error code', async () => {
    const { svc, web } = service();
    web.page('https://docs.example.test/401', { status: 401 });
    web.page('https://docs.example.test/403', { status: 403, headers: { 'content-type': 'text/html' }, body: '<p>Forbidden</p>' });
    web.page('https://docs.example.test/429', { status: 429 });
    web.page('https://docs.example.test/500', { status: 500 });
    web.page('https://docs.example.test/big', { headers: { 'content-type': 'text/plain' }, body: Buffer.alloc(5 * 1024 * 1024 + 1, 0x61) });
    web.resolve('gone.example.test', []);
    expect(await codeOf(read(svc, 'https://docs.example.test/401'))).toBe('BLOCKED');
    expect(await codeOf(read(svc, 'https://docs.example.test/403'))).toBe('BLOCKED');
    expect(await codeOf(read(svc, 'https://docs.example.test/429'))).toBe('BLOCKED');
    expect(await codeOf(read(svc, 'https://docs.example.test/missing'))).toBe('UNAVAILABLE');
    expect(await codeOf(read(svc, 'https://docs.example.test/500'))).toBe('UNAVAILABLE');
    expect(await codeOf(read(svc, 'https://docs.example.test/big'))).toBe('TOO_LARGE');
    expect(await codeOf(read(svc, 'https://gone.example.test/'))).toBe('UNAVAILABLE');
    expect(web.requests.find((r) => r.url.endsWith('/big'))!.maxBytes).toBe(5 * 1024 * 1024);
  });

  it('ends a slow server at the deadline: UNAVAILABLE', async () => {
    const { svc, web } = service();
    svc.deadlineMs = 200;
    web.page('https://docs.example.test/slow', { delayMs: 5_000, headers: { 'content-type': 'text/plain' }, body: 'late' });
    const started = Date.now();
    expect(await codeOf(read(svc, 'https://docs.example.test/slow'))).toBe('UNAVAILABLE');
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(web.requests[0]!.timeoutMs).toBeLessThanOrEqual(200);
  });

  it('Stop cancels a slow read within one second: ABORTED, not counted', async () => {
    const { svc, web, metrics } = service();
    web.page('https://docs.example.test/slow', { delayMs: 10_000, headers: { 'content-type': 'text/plain' }, body: 'late' });
    const stop = new AbortController();
    const started = Date.now();
    const p = svc.fetch(USER, { url: 'https://docs.example.test/slow', maxChars: 12_000, signal: stop.signal }, null);
    setTimeout(() => stop.abort(), 100);
    expect(await codeOf(p)).toBe('ABORTED');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(metrics).toEqual([]);
  });

  it('Stop during a lookup that never answers still ends the call at once', async () => {
    const web = new FakeWeb();
    const hang: HostResolver = { resolveAll: () => new Promise(() => undefined) };
    (web as unknown as { resolver: HostResolver }).resolver.resolveAll = hang.resolveAll;
    const { svc } = service({}, web);
    const stop = new AbortController();
    const p = svc.fetch(USER, { url: 'https://docs.example.test/', maxChars: 12_000, signal: stop.signal }, null);
    setTimeout(() => stop.abort(), 50);
    const started = Date.now();
    expect(await codeOf(p)).toBe('ABORTED');
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('the binding: redirects', () => {
  it('follows up to 5 redirects itself, relative ones included, and refuses a sixth', async () => {
    const { svc, web } = service();
    web.redirect('https://a.example.test/1', '/2', 301);
    web.redirect('https://a.example.test/2', 'https://b.example.test/3', 302);
    web.redirect('https://b.example.test/3', '4', 303);
    web.redirect('https://b.example.test/4', 'https://c.example.test/5', 307);
    web.redirect('https://c.example.test/5', 'https://c.example.test/6', 308);
    web.html('https://c.example.test/6', '<title>End</title><p>Arrived.</p>');
    expect(await read(svc, 'https://a.example.test/1')).toMatchObject({ finalUrl: 'https://c.example.test/6', title: 'End', text: 'Arrived.' });
    expect(web.requests.map((r) => r.url)).toEqual(['https://a.example.test/1', 'https://a.example.test/2', 'https://b.example.test/3', 'https://b.example.test/4', 'https://c.example.test/5', 'https://c.example.test/6']);

    const loop = service();
    for (let i = 0; i < 7; i++) loop.web.redirect(`https://a.example.test/${i}`, `https://a.example.test/${i + 1}`);
    loop.web.html('https://a.example.test/7', '<p>never</p>');
    expect(await codeOf(read(loop.svc, 'https://a.example.test/0'))).toBe('BLOCKED');
    expect(loop.web.requests).toHaveLength(6);
  });

  it('a redirect without a Location is UNAVAILABLE', async () => {
    const { svc, web } = service();
    web.page('https://a.example.test/r', { status: 302 });
    expect(await codeOf(read(svc, 'https://a.example.test/r'))).toBe('UNAVAILABLE');
  });

  it('a redirect that leaves the run\'s allowed sites is NOT_ALLOWED, and nothing is sent to it', async () => {
    const { svc, web, metrics } = service();
    web.redirect('https://docs.example.test/out', 'https://evil.example.test/collect');
    web.html('https://evil.example.test/collect', '<p>x</p>');
    expect(await codeOf(read(svc, 'https://docs.example.test/out', fakeSites(['docs.example.test'])))).toBe('NOT_ALLOWED');
    expect(web.requestsTo('evil.example.test')).toEqual([]);
    expect(metrics.at(-1)).toEqual({ key: 'webFetchCalls', attrs: { outcome: 'not_allowed' } });
    expect(await codeOf(read(svc, 'https://evil.example.test/collect', fakeSites(['docs.example.test'])))).toBe('NOT_ALLOWED');
  });

  it('an administrator\'s blocked host is BLOCKED at any hop', async () => {
    const { svc, web } = service({ fetch: { blockedHosts: ['*.tracker.example.test', 'bad.example.test'] } });
    web.redirect('https://docs.example.test/r', 'https://x.tracker.example.test/');
    expect(await codeOf(read(svc, 'https://bad.example.test/'))).toBe('BLOCKED');
    expect(await codeOf(read(svc, 'https://docs.example.test/r'))).toBe('BLOCKED');
    expect(web.requestsTo('x.tracker.example.test')).toEqual([]);
    expect(web.requestsTo('bad.example.test')).toEqual([]);
  });
});

describe('SSRF: refused before a byte is sent to the target', () => {
  const PRIVATE_TARGETS: [string, string][] = [
    ['a private address', 'https://10.0.0.5/admin'],
    ['another private range', 'https://192.168.1.1/'],
    ['localhost', 'https://localhost/'],
    ['a localhost subdomain', 'https://app.localhost/'],
    ['the IPv4 loopback', 'https://127.0.0.1/'],
    ['the IPv6 loopback', 'https://[::1]/'],
    ['an IPv4-mapped IPv6 loopback', 'https://[::ffff:127.0.0.1]/'],
    ['the cloud metadata address', 'https://169.254.169.254/latest/meta-data/'],
    ['carrier-grade NAT', 'https://100.64.0.1/'],
    ['a decimal-encoded loopback', 'https://2130706433/'],
    ['a single-label internal name', 'https://intranet/'],
  ];

  it.each(PRIVATE_TARGETS)('%s', async (_label, url) => {
    const { svc, web } = service();
    expect(await codeOf(read(svc, url))).toBe('BLOCKED');
    expect(web.requests).toEqual([]);
  });

  it.each(PRIVATE_TARGETS)('a redirect to %s', async (_label, url) => {
    const { svc, web } = service();
    web.redirect('https://docs.example.test/r', url);
    expect(await codeOf(read(svc, 'https://docs.example.test/r'))).toBe('BLOCKED');
    expect(web.requests.map((r) => r.url)).toEqual(['https://docs.example.test/r']);
  });

  it('a public name that resolves to a private, loopback or metadata address (and a redirect to it)', async () => {
    for (const address of ['10.1.2.3', '127.0.0.1', '::1', '169.254.169.254', 'fd00:ec2::254']) {
      const { svc, web } = service();
      web.resolve('inside.example.test', [address]);
      web.redirect('https://docs.example.test/r', 'https://inside.example.test/');
      expect(await codeOf(read(svc, 'https://inside.example.test/'))).toBe('BLOCKED');
      expect(await codeOf(read(svc, 'https://docs.example.test/r'))).toBe('BLOCKED');
      expect(web.requestsTo('inside.example.test')).toEqual([]);
    }
  });

  it('a name with one public and one private answer is refused (every address is checked)', async () => {
    const { svc, web } = service();
    web.resolve('mixed.example.test', [FAKE_PUBLIC_ADDRESS, '10.0.0.1']);
    expect(await codeOf(read(svc, 'https://mixed.example.test/'))).toBe('BLOCKED');
    expect(web.requests).toEqual([]);
  });

  it('rebinding: public on the first lookup, private on the second; the connection goes to the address checked, and the second read is refused', async () => {
    const { svc, web } = service();
    web.resolve('rebind.example.test', [FAKE_PUBLIC_ADDRESS], ['127.0.0.1']);
    web.html('https://rebind.example.test/', '<p>first</p>');
    web.html('https://rebind.example.test/again', '<p>second</p>');
    expect((await read(svc, 'https://rebind.example.test/')).text).toBe('first');
    expect(await codeOf(read(svc, 'https://rebind.example.test/again'))).toBe('BLOCKED');
    expect(web.requests.map((r) => [r.url, r.address])).toEqual([['https://rebind.example.test/', FAKE_PUBLIC_ADDRESS]]);
    expect(web.lookups).toEqual(['rebind.example.test', 'rebind.example.test']);
  });

  it('a URL with a user name or password, a non-standard port, plain http', async () => {
    const { svc, web } = service();
    for (const url of ['https://user:pass@docs.example.test/', 'https://user@docs.example.test/', 'https://docs.example.test:8080/', 'https://docs.example.test:22/', 'http://docs.example.test/', 'ftp://docs.example.test/']) {
      expect(await codeOf(read(svc, url))).toBe('BLOCKED');
      web.redirect('https://docs.example.test/r', url);
      expect(await codeOf(read(svc, 'https://docs.example.test/r'))).toBe('BLOCKED');
      svc.cache.clear();
    }
    expect(web.requests.every((r) => r.url === 'https://docs.example.test/r')).toBe(true);
    expect(web.lookups.every((h) => h === 'docs.example.test')).toBe(true);
    web.html('https://docs.example.test:8443/ok', '<p>ok</p>');
    expect((await read(svc, 'https://docs.example.test:8443/ok')).text).toBe('ok');
  });

  it('the production transport refuses a private target too, with the development conveniences on', async () => {
    const resolver: HostResolver = { resolveAll: async (h) => (h === 'inside.example.test' ? [{ address: '10.9.9.9', family: 4 }] : [{ address: '169.254.169.254', family: 4 }]) };
    const { svc } = service({}, new PinnedOutboundHttp(resolver));
    expect(await codeOf(read(svc, 'https://inside.example.test/'))).toBe('BLOCKED');
    expect(await codeOf(read(svc, 'https://metadata.example.test/'))).toBe('BLOCKED');
    // OutboundHttp lets a loopback name through outside production; web_fetch never does.
    expect(await codeOf(read(svc, 'https://localhost/'))).toBe('BLOCKED');
    expect(await codeOf(read(svc, 'https://127.0.0.1:443/'))).toBe('BLOCKED');
  });

  it('hopRefusal names the code', () => {
    expect(hopRefusal('https://docs.example.test/', [], null)).toBeNull();
    expect(hopRefusal('https://docs.example.test/', [], fakeSites(['other.example.test']))).toBe('NOT_ALLOWED');
    expect(hopRefusal('https://10.0.0.1/', [], fakeSites(['other.example.test']))).toBe('BLOCKED');
    expect(hopRefusal('not a url', [], null)).toBe('BLOCKED');
    expect(hopRefusal('https://printer.local/', [], null)).toBe('BLOCKED');
    expect(hopRefusal('https://metadata.google.internal/', [], null)).toBe('BLOCKED');
  });
});

describe('what leaves', () => {
  it('a fixed User-Agent naming Hexactra and its version, the Accept list, and no cookie, Authorization or referrer, also after a Set-Cookie', async () => {
    const { svc, web } = service();
    web.html('https://docs.example.test/a', '<p>a</p>', { 'set-cookie': 'sid=abc; Path=/' });
    web.redirect('https://docs.example.test/b', 'https://docs.example.test/c');
    web.html('https://docs.example.test/c', '<p>c</p>', { 'set-cookie': 'sid=def' });
    await read(svc, 'https://docs.example.test/a');
    await read(svc, 'https://docs.example.test/b');
    expect(web.requests).toHaveLength(3);
    for (const r of web.requests) {
      const names = Object.keys(r.headers).map((h) => h.toLowerCase());
      expect(names.sort()).toEqual(['accept', 'accept-encoding', 'user-agent']);
      expect(r.headers.accept).toBe(WEB_FETCH_ACCEPT);
      expect(r.headers['user-agent']).toMatch(/^Hexactra\/\d+\.\d+\.\d+ \(web_fetch; \+https:\/\/github\.com\/marinoscar\/hexactra\)$/);
      expect(r.headers['user-agent']).not.toMatch(/@|alice/i);
    }
  });
});

describe('the port of a run', () => {
  it('is null when the administrator switched web_fetch off, and refuses NOT_CONFIGURED once switched off mid-run', async () => {
    expect(await service({ fetch: { enabled: false } }).svc.forRun({ userId: USER, sites: null })).toBeNull();
    const { svc, web, current } = service();
    web.html('https://docs.example.test/', '<p>x</p>');
    const port = (await svc.forRun({ userId: USER, sites: null }))!;
    current.value = { fetch: { enabled: false } };
    expect(await codeOf(port.fetch({ url: 'https://docs.example.test/', maxChars: 1_000, signal: signal() }))).toBe('NOT_CONFIGURED');
  });

  it('counts its reads against limits.fetchPerRun', async () => {
    const { svc, web } = service({ limits: { fetchPerRun: 2 } });
    web.html('https://docs.example.test/', '<p>x</p>');
    const port = (await svc.forRun({ userId: USER, sites: null }))!;
    const go = () => port.fetch({ url: 'https://docs.example.test/', maxChars: 1_000, signal: signal() });
    await go();
    await go();
    expect(await codeOf(go())).toBe('LIMIT_REACHED');
    const other = (await svc.forRun({ userId: USER, sites: null }))!;
    await expect(other.fetch({ url: 'https://docs.example.test/', maxChars: 1_000, signal: signal() })).resolves.toMatchObject({ text: 'x' });
  });

  it('through the web_fetch tool and the sites of its own context: a redirect off the list is refused, and the page never reaches the model', async () => {
    const { svc, web } = service();
    web.redirect('https://docs.example.test/out', 'https://evil.example.test/');
    web.html('https://evil.example.test/', '<p>EVIL TEXT</p>');
    web.html('https://docs.example.test/in', '<title>In</title><p>Inside text.</p>');
    const run = fakeWebRun({ allowedHosts: ['docs.example.test'] });
    const ext = run.ctx.ext.web!;
    (ext as { fetch: WebFetchPort | null }).fetch = (await svc.forRun({ userId: USER, sites: ext.sites }))!;
    const call = (url: string) => executeTool(run.ctx, webFetch as never, { url, max_chars: null }, new GatePipeline(run.gates as never) as never);
    const refused = await call('https://docs.example.test/out');
    expect(refused).toBe('Refused: that site is not allowed for this task (docs.example.test).');
    expect(web.requestsTo('evil.example.test')).toEqual([]);
    const ok = await call('https://docs.example.test/in');
    expect(ok).toContain('In — https://docs.example.test/in');
    expect(ok).toContain('Inside text.');
  });
});

describe('the cache', () => {
  it('reads a page once in 10 minutes, per user, keyed by the final address', async () => {
    const { svc, web } = service();
    web.redirect('https://docs.example.test/old', 'https://docs.example.test/new');
    web.html('https://docs.example.test/new', '<p>cached</p>');
    await read(svc, 'https://docs.example.test/old');
    await read(svc, 'https://docs.example.test/old');
    await read(svc, 'https://docs.example.test/new');
    expect(web.requests).toHaveLength(2);
    await svc.fetch('u-bob', { url: 'https://docs.example.test/new', maxChars: 1_000, signal: signal() }, null);
    expect(web.requests).toHaveLength(3);
  });

  it('a hit is checked again against the current run\'s sites, at every hop that led to it', async () => {
    const { svc, web } = service();
    web.redirect('https://docs.example.test/old', 'https://cdn.example.test/new');
    web.html('https://cdn.example.test/new', '<p>cached</p>');
    await read(svc, 'https://docs.example.test/old');
    expect(await codeOf(read(svc, 'https://docs.example.test/old', fakeSites(['docs.example.test'])))).toBe('NOT_ALLOWED');
    expect(web.requests).toHaveLength(2);
  });

  it('expires after 10 minutes and keeps at most 50 entries a user', () => {
    let now = 0;
    const cache = new FetchCache(10 * 60_000, 50, () => now);
    const page = (n: number) => ({ hops: [`https://a.example.test/${n}`], finalUrl: `https://a.example.test/${n}`, title: null, text: 't', cut: false, contentType: 'text/plain' });
    cache.put(USER, page(0));
    now = 10 * 60_000 + 1;
    expect(cache.get(USER, 'https://a.example.test/0')).toBeNull();
    for (let i = 1; i <= 60; i++) cache.put(USER, page(i));
    expect(cache.size(USER)).toBe(50);
    expect(cache.get(USER, 'https://a.example.test/1')).toBeNull();
    expect(cache.get(USER, 'https://a.example.test/60')).not.toBeNull();
    expect(cache.get('u-bob', 'https://a.example.test/60')).toBeNull();
  });
});

describe('settings and metrics', () => {
  it('defaults: web_fetch on, no blocked host, 30 reads a run; a patch keeps what it leaves out', () => {
    expect(resolveWebSearchSystemSettings(null)).toMatchObject({ limits: { fetchPerRun: 30 }, fetch: { enabled: true, blockedHosts: [] } });
    let s = mergeWebSearchSystemSettings(undefined, { fetch: { blockedHosts: ['*.example.test', '*.example.test'] } });
    s = mergeWebSearchSystemSettings(s, { fetch: { enabled: false }, limits: { fetchPerRun: null } });
    expect(resolveWebSearchSystemSettings(s)).toMatchObject({ limits: { perRun: 30, fetchPerRun: null }, fetch: { enabled: false, blockedHosts: ['*.example.test'] } });
  });

  it('maps every code to a bounded outcome', () => {
    expect(['BLOCKED', 'NOT_ALLOWED', 'TOO_LARGE', 'UNSUPPORTED_TYPE', 'UNAVAILABLE', 'RATE_LIMITED'].map(fetchOutcomeOf)).toEqual(['blocked', 'not_allowed', 'too_large', 'unsupported', 'unavailable', 'unavailable']);
    expect(fetchOutcomeOf(null)).toBe('ok');
  });
});
