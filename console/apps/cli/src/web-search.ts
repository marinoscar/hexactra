// Web search from a terminal (E50.15, #985): the shapes of `/api/web-search` and `/api/service-credentials`, the lines the commands print,
// the administrator's `admin set <field> <value>` parser and the key readers. A key is read from a hidden prompt or standard input only:
// never an argument (it would land in the shell's history), never echoed, never written to a file. Pure, except the readers.
import { UsageError } from '@marinoscar/platform-cli/commands';

export type KeyTier = 'user' | 'organization' | 'system';

/** `GET /api/web-search/status`. */
export interface WebSearchStatusView {
  enabled: boolean;
  reason: 'disabled_by_admin' | 'disabled_by_you' | 'no_provider' | 'no_key' | null;
  provider: { id: string; label: string; tier: KeyTier | null } | null;
  today: { calls: number; limit: number | null; remaining: number | null };
  perRunLimit: number | null;
}

/** `GET /api/web-search/providers`. */
export interface WebSearchProviderView {
  id: string;
  label: string;
  kind: 'results' | 'answer';
  credential: 'api_key' | 'none' | 'ai_service';
  needsKey: boolean;
  enabled: boolean;
  listed: boolean;
  keyTier: KeyTier | null;
  keys: { user: boolean; organization: boolean; system: boolean };
  estimatedCostPerCallUsd: number | null;
}

/** `POST /api/web-search/search`. */
export interface WebSearchResultView {
  provider: string;
  hits: { title: string; url: string; snippet: string; publishedAt: string | null }[];
  answer: { text: string; citations: string[] } | null;
}

/** `GET /api/service-credentials`: which tiers hold a key, never a key. */
export interface ServiceCredentialView {
  service: string;
  name: string;
  label: string;
  binding: string;
  tier: KeyTier | null;
  tiers: Record<KeyTier, { available: boolean; set: boolean; setAt: string | null }>;
}

/** `GET /api/web-search/admin`. */
export interface WebSearchAdminView {
  enabled: boolean;
  providers: Record<string, { enabled: boolean; costPerCallUsd: number | null; baseUrl: string | null }>;
  order: string[];
  shareDeploymentKey: boolean;
  allowUserKeys: boolean;
  limits: { perRun: number | null; perUserPerDay: number | null; fetchPerRun: number | null };
  fetch: { enabled: boolean; blockedHosts: string[] };
  installed: { id: string; label: string; credential: string; hosts: string[]; defaultEstimatedCostPerCallUsd: number | null }[];
}

export interface WebSearchUsageRowView {
  day: string;
  provider: string;
  calls: number;
  failures: number;
  estimatedCostUsd: number;
}

/** The service of web search keys at `/api/service-credentials/{service}/{name}`. */
export const WEB_SEARCH_SERVICE = 'web_search';

const TIER_WORDS: Record<KeyTier, string> = { user: 'your own key', organization: "your organization's key", system: "the deployment's key" };
const REASON_WORDS: Record<NonNullable<WebSearchStatusView['reason']>, string> = {
  disabled_by_admin: 'your administrator switched web search off for this deployment',
  disabled_by_you: 'you switched it off (`search on` switches it on)',
  no_provider: 'no search provider is set up here (ask your administrator)',
  no_key: 'no search provider has a key you can use (`search key set <provider>`)',
};

const limitText = (n: number | null) => (n === null ? 'unlimited' : String(n));

export const tierWords = (t: KeyTier | null): string => (t ? TIER_WORDS[t] : 'no key needed');

export function statusLines(s: WebSearchStatusView): string[] {
  const lines = [s.enabled ? 'Web search: on' : `Web search: off: ${s.reason ? REASON_WORDS[s.reason] : 'not available'}`];
  if (s.provider) lines.push(`Provider: ${s.provider.label} (${s.provider.id}), ${tierWords(s.provider.tier)}`);
  lines.push(`Today: ${s.today.calls} of ${limitText(s.today.limit)} searches${s.today.remaining !== null ? ` (${s.today.remaining} left)` : ''}`);
  lines.push(`A run: at most ${limitText(s.perRunLimit)} searches`);
  return lines;
}

/** Whether you can search with a provider now, in words. */
export function providerUsable(p: WebSearchProviderView): string {
  if (!p.enabled) return 'switched off by your administrator';
  if (!p.listed) return "not in the deployment's order";
  if (p.needsKey && !p.keyTier) return 'no key you can use';
  return p.needsKey ? `usable, ${tierWords(p.keyTier)}` : 'usable';
}

export function providerLine(p: WebSearchProviderView): string {
  const cost = p.estimatedCostPerCallUsd !== null ? `  ~$${p.estimatedCostPerCallUsd} a search (estimate)` : '';
  return `${p.id.padEnd(12)}  ${p.label.padEnd(20)}  ${p.kind.padEnd(7)}  ${providerUsable(p)}${cost}`;
}

/** The numbered hits (and an answer-type provider's answer). The text is the provider's: printed as plain text. */
export function resultLines(r: WebSearchResultView): string[] {
  const lines: string[] = [];
  if (r.answer) lines.push(r.answer.text.replace(/\s+/g, ' ').trim(), ...r.answer.citations.map((c, i) => `  [${i + 1}] ${c}`), '');
  r.hits.forEach((h, i) => {
    lines.push(`${String(i + 1).padStart(2)}. ${h.title.replace(/\s+/g, ' ').trim()}`, `    ${h.url}`);
    const snippet = h.snippet.replace(/\s+/g, ' ').trim();
    if (snippet) lines.push(`    ${snippet}`);
  });
  if (r.hits.length === 0 && !r.answer) lines.push('No results.');
  lines.push(`(answered by ${r.provider})`);
  return lines;
}

export function keyLine(c: ServiceCredentialView): string {
  const held = (['user', 'organization', 'system'] as const).filter((t) => c.tiers[t].set).map((t) => `${t === 'system' ? 'deployment' : t}${c.tiers[t].setAt ? ` (${c.tiers[t].setAt!.slice(0, 10)})` : ''}`);
  return `${c.name.padEnd(12)}  ${c.label.padEnd(20)}  ${held.length ? `stored: ${held.join(', ')}` : 'no key stored'}  ${c.tier ? `used: ${tierWords(c.tier)}` : ''}`.trimEnd();
}

export function adminLines(a: WebSearchAdminView): string[] {
  const lines = [
    `enabled              ${a.enabled ? 'on' : 'off'}`,
    `order                ${a.order.join(',') || '(none)'}`,
    `shareDeploymentKey   ${a.shareDeploymentKey ? 'on' : 'off'}`,
    `allowUserKeys        ${a.allowUserKeys ? 'on' : 'off'}`,
    `limits.perRun        ${limitText(a.limits.perRun)}`,
    `limits.perUserPerDay ${limitText(a.limits.perUserPerDay)}`,
    `limits.fetchPerRun   ${limitText(a.limits.fetchPerRun)}`,
    `fetch.enabled        ${a.fetch.enabled ? 'on' : 'off'}`,
    `fetch.blockedHosts   ${a.fetch.blockedHosts.join(',') || '(none)'}`,
  ];
  for (const p of a.installed) {
    const s = a.providers[p.id] ?? { enabled: true, costPerCallUsd: null, baseUrl: null };
    const cost = s.costPerCallUsd ?? p.defaultEstimatedCostPerCallUsd;
    lines.push(`providers.${p.id}  ${s.enabled ? 'on' : 'off'}, ~$${cost ?? '?'} a search (estimate${s.costPerCallUsd !== null ? ', overridden' : ''})${s.baseUrl ? `, ${s.baseUrl}` : ''}`);
  }
  return lines;
}

function bool(field: string, v: string): boolean {
  if (/^(on|true|yes|1)$/i.test(v)) return true;
  if (/^(off|false|no|0)$/i.test(v)) return false;
  throw new UsageError(`${field} is on or off.`);
}

function limit(field: string, v: string): number | null {
  if (/^(unlimited|null|none)$/i.test(v)) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${field} is a whole number of 1 or more, or unlimited.`);
  return n;
}

const list = (v: string) =>
  v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

export const ADMIN_FIELDS = 'enabled, order, shareDeploymentKey, allowUserKeys, limits.perRun, limits.perUserPerDay, limits.fetchPerRun, fetch.enabled, fetch.blockedHosts, providers.<id>.enabled, providers.<id>.costPerCallUsd, providers.<id>.baseUrl';

/** The body of `PUT /api/web-search/admin` for one `admin set <field> <value>`; the API validates it again. */
export function adminPatch(field: string, value: string): Record<string, unknown> {
  switch (field) {
    case 'enabled':
    case 'shareDeploymentKey':
    case 'allowUserKeys':
      return { [field]: bool(field, value) };
    case 'order':
      return { order: list(value) };
    case 'limits.perRun':
    case 'limits.perUserPerDay':
    case 'limits.fetchPerRun':
      return { limits: { [field.slice('limits.'.length)]: limit(field, value) } };
    case 'fetch.enabled':
      return { fetch: { enabled: bool(field, value) } };
    case 'fetch.blockedHosts':
      return { fetch: { blockedHosts: /^(none|-)$/i.test(value) ? [] : list(value) } };
  }
  const m = /^providers\.([a-z][a-z0-9_]{0,31})\.(enabled|costPerCallUsd|baseUrl)$/.exec(field);
  if (m) {
    const [, id, key] = m as unknown as [string, string, 'enabled' | 'costPerCallUsd' | 'baseUrl'];
    if (key === 'enabled') return { providers: { [id]: { enabled: bool(field, value) } } };
    if (key === 'baseUrl') return { providers: { [id]: { baseUrl: /^(none|null|default)$/i.test(value) ? null : value } } };
    if (/^(default|null)$/i.test(value)) return { providers: { [id]: { costPerCallUsd: null } } };
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new UsageError(`${field} is an amount in US dollars, or default.`);
    return { providers: { [id]: { costPerCallUsd: n } } };
  }
  throw new UsageError(`Unknown field "${field}". Fields: ${ADMIN_FIELDS}.`);
}

/** Where a key is read from. Tests swap them; nothing here prints what is read. */
export interface KeyReaders {
  /** A prompt that does not echo what is typed. */
  hidden(prompt: string): Promise<string>;
  /** Everything on standard input, trimmed. */
  stdin(): Promise<string>;
  /** Standard input is a terminal (a prompt is possible). */
  isTTY(): boolean;
}

/** Reads a line from the terminal without echoing it: raw mode, Enter ends it, Ctrl-C cancels. */
export function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    process.stderr.write(prompt);
    let value = '';
    const done = (err?: Error) => {
      input.off('data', onData);
      input.setRawMode?.(false);
      input.pause();
      process.stderr.write('\n');
      if (err) reject(err);
      else resolve(value.trim());
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done();
        if (ch === '\u0003') return done(new UsageError('Cancelled.'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    input.setRawMode?.(true);
    input.resume();
    input.on('data', onData);
  });
}

export async function readAllStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += String(chunk);
  return data.trim();
}

export const DEFAULT_KEY_READERS: KeyReaders = { hidden: readHidden, stdin: readAllStdin, isTTY: () => Boolean(process.stdin.isTTY) };
