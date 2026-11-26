// Plain words of the diagnostics panel (E50.14, #984): what each stage checks, a status in words, who must act, the facts a stage's
// `data` carries, the one-sentence summary, and the stages the panel expects for each kind of target (a determinate list while the one
// request runs). The titles and remedies of codes come from the remedy table the API and the CLI share (`@app/shared`, `diagnostics.json`).
import { DIAGNOSTIC_REMEDIES, type DiagnosticRemedy } from '@app/shared';

import { CAPABILITY_WORDS } from '../connections/words';
import type { Capability } from '../connections/api';
import type { DiagnosticReport, DiagnosticStage, DiagnosticTarget, StageStatus } from './api';

/** What a stage checks, by its id. An id this build does not know reads as its words ("live_query" → "Live query"). */
const STAGE_TITLES: Record<string, string> = {
  // Every connection.
  status: 'The connection is on',
  provider_installed: 'Available on this console',
  latency: 'Time taken',
  provider: "The provider's checks",
  // Google and Microsoft (connection and provider app).
  app_config: "The administrator's app",
  sign_in: 'Sign-in',
  token_lifetime: 'Staying signed in',
  permissions: 'Permissions granted',
  clock: 'Clock',
  redirect_uri: 'Redirect address',
  discovery: "The provider's sign-in service",
  client_check: 'Client id and secret',
  picker_key: 'File picker key',
  // MCP servers.
  server: 'The server answers',
  switch: 'Added tools are switched on here',
  address: 'Address',
  network: 'Network',
  initialize: 'The server starts a session',
  tool_list: 'The list of tools',
  tool_changes: 'Changed tools',
  enabled_tools: 'Tools switched on',
  offered_cap: 'Tools offered to the agent',
  // Search providers.
  switches: 'Switches',
  credential: 'Key',
  live_query: 'One real search',
  limits: 'Limits',
  fetch: 'Page reading',
};

export function stageTitle(id: string): string {
  if (id.startsWith('capability:')) {
    const cap = id.slice('capability:'.length) as Capability;
    return CAPABILITY_WORDS[cap] ?? words(cap);
  }
  return STAGE_TITLES[id] ?? words(id);
}

const words = (id: string): string => {
  const s = id.replace(/[_:]+/g, ' ').trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : 'Check';
};

export const STATUS_WORDS: Record<StageStatus, string> = { pass: 'Passed', warn: 'Warning', fail: 'Failed', skipped: 'Skipped' };
export const OVERALL_WORDS: Record<StageStatus, string> = { pass: 'Working', warn: 'Working, with a warning', fail: 'Problem', skipped: 'Not checked' };
export const WHO_WORDS: Record<DiagnosticRemedy['who'], string> = { owner: 'You', admin: 'Your administrator' };

/** The remedy table entry of a stage (its remedy key, else its code), or null. */
export function remedyOf(s: Pick<DiagnosticStage, 'code' | 'remedy'>): DiagnosticRemedy | null {
  return (s.remedy && DIAGNOSTIC_REMEDIES[s.remedy]) || (s.code && DIAGNOSTIC_REMEDIES[s.code]) || null;
}

/** Google's API ids in words (a closed list; `data.api`). */
export const GOOGLE_API_NAMES: Record<string, string> = {
  'gmail.googleapis.com': 'Gmail API',
  'calendar-json.googleapis.com': 'Google Calendar API',
  'drive.googleapis.com': 'Google Drive API',
  'docs.googleapis.com': 'Google Docs API',
  'sheets.googleapis.com': 'Google Sheets API',
  'people.googleapis.com': 'People API',
};

const HOST_KEYS = /(^|_)host$/;
export const isHostKey = (k: string) => HOST_KEYS.test(k);

/** `1.2 s`, `340 ms`. */
export function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

const FACT_WORDS: Record<string, (v: string | number | boolean) => string> = {
  api: (v) => GOOGLE_API_NAMES[String(v)] ?? String(v),
  tools: (v) => `${v} ${v === 1 ? 'tool' : 'tools'}`,
  changed: (v) => `${v} ${v === 1 ? 'tool' : 'tools'} changed`,
  new: (v) => `${v} new ${v === 1 ? 'tool' : 'tools'}`,
  enabled: (v) => (typeof v === 'boolean' ? (v ? 'Switched on' : 'Switched off') : `${v} switched on`),
  hits: (v) => `${v} ${v === 1 ? 'result' : 'results'}`,
  count: (v) => `${v} ${v === 1 ? 'tool' : 'tools'} listed`,
  pages: (v) => `${v} ${v === 1 ? 'page' : 'pages'}`,
  removed: (v) => `${v} removed`,
  read: (v) => `${v} on Read`,
  write: (v) => `${v} on Write`,
  cap: (v) => `at most ${v} a run`,
  toolbox: (v) => (v ? 'Offered behind a toolbox' : 'Offered directly'),
  not_offered: (v) => `${v} not offered directly`,
  position: (v) => `Number ${v} in the order`,
  calls: (v) => `${v} today`,
  limit: (v) => `limit ${v}`,
  unlimited: (v) => (v ? 'No daily limit' : 'Daily limit'),
  installed: (v) => (v ? 'Installed' : 'Not installed'),
  ms: (v) => duration(Number(v)),
  https: (v) => (v ? 'https' : 'not https'),
  matches_public: (v) => (v ? "Matches the console's address" : "Does not match the console's address"),
  tier: (v) => (v === 'user' ? 'Your own key' : v === 'system' ? "The deployment's key" : v === 'organization' ? "Your organization's key" : String(v)),
};

/** A stage's `data` as small facts ("Gmail API", "3 tools changed", "1.2 s"). Host names are shown here, never copied unless asked. */
export function facts(s: Pick<DiagnosticStage, 'data' | 'ms'>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(s.data ?? {})) {
    const f = FACT_WORDS[k];
    if (f) out.push(f(v));
    else if (isHostKey(k)) out.push(String(v));
    else out.push(`${words(k)}: ${typeof v === 'boolean' ? (v ? 'yes' : 'no') : v}`);
  }
  if (s.ms !== null && s.ms !== undefined && !(s.data && 'ms' in s.data)) out.push(duration(s.ms));
  return out;
}

/** The first failing stage, else the first warning, else null. */
export function firstProblem(r: Pick<DiagnosticReport, 'stages'>): DiagnosticStage | null {
  return r.stages.find((s) => s.status === 'fail') ?? r.stages.find((s) => s.status === 'warn') ?? null;
}

/** One sentence at the top: what is wrong and what to do, or that everything works. */
export function summarySentence(r: Pick<DiagnosticReport, 'overall' | 'stages'>): string {
  const p = firstProblem(r);
  if (r.overall === 'skipped' || r.stages.length === 0) return 'Nothing could be checked.';
  if (!p) return 'Everything works.';
  const remedy = remedyOf(p);
  const title = remedy?.title ?? `${stageTitle(p.id)}: ${STATUS_WORDS[p.status].toLowerCase()}`;
  const prefix = p.status === 'fail' ? '' : 'It works, but: ';
  return `${prefix}${title}. ${remedy?.remedy ?? 'Run it again; if it keeps failing, ask your administrator.'}`;
}

/**
 * The stages the panel shows while the one request runs, in order. The report replaces them when it comes back (it may hold more
 * or fewer: a provider's own stages, a capability switched off since).
 */
export function expectedStages(t: DiagnosticTarget): string[] {
  switch (t.kind) {
    case 'connection':
      if (t.provider === 'mcp') return ['status', 'provider_installed', 'switch', 'address', 'network', 'initialize', 'sign_in', 'tool_list', 'tool_changes', 'enabled_tools', 'latency'];
      return ['status', 'provider_installed', 'app_config', 'sign_in', 'token_lifetime', 'permissions', ...t.capabilities.map((c) => `capability:${c}`), 'clock', 'latency'];
    case 'provider_app':
      return t.provider === 'google' ? ['app_config', 'redirect_uri', 'discovery', 'client_check', 'picker_key'] : ['app_config', 'redirect_uri', 'discovery', 'client_check'];
    case 'search_provider':
      return ['switches', 'credential', 'network', 'live_query', 'limits', 'fetch'];
  }
}

/** Codes a new sign-in fixes: the panel offers the reconnect flow for them. */
export const RECONNECT_CODES = new Set(['CONNECTION_NEEDS_RECONNECT', 'GRANT_REVOKED', 'NO_REFRESH_TOKEN', 'TOKEN_STORE_FAILED', 'AUTH_REFUSED', 'NO_SECRET', 'NEEDS_A_SIGN_IN', 'PERMISSION_MISSING']);

/** Where a provider's own console is, for a remedy whose `link` is `provider_console` (a closed list; a link, never a call). */
export function providerConsoleUrl(provider: string, s: Pick<DiagnosticStage, 'data'>): string | null {
  if (provider === 'google') {
    const api = s.data?.api;
    return typeof api === 'string' && api in GOOGLE_API_NAMES ? `https://console.cloud.google.com/apis/library/${api}` : 'https://console.cloud.google.com/apis/dashboard';
  }
  if (provider === 'microsoft') return 'https://entra.microsoft.com/';
  return null;
}
