#!/usr/bin/env node
// End-to-end test of remote browser control (#177).
//
// Starts the real stack and drives a real Chromium through the CLI:
//
//   hexactra CLI -> hexactra-control -> hexactra-agent -> native host
//     -> Hexactra extension in Chromium -> fixture page
//
// Requirements:
//   - built binaries in target/debug (or HEXACTRA_BIN_DIR):
//       hexactra, hexactra-control, hexactra-agent, hexactra-native-host
//   - built extension in apps/chrome-extension/dist
//   - a Chromium that honours --load-extension (Chromium or Chrome for
//     Testing; branded Google Chrome does not), path in CHROMIUM_PATH
//   - a display: run under xvfb-run on headless machines
//
// Usage: CHROMIUM_PATH=/path/to/chrome xvfb-run -a node tests/e2e/remote-control.e2e.mjs

import { spawn, spawnSync, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
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

for (const b of ['hexactra', 'hexactra-control', 'hexactra-agent', 'hexactra-native-host']) {
  if (!existsSync(join(binDir, b))) throw new Error(`missing binary ${join(binDir, b)}; run cargo build first`);
}
if (!existsSync(join(extensionDir, 'manifest.json'))) throw new Error('extension not built; run pnpm build');
if (!chromium || !existsSync(chromium)) throw new Error('set CHROMIUM_PATH to a Chromium binary');

const work = mkdtempSync(join(tmpdir(), 'hexactra-e2e-'));
const token = 'e2e-token-' + Math.random().toString(16).slice(2).padEnd(24, '0');
const socket = join(work, 'run', 'bridge.sock');
const userDataDir = join(work, 'chrome-profile');
const env = {
  ...process.env,
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
      join(binDir, 'hexactra'),
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
  assert.equal(r.code, 0, `hexactra ${args.join(' ')} failed:\n${r.err}${r.out}`);
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
  start('control', join(binDir, 'hexactra-control'), ['serve', '--bind', `127.0.0.1:${controlPort}`]);
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
  start('chromium', chromium, chromeArgs);

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

  await step('non-web URLs are refused', async () => {
    const r = await cli('navigate', 'javascript:alert(1)');
    assert.notEqual(r.code, 0);
    assert.match(r.err, /only http\(s\)/);
  });

  await step('the extension reconnects after the agent restarts', async () => {
    stop(agent);
    await new Promise((r) => agent.once('exit', r));
    agent = startAgent();
    await until('browser reconnected', async () => /browser=true/.test((await cli('status')).out), 30_000);
    assert.match(await ok('navigate', `${site}/index.html`), /Hexactra Fixture Home/);
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
  await sleep(500);
  if (!keep) rmSync(work, { recursive: true, force: true });
}

console.log(`\n${results.length} steps passed${failed ? ', then a step failed' : ''}`);
process.exit(failed ? 1 : 0);
