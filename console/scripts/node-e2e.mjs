// The outside view of an unattended node (#344), driven by node-e2e.sh:
// the fabric's API and the desktop tunnel, as the console uses them.
//   T=<operator token> FABRIC=http://127.0.0.1:8787 [CRX=1] [PHASE=offline|online] node node-e2e.mjs

const base = process.env.FABRIC ?? 'http://127.0.0.1:8787';
const headers = { authorization: `Bearer ${process.env.T}`, 'content-type': 'application/json' };
const phase = process.env.PHASE ?? 'main';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (msg) => console.log(`ok   ${msg}`);

async function api(method, path, body) {
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  return { status: res.status, json, text };
}

async function node() {
  const r = await api('GET', '/v1/hosts');
  return r.json.hosts.find((h) => h.name === 'ci-node');
}

async function until(what, seconds, check) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(1000);
  }
}

/** Opens a tunnel to the node's desktop and runs the RFB handshake; resolves with the ServerInit size. */
async function rfbHandshake(hostId) {
  const s = await api('POST', `/v1/hosts/${hostId}/desktop-sessions`, { actor: { user_id: 'ci', display_name: 'CI' } });
  if (s.status !== 201) throw new Error(`desktop-sessions: ${s.status} ${s.text}`);
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/v1/desktop/${s.json.tunnel_id}/connect`, {
    headers: { authorization: `Bearer ${s.json.connect_token}` },
  });
  ws.binaryType = 'arraybuffer';
  return await new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let step = 0;
    const t = setTimeout(() => reject(new Error(`no RFB handshake (step ${step})`)), 30_000);
    ws.onerror = (e) => reject(new Error(`websocket: ${e.message ?? e.type}`));
    ws.onmessage = (m) => {
      buf = Buffer.concat([buf, Buffer.from(m.data)]);
      if (step === 0 && buf.length >= 12) {
        if (buf.subarray(0, 12).toString() !== 'RFB 003.008\n') return reject(new Error(`greeting ${JSON.stringify(buf.subarray(0, 12).toString())}`));
        buf = buf.subarray(12);
        ws.send(Buffer.from('RFB 003.008\n'));
        step = 1;
      }
      if (step === 1 && buf.length >= 1 && buf.length >= 1 + buf[0]) {
        const types = [...buf.subarray(1, 1 + buf[0])];
        buf = buf.subarray(1 + buf[0]);
        if (!types.includes(1)) return reject(new Error(`no "None" security type: ${types}`));
        ws.send(Buffer.from([1]));
        step = 2;
      }
      if (step === 2 && buf.length >= 4) {
        if (buf.readUInt32BE(0) !== 0) return reject(new Error('security failed'));
        buf = buf.subarray(4);
        ws.send(Buffer.from([1])); // shared
        step = 3;
      }
      if (step === 3 && buf.length >= 24) {
        clearTimeout(t);
        const size = `${buf.readUInt16BE(0)}x${buf.readUInt16BE(2)}`;
        ws.close();
        resolve(size);
      }
    };
  });
}

if (phase === 'offline') {
  const h = await until('the host goes offline', 90, async () => {
    const x = await node();
    return x && !x.online ? x : null;
  });
  const r = await api('POST', `/v1/hosts/${h.id}/desktop-sessions`, { actor: {} });
  if (r.status !== 409 || r.json?.error !== 'host_offline') throw new Error(`desktop of an offline node: ${r.status} ${r.text}`);
  ok('the stopped node is offline; its desktop answers 409 host_offline');
  process.exit(0);
}

if (phase === 'online') {
  const h = await until('the host comes back online', 120, async () => {
    const x = await node();
    return x && x.online ? x : null;
  });
  const size = await rfbHandshake(h.id);
  ok(`back online; its desktop answers again (${size})`);
  process.exit(0);
}

// (a) Online, unattended, with a desktop.
const h = await until('ci-node online', 120, async () => {
  const x = await node();
  return x && x.online ? x : null;
});
if (h.mode !== 'unattended' || !h.desktop) throw new Error(`ci-node: ${JSON.stringify(h)}`);
ok(`ci-node is online, mode unattended, with a desktop`);

// (b) Google Chrome with the extension by policy, driven by the agent.
if (process.env.CRX) {
  const s = await api('POST', '/v1/sessions', { host_id: h.id, profile: 'default' });
  if (s.status !== 200 && s.status !== 201) throw new Error(`session: ${s.status} ${s.text}`);
  const nav = await api('POST', `/v1/sessions/${s.json.id}/actions`, {
    action: { type: 'navigate', url: 'about:blank' },
    timeout_ms: 120_000,
  });
  if (nav.json?.state !== 'succeeded') throw new Error(`navigate on the node: ${nav.status} ${nav.text}`);
  ok('Google Chrome on the node loaded the extension by policy and ran an action');
  await api('DELETE', `/v1/sessions/${s.json.id}`);
} else {
  console.log('skip the extension check: EXTENSION_CRX_KEY is not available to this run');
}

// (c) The desktop through the fabric's tunnel: a full RFB handshake.
const size = await rfbHandshake(h.id);
if (size !== '1920x1080') throw new Error(`desktop size ${size}`);
ok(`the desktop answers a full RFB handshake through the tunnel (ServerInit ${size})`);

// (e) A takeover pauses the agent's actions; releasing it resumes them.
const s = await api('POST', '/v1/sessions', { host_id: h.id, profile: 'default' });
if (s.status !== 200 && s.status !== 201) throw new Error(`session: ${s.status} ${s.text}`);
const lease = await api('POST', `/v1/hosts/${h.id}/takeover`, { actor: { user_id: 'ci', display_name: 'CI' }, ttl_s: 60 });
if (lease.status !== 201) throw new Error(`takeover: ${lease.status} ${lease.text}`);
const held = await api('POST', `/v1/sessions/${s.json.id}/actions`, { action: { type: 'tabs' }, timeout_ms: 1000 });
if (held.status !== 409 || held.json?.error !== 'takeover_active') throw new Error(`action during a takeover: ${held.status} ${held.text}`);
const rel = await api('DELETE', `/v1/hosts/${h.id}/takeover/${lease.json.lease_id}`);
if (rel.status !== 204) throw new Error(`release: ${rel.status}`);
const after = await api('POST', `/v1/sessions/${s.json.id}/actions`, { action: { type: 'tabs' }, timeout_ms: 1000 });
if (after.status === 409) throw new Error(`still paused after the release: ${after.text}`);
await api('DELETE', `/v1/sessions/${s.json.id}`);
ok('a takeover pauses the agent (409 takeover_active) and the release resumes it');
