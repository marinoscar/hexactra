#!/usr/bin/env node
// End-to-end test of remote browser control (#177).
//
// Starts the real stack and drives a real Chromium through the CLI:
//
//   hexactra CLI / hexactra-mcp -> hexactra-control -> hexactra-agent -> native host
//     -> Hexactra extension in Chromium -> fixture page
//
// Requirements:
//   - built binaries in target/debug (or HEXACTRA_BIN_DIR):
//       hexactra, hexactra-control, hexactra-agent, hexactra-native-host, hexactra-mcp
//   - built extension in apps/chrome-extension/dist
//   - a Chromium that honours --load-extension (Chromium or Chrome for
//     Testing; branded Google Chrome does not), path in CHROMIUM_PATH
//   - a display: run under xvfb-run on headless machines
//
// Usage: CHROMIUM_PATH=/path/to/chrome xvfb-run -a node tests/e2e/remote-control.e2e.mjs

import { spawn, spawnSync, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const binDir = process.env.HEXACTRA_BIN_DIR ?? join(root, 'target', 'debug');
const extensionDir = join(root, 'apps', 'chrome-extension', 'dist');
const fixtureDir = join(root, 'tests', 'e2e', 'remote-fixture');
const chromium = process.env.CHROMIUM_PATH;
const keep = process.env.HEXACTRA_E2E_KEEP === '1';

for (const b of ['hexactra-fabric', 'hexactra-control', 'hexactra-agent', 'hexactra-native-host', 'hexactra-mcp']) {
  if (!existsSync(join(binDir, b))) throw new Error(`missing binary ${join(binDir, b)}; run cargo build first`);
}
if (!existsSync(join(extensionDir, 'manifest.json'))) throw new Error('extension not built; run pnpm build');
if (!chromium || !existsSync(chromium)) throw new Error('set CHROMIUM_PATH to a Chromium binary');

const work = mkdtempSync(join(tmpdir(), 'hexactra-e2e-'));
const token = 'e2e-token-' + Math.random().toString(16).slice(2).padEnd(24, '0');
const socket = join(work, 'run', 'bridge.sock');
const userDataDir = join(work, 'chrome-profile');
const work_dir_profiles = join(work, 'launch-profiles');
// --- OTLP/JSON collector (#215): control and agents export here ------------
const otlp = { spans: [], raw: [] };
const collector = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    otlp.raw.push(body);
    try {
      const j = JSON.parse(body);
      for (const rs of j.resourceSpans ?? []) {
        const svc = (rs.resource?.attributes ?? []).find((a) => a.key === 'service.name')?.value?.stringValue;
        for (const ss of rs.scopeSpans ?? []) {
          for (const sp of ss.spans ?? []) otlp.spans.push({ svc, traceId: sp.traceId, name: sp.name });
        }
      }
    } catch {
      // metrics or an unparsable body: kept in raw only
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
});
await new Promise((r) => collector.listen(0, '127.0.0.1', r));

const env = {
  ...process.env,
  OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.address().port}`,
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
  OTEL_BSP_SCHEDULE_DELAY: '200',
  OTEL_METRIC_EXPORT_INTERVAL: '1000',
  HEXACTRA_API_TOKEN: token,
  HEXACTRA_BRIDGE_SOCKET: socket,
  XDG_CONFIG_HOME: join(work, 'config'),
  RUST_LOG: 'info',
};
const children = [];
const logs = {};

function start(name, cmd, args, extraEnv = {}) {
  const child = spawn(cmd, args, { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  logs[name] = '';
  const append = (d) => {
    logs[name] += d.toString();
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  children.push(child);
  return child;
}

function stop(child) {
  if (child.exitCode === null) child.kill('SIGTERM');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- fixture site ----------------------------------------------------------
const fixture = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const file = join(fixtureDir, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
  if (!file.startsWith(fixtureDir) || !existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': extname(file) === '.html' ? 'text/html' : 'text/plain' });
  res.end(readFileSync(file));
});
await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${fixture.address().port}`;

// --- CLI helper ------------------------------------------------------------
const controlPort = 20000 + Math.floor(Math.random() * 20000);
const controlUrl = `http://127.0.0.1:${controlPort}`;

// Async on purpose: the fixture server runs in this process, so blocking the
// event loop (spawnSync) would stop it from serving the browser.
function cli(...args) {
  return new Promise((resolve) => {
    execFile(
      join(binDir, 'hexactra-fabric'),
      ['--url', controlUrl, ...args],
      { env, encoding: 'utf8', timeout: 60_000 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, out: stdout ?? '', err: stderr ?? '' });
      },
    );
  });
}

async function ok(...args) {
  const r = await cli(...args);
  assert.equal(r.code, 0, `hexactra-fabric ${args.join(' ')} failed:\n${r.err}${r.out}`);
  return r.out;
}

async function until(what, fn, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}


// Minimal MCP stdio client.
function mcpClient(extraEnv = {}) {
  const proc = spawn(join(binDir, 'hexactra-mcp'), [], {
    env: { ...env, HEXACTRA_URL: controlUrl, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(proc);
  let buf = '';
  const pending = new Map();
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  let nextId = 1;
  const rpc = (method, params, timeoutMs = 60_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const t = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), timeoutMs);
      pending.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const call = async (name, args, timeoutMs) => (await rpc('tools/call', { name, arguments: args }, timeoutMs)).result;
  return { proc, rpc, call };
}

// A webhook receiver playing the person's channel (chat bot, automation):
// verifies Standard Webhooks signatures and answers handoffs from the payload.
// With `auto: false` it only records events; the test answers with the
// response token each `handoff.created` event carries.
async function startChannel({ auto = true } = {}) {
  const state = { secret: null, events: [], badSignatures: 0 };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const key = Buffer.from((state.secret ?? '').replace(/^whsec_/, ''), 'base64');
      const signed = `${req.headers['webhook-id']}.${req.headers['webhook-timestamp']}.${raw}`;
      const expected = 'v1,' + crypto.createHmac('sha256', key).update(signed).digest('base64');
      if (req.headers['webhook-signature'] !== expected) {
        state.badSignatures += 1;
        res.writeHead(401).end();
        return;
      }
      res.writeHead(204).end();
      const event = JSON.parse(raw);
      state.events.push(event);
      if (!auto || event.type !== 'handoff.created') return;
      const h = event.data.handoff;
      const answer = { channel: 'e2e-channel', response_token: event.data.respond.token };
      if (h.input === 'secret') answer.value = '424242';
      if (h.input === 'text') answer.value = 'from the channel';
      if (h.input === 'choice') answer.value = h.choices[0].id;
      // A person takes a moment to answer.
      const delay = h.kind === 'captcha' ? 2_000 : 300;
      setTimeout(() => {
        fetch(event.data.respond.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(answer),
        }).catch(() => undefined);
      }, delay);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  state.url = `http://127.0.0.1:${server.address().port}/hook`;
  state.close = () => server.close();
  return state;
}

const visits = (text) => Number((/visits: (\d+)/.exec(text) ?? [])[1] ?? 0);

const results = [];
async function step(name, fn) {
  const t = Date.now();
  await fn();
  results.push(`ok   ${name} (${Date.now() - t} ms)`);
  console.log(`ok   ${name}`);
}

let failed = false;
try {
  // --- stack -----------------------------------------------------------------
  start('control', join(binDir, 'hexactra-control'), [
    'serve',
    '--bind',
    `127.0.0.1:${controlPort}`,
    '--public-url',
    controlUrl,
    // The test's webhook receiver listens on loopback over http.
    '--webhook-allow-insecure',
  ]);
  await until('control plane', () => fetch(`${controlUrl}/v1/health`).then((r) => r.ok).catch(() => false));

  const startAgent = () =>
    start('agent', join(binDir, 'hexactra-agent'), ['daemon', '--url', controlUrl, '--name', 'e2e-host']);
  let agent = startAgent();

  const install = spawnSync(
    'bash',
    [
      join(root, 'scripts', 'install-native-host.sh'),
      '--binary',
      join(binDir, 'hexactra-native-host'),
      '--user-data-dir',
      userDataDir,
      '--allow-root',
    ],
    { env, encoding: 'utf8' },
  );
  assert.equal(install.status, 0, install.stderr);

  const chromeArgs = [
    `--user-data-dir=${userDataDir}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1280,900',
  ];
  // Chromium refuses to run as root with its sandbox (containers only).
  if (process.getuid?.() === 0) chromeArgs.push('--no-sandbox');
  chromeArgs.push('about:blank');
  const attachedChromium = start('chromium', chromium, chromeArgs);

  // --- scenario --------------------------------------------------------------
  await step('extension connects through the native host to the agent', async () => {
    await until('browser connected', async () => /browser=true/.test((await cli('status')).out), 45_000);
  });

  await step('navigate opens the fixture page', async () => {
    const out = await ok('navigate', `${site}/index.html`);
    assert.match(out, /Hexactra Fixture Home/);
  });

  await step('elements lists interactive elements with selectors', async () => {
    const out = await ok('elements');
    assert.match(out, /#q/);
    assert.match(out, /#next/);
  });

  await step('type with submit fills the input and submits the form', async () => {
    await ok('type', '#q', 'hello hexactra', '--submit');
    const out = await ok('text', '--selector', '#out');
    assert.match(out, /searched: hello hexactra/);
  });

  await step('click runs page handlers', async () => {
    await ok('click', '#counter');
    await ok('click', '#counter');
    assert.match(await ok('text', '--selector', '#counter'), /Clicked 2/);
  });

  await step('scroll moves the page', async () => {
    assert.match(await ok('scroll', '--dy', '800'), /y=8\d\d/);
  });

  await step('screenshot returns a JPEG', async () => {
    const file = join(work, 'shot.jpg');
    await ok('screenshot', '-o', file);
    const bytes = readFileSync(file);
    assert.ok(bytes.length > 1000, 'screenshot too small');
    assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  });

  await step('click a link, then wait for late content', async () => {
    await ok('click', '#next');
    await ok('wait-for', '#arrived', '--wait-ms', '10000');
    assert.match(await ok('text'), /Arrived after a delay/);
  });

  await step('tabs and history work', async () => {
    assert.match(await ok('tabs'), /Hexactra Fixture Next/);
    // Chrome skips history entries created by script navigation without a
    // user gesture (the synthetic link click above), so check history across
    // browser-initiated navigations.
    await ok('navigate', `${site}/index.html`);
    await ok('navigate', `${site}/next.html`);
    await ok('back');
    assert.match(await ok('text', '--selector', 'h1'), /Fixture home/);
    await ok('forward');
    assert.match(await ok('text', '--selector', 'h1'), /Next page/);
  });

  await step('a missing element fails with a clear error', async () => {
    const r = await cli('click', '#does-not-exist');
    assert.notEqual(r.code, 0);
    assert.match(r.err, /no element matches #does-not-exist/);
  });

  await step('javascript: URLs are refused (use evaluate)', async () => {
    const r = await cli('navigate', 'javascript:alert(1)');
    assert.notEqual(r.code, 0);
    assert.match(r.err, /use the evaluate action/);
  });

  await step('full powers (#366): JavaScript, trusted input by position, marked screenshots and the desktop', async () => {
    const mcp = mcpClient();
    await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
    mcp.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const call = async (name, args) => {
      const r = await mcp.call(name, args);
      assert.equal(r.isError, false, `${name}: ${JSON.stringify(r)}`);
      return r;
    };
    const value = async (script) => JSON.parse((await call('browser_evaluate', { script })).content[0].text).value;

    // A fresh page, a listener that records whether clicks are trusted, and the button's center.
    await call('browser_navigate', { url: `${site}/index.html` });
    assert.equal(await value('document.title'), 'Hexactra Fixture Home');
    const at = await value(`scrollTo(0, 0);
      window.__trusted = [];
      document.querySelector('#counter').addEventListener('click', (e) => window.__trusted.push(e.isTrusted));
      const r = document.querySelector('#counter').getBoundingClientRect();
      ({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })`);
    assert.ok(at.x > 0 && at.y > 0, JSON.stringify(at));

    await call('browser_click_at', { x: at.x, y: at.y });
    assert.match(await value("document.querySelector('#counter').textContent"), /Clicked 1/);
    assert.deepEqual(await value('window.__trusted'), [true], 'click_at must reach the page as a trusted event');

    // Real typing at the focus, then Enter submits the form.
    await call('browser_click', { selector: '#q' });
    await call('browser_type_keys', { text: 'typed by keys' });
    await call('browser_key', { key: 'Enter' });
    assert.match(await value("document.querySelector('#out').textContent"), /searched: typed by keys/);

    // Top-level await works; a thrown error fails the call with its message.
    assert.equal(await value('await new Promise((r) => setTimeout(() => r(42), 50))'), 42);
    const thrown = await mcp.call('browser_evaluate', { script: 'nope()' });
    assert.equal(thrown.isError, true);
    assert.match(thrown.content[0].text, /nope is not defined/);

    // A marked screenshot: the image, plus the numbered marks with selectors.
    const shot = await call('browser_screenshot', { marks: true });
    assert.equal(shot.content[0].type, 'image');
    assert.match(shot.content[1].text, /marks: .*#counter/);
    // The overlay is gone afterwards.
    assert.equal(await value("document.getElementById('__hexactra_marks__')"), null);

    // The node's desktop, through the host agent (xdotool + ImageMagick on the CI display).
    const desk = await call('browser_desktop_screenshot', {});
    assert.equal(desk.content[0].type, 'image');
    assert.ok(desk.content[0].data.length > 1000);
    await call('browser_desktop_move', { x: 10, y: 10 });
    mcp.proc.stdin.end();
  });

  await step('an MCP client operates the browser through hexactra-mcp', async () => {
    const mcp = spawn(join(binDir, 'hexactra-mcp'), [], {
      env: { ...env, HEXACTRA_URL: controlUrl },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(mcp);
    let buf = '';
    const pending = new Map();
    mcp.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const msg = JSON.parse(line);
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      }
    });
    let nextId = 1;
    const rpc = (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const t = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 60_000);
        pending.set(id, (m) => {
          clearTimeout(t);
          resolve(m);
        });
        mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });

    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'hexactra');
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await rpc('tools/list', {});
    assert.ok(list.result.tools.some((t) => t.name === 'browser_navigate'));

    const nav = await rpc('tools/call', { name: 'browser_navigate', arguments: { url: `${site}/index.html` } });
    assert.equal(nav.result.isError, false, JSON.stringify(nav));
    assert.match(nav.result.content[0].text, /Hexactra Fixture Home/);

    const typed = await rpc('tools/call', { name: 'browser_type', arguments: { selector: '#q', text: 'from mcp', submit: true } });
    assert.equal(typed.result.isError, false, JSON.stringify(typed));
    const text = await rpc('tools/call', { name: 'browser_text', arguments: { selector: '#out' } });
    assert.match(text.result.content[0].text, /searched: from mcp/);

    const shot = await rpc('tools/call', { name: 'browser_screenshot', arguments: {} });
    assert.equal(shot.result.content[0].type, 'image');
    assert.equal(shot.result.content[0].mimeType, 'image/jpeg');
    assert.ok(shot.result.content[0].data.length > 1000);

    const bad = await rpc('tools/call', { name: 'browser_click', arguments: { selector: '#nope' } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /no element matches #nope/);
    mcp.stdin.end();
  });

  await step('a webhook channel answers handoffs for the CLI and an MCP agent', async () => {
    const channel = await startChannel();
    try {
      const added = JSON.parse(await ok('--json', 'webhook', 'add', channel.url, '--description', 'e2e channel'));
      channel.secret = added.secret;
      assert.match(channel.secret, /^whsec_/);

      // CLI: a choice answered by the channel.
      const out = await ok(
        'handoff', 'request', '--kind', 'confirmation', '--prompt', 'Approve the test purchase?',
        '--input', 'choice', '--choice', 'Approve', '--choice', 'Reject', '--wait', '--timeout-s', '60',
      );
      assert.match(out, /completed via e2e-channel/);
      assert.match(out, /Approve/);

      // While a handoff is open, browser actions are paused.
      const id = (await ok('handoff', 'request', '--kind', 'captcha', '--prompt', 'Solve the CAPTCHA')).trim();
      const blocked = await cli('text');
      assert.notEqual(blocked.code, 0);
      assert.match(blocked.err, /handoff_pending/);
      assert.match(await ok('handoff', 'show', id, '--wait-s', '20'), /Completed/);
      await ok('text');

      // MCP agent: asks for a one-time code and types it into the page.
      const { proc, rpc, call } = mcpClient();
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
      assert.equal((await call('browser_navigate', { url: `${site}/index.html` })).isError, false);
      const asked = await call('browser_request_human', {
        kind: 'code',
        prompt: 'Enter the verification code sent to your phone',
        input: 'secret',
        timeout_s: 60,
      }, 90_000);
      assert.equal(asked.isError, false, JSON.stringify(asked));
      // The model never sees the secret: it is withheld, and the fabric
      // types it with browser_type_secret (#287).
      assert.ok(!JSON.stringify(asked).includes('424242'), JSON.stringify(asked));
      const outcome = JSON.parse(asked.content[0].text.split('\n').find((l) => l.startsWith('{')));
      assert.equal(outcome.value_withheld, true);
      assert.equal(outcome.value, undefined);
      const typedSecret = await call('browser_type_secret', { handoff_id: outcome.handoff_id, selector: '#q', submit: true });
      assert.equal(typedSecret.isError, false, JSON.stringify(typedSecret));
      assert.ok(!JSON.stringify(typedSecret).includes('424242'));
      // The page got it; the agent only learns that by reading the page.
      assert.match((await call('browser_text', { selector: '#out' })).content[0].text, /searched: 424242/);
      const again = await call('browser_type_secret', { handoff_id: outcome.handoff_id, selector: '#q' });
      assert.equal(again.isError, true);
      assert.match(again.content[0].text, /secret_unavailable/);
      proc.stdin.end();

      // CLI: a secret answered by the channel, typed with type-secret; the
      // operation view and the handoff never carry the value.
      const waited = await ok(
        'handoff', 'request', '--kind', 'code', '--prompt', 'Enter the code', '--input', 'secret',
        '--wait', '--timeout-s', '60',
      );
      assert.ok(!waited.includes('424242'), waited);
      const secretId = (/handoff type-secret ([0-9a-f-]{36})/.exec(waited) ?? [])[1];
      assert.ok(secretId, waited);
      await ok('navigate', `${site}/index.html`);
      const typedOp = JSON.parse(await ok('--json', 'handoff', 'type-secret', secretId, '--selector', '#q', '--submit'));
      assert.equal(typedOp.state, 'succeeded');
      assert.equal(typedOp.action.type, 'type_secret');
      const auth = { headers: { authorization: `Bearer ${token}` } };
      const opView = await (await fetch(`${controlUrl}/v1/operations/${typedOp.id}`, auth)).text();
      const handoffView = await (await fetch(`${controlUrl}/v1/handoffs/${secretId}`, auth)).text();
      for (const [what, body] of [['type-secret output', JSON.stringify(typedOp)], ['operation view', opView], ['handoff view', handoffView]]) {
        assert.ok(!body.includes('424242'), `${what} leaks the secret: ${body}`);
      }
      assert.match(await ok('text', '--selector', '#out'), /searched: 424242/);

      // The handoff.created event carried the page the agent was on.
      const codeEvent = channel.events.find((e) => e.type === 'handoff.created' && e.data.handoff.kind === 'code');
      assert.equal(codeEvent.data.handoff.page.title, 'Hexactra Fixture Home');
      // The secret never travelled in an event.
      assert.ok(!JSON.stringify(channel.events).includes('424242'));
      assert.equal(channel.badSignatures, 0);
      assert.match(await ok('webhook', 'deliveries', added.webhook.id), /succeeded/);
    } finally {
      channel.close();
    }
  });

  await step('typed questions: every public type gets a typed, validated answer', async () => {
    const channel = await startChannel({ auto: false });
    try {
      const added = JSON.parse(await ok('--json', 'webhook', 'add', channel.url, '--event', 'handoff.*', '--description', 'e2e questions'));
      channel.secret = added.secret;
      await ok('navigate', `${site}/index.html`);

      // Ask through the CLI without waiting; the channel learns of it from the
      // signed handoff.created event, which carries a single-use response token.
      const ask = async (...args) => {
        const created = JSON.parse(await ok('--json', 'handoff', 'request', ...args, '--timeout-s', '60'));
        const id = created.handoff.id;
        let event;
        await until(`handoff.created for ${id}`, () => (event = channel.events.find((e) => e.type === 'handoff.created' && e.data.handoff.id === id)));
        assert.ok(event.data.respond.token && event.data.respond.url, JSON.stringify(event.data));
        return { id, created, event };
      };
      const answer = (event, body) =>
        fetch(event.data.respond.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ response_token: event.data.respond.token, channel: 'e2e-channel', ...body }),
        });
      const refused = async (event, body, why) => {
        const r = await answer(event, body);
        assert.ok(r.status >= 400 && r.status < 500, `${why}: expected a 4xx, got ${r.status} ${await r.text()}`);
      };
      const accepted = async (event, body) => {
        const r = await answer(event, body);
        assert.ok(r.ok, `answer refused: ${r.status} ${await r.text()}`);
      };
      const resolved = async (id) => {
        const h = JSON.parse(await ok('--json', 'handoff', 'show', id, '--wait-s', '20'));
        assert.equal(h.status, 'completed', JSON.stringify(h));
        return h.response;
      };

      // choice, with options that have their own ids
      const choice = await ask('--kind', 'confirmation', '--prompt', 'Which shipping speed?', '--input', 'choice', '--choice', 'std=Standard (3-5 days)', '--choice', 'exp=Express (next day)');
      assert.deepEqual(choice.event.data.handoff.choices.map((c) => c.id), ['std', 'exp']);
      await refused(choice.event, { value: 'overnight' }, 'a value that is not an option id');
      await accepted(choice.event, { value: 'exp' });
      let r = await resolved(choice.id);
      assert.equal(r.outcome, 'completed');
      assert.equal(r.value, 'exp');
      assert.equal(r.by, 'token');
      assert.equal(r.channel, 'e2e-channel');
      // First answer wins: the token is spent and the handoff is resolved.
      await refused(choice.event, { value: 'std' }, 'a second answer');
      assert.equal((await resolved(choice.id)).value, 'exp');

      // multi_choice with selection bounds
      const multi = await ask('--kind', 'other', '--prompt', 'Which reports should be attached?', '--input', 'multi-choice', '--choice', 'sales=Sales', '--choice', 'ops=Operations', '--choice', 'hr=Staffing', '--min-selections', '1', '--max-selections', '2');
      await refused(multi.event, { values: ['sales', 'ops', 'hr'] }, 'more selections than allowed');
      await refused(multi.event, { values: [] }, 'fewer selections than allowed');
      await accepted(multi.event, { values: ['sales', 'hr'] });
      r = await resolved(multi.id);
      assert.equal(r.outcome, 'completed');
      assert.deepEqual([...r.values].sort(), ['hr', 'sales']);
      assert.equal(r.value ?? null, null);
      assert.equal(r.by, 'token');

      // number with min, max and step
      const number = await ask('--kind', 'other', '--prompt', 'How many kilograms?', '--input', 'number', '--min', '1', '--max', '10', '--step', '0.5', '--unit', 'kg');
      await refused(number.event, { value: '11' }, 'above max');
      await refused(number.event, { value: '2.25' }, 'off the step');
      await refused(number.event, { value: 'two' }, 'not a number');
      await accepted(number.event, { value: '2.5' });
      r = await resolved(number.id);
      assert.equal(r.outcome, 'completed');
      assert.equal(Number(r.value), 2.5);
      assert.equal(r.by, 'token');

      // text with a pattern and a length limit
      const text = await ask('--kind', 'other', '--prompt', 'Order reference (ABC-123)?', '--input', 'text', '--pattern', '^[A-Z]{3}-[0-9]{3}$', '--max-length', '7');
      await refused(text.event, { value: 'abc-123' }, 'does not match the pattern');
      await accepted(text.event, { value: 'QRS-042' });
      r = await resolved(text.id);
      assert.equal(r.outcome, 'completed');
      assert.equal(r.value, 'QRS-042');
      assert.equal(r.by, 'token');

      // confirm, low risk, answered by the operator on behalf of a signed-in person
      const confirm = await ask('--kind', 'confirmation', '--prompt', 'Save the draft?', '--input', 'confirm', '--risk', 'low', '--confirm-label', 'Save', '--deny-label', 'Discard');
      assert.equal((await cli('handoff', 'respond', confirm.id, '--value', 'maybe')).code !== 0, true, 'confirm takes only approve or deny');
      await ok('handoff', 'respond', confirm.id, '--value', 'approve', '--answered-by', 'user:e2e-person');
      r = await resolved(confirm.id);
      assert.equal(r.outcome, 'completed');
      assert.equal(r.value, 'approve');
      assert.equal(r.by, 'user:e2e-person');

      // The channel saw each answer in a signed handoff.resolved event, typed.
      await until('handoff.resolved events', () => [choice, multi, number, text, confirm].every(({ id }) => channel.events.some((e) => e.type === 'handoff.resolved' && e.data.handoff.id === id)));
      const resolvedEvent = (id) => channel.events.find((e) => e.type === 'handoff.resolved' && e.data.handoff.id === id).data.handoff;
      assert.equal(resolvedEvent(choice.id).response.value, 'exp');
      assert.deepEqual([...resolvedEvent(multi.id).response.values].sort(), ['hr', 'sales']);
      assert.equal(resolvedEvent(confirm.id).response.by, 'user:e2e-person');
      assert.equal(channel.badSignatures, 0);
      // Browser actions resume once nothing is pending.
      await ok('text');
      await ok('webhook', 'remove', added.webhook.id);
    } finally {
      channel.close();
    }
  });

  await step('the extension reconnects after the agent restarts', async () => {
    stop(agent);
    await new Promise((r) => agent.once('exit', r));
    agent = startAgent();
    await until('browser reconnected', async () => /browser=true/.test((await cli('status')).out), 30_000);
    assert.match(await ok('navigate', `${site}/index.html`), /Hexactra Fixture Home/);
  });
  await step('launch mode: the agent starts Chromium on demand, idles it out, keeps the profile', async () => {
    // Replace the attach-mode setup with an agent that owns the browser.
    stop(agent);
    await new Promise((r) => agent.once('exit', r));
    stop(attachedChromium);
    await sleep(1_000);
    const launchProfiles = work_dir_profiles;
    const launchProfile = join(launchProfiles, 'default');
    const launchArgs = [
      'daemon', '--url', controlUrl, '--name', 'e2e-launch-host',
      '--browser', chromium,
      '--profiles-dir', launchProfiles,
      '--extension-dir', extensionDir,
      '--native-host', join(binDir, 'hexactra-native-host'),
      '--idle-shutdown-s', '4',
      '--viewer-url', 'https://viewer.example.test/vnc.html',
      '--browser-arg=--disable-gpu',
      '--browser-arg=--window-size=1280,900',
    ];
    if (process.getuid?.() === 0) launchArgs.push('--browser-arg=--no-sandbox');
    // This host enrolls with a single-use token instead of the operator token.
    const enrollment = await (
      await fetch(`${controlUrl}/v1/admin/hosts/enrollments`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'e2e-launch-host', ttl_s: 600 }),
      })
    ).json();
    assert.match(enrollment.enrollment_token, /^hxe_/);
    launchArgs.push('--enrollment-token', enrollment.enrollment_token);
    agent = start('agent', join(binDir, 'hexactra-agent'), launchArgs);
    const credFile = join(work, 'config', 'hexactra', 'host-credential.json');
    await until('host credential saved', async () => existsSync(credFile), 20_000);
    assert.equal(statSync(credFile).mode & 0o777, 0o600);
    assert.match(readFileSync(credFile, 'utf8'), /"host_token": "hxh_/);
    await until('on-demand host', async () => /on_demand=true/.test((await cli('status')).out), 30_000);
    assert.match((await cli('status')).out, /viewer=https:\/\/viewer\.example\.test/);
    const browserRunning = () =>
      spawnSync('pgrep', ['-f', `user-data-dir=${launchProfile}`]).status === 0;
    assert.equal(browserRunning(), false, 'browser should not start before it is needed');

    // First action launches the browser.
    await ok('session', 'create');
    assert.match(await ok('navigate', `${site}/persist.html`), /Hexactra Fixture Persist/);
    assert.match(await ok('text', '--selector', '#visits'), /visits: 1/);
    assert.equal(browserRunning(), true);

    // Idle shutdown closes it.
    await until('idle shutdown', async () => !browserRunning(), 30_000);

    // Next action relaunches it with the same profile: localStorage survived
    // (the count keeps going up; a restored tab may add a visit).
    assert.match(await ok('navigate', `${site}/persist.html`), /Hexactra Fixture Persist/);
    assert.ok(visits(await ok('text', '--selector', '#visits')) >= 2);

    // Handoffs point the person at the viewer.
    const id = (await ok('handoff', 'request', '--kind', 'captcha', '--prompt', 'Solve it in the viewer')).trim();
    const shown = JSON.parse(await ok('--json', 'handoff', 'show', id));
    assert.equal(shown.viewer_url, 'https://viewer.example.test/vnc.html');
    await ok('handoff', 'cancel', id);
  });
  await step('profiles: two profiles keep separate storage and share one browser slot', async () => {
    const api = async (method, path, body) => {
      const r = await fetch(`${controlUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const act = async (session, action) => {
      const r = await api('POST', `/v1/sessions/${session}/actions`, { action, timeout_ms: 60000 });
      assert.equal(r.body.state, 'succeeded', JSON.stringify(r.body));
      return r.body.result;
    };
    // Unknown profile is refused until created explicitly.
    assert.equal((await api('POST', '/v1/sessions', { profile: 'travel' })).status, 404);
    const travel = (await api('POST', '/v1/sessions', { profile: 'travel', create_profile: true })).body;
    const work = (await api('POST', '/v1/sessions', { profile: 'work', create_profile: true })).body;
    assert.equal(travel.profile, 'travel');

    await act(travel.id, { type: 'navigate', url: `${site}/persist.html` });
    assert.match((await act(travel.id, { type: 'text', selector: '#visits' })).text, /visits: 1/);
    await act(travel.id, { type: 'navigate', url: `${site}/persist.html` });
    assert.match((await act(travel.id, { type: 'text', selector: '#visits' })).text, /visits: 2/);

    // Same site, other profile: its own storage (count starts again).
    await act(work.id, { type: 'navigate', url: `${site}/persist.html` });
    assert.match((await act(work.id, { type: 'text', selector: '#visits' })).text, /visits: 1/);

    // Capacity 1: only one profile's browser runs at a time.
    const running = (p) => spawnSync('pgrep', ['-f', `user-data-dir=${join(work_dir_profiles, p)}`]).status === 0;
    assert.equal(running('work'), true);
    assert.equal(running('travel'), false);

    // Back to travel: relaunched with its storage intact.
    await act(travel.id, { type: 'navigate', url: `${site}/persist.html` });
    assert.ok(visits((await act(travel.id, { type: 'text', selector: '#visits' })).text) >= 3);

    const host = (await api('GET', '/v1/hosts')).body.hosts.find((h) => h.name === 'e2e-launch-host');
    for (const p of ['default', 'travel', 'work']) assert.ok(host.profiles.includes(p), JSON.stringify(host));
  });
  await step('CLI and MCP pick profiles by name', async () => {
    const list = await ok('profile', 'list');
    assert.match(list, /e2e-launch-host \(online\): .*travel.*work/);

    // --profile keeps its own current session per profile.
    await ok('--profile', 'travel', 'navigate', `${site}/persist.html`);
    const t1 = visits(await ok('--profile', 'travel', 'text', '--selector', '#visits'));
    await ok('--profile', 'work', 'navigate', `${site}/persist.html`);
    const w1 = visits(await ok('--profile', 'work', 'text', '--selector', '#visits'));
    assert.ok(t1 >= 4 && w1 >= 2 && t1 !== w1, `travel=${t1} work=${w1}`);
    assert.match(await ok('session', 'list'), /profile=travel/);

    // Unknown profiles are not created by accident.
    const typo = await cli('--profile', 'trvel', 'navigate', `${site}/persist.html`);
    assert.notEqual(typo.code, 0);
    assert.match(typo.err, /no host has a profile named "trvel"/);
    await ok('--profile', 'shop', 'session', 'create', '--create');
    await ok('--profile', 'shop', 'navigate', `${site}/persist.html`);
    // Hosts report new profiles on their next poll.
    await until('shop listed', async () => /shop/.test((await cli('profile', 'list')).out), 20_000);

    // MCP starts on HEXACTRA_PROFILE and can switch.
    const { proc, rpc, call } = mcpClient({ HEXACTRA_PROFILE: 'work' });
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
    const profiles = JSON.parse((await call('browser_profiles', {})).content[0].text);
    assert.equal(profiles.current_profile, 'work');
    await call('browser_navigate', { url: `${site}/persist.html` });
    assert.ok(visits((await call('browser_text', { selector: '#visits' })).content[0].text) > w1);
    const ghost = await call('browser_use_profile', { profile: 'ghost' });
    assert.equal(ghost.isError, true);
    assert.match(ghost.content[0].text, /No host has a profile named "ghost"/);
    assert.equal((await call('browser_use_profile', { profile: 'travel' })).isError, false);
    await call('browser_navigate', { url: `${site}/persist.html` });
    assert.ok(visits((await call('browser_text', { selector: '#visits' })).content[0].text) > t1);
    proc.stdin.end();
  });
  await step('host commands manage profiles and browsers; attach hosts refuse them', async () => {
    const hosts = JSON.parse(await ok('--json', 'hosts'));
    const launch = hosts.find((h) => h.name === 'e2e-launch-host');
    const running = (p) => spawnSync('pgrep', ['-f', `user-data-dir=${join(work_dir_profiles, p)}`]).status === 0;

    await ok('profile', 'create', 'scratch', '--host', launch.id);
    assert.ok(existsSync(join(work_dir_profiles, 'scratch')));
    await ok('profile', 'restart', 'scratch', '--host', launch.id);
    assert.equal(running('scratch'), true);
    await ok('profile', 'close', 'scratch', '--host', launch.id);
    await until('scratch browser closed', async () => !running('scratch'), 20_000);

    const unconfirmed = await cli('profile', 'delete', 'scratch', '--host', launch.id);
    assert.notEqual(unconfirmed.code, 0);
    assert.match(unconfirmed.err, /pass --yes/);
    await ok('profile', 'delete', 'scratch', '--host', launch.id, '--yes');
    assert.equal(existsSync(join(work_dir_profiles, 'scratch')), false);

    // Drain: no new sessions are placed on the host until it is undrained.
    await ok('host', 'drain', launch.id);
    const drained = await cli('--profile', 'scratch2', 'session', 'create', '--create', '--host', launch.id);
    assert.notEqual(drained.code, 0);
    assert.match(drained.err, /draining/);
    await ok('host', 'undrain', launch.id);
    assert.match(await ok('host', 'commands', launch.id), /delete_profile\tscratch\tSucceeded/);

    // An attach-mode agent (no browser needed) refuses profile and browser commands.
    const attachAgent = start(
      'attach-agent',
      join(binDir, 'hexactra-agent'),
      ['daemon', '--url', controlUrl, '--name', 'e2e-attach-only'],
      { HEXACTRA_BRIDGE_SOCKET: join(work, 'run', 'attach-only.sock'), XDG_CONFIG_HOME: join(work, 'config-attach-only') },
    );
    const attachOnly = async () => JSON.parse(await ok('--json', 'hosts')).find((h) => h.name === 'e2e-attach-only' && h.online);
    await until('attach-only agent online', async () => Boolean(await attachOnly()), 20_000);
    const refused = await cli('profile', 'close', 'default', '--host', (await attachOnly()).id);
    assert.notEqual(refused.code, 0);
    assert.match(refused.err, /attaches to a Chrome you run yourself/);
    stop(attachAgent);
  });
  await step('hexactra-fabric admin mints and revokes service tokens and enrollments', async () => {
    const token = (await ok('admin', 'service-token-create', 'e2e-console')).trim();
    assert.match(token, /^hxs_/);
    const listed = JSON.parse(await ok('--json', 'admin', 'service-token-list')).service_tokens;
    const mine = listed.find((t) => t.name === 'e2e-console');
    assert.ok(mine, JSON.stringify(listed));
    assert.ok(!JSON.stringify(listed).includes(token), 'list must never include the token');
    // The new token works for client routes.
    assert.equal((await fetch(`${controlUrl}/v1/hosts`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
    await ok('admin', 'service-token-revoke', mine.id);
    assert.equal((await fetch(`${controlUrl}/v1/hosts`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
    const enroll = await ok('admin', 'enroll', '--name', 'e2e-later');
    assert.match(enroll, /^hexactra-agent daemon --url http:\/\/127\.0\.0\.1:\d+ --enrollment-token hxe_\S+ --name 'e2e-later'/);
  });
  await step('one OTLP trace spans the control plane and the agent', async () => {
    const traceId = crypto.randomBytes(16).toString('hex');
    const traceparent = `00-${traceId}-${crypto.randomBytes(8).toString('hex')}-01`;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', traceparent };
    const s = await (await fetch(`${controlUrl}/v1/sessions`, { method: 'POST', headers, body: '{}' })).json();
    const op = await (
      await fetch(`${controlUrl}/v1/sessions/${s.id}/actions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: { type: 'navigate', url: `${site}/persist.html` }, timeout_ms: 60000 }),
      })
    ).json();
    assert.equal(op.state, 'succeeded', JSON.stringify(op));
    await until(
      'spans from both services in one trace',
      async () => {
        const svcs = new Set(otlp.spans.filter((x) => x.traceId === traceId).map((x) => x.svc));
        return svcs.has('hexactra-control') && svcs.has('hexactra-agent');
      },
      20_000,
    );
    const names = otlp.spans.filter((x) => x.traceId === traceId).map((x) => x.name);
    assert.ok(names.includes('POST /v1/sessions/{id}/actions'), names.join(', '));
    assert.ok(names.includes('execute navigate'), names.join(', '));
    // Content-free: action URLs never reach telemetry.
    assert.ok(!otlp.raw.some((b) => b.includes('persist.html')), 'an action URL leaked into telemetry');
    await until('metrics exported', async () => otlp.raw.some((b) => b.includes('hexactra.operations')), 20_000);
  });
} catch (e) {
  failed = true;
  console.error(`\nFAILED: ${e.stack ?? e}`);
  for (const [name, log] of Object.entries(logs)) {
    console.error(`\n----- ${name} log (tail) -----\n${log.split('\n').slice(-40).join('\n')}`);
  }
} finally {
  for (const c of children.reverse()) stop(c);
  fixture.close();
  collector.close();
  await sleep(500);
  if (!keep) rmSync(work, { recursive: true, force: true });
}

console.log(`\n${results.length} steps passed${failed ? ', then a step failed' : ''}`);
process.exit(failed ? 1 : 0);
