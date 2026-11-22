// Site facts in the console (E46.33, #855): the labels, the kind-and-text fields and the refusal shown under them. A fact's text is data
// about one site, rendered as text everywhere; a refused fact names the rule it broke and never echoes what was typed.
import { Chip, MenuItem, Stack, TextField } from '@mui/material';
import { isPlatformApiError } from '@marinoscar/platform-web/core';

import { SITE_FACT_KINDS, SITE_FACT_MAX_TEXT, type KgSiteFactKind, type KgSiteFactSource, type KgSiteFactStatus } from './api';

export const FACT_KIND_LABEL: Record<KgSiteFactKind, string> = { navigation: 'Where things are', sign_in: 'Signing in', quirk: 'Quirks', timing: 'Timing', other: 'Other' };
export const factKindLabel = (kind: string) => FACT_KIND_LABEL[kind as KgSiteFactKind] ?? kind;

export const FACT_SOURCE_LABEL: Record<KgSiteFactSource, string> = { owner: 'You wrote it', derived: 'Learned from a run', agent_proposed: 'Proposed by the agent' };
export const factSourceLabel = (source: string) => FACT_SOURCE_LABEL[source as KgSiteFactSource] ?? source;

const STATUS_LABEL: Record<KgSiteFactStatus, string> = { active: 'Active', proposed: 'Waiting for review', archived: 'Archived' };
const STATUS_COLOR: Record<KgSiteFactStatus, 'success' | 'info' | 'default'> = { active: 'success', proposed: 'info', archived: 'default' };
export function FactStatusChip({ status }: { status: KgSiteFactStatus }) {
  return <Chip size="small" variant={status === 'active' ? 'filled' : 'outlined'} color={STATUS_COLOR[status] ?? 'default'} label={STATUS_LABEL[status] ?? status} />;
}

/** Each rule of `validateSiteFact`, in words. Never the text that broke it. */
export const FACT_RULE_TEXT: Record<string, string> = {
  secret: 'It looks like a password, code, token or full card, account or ID number. A fact never holds one.',
  instruction: 'It reads as an instruction, or names another site or a link away from this one. A fact says what the site is like.',
  domain: 'That is not one site. Use its registrable domain, such as example.com, in lower case.',
  length: `A fact has at most ${SITE_FACT_MAX_TEXT} characters.`,
  schema: 'Something is missing or not allowed in this fact.',
};

/** Where a refusal shows: under the text, or under the site. */
export interface FactRefusal {
  field: 'text' | 'site';
  message: string;
}

/**
 * A `422 KGRAPH_SITE_FACT_REFUSED` (its `details.rules`) or a `400` on the site, as the line under the field; `null` for any other
 * failure (the caller shows that in its banner). The API's own message is not used: it is replaced by the rule's words.
 */
export function factRefusal(e: unknown): FactRefusal | null {
  if (!isPlatformApiError(e)) return null;
  if (e.code === 'KGRAPH_SITE_FACT_REFUSED') {
    const raw = (e.details as { rules?: unknown } | undefined)?.rules;
    const rules = Array.isArray(raw) ? raw.filter((r): r is string => typeof r === 'string') : [];
    if (rules.length === 1 && rules[0] === 'domain') return { field: 'site', message: FACT_RULE_TEXT.domain! };
    const words = rules.filter((r) => r !== 'domain').map((r) => FACT_RULE_TEXT[r] ?? FACT_RULE_TEXT.schema!);
    return { field: 'text', message: words.length ? [...new Set(words)].join(' ') : FACT_RULE_TEXT.schema! };
  }
  if (e.status === 400) return { field: 'site', message: FACT_RULE_TEXT.domain! };
  return null;
}

export interface FactFieldsProps {
  kind: KgSiteFactKind;
  text: string;
  onKind: (k: KgSiteFactKind) => void;
  onText: (t: string) => void;
  /** The refusal of the last save, shown under the text. */
  error?: string | null;
  disabled?: boolean;
  /** A prefix for the fields' ids. */
  idPrefix: string;
  autoFocus?: boolean;
}

/** The kind and the text of a fact, with the refusal under the text. */
export function FactFields({ kind, text, onKind, onText, error, disabled, idPrefix, autoFocus }: FactFieldsProps) {
  const over = text.length > SITE_FACT_MAX_TEXT;
  return (
    <Stack spacing={1.5} sx={{ minWidth: 0 }}>
      <TextField select size="small" id={`${idPrefix}-kind`} label="Kind" value={kind} disabled={disabled} onChange={(e) => onKind(e.target.value as KgSiteFactKind)} sx={{ maxWidth: { sm: 260 } }}>
        {SITE_FACT_KINDS.map((k) => (
          <MenuItem key={k} value={k}>
            {FACT_KIND_LABEL[k]}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        id={`${idPrefix}-text`}
        label="Fact"
        value={text}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(e) => onText(e.target.value)}
        multiline
        minRows={2}
        fullWidth
        error={!!error || over}
        helperText={error ?? (over ? FACT_RULE_TEXT.length : `What the site is like, in your words. No passwords or codes. ${text.length}/${SITE_FACT_MAX_TEXT}`)}
      />
    </Stack>
  );
}
