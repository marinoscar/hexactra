#!/usr/bin/env node
// Throwaway spike for issue #598 (E39.1). Not part of any build, not product code.
// Zero dependencies (Node 20+: global fetch). Holds no secrets: client ids and
// secrets come from environment variables; tokens go to a state directory that
// must be OUTSIDE any git work tree. See README.md.
//
// Commands:
//   scopes  <google|microsoft> [--caps a,b]       print the scopes (offline)
//   auth    <google|microsoft> --profile <name> [--caps a,b]
//   probe   --profile <name> [--caps a,b]         one read + one harmless write per capability
//   refresh-daily [--profile <name> ...]          refresh every stored profile, append to the log
//   status                                        profiles, age of each refresh token, last results
//   revoke  --profile <name>
//   help

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------- configuration

const CAPABILITIES = ['mail_read', 'mail_send', 'calendar_read', 'calendar_write', 'docs_read', 'docs_write'];

// The candidate permission sets from console/docs/decisions/connections-auth.md.
// Change them here to test a variant; the log records the scopes actually used.
const G = 'https://www.googleapis.com/auth/';
const SCOPES = {
  google: {
    base: ['openid', 'email', 'profile'],
    mail_read: [G + 'gmail.readonly'],
    mail_send: [G + 'gmail.send'],
    calendar_read: [G + 'calendar.readonly'],
    calendar_write: [G + 'calendar.events'],
    docs_read: [G + 'drive.file', G + 'documents.readonly', G + 'spreadsheets.readonly'],
    docs_write: [G + 'drive.file', G + 'documents', G + 'spreadsheets'],
  },
  microsoft: {
    base: ['openid', 'email', 'profile', 'offline_access', 'User.Read'],
    mail_read: ['Mail.Read'],
    mail_send: ['Mail.Send'],
    calendar_read: ['Calendars.Read'],
    calendar_write: ['Calendars.ReadWrite'],
    docs_read: ['Files.Read'],
    docs_write: ['Files.ReadWrite'],
  },
};

const PORT = Number(process.env.SPIKE_REDIRECT_PORT || 53682);
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const STATE_DIR = path.resolve(process.env.SPIKE_STATE_DIR || path.join(os.homedir(), '.hexactra-spike-connections'));
const TOKENS_FILE = path.join(STATE_DIR, 'tokens.json');
const LOG_FILE = path.join(STATE_DIR, 'log.ndjson');
const TAG = '[hexactra-spike]';

// ---------------------------------------------------------------- small helpers

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        (flags[key] ??= []).push(next);
        i += 1;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

const flag = (flags, name) => (Array.isArray(flags[name]) ? flags[name][flags[name].length - 1] : flags[name]);

function parseCaps(value, fallback = CAPABILITIES) {
  if (!value || value === true) return fallback;
  const caps = String(value).split(',').map((c) => c.trim()).filter(Boolean);
  for (const c of caps) if (!CAPABILITIES.includes(c)) die(`unknown capability "${c}" (known: ${CAPABILITIES.join(', ')})`);
  return caps;
}

function scopesFor(provider, caps) {
  const set = new Set(SCOPES[provider].base);
  for (const c of caps) for (const s of SCOPES[provider][c]) set.add(s);
  return [...set];
}

// Anything that looks like an address or a token is masked before it is logged.
function redact(text) {
  return String(text ?? '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\b(ya29|1\/\/|eyJ)[A-Za-z0-9._\-/]{20,}/g, '<token>')
    .replace(/(access_token|refresh_token|id_token|client_secret|code)=([^&\s"]+)/g, '$1=<redacted>')
    .slice(0, 400);
}

function assertStateDirOutsideRepo() {
  let dir = STATE_DIR;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) die(`SPIKE_STATE_DIR (${STATE_DIR}) is inside a git work tree (${dir}). Tokens must live outside any repository.`);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

function readTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeTokens(all) {
  const tmp = `${TOKENS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, TOKENS_FILE);
}

function log(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  fs.appendFileSync(LOG_FILE, `${line}\n`, { mode: 0o600 });
  const brief = [entry.event, entry.profile, entry.capability, entry.step, entry.ok === undefined ? '' : entry.ok ? 'ok' : 'FAIL', entry.status ?? '', entry.error ?? '']
    .filter((x) => x !== '' && x !== undefined)
    .join(' ');
  console.log(brief);
}

function env(name, required = true) {
  const v = process.env[name];
  if (!v && required) die(`set ${name} in the environment (never in a file in the repository)`);
  return v;
}

function providerConfig(provider) {
  if (provider === 'google') {
    return {
      clientId: env('SPIKE_GOOGLE_CLIENT_ID'),
      clientSecret: env('SPIKE_GOOGLE_CLIENT_SECRET', false),
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      revokeUrl: 'https://oauth2.googleapis.com/revoke',
    };
  }
  if (provider === 'microsoft') {
    const authority = process.env.SPIKE_MS_AUTHORITY || 'common'; // common | organizations | consumers | <tenant id>
    const base = `https://login.microsoftonline.com/${authority}/oauth2/v2.0`;
    return {
      clientId: env('SPIKE_MS_CLIENT_ID'),
      clientSecret: env('SPIKE_MS_CLIENT_SECRET', false),
      authorizeUrl: `${base}/authorize`,
      tokenUrl: `${base}/token`,
      authority,
    };
  }
  return die(`unknown provider "${provider}" (google | microsoft)`);
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function pkcePair() {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function tokenRequest(provider, params) {
  const cfg = providerConfig(provider);
  const body = new URLSearchParams({ client_id: cfg.clientId, ...params });
  if (cfg.clientSecret) body.set('client_secret', cfg.clientSecret);
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(redact(`${json.error ?? res.status}: ${json.error_description ?? ''}`));
    err.status = res.status;
    err.code = json.error;
    throw err;
  }
  return json;
}

// ---------------------------------------------------------------- auth

function waitForCallback(expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const result = Object.fromEntries(url.searchParams.entries());
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('Done. You can close this tab and return to the terminal.');
      server.close();
      clearTimeout(timer);
      if (result.state !== expectedState) reject(new Error('state mismatch'));
      else resolve(result);
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('timed out waiting for the redirect (5 minutes)'));
    }, 5 * 60 * 1000);
    server.listen(PORT, '127.0.0.1');
    server.on('error', reject);
  });
}

async function cmdAuth(provider, flags) {
  const profile = flag(flags, 'profile');
  if (!profile || profile === true) die('--profile <name> is required (a label such as google-workspace-internal; never an address)');
  const caps = parseCaps(flag(flags, 'caps'));
  const scopes = scopesFor(provider, caps);
  const cfg = providerConfig(provider);
  const { verifier, challenge } = pkcePair();
  const state = b64url(crypto.randomBytes(24));

  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (provider === 'google') {
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'true');
  } else {
    url.searchParams.set('prompt', 'select_account');
  }
  const hint = process.env.SPIKE_LOGIN_HINT;
  if (hint) url.searchParams.set('login_hint', hint);

  console.log(`Open this URL in a browser signed in to the account for profile "${profile}":\n\n${url}\n`);
  console.log('Write down every consent screen, warning and error text as you see it (README: "What to record").');
  const callback = await waitForCallback(state);
  if (callback.error) {
    log({ event: 'auth', provider, profile, ok: false, error: redact(`${callback.error}: ${callback.error_description ?? ''}`) });
    die('the provider returned an error; recorded in the log');
  }
  const tok = await tokenRequest(provider, {
    grant_type: 'authorization_code',
    code: callback.code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  if (!tok.refresh_token) die('no refresh token was returned (Google: revoke the app at the account and retry; Microsoft: offline_access missing?)');

  const granted = String(tok.scope ?? '').split(/[ ,]+/).filter(Boolean);
  const identity = await identityOf(provider, tok.access_token);
  const all = readTokens();
  all[profile] = {
    provider,
    email: identity.email,
    accountId: identity.id,
    requestedCaps: caps,
    requestedScopes: scopes,
    grantedScopes: granted,
    refreshToken: tok.refresh_token,
    accessToken: tok.access_token,
    accessExpiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000,
    firstAuthorizedAt: new Date().toISOString(),
    lastRefreshAt: new Date().toISOString(),
  };
  writeTokens(all);
  const missing = scopes.filter((s) => !granted.includes(s) && !SCOPES[provider].base.includes(s));
  log({ event: 'auth', provider, profile, ok: true, capabilities: caps, grantedCount: granted.length, missingScopes: missing, refreshTokenExpiresIn: tok.refresh_token_expires_in ?? null });
}

async function identityOf(provider, accessToken) {
  const url = provider === 'google' ? 'https://openidconnect.googleapis.com/v1/userinfo' : 'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName';
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) return { email: undefined, id: undefined };
  return provider === 'google' ? { email: j.email, id: j.sub } : { email: j.mail || j.userPrincipalName, id: j.id };
}

// ---------------------------------------------------------------- tokens

async function refresh(profile, entry) {
  const tok = await tokenRequest(entry.provider, {
    grant_type: 'refresh_token',
    refresh_token: entry.refreshToken,
    ...(entry.provider === 'microsoft' ? { scope: scopesFor('microsoft', entry.requestedCaps).join(' ') } : {}),
  });
  entry.accessToken = tok.access_token;
  entry.accessExpiresAt = Date.now() + (tok.expires_in ?? 3600) * 1000;
  entry.lastRefreshAt = new Date().toISOString();
  const rotated = Boolean(tok.refresh_token && tok.refresh_token !== entry.refreshToken);
  if (rotated) entry.refreshToken = tok.refresh_token; // Microsoft rotates; Google normally does not
  return { rotated, expiresIn: tok.expires_in };
}

async function accessTokenFor(profile) {
  const all = readTokens();
  const entry = all[profile];
  if (!entry) die(`no stored tokens for profile "${profile}" (run auth first)`);
  if (entry.accessExpiresAt - Date.now() < 120000) {
    await refresh(profile, entry);
    writeTokens(all);
  }
  return entry;
}

async function cmdRefreshDaily(flags) {
  const all = readTokens();
  const wanted = Array.isArray(flags.profile) ? flags.profile : Object.keys(all);
  if (wanted.length === 0) die('no profiles stored');
  for (const profile of wanted) {
    const entry = all[profile];
    if (!entry) {
      log({ event: 'refresh', profile, ok: false, error: 'unknown profile' });
      continue;
    }
    const ageDays = Number(((Date.now() - Date.parse(entry.firstAuthorizedAt)) / 86400000).toFixed(2));
    try {
      const r = await refresh(profile, entry);
      writeTokens(all);
      const me = await identityOf(entry.provider, entry.accessToken);
      log({ event: 'refresh', provider: entry.provider, profile, ok: Boolean(me.id), ageDays, rotated: r.rotated, accessExpiresIn: r.expiresIn });
    } catch (e) {
      log({ event: 'refresh', provider: entry.provider, profile, ok: false, ageDays, status: e.status, error: redact(e.message) });
    }
  }
}

// ---------------------------------------------------------------- probes

async function api(entry, method, url, { json, body, headers = {}, raw } = {}) {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${entry.accessToken}`, ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
    body: json ? JSON.stringify(json) : body,
  });
  let data = null;
  if (res.status !== 204) data = raw ? Buffer.from(await res.arrayBuffer()) : await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

function rfc822(to, subject, text) {
  return b64url(Buffer.from([`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=UTF-8', '', text].join('\r\n')));
}

const inOneHour = () => new Date(Date.now() + 3600000).toISOString();
const inTwoHours = () => new Date(Date.now() + 7200000).toISOString();

// Each probe returns an array of { step, ok, status, error? }. No mailbox content is logged: only status codes.
const PROBES = {
  google: {
    async mail_read(e) {
      const a = await api(e, 'GET', 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1');
      const b = await api(e, 'GET', 'https://gmail.googleapis.com/gmail/v1/users/me/labels');
      return [step('messages.list', a), step('labels.list', b)];
    },
    async mail_send(e) {
      if (!e.email) return [{ step: 'messages.send', ok: false, error: 'account address unknown' }];
      const r = await api(e, 'POST', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { json: { raw: rfc822(e.email, `${TAG} probe`, 'Harmless spike probe. Delete me.') } });
      return [step('messages.send (to self)', r)];
    },
    async calendar_read(e) {
      return [step('calendarList.list', await api(e, 'GET', 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1'))];
    },
    async calendar_write(e) {
      const c = await api(e, 'POST', 'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none', {
        json: { summary: `${TAG} probe`, start: { dateTime: inOneHour() }, end: { dateTime: inTwoHours() } },
      });
      const out = [step('events.insert (no attendees)', c)];
      if (c.ok) out.push(step('events.delete', await api(e, 'DELETE', `https://www.googleapis.com/calendar/v3/calendars/primary/events/${c.data.id}?sendUpdates=none`)));
      return out;
    },
    async docs_read(e) {
      return [step('drive.files.list (drive.file view)', await api(e, 'GET', 'https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id)'))];
    },
    async docs_write(e) {
      const out = [];
      const s = await api(e, 'POST', 'https://sheets.googleapis.com/v4/spreadsheets', { json: { properties: { title: `${TAG} probe sheet` } } });
      out.push(step('spreadsheets.create', s));
      if (s.ok) {
        const id = s.data.spreadsheetId;
        out.push(step('values.append (RAW)', await api(e, 'POST', `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/A1:append?valueInputOption=RAW`, { json: { values: [['spike', new Date().toISOString()]] } })));
        out.push(step('files.delete (sheet)', await api(e, 'DELETE', `https://www.googleapis.com/drive/v3/files/${id}`)));
      }
      const d = await api(e, 'POST', 'https://docs.googleapis.com/v1/documents', { json: { title: `${TAG} probe doc` } });
      out.push(step('documents.create', d));
      if (d.ok) out.push(step('files.delete (doc)', await api(e, 'DELETE', `https://www.googleapis.com/drive/v3/files/${d.data.documentId}`)));
      return out;
    },
  },
  microsoft: {
    async mail_read(e) {
      return [
        step('messages.list ($top=1)', await api(e, 'GET', 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=1&$select=id')),
        step('mailFolders.list', await api(e, 'GET', 'https://graph.microsoft.com/v1.0/me/mailFolders?$top=1&$select=id')),
      ];
    },
    async mail_send(e) {
      if (!e.email) return [{ step: 'sendMail', ok: false, error: 'account address unknown' }];
      const message = { subject: `${TAG} probe`, body: { contentType: 'Text', content: 'Harmless spike probe. Delete me.' }, toRecipients: [{ emailAddress: { address: e.email } }] };
      return [step('sendMail (to self)', await api(e, 'POST', 'https://graph.microsoft.com/v1.0/me/sendMail', { json: { message, saveToSentItems: true } }))];
    },
    async calendar_read(e) {
      return [step('calendars.list', await api(e, 'GET', 'https://graph.microsoft.com/v1.0/me/calendars?$top=1&$select=id'))];
    },
    async calendar_write(e) {
      const c = await api(e, 'POST', 'https://graph.microsoft.com/v1.0/me/events', {
        json: { subject: `${TAG} probe`, start: { dateTime: inOneHour().replace('Z', ''), timeZone: 'UTC' }, end: { dateTime: inTwoHours().replace('Z', ''), timeZone: 'UTC' } },
      });
      const out = [step('events.create (no attendees)', c)];
      if (c.ok) out.push(step('events.delete', await api(e, 'DELETE', `https://graph.microsoft.com/v1.0/me/events/${c.data.id}`)));
      return out;
    },
    async docs_read(e) {
      return [step('drive.root.children ($top=1)', await api(e, 'GET', 'https://graph.microsoft.com/v1.0/me/drive/root/children?$top=1&$select=id'))];
    },
    async docs_write(e) {
      const out = [];
      const name = `hexactra-spike-probe-${Date.now()}.txt`;
      const up = await api(e, 'PUT', `https://graph.microsoft.com/v1.0/me/drive/root:/${name}:/content`, { body: 'harmless spike probe', headers: { 'content-type': 'text/plain' } });
      out.push(step('drive.upload (simple)', up));
      if (up.ok) out.push(step('drive.delete', await api(e, 'DELETE', `https://graph.microsoft.com/v1.0/me/drive/items/${up.data.id}`)));
      // Optional Excel workbook probe: point SPIKE_XLSX_TEMPLATE at any empty .xlsx you created by hand.
      const xlsx = process.env.SPIKE_XLSX_TEMPLATE;
      if (xlsx && fs.existsSync(xlsx)) {
        const xname = `hexactra-spike-probe-${Date.now()}.xlsx`;
        const x = await api(e, 'PUT', `https://graph.microsoft.com/v1.0/me/drive/root:/${xname}:/content`, { body: fs.readFileSync(xlsx), headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } });
        out.push(step('drive.upload (xlsx)', x));
        if (x.ok) {
          const base = `https://graph.microsoft.com/v1.0/me/drive/items/${x.data.id}/workbook`;
          out.push(step('workbook.worksheets.list', await api(e, 'GET', `${base}/worksheets?$select=id`)));
          out.push(step('workbook.range.patch (A1)', await api(e, 'PATCH', `${base}/worksheets('Sheet1')/range(address='A1:B1')`, { json: { values: [['spike', new Date().toISOString()]] } })));
          out.push(step('drive.delete (xlsx)', await api(e, 'DELETE', `https://graph.microsoft.com/v1.0/me/drive/items/${x.data.id}`)));
        }
      }
      return out;
    },
  },
};

function step(name, r) {
  const providerError = r.data && (r.data.error?.code || r.data.error?.status || (typeof r.data.error === 'string' ? r.data.error : undefined));
  const message = r.data?.error?.message;
  return { step: name, ok: r.ok, status: r.status, error: r.ok ? undefined : redact(`${providerError ?? ''} ${message ?? ''}`.trim()) };
}

async function cmdProbe(flags) {
  const profile = flag(flags, 'profile');
  if (!profile || profile === true) die('--profile <name> is required');
  const entry = await accessTokenFor(profile);
  const caps = parseCaps(flag(flags, 'caps'), entry.requestedCaps);
  for (const cap of caps) {
    try {
      for (const r of await PROBES[entry.provider][cap](entry)) log({ event: 'probe', provider: entry.provider, profile, capability: cap, ...r });
    } catch (e) {
      log({ event: 'probe', provider: entry.provider, profile, capability: cap, ok: false, error: redact(e.message) });
    }
  }
}

// ---------------------------------------------------------------- the rest

function cmdStatus() {
  const all = readTokens();
  for (const [profile, e] of Object.entries(all)) {
    const age = ((Date.now() - Date.parse(e.firstAuthorizedAt)) / 86400000).toFixed(1);
    console.log(`${profile}\t${e.provider}\tcaps=${e.requestedCaps.join(',')}\tauthorized ${age} days ago\tlast refresh ${e.lastRefreshAt}`);
  }
  if (Object.keys(all).length === 0) console.log('no profiles stored');
}

async function cmdRevoke(flags) {
  const profile = flag(flags, 'profile');
  const all = readTokens();
  const e = all[profile];
  if (!e) die('unknown profile');
  if (e.provider === 'google') {
    const res = await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: e.refreshToken }) });
    log({ event: 'revoke', provider: 'google', profile, ok: res.ok, status: res.status });
  } else {
    log({ event: 'revoke', provider: 'microsoft', profile, ok: true, error: 'no per-token revoke in Microsoft identity platform: remove the app at the account (README)' });
  }
  delete all[profile];
  writeTokens(all);
}

function help() {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 16).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, provider] = positional;
  if (!command || command === 'help') return help();
  if (command === 'scopes') {
    if (!SCOPES[provider]) die('scopes <google|microsoft>');
    return console.log(scopesFor(provider, parseCaps(flag(flags, 'caps'))).join('\n'));
  }
  assertStateDirOutsideRepo();
  switch (command) {
    case 'auth': return cmdAuth(provider, flags);
    case 'probe': return cmdProbe(flags);
    case 'refresh-daily': return cmdRefreshDaily(flags);
    case 'status': return cmdStatus();
    case 'revoke': return cmdRevoke(flags);
    default: return die(`unknown command "${command}" (try help)`);
  }
}

main().catch((e) => die(redact(e.stack || e.message)));
