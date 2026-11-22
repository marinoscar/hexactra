// The rules a site fact must satisfy before a store keeps it (E46.30). `validateSiteFact` returns typed violations (empty: valid) and never
// throws on bad input. A fact is data: the instruction check is defence in depth (the owner still approves every fact before it is used).
import { registrableDomain } from '../compile/compile';
import { SITE_FACT_MAX_TEXT, siteFactEvidenceSchema, siteFactKindSchema, siteFactSourceSchema } from '../schema/site-fact';
import { registrableDomainSchema } from '../schema/core';
import { defaultIsSensitive } from './sensitive';

/**
 * Whether text holds Secret Material.
 *
 * A correct binding guarantees: it applies the host's own secret rules (in the console, the memories secret check and the sensitive-pattern
 * table), it never throws, and it never records or sends the text it reads.
 */
export interface SecretCheckPort {
  hasSecret(text: string): boolean;
}

/** The package's fallback: `defaultIsSensitive` over the whole text. */
export const defaultSecretCheck: SecretCheckPort = Object.freeze({ hasSecret: (text: string) => defaultIsSensitive(text) });

export const SITE_FACT_RULES = ['schema', 'length', 'domain', 'secret', 'instruction'] as const;
export type SiteFactRule = (typeof SITE_FACT_RULES)[number];

export interface SiteFactViolation {
  rule: SiteFactRule;
  message: string;
}

export interface ValidateSiteFactOptions {
  /** The host's secret rules. Default: `defaultSecretCheck`. */
  secretCheck?: SecretCheckPort;
}

/** Instruction-shaped phrases: a fact says what a site is like, never what to do about authority, recipients or confirmations. */
const INSTRUCTION_PHRASES: readonly RegExp[] = [
  /\bignore\b/i,
  /\bdisregard\b/i,
  /\balways\s+(?:allow|approve|accept|confirm|pay|send)\b/i,
  /\b(?:send|forward|transfer|wire|email|mail)\s+(?:\S+\s+){0,3}?to\b/i,
  /\b(?:without|don'?t|do\s+not|never)\s+(?:asking|ask|confirm(?:ing)?|check(?:ing)?)\b/i,
  /\b(?:new|previous|prior|system)\s+(?:instructions?|prompt)\b/i,
  /\byou\s+(?:must|should|are\s+allowed)\b/i,
];

const URL_HOSTS = /\b(?:https?:\/\/|www\.)([a-z0-9.-]+)/gi;
const BARE_HOSTS = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})\b/gi;

/** The hosts a text names (URLs and bare domains), lower case. */
function hostsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(URL_HOSTS)) out.add(m[1]!.toLowerCase().replace(/\.$/, ''));
  for (const m of text.matchAll(BARE_HOSTS)) out.add(m[1]!.toLowerCase());
  return [...out];
}

/** Whether `host` is `site` or one of its subdomains. */
const onSite = (host: string, site: string) => host === site || host.endsWith(`.${site}`);

/** Validate an unknown value as a site fact (or a proposal: `id`, `status` and the times are checked only when present). */
export function validateSiteFact(input: unknown, options: ValidateSiteFactOptions = {}): SiteFactViolation[] {
  const out: SiteFactViolation[] = [];
  const check = options.secretCheck ?? defaultSecretCheck;
  const f = (input ?? {}) as Record<string, unknown>;
  if (typeof input !== 'object' || input === null) return [{ rule: 'schema', message: 'a site fact is an object' }];

  const site = typeof f.site === 'string' ? f.site : '';
  if (!registrableDomainSchema.safeParse(site).success || registrableDomain(site) !== site) out.push({ rule: 'domain', message: `'${site.slice(0, 100)}' is not a registrable domain (one site, such as example.com, lower case, no subdomain)` });

  const kind = siteFactKindSchema.safeParse(f.kind);
  if (!kind.success) out.push({ rule: 'schema', message: 'kind: must be navigation, sign_in, quirk, timing or other' });
  const source = siteFactSourceSchema.safeParse(f.source);
  if (!source.success) out.push({ rule: 'schema', message: 'source: must be owner, derived or agent_proposed' });
  if (f.evidence !== undefined && !siteFactEvidenceSchema.safeParse(f.evidence).success) out.push({ rule: 'schema', message: 'evidence: only runId, stepIds and screenIds, as ids' });
  if (f.status !== undefined && !['proposed', 'active', 'archived'].includes(f.status as string)) out.push({ rule: 'schema', message: 'status: must be proposed, active or archived' });

  if (typeof f.text !== 'string' || f.text.trim().length === 0) {
    out.push({ rule: 'schema', message: 'text: a fact has text' });
    return out;
  }
  const text = f.text;
  if (text.length > SITE_FACT_MAX_TEXT) out.push({ rule: 'length', message: `text: at most ${SITE_FACT_MAX_TEXT} characters (it has ${text.length})` });
  // The secret check reads the whole text; nothing of it is echoed in the message.
  let secret = false;
  try {
    secret = check.hasSecret(text);
  } catch {
    secret = true;
  }
  if (secret) out.push({ rule: 'secret', message: 'text: a fact never holds a password, code, token or full card, account or ID number' });
  for (const p of INSTRUCTION_PHRASES) {
    if (p.test(text)) {
      out.push({ rule: 'instruction', message: 'text: a fact says what the site is like, never an instruction' });
      break;
    }
  }
  const foreign = hostsIn(text).filter((h) => !(site && onSite(h, site)));
  if (foreign.length > 0 && !out.some((v) => v.rule === 'instruction')) out.push({ rule: 'instruction', message: 'text: a fact names no other site and no link away from its own' });
  return out;
}
