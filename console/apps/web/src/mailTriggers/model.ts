// The form model of an email trigger (E39.8, #605): the draft the dialog edits, its checks, and the words the page uses. Pure.
import type { InputSource, MailTrigger, TriggerBody, TriggerEvent, TriggerInputs, PreviewMessage } from './api';

export const POLL_CHOICES = [
  { minutes: 1, label: 'Every minute' },
  { minutes: 5, label: 'Every 5 minutes' },
  { minutes: 15, label: 'Every 15 minutes' },
  { minutes: 60, label: 'Every hour' },
] as const;

export type MappingKind = 'none' | 'fixed' | 'subject' | 'from' | 'date' | 'capture_subject' | 'capture_text';
export interface MappingDraft {
  kind: MappingKind;
  /** The fixed value, or the pattern. */
  value: string;
}

export const MAPPING_LABEL: Record<MappingKind, string> = {
  none: 'Not from the email',
  fixed: 'A fixed value',
  subject: 'The subject',
  from: "The sender's address",
  date: "The email's date",
  capture_subject: 'A part of the subject (pattern)',
  capture_text: 'A part of the text (pattern)',
};

export interface TriggerDraft {
  id?: string;
  name: string;
  connectionId: string;
  /** Senders as typed: addresses or `@domain`, separated by commas, spaces or new lines. */
  from: string;
  subjectContains: string;
  textContains: string;
  attachment: 'any' | 'with' | 'without';
  afterStart: 'none' | 'mark_read' | 'add_label';
  labelId: string;
  pollMinutes: number;
  maxRunsPerDay: number;
  acceptUnverified: boolean;
  enabled: boolean;
  mappings: Record<string, MappingDraft>;
}

export const newDraft = (connectionId = ''): TriggerDraft => ({
  name: '',
  connectionId,
  from: '',
  subjectContains: '',
  textContains: '',
  attachment: 'any',
  afterStart: 'none',
  labelId: '',
  pollMinutes: 5,
  maxRunsPerDay: 10,
  acceptUnverified: false,
  enabled: true,
  mappings: {},
});

/** The senders a text holds: split at commas, spaces and new lines, empty ones dropped, no repeats. */
export function splitSenders(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
}

const toMapping = (s: InputSource): MappingDraft => {
  if ('fixed' in s) return { kind: 'fixed', value: s.fixed };
  if ('header' in s) return { kind: s.header, value: '' };
  return { kind: s.capture.source === 'subject' ? 'capture_subject' : 'capture_text', value: s.capture.pattern };
};

const fromMapping = (m: MappingDraft): InputSource | null => {
  const v = m.value.trim();
  switch (m.kind) {
    case 'none':
      return null;
    case 'fixed':
      return v ? { fixed: v } : null;
    case 'subject':
    case 'from':
    case 'date':
      return { header: m.kind };
    case 'capture_subject':
      return v ? { capture: { source: 'subject', pattern: v } } : null;
    case 'capture_text':
      return v ? { capture: { source: 'text', pattern: v } } : null;
  }
};

export function draftFromTrigger(t: MailTrigger): TriggerDraft {
  const after = t.afterStart.startsWith('add_label:') ? 'add_label' : t.afterStart === 'mark_read' ? 'mark_read' : 'none';
  return {
    id: t.id,
    name: t.name,
    connectionId: t.connectionId,
    from: t.match.from.join('\n'),
    subjectContains: t.match.subjectContains ?? '',
    textContains: t.match.textContains ?? '',
    attachment: t.match.hasAttachment === true ? 'with' : t.match.hasAttachment === false ? 'without' : 'any',
    afterStart: after,
    labelId: after === 'add_label' ? t.afterStart.slice('add_label:'.length) : '',
    pollMinutes: Math.max(1, Math.round(t.pollSeconds / 60)),
    maxRunsPerDay: t.maxRunsPerDay,
    acceptUnverified: t.acceptUnverified,
    enabled: t.enabled,
    mappings: Object.fromEntries(Object.entries(t.inputs ?? {}).map(([k, s]) => [k, toMapping(s)])),
  };
}

/** What the form checks before it lets Save through (the server checks again, and is the authority). Messages by field. */
export function draftProblems(d: TriggerDraft, opts: { canModify: boolean }): Record<string, string> {
  const p: Record<string, string> = {};
  if (!d.connectionId) p.connectionId = 'Choose the account to watch';
  const senders = splitSenders(d.from);
  if (senders.length === 0) p.from = 'A sender is required: an address or a domain (@example.test). Without one, anyone who can email you could start this task.';
  else if (senders.some((s) => s.includes('*'))) p.from = 'No wildcards: give an exact address or one domain';
  else if (senders.length > 20) p.from = 'At most 20 senders';
  if (d.afterStart !== 'none' && !opts.canModify) p.afterStart = 'This needs the account\'s "change mail" switch (Settings, Connections)';
  if (d.afterStart === 'add_label' && !d.labelId.trim()) p.labelId = 'Enter the label to add';
  if (!Number.isInteger(d.maxRunsPerDay) || d.maxRunsPerDay < 1 || d.maxRunsPerDay > 100) p.maxRunsPerDay = 'From 1 to 100';
  for (const [key, m] of Object.entries(d.mappings)) {
    if ((m.kind === 'fixed' || m.kind === 'capture_subject' || m.kind === 'capture_text') && !m.value.trim()) p[`mapping:${key}`] = m.kind === 'fixed' ? 'Enter the value' : 'Enter the pattern';
    else if (m.kind.startsWith('capture') && !/\((?!\?)/.test(m.value)) p[`mapping:${key}`] = 'The pattern needs one group ( ) around the part to take';
  }
  return p;
}

export function draftToBody(d: TriggerDraft): TriggerBody {
  const inputs: TriggerInputs = {};
  for (const [k, m] of Object.entries(d.mappings)) {
    const s = fromMapping(m);
    if (s) inputs[k] = s;
  }
  return {
    ...(d.name.trim() ? { name: d.name.trim() } : {}),
    connectionId: d.connectionId,
    match: {
      from: splitSenders(d.from),
      ...(d.subjectContains.trim() ? { subjectContains: d.subjectContains.trim() } : {}),
      ...(d.textContains.trim() ? { textContains: d.textContains.trim() } : {}),
      ...(d.attachment !== 'any' ? { hasAttachment: d.attachment === 'with' } : {}),
    },
    inputs: Object.keys(inputs).length ? inputs : null,
    afterStart: d.afterStart === 'add_label' ? `add_label:${d.labelId.trim()}` : d.afterStart,
    pollSeconds: d.pollMinutes * 60,
    maxRunsPerDay: d.maxRunsPerDay,
    acceptUnverified: d.acceptUnverified,
    enabled: d.enabled,
  };
}

/** The rules in words: "from a@example.test, subject has "invoice", with an attachment". */
export function matchText(m: MailTrigger['match']): string {
  const parts = [`from ${m.from.join(' or ')}`];
  if (m.to) parts.push(`to ${m.to}`);
  if (m.subjectContains) parts.push(`subject has “${m.subjectContains}”`);
  if (m.textContains) parts.push(`text has “${m.textContains}”`);
  if (m.hasAttachment === true) parts.push('with an attachment');
  if (m.hasAttachment === false) parts.push('without an attachment');
  return parts.join(', ');
}

export const STATUS_TEXT: Record<MailTrigger['status'], { label: string; color: 'success' | 'warning' | 'error' | 'default' }> = {
  ok: { label: 'Watching', color: 'success' },
  needs_reconnect: { label: 'Reconnect the account', color: 'error' },
  failing: { label: 'Failing', color: 'error' },
  rate_limited: { label: 'Waiting: the provider asked to slow down', color: 'warning' },
  connection_paused: { label: 'Account paused', color: 'warning' },
  connection_removed: { label: 'Account removed', color: 'error' },
};

const REASON_TEXT: Record<string, string> = {
  SENDER_NOT_VERIFIED: 'sender not verified',
  SENDER_NOT_CHECKED: 'the provider could not check the sender',
  TRIGGER_DAILY_LIMIT: "this trigger's daily limit",
  USER_DAILY_LIMIT: 'your daily limit',
  OWN_MESSAGE: 'sent from the account itself',
  START_FAILED: 'the run could not be started',
};

/** One event as the list reads it: "Started a run", "Skipped: sender not verified". */
export function eventText(e: Pick<TriggerEvent, 'outcome' | 'reason'>): string {
  if (e.outcome === 'started') return 'Started a run';
  const why = e.reason ? (REASON_TEXT[e.reason] ?? e.reason.toLowerCase().replace(/_/g, ' ')) : null;
  if (e.outcome === 'failed') return `Could not start${why ? `: ${why}` : ''}`;
  return `Skipped${why ? `: ${why}` : ''}`;
}

const PREVIEW_REASON: Record<NonNullable<PreviewMessage['reason']>, string> = {
  before_enabled: 'arrived before the trigger was switched on',
  own_message: 'sent from the account itself',
  sender_not_verified: 'the sender did not pass the provider\'s check',
  sender_not_checked: 'the provider could not check the sender (allow unverified senders to accept these)',
};
export const previewReason = (m: Pick<PreviewMessage, 'wouldStart' | 'reason'>): string => (m.wouldStart ? 'Would start a run' : `Would not start: ${m.reason ? PREVIEW_REASON[m.reason] : 'it does not match'}`);
