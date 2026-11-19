// The match of a mail trigger (E39.8, #605): the structured rules, their validation, and the server's own re-check of a message
// against them. The provider search narrows the candidates (`toMailQuery`); this decides. Pure: no I/O.
//
// A sender is REQUIRED. That is the protection: without it, anyone who can email the owner could start the owner's tasks. A rule is
// an exact address (`person-a@example.test`) or a domain (`@example.test`, exactly that domain). A domain every person can have an
// address at (a free mail service) is refused: it would match anyone, so it needs an exact address.
import { z } from 'zod';

import type { MailMessage, MailQuery, MailSummary } from '../connections/capabilities';

/** Domains anybody can get an address at: a domain rule on one of them is a rule for anyone. Exact addresses are fine. */
export const OPEN_MAIL_DOMAINS: readonly string[] = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'zoho.com', 'mail.com', 'yandex.com', 'fastmail.com', 'hey.com',
];

const DOMAIN = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ADDRESS = /^[^\s@<>"',;()]{1,64}@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;

export type FromRule = { kind: 'address'; value: string } | { kind: 'domain'; value: string };

/** One `from` entry as written (`Person@Example.test`, `@example.test`, `example.test`) or the problem with it. */
export function parseFromRule(raw: string): { ok: true; rule: FromRule; text: string } | { ok: false; message: string } {
  const t = raw.trim().toLowerCase();
  if (!t) return { ok: false, message: 'Enter an address or a domain' };
  if (t.includes('*') || t.includes(' ')) return { ok: false, message: 'No wildcards: give an exact address or one domain' };
  if (t.includes('@') && !t.startsWith('@')) {
    return ADDRESS.test(t) ? { ok: true, rule: { kind: 'address', value: t }, text: t } : { ok: false, message: 'This is not an email address' };
  }
  const domain = t.startsWith('@') ? t.slice(1) : t;
  if (!DOMAIN.test(domain)) return { ok: false, message: 'This is not a domain (write it as @example.test)' };
  if (OPEN_MAIL_DOMAINS.includes(domain)) return { ok: false, message: `${domain} lets anyone have an address: give the exact address instead` };
  return { ok: true, rule: { kind: 'domain', value: domain }, text: `@${domain}` };
}

const oneLine = (max: number) => z.string().trim().min(1).max(max).refine((v) => !CONTROL.test(v), { message: 'One line, no control characters' });

export const mailMatchSchema = z
  .object({
    from: z
      .array(z.string().max(320))
      .min(1, 'A sender is required: an address or a domain')
      .max(20)
      .describe('Required: at least one exact address (`person-a@example.test`) or one domain (`@example.test`, exactly that domain). A domain anybody can have an address at is refused.')
      .superRefine((list, ctx) => {
        list.forEach((raw, i) => {
          const r = parseFromRule(raw);
          if (!r.ok) ctx.addIssue({ code: 'custom', path: [i], message: r.message });
        });
      }),
    to: oneLine(320).optional().describe('The message was sent to this address (To).'),
    subjectContains: oneLine(200).optional(),
    textContains: oneLine(200).optional().describe('Words that must appear in the text body.'),
    hasAttachment: z.boolean().optional(),
    label: oneLine(200).optional().describe('A label or folder id from the connection; default is the inbox.'),
  })
  .strict();
export type MailMatch = z.infer<typeof mailMatchSchema>;

/** The match as it is stored: each sender in its canonical form (lower case, `@domain`), without duplicates. Call it on a validated match. */
export function normalizeMatch(m: MailMatch): MailMatch {
  const from: string[] = [];
  for (const raw of m.from) {
    const r = parseFromRule(raw);
    if (r.ok && !from.includes(r.text)) from.push(r.text);
  }
  return { ...m, from };
}

/** The stored match, read defensively (an old row never throws). */
export function readMatch(raw: unknown): MailMatch | null {
  const r = mailMatchSchema.safeParse(raw);
  return r.success ? normalizeMatch(r.data) : null;
}

/** The label the provider search is limited to: the match's own, else the inbox. */
export const DEFAULT_LABEL = 'INBOX';

/** The provider query for the candidates. A hint only: every message is re-checked by `matchMessage`. */
export function toMailQuery(match: MailMatch, after: string, pageSize = 50): MailQuery {
  const rules = match.from.map((f) => parseFromRule(f)).flatMap((r) => (r.ok ? [r.rule] : []));
  return {
    // A provider takes one sender term: with several rules the search is wide (no `from`) and the re-check narrows.
    ...(rules.length === 1 ? { from: rules[0]!.value } : {}),
    ...(match.to ? { to: match.to } : {}),
    ...(match.subjectContains ? { subject: match.subjectContains } : {}),
    ...(match.hasAttachment !== undefined ? { hasAttachment: match.hasAttachment } : {}),
    label: match.label ?? DEFAULT_LABEL,
    after,
    pageSize,
  };
}

const lower = (s: string | null | undefined) => (s ?? '').toLowerCase();

/** The From address against the rules: an exact address, or exactly the domain. */
export function senderMatches(from: string[], address: string | null | undefined): boolean {
  const a = lower(address).trim();
  const at = a.lastIndexOf('@');
  if (at < 1) return false;
  const domain = a.slice(at + 1);
  return from.some((f) => {
    const r = parseFromRule(f);
    if (!r.ok) return false;
    return r.rule.kind === 'address' ? r.rule.value === a : r.rule.value === domain;
  });
}

export type MatchVerdict = { ok: true } | { ok: false; reason: 'sender' | 'to' | 'subject' | 'text' | 'attachment' | 'label' | 'before_active' };

/**
 * The server's check of a message against the match, on the headers it got (never the provider's say-so). `text` is the plain body, given
 * only when `textContains` is set. A message that arrived before `activeSince` never matches.
 */
export function matchMessage(match: MailMatch, m: Pick<MailSummary, 'from' | 'to' | 'subject' | 'hasAttachments' | 'labels' | 'date'>, opts: { activeSince: Date; text?: string | null }): MatchVerdict {
  if (!senderMatches(match.from, m.from?.address)) return { ok: false, reason: 'sender' };
  if (!m.date || new Date(m.date).getTime() < opts.activeSince.getTime()) return { ok: false, reason: 'before_active' };
  if (match.to && !m.to.some((t) => lower(t.address) === lower(match.to))) return { ok: false, reason: 'to' };
  if (match.subjectContains && !lower(m.subject).includes(lower(match.subjectContains))) return { ok: false, reason: 'subject' };
  if (match.hasAttachment !== undefined && m.hasAttachments !== match.hasAttachment) return { ok: false, reason: 'attachment' };
  if (match.label && !m.labels.includes(match.label)) return { ok: false, reason: 'label' };
  if (!match.label && m.labels.length > 0 && !m.labels.some((l) => lower(l) === lower(DEFAULT_LABEL))) return { ok: false, reason: 'label' };
  if (match.textContains && !lower(opts.text).includes(lower(match.textContains))) return { ok: false, reason: 'text' };
  return { ok: true };
}

/** The message as the owner's own address sent it: a run's own mail, or the owner writing to themselves. Never starts a run. */
export const isOwnMessage = (m: Pick<MailMessage, 'from'> | Pick<MailSummary, 'from'>, accountEmail: string): boolean => lower(m.from?.address) === lower(accountEmail);
