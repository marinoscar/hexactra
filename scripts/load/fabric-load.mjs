#!/usr/bin/env node
// Load test of the fabric control plane (crates/hexactra-control): N simulated
// hosts x M profiles x S concurrent sessions, each sending A actions.
//
//   node scripts/load/fabric-load.mjs --bin target/release/hexactra-control \
//     --hosts 10 --profiles 4 --sessions 40 --actions 25 --browser-ms 150
//
// The hosts speak the real host protocol (register, long-poll /next, post the
// result) but answer every action after --browser-ms instead of driving
// Chromium: this measures the control plane (dispatch, long-poll fan-out,
// durable state, the event stream), not the browsers. Browser capacity is a
// separate, measured number (docs/operations/capacity.md).
//
// Prints one JSON object: settings, throughput, latency percentiles, errors and
// the control plane's peak RSS. Uses only Node built-ins. The operator token
// is generated here and never printed.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: o } = parseArgs({
  options: {
    bin: { type: 'string', default: 'target/release/hexactra-control' },
    port: { type: 'string', default: '18787' },
    hosts: { type: 'string', default: '4' },
    profiles: { type: 'string', default: '2' },
    sessions: { type: 'string', default: '8' },
    actions: { type: 'string', default: '20' },
    'browser-ms': { type: 'string', default: '100' },
    'events-clients': { type: 'string', default: '1' },
  },
});
const N = Number(o.hosts), M = Number(o.profiles), S = Number(o.sessions), A = Number(o.actions);
const BROWSER_MS = Number(o['browser-ms']);
const base = `http://127.0.0.1:${o.port}`;
const token = randomBytes(32).toString('hex');
const dir = mkdtempSync(join(tmpdir(), 'hexactra-load-'));

const control = spawn(o.bin, ['serve', '--bind', `127.0.0.1:${o.port}`, '--state-db', join(dir, 'control.db'), '--webhooks-file', join(dir, 'webhooks.json')], {
  env: { ...process.env, HEXACTRA_API_TOKEN: token, RUST_LOG: 'warn' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
let peakRssKb = 0;
const rssTimer = setInterval(() => {
  try {
    const kb = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${control.pid}/status`, 'utf8'))?.[1] ?? 0);
    peakRssKb = Math.max(peakRssKb, kb);
  } catch {
    /* not Linux, or exited */
  }
}, 200);

const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, { method, headers: H, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function waitHealthy() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/v1/health`)).ok) return;
    } catch {
      /* starting */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('control plane did not start');
}

let stopping = false;
let dispatched = 0;
/** One simulated host: M profiles, one long-poll loop per profile (a browser each). */
async function host(i) {
  const profiles = Array.from({ length: M }, (_, p) => `p${p}`);
  const r = await call('POST', '/v1/hosts/register', { name: `load-host-${i}`, version: 'load' });
  if (r.status !== 200) throw new Error(`register: ${r.status}`);
  const id = r.json.host_id;
  const q = `wait_ms=5000&browser_connected=true&on_demand=true&profiles=${profiles.join(',')}&running=${profiles.join(',')}`;
  const loops = profiles.map(async () => {
    while (!stopping) {
      const res = await fetch(`${base}/v1/hosts/${id}/next?${q}`, { headers: H }).catch(() => null);
      if (!res) continue;
      if (res.status !== 200) {
        await res.text();
        continue;
      }
      const op = await res.json();
      if (!op?.id || op.command) continue;
      dispatched++;
      await new Promise((r2) => setTimeout(r2, BROWSER_MS));
      await call('POST', `/v1/hosts/${id}/operations/${op.id}/result`, { ok: true, result: { url: 'about:blank' } });
    }
  });
  return { id, loops };
}

/** A client consuming the event stream, as the console does. */
async function eventsClient(signal) {
  let events = 0;
  try {
    const res = await fetch(`${base}/v1/events`, { headers: H, signal });
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      events += (new TextDecoder().decode(value).match(/^data:/gm) ?? []).length;
    }
  } catch {
    /* aborted */
  }
  return events;
}

const latencies = [];
let errors = 0;
async function session(i) {
  const created = await call('POST', '/v1/sessions', { profile: `p${i % M}`, label: `load-${i}` });
  if (created.status >= 300) {
    errors++;
    return;
  }
  const sid = created.json.id;
  for (let a = 0; a < A; a++) {
    const t0 = performance.now();
    const r = await call('POST', `/v1/sessions/${sid}/actions`, { action: { type: 'navigate', url: 'about:blank' }, timeout_ms: 30000 });
    const ms = performance.now() - t0;
    if (r.status >= 300 || r.json?.state !== 'succeeded') errors++;
    else latencies.push(ms);
  }
  await call('DELETE', `/v1/sessions/${sid}`);
}

const pct = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null);

try {
  await waitHealthy();
  const hosts = await Promise.all(Array.from({ length: N }, (_, i) => host(i)));
  const abort = new AbortController();
  const streams = Array.from({ length: Number(o['events-clients']) }, () => eventsClient(abort.signal));
  const t0 = performance.now();
  await Promise.all(Array.from({ length: S }, (_, i) => session(i)));
  const seconds = (performance.now() - t0) / 1000;
  stopping = true;
  abort.abort();
  const events = await Promise.all(streams);
  latencies.sort((a, b) => a - b);
  const overhead = latencies.map((l) => l - BROWSER_MS).sort((a, b) => a - b);
  const summary = {
    settings: { hosts: N, profilesPerHost: M, sessions: S, actionsPerSession: A, browserMs: BROWSER_MS, eventClients: events.length },
    actions: { ok: latencies.length, errors, dispatched, perSecond: Math.round((latencies.length / seconds) * 10) / 10, seconds: Math.round(seconds * 10) / 10 },
    latencyMs: { p50: Math.round(pct(latencies, 50)), p95: Math.round(pct(latencies, 95)), p99: Math.round(pct(latencies, 99)), max: Math.round(latencies.at(-1) ?? 0) },
    controlPlaneOverheadMs: { p50: Math.round(pct(overhead, 50)), p95: Math.round(pct(overhead, 95)), p99: Math.round(pct(overhead, 99)) },
    eventsSeenPerClient: events,
    controlPlanePeakRssMb: Math.round(peakRssKb / 1024),
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  await Promise.race([Promise.all(hosts.flatMap((h) => h.loops)), new Promise((r) => setTimeout(r, 6000))]);
  if (errors > 0) process.exitCode = 1;
} finally {
  clearInterval(rssTimer);
  control.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
}
