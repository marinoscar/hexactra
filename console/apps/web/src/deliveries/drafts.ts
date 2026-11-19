// The delivery editor's model (E39.10, #607; the API is E39.6, #603): what a delivery looks like while the owner edits it, the words
// that summarise it, the checks that mirror the server's, and the plan of requests that saves a changed list. Pure; no request here.
//
// A delivery is deterministic: a job reads the finished run and these settings and sends. Recipients, destinations and file names are
// fixed here, by the owner. Nothing in a run can add or redirect one.
import type { TaskOutput } from '../taskOutputs/model';
import { effectiveKeys, outputKey } from '../taskOutputs/model';
import type { Connection } from '../connections/api';
import type { DeliveryKind } from './model';

export type DeliveryWhen = 'always' | 'succeeded' | 'failed' | 'needs_attention';
export const WHEN_ORDER: readonly DeliveryWhen[] = ['succeeded', 'always', 'failed', 'needs_attention'];
export const WHEN_LABEL: Record<DeliveryWhen, string> = { succeeded: 'When it succeeds', always: 'Every time', failed: 'When it fails', needs_attention: 'When it needs my attention' };
const WHEN_PHRASE: Record<DeliveryWhen, string> = { succeeded: 'when it succeeds', always: 'every time', failed: 'when it fails', needs_attention: 'when it needs attention' };

export const MAX_DELIVERIES = 10;
export const MAX_RECIPIENTS = 10;
export const MAX_COLUMNS = 50;
export const SUBJECT_MAX = 200;
export const NAME_TEMPLATE_MAX = 120;
export const DEFAULT_SUBJECT = '{{task}}: {{status}} on {{date}}';
export const DEFAULT_NAME_TEMPLATE = '{{task}} {{date}}';

export type Screenshots = 'none' | 'final' | 'all';
export const RUN_FIELDS = ['run_date', 'status', 'task', 'goal', 'result', 'run_link', 'report_link', 'cost', 'steps'] as const;
export type RunField = (typeof RUN_FIELDS)[number];
export const RUN_FIELD_LABEL: Record<RunField, string> = {
  run_date: 'Run date',
  status: 'Status',
  task: 'Task',
  goal: 'Goal',
  result: 'Result',
  run_link: 'Link to the run',
  report_link: 'Link to the report',
  cost: 'Cost',
  steps: 'Steps',
};

export type ColumnSource = { kind: 'output'; key: string } | { kind: 'field'; field: RunField };
export interface SheetColumn {
  header: string;
  value: ColumnSource;
}

export interface EmailConfig {
  via: 'console' | { connectionId: string };
  to: string[];
  cc?: string[];
  subject?: string;
  attach: { pdf: boolean; json: boolean; screenshots: Screenshots };
  includeOutputs: boolean;
  includeSensitive: boolean;
}
export interface WebhookConfig {
  url: string;
  includeOutputs: boolean;
  includeReportLink: boolean;
  includeSensitive: boolean;
}
export interface SheetRowConfig {
  connectionId: string;
  fileId?: string;
  sheet?: string;
  newTitle?: string;
  columns: SheetColumn[];
  createIfMissing: boolean;
  includeSensitive: boolean;
}
export interface FolderConfig {
  target: 'storage' | { connectionId: string; folderId: string };
  files: { pdf: boolean; json: boolean; screenshots: Screenshots };
  nameTemplate: string;
}
export type DeliveryConfig = EmailConfig | WebhookConfig | SheetRowConfig | FolderConfig;

/** A delivery as `GET /tasks/{id}/deliveries` answers it. */
export interface TaskDelivery {
  id: string;
  taskId: string;
  kind: DeliveryKind;
  enabled: boolean;
  when: DeliveryWhen;
  position: number;
  config: Record<string, unknown>;
  recipients: { address: string; state: 'own' | 'confirmed' | 'unconfirmed' | 'unsubscribed' }[];
  connection: { id: string; label: string | null } | null;
  disabledReason: 'connection_removed' | null;
  webhookSecretConfigured: boolean | null;
  createdAt: string;
  updatedAt: string;
}

/** A delivery while it is edited: saved ones carry their `id`; a new one has none until the task is saved. */
export interface DeliveryDraft {
  /** Stable in the form (a saved delivery's own id, a new one's local key). */
  key: string;
  id: string | null;
  kind: DeliveryKind;
  enabled: boolean;
  when: DeliveryWhen;
  config: DeliveryConfig;
  /** Why the system switched it off (a removed connection): the owner points it at another account to switch it on. */
  disabledReason?: 'connection_removed' | null;
  /** Names the chooser learned (a file's or a folder's name), for the summary only. Never sent. */
  labels?: { file?: string; folder?: string };
}

let seq = 0;
export const newKey = (): string => `new-${(seq += 1)}`;

export const KIND_ORDER: readonly DeliveryKind[] = ['email', 'sheet_row', 'folder', 'webhook'];
export const KIND_ADD_LABEL: Record<DeliveryKind, string> = { email: 'Email', sheet_row: 'Spreadsheet row', folder: 'Save to a folder', webhook: 'Webhook' };

/** What a connection can do for a delivery kind. */
export const connectionFits = (c: Pick<Connection, 'capabilities' | 'status' | 'provider'>, kind: DeliveryKind): boolean =>
  c.provider !== 'mcp' && (kind === 'email' ? c.capabilities.includes('mail_send') : kind === 'sheet_row' || kind === 'folder' ? c.capabilities.includes('docs_write') : false);

// ---- Starting points ----

export function emailDefaults(ownAddress: string | null): EmailConfig {
  return { via: 'console', to: ownAddress ? [ownAddress] : [], attach: { pdf: true, json: false, screenshots: 'none' }, includeOutputs: true, includeSensitive: false };
}

export function newDraft(kind: DeliveryKind, ctx: { ownAddress?: string | null; outputs?: readonly TaskOutput[]; connections?: readonly Connection[] } = {}): DeliveryDraft {
  const base = { key: newKey(), id: null, kind, enabled: true, when: 'succeeded' as DeliveryWhen };
  if (kind === 'email') return { ...base, config: emailDefaults(ctx.ownAddress ?? null) };
  if (kind === 'webhook') return { ...base, config: { url: '', includeOutputs: true, includeReportLink: true, includeSensitive: false } satisfies WebhookConfig };
  if (kind === 'folder') return { ...base, config: { target: 'storage', files: { pdf: true, json: false, screenshots: 'none' }, nameTemplate: DEFAULT_NAME_TEMPLATE } satisfies FolderConfig };
  const first = (ctx.connections ?? []).find((c) => connectionFits(c, 'sheet_row'));
  return { ...base, config: { connectionId: first?.id ?? '', columns: fillFromOutputs(ctx.outputs ?? [], []), createIfMissing: false, includeSensitive: false } satisfies SheetRowConfig };
}

/** A saved delivery as a draft. An unknown shape stays as it is: the editor shows what it can. */
export function draftFromDelivery(d: TaskDelivery): DeliveryDraft {
  return { key: d.id, id: d.id, kind: d.kind, enabled: d.enabled, when: d.when, config: d.config as unknown as DeliveryConfig, disabledReason: d.disabledReason };
}

/**
 * "Fill from outputs": one column per output of the task, after the columns already there (an output already mapped is not added twice).
 * The run date comes first when there are no columns yet: a log row without a date is hard to read.
 */
export function fillFromOutputs(outputs: readonly TaskOutput[], existing: readonly SheetColumn[]): SheetColumn[] {
  const keys = effectiveKeys(outputs.filter((o) => o.label.trim() !== ''));
  const labels = outputs.filter((o) => o.label.trim() !== '').map((o) => o.label.trim());
  const mapped = new Set(existing.flatMap((c) => (c.value.kind === 'output' ? [c.value.key] : [])));
  const out = [...existing];
  if (out.length === 0) out.push({ header: RUN_FIELD_LABEL.run_date, value: { kind: 'field', field: 'run_date' } });
  keys.forEach((key, i) => {
    if (!mapped.has(key)) out.push({ header: labels[i]!, value: { kind: 'output', key } });
  });
  return out.slice(0, MAX_COLUMNS);
}

/** The "keep a record of each run" starting point of the guided setup (E39.10): an email with the report and a row per run. */
export function recordKeepingDrafts(ctx: { ownAddress: string | null; outputs: readonly TaskOutput[]; connections: readonly Connection[] }): DeliveryDraft[] {
  const mailer = ctx.connections.find((c) => connectionFits(c, 'email'));
  const email = newDraft('email', { ownAddress: ctx.ownAddress });
  if (mailer && ctx.ownAddress === null) (email.config as EmailConfig).via = { connectionId: mailer.id };
  const sheet = newDraft('sheet_row', { outputs: ctx.outputs, connections: ctx.connections });
  (sheet.config as SheetRowConfig).createIfMissing = true;
  return [email, sheet];
}

// ---- Words ----

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function filesPhrase(f: { pdf: boolean; json: boolean; screenshots: Screenshots }): string {
  const parts = [f.pdf && 'the PDF report', f.json && 'the JSON trace', f.screenshots === 'final' && 'the last picture', f.screenshots === 'all' && 'the step pictures'].filter(Boolean) as string[];
  if (parts.length === 0) return 'no files';
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** One line: "Email to 2 people with the PDF report, when it succeeds". */
export function summarize(d: DeliveryDraft, connections: readonly Connection[]): string {
  const when = WHEN_PHRASE[d.when];
  const labelOf = (id: string) => connections.find((c) => c.id === id)?.label ?? 'a removed account';
  if (d.kind === 'email') {
    const c = d.config as EmailConfig;
    const n = new Set([...(c.to ?? []), ...(c.cc ?? [])].map((a) => a.toLowerCase())).size;
    const who = n === 0 ? 'no one yet' : n === 1 ? '1 person' : `${n} people`;
    const from = c.via !== 'console' ? ` from ${labelOf(c.via.connectionId)}` : '';
    const attached = c.attach?.pdf || c.attach?.json || c.attach?.screenshots !== 'none' ? ` with ${filesPhrase(c.attach)}` : '';
    return `Email to ${who}${from}${attached}, ${when}`;
  }
  if (d.kind === 'sheet_row') {
    const c = d.config as SheetRowConfig;
    const where = c.fileId ? (d.labels?.file ? `“${d.labels.file}”` : 'a spreadsheet') : c.createIfMissing ? `a new spreadsheet${c.newTitle ? ` “${c.newTitle}”` : ''}` : 'a spreadsheet (not chosen yet)';
    return `Add a row to ${where} in ${c.connectionId ? labelOf(c.connectionId) : 'an account'}, ${when}`;
  }
  if (d.kind === 'folder') {
    const c = d.config as FolderConfig;
    const where = c.target === 'storage' ? 'Hexactra storage' : `${d.labels?.folder ? `the folder “${d.labels.folder}”` : 'a folder'} in ${labelOf(c.target.connectionId)}`;
    return `Save ${filesPhrase(c.files)} to ${where}, ${when}`;
  }
  const c = d.config as WebhookConfig;
  return `Send the run's fields to ${c.url ? hostOf(c.url) : 'a web address'}, ${when}`;
}

/** The delivery needs a connection that is not there, or that lacks what it needs: what to tell the owner, and the permission to ask for. */
export function connectionIssue(d: DeliveryDraft, connections: readonly Connection[]): { text: string; capability?: 'mail_send' | 'docs_write'; connectionId?: string } | null {
  if (d.disabledReason === 'connection_removed') return { text: 'The account this used was removed, so it is switched off. Choose another account to switch it on.' };
  const id = d.kind === 'email' ? ((d.config as EmailConfig).via === 'console' ? null : ((d.config as EmailConfig).via as { connectionId: string }).connectionId) : d.kind === 'sheet_row' ? (d.config as SheetRowConfig).connectionId : d.kind === 'folder' ? (((d.config as FolderConfig).target === 'storage' ? null : ((d.config as FolderConfig).target as { connectionId: string }).connectionId)) : null;
  if (!id) return null;
  const c = connections.find((x) => x.id === id);
  if (!c) return { text: 'The account this uses is not there any more. Choose another.' };
  if (c.status !== 'active') return { text: c.status === 'paused' ? `${c.label} is paused, so this cannot send.` : `${c.label} needs to be connected again before this can send.`, connectionId: c.id };
  const needed = d.kind === 'email' ? 'mail_send' : 'docs_write';
  if (!c.capabilities.includes(needed)) return { text: d.kind === 'email' ? `${c.label} is not allowed to send mail.` : `${c.label} is not allowed to change documents.`, capability: needed, connectionId: c.id };
  return null;
}

// ---- Checks (mirror the server's; the server stays the authority) ----

const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;
const ADDRESS = /^[^\s@<>()[\],;:"\\]+@[^\s@<>()[\],;:"\\]+\.[^\s@<>()[\],;:"\\]{2,}$/;
export const isAddress = (a: string): boolean => a.length <= 254 && ADDRESS.test(a);

/** The addresses of a text typed or pasted (commas, spaces, semicolons, lines), without repeats, lower-cased. */
export function splitAddresses(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((a) => a.trim().toLowerCase()).filter(Boolean))];
}

/** Template placeholders a subject or a file name may use: `{{task}}`, `{{date}}`, `{{status}}` and `{{output:<key>}}`. Returns the unknown ones. */
export function badPlaceholders(template: string, outputKeys: readonly string[]): string[] {
  const bad: string[] = [];
  for (const m of template.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) {
    const name = m[1]!;
    const ok = name === 'task' || name === 'date' || name === 'status' || (name.startsWith('output:') && outputKeys.includes(name.slice(7)));
    if (!ok) bad.push(`{{${name}}}`);
  }
  // A lone brace pair is text; an unclosed one is a mistake the server refuses.
  if ((template.match(/\{\{/g) ?? []).length !== (template.match(/\}\}/g) ?? []).length) bad.push('{{');
  return bad;
}

/** The menu of placeholders: the fixed ones and one per output of the task. */
export function placeholderMenu(outputs: readonly TaskOutput[]): { token: string; label: string }[] {
  const named = outputs.filter((o) => o.label.trim() !== '');
  const keys = effectiveKeys(named);
  return [
    { token: '{{task}}', label: 'Task name' },
    { token: '{{date}}', label: 'Date the run ended' },
    { token: '{{status}}', label: 'Status (succeeded, failed, stopped)' },
    ...named.map((o, i) => ({ token: `{{output:${keys[i]}}}`, label: `Output: ${o.label.trim()}` })),
  ];
}

export type DraftProblems = Record<string, string>;

/** What would stop a delivery being saved, by field: `to`, `subject`, `url`, `connection`, `file`, `columns`, `column:<i>`, `folder`, `files`, `nameTemplate`. */
export function draftProblems(d: DeliveryDraft, ctx: { outputs: readonly TaskOutput[]; connections: readonly Connection[] }): DraftProblems {
  const out: DraftProblems = {};
  const keys = effectiveKeys(ctx.outputs.filter((o) => o.label.trim() !== ''));
  if (d.kind === 'email') {
    const c = d.config as EmailConfig;
    if (c.to.length === 0) out.to = 'Add at least one address';
    else if (c.to.length > MAX_RECIPIENTS) out.to = `At most ${MAX_RECIPIENTS} addresses`;
    else {
      const bad = c.to.filter((a) => !isAddress(a));
      if (bad.length > 0) out.to = `${bad.map((b) => `“${b}”`).join(', ')} ${bad.length === 1 ? 'is not an email address' : 'are not email addresses'}`;
    }
    if ((c.cc ?? []).length > MAX_RECIPIENTS) out.cc = `At most ${MAX_RECIPIENTS} addresses`;
    else if ((c.cc ?? []).some((a) => !isAddress(a))) out.cc = 'One of the copy addresses is not an email address';
    if (c.subject !== undefined && c.subject !== '') {
      if (c.subject.length > SUBJECT_MAX) out.subject = `At most ${SUBJECT_MAX} characters`;
      else if (CONTROL.test(c.subject)) out.subject = 'No line breaks';
      else {
        const bad = badPlaceholders(c.subject, keys);
        if (bad.length > 0) out.subject = `${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not something the subject can use`;
      }
    }
    if (c.via !== 'console' && !c.via.connectionId) out.connection = 'Choose the account to send from';
    if (!c.attach.pdf && !c.attach.json && c.attach.screenshots === 'none' && !c.includeOutputs) out.attach = 'Send at least the outputs or one attachment';
  } else if (d.kind === 'webhook') {
    const c = d.config as WebhookConfig;
    if (!c.url.trim()) out.url = 'Enter the address to send to';
    else {
      try {
        const u = new URL(c.url.trim());
        if (u.protocol !== 'https:') out.url = 'Use an https address';
      } catch {
        out.url = 'That is not a web address';
      }
    }
  } else if (d.kind === 'sheet_row') {
    const c = d.config as SheetRowConfig;
    if (!c.connectionId) out.connection = 'Choose the account the spreadsheet is in';
    if (!c.fileId && !c.createIfMissing) out.file = 'Choose a spreadsheet, or have one created';
    if (c.columns.length === 0) out.columns = 'Add at least one column';
    else if (c.columns.length > MAX_COLUMNS) out.columns = `At most ${MAX_COLUMNS} columns`;
    c.columns.forEach((col, i) => {
      if (!col.header.trim()) out[`column:${i}`] = 'Give the column a header';
      else if (CONTROL.test(col.header) || col.header.length > 100) out[`column:${i}`] = 'At most 100 characters, no line breaks';
      else if (col.value.kind === 'output' && !keys.includes(col.value.key)) out[`column:${i}`] = 'This output is not defined on the task any more';
    });
    if (c.newTitle && (CONTROL.test(c.newTitle) || c.newTitle.length > 255)) out.file = 'The title is at most 255 characters, with no line breaks';
  } else {
    const c = d.config as FolderConfig;
    if (c.target !== 'storage' && !c.target.connectionId) out.connection = 'Choose the account the folder is in';
    if (c.target !== 'storage' && c.target.connectionId && !c.target.folderId) out.folder = 'Choose a folder';
    if (!c.files.pdf && !c.files.json && c.files.screenshots === 'none') out.files = 'Choose at least one file to save';
    if (!c.nameTemplate.trim()) out.nameTemplate = 'Give the file a name';
    else if (c.nameTemplate.length > NAME_TEMPLATE_MAX || CONTROL.test(c.nameTemplate)) out.nameTemplate = `At most ${NAME_TEMPLATE_MAX} characters, no line breaks`;
    else {
      const bad = badPlaceholders(c.nameTemplate, keys);
      if (bad.length > 0) out.nameTemplate = `${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not something a file name can use`;
    }
  }
  return out;
}

/** The name a template gives, for the live example: placeholders filled with sample values and the characters a file name cannot hold replaced. */
export function exampleName(template: string, sample: { task: string; date: string; status: string; outputs: Record<string, string> }): string {
  const text = template.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (_m, name: string) =>
    name === 'task' ? sample.task : name === 'date' ? sample.date : name === 'status' ? sample.status : name.startsWith('output:') ? (sample.outputs[name.slice(7)] ?? '') : '',
  );
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\.\.+/g, '.').trim().slice(0, 80);
}

/** Sample values for the preview row and the live examples. */
export function sampleValue(o: TaskOutput): string {
  switch (o.type) {
    case 'number':
      return '42';
    case 'money':
      return '412.50 USD';
    case 'date':
      return '2026-11-18';
    case 'datetime':
      return '2026-11-18 09:00';
    case 'boolean':
      return 'Yes';
    case 'url':
      return 'https://example.test/receipt';
    case 'choice':
      return o.options?.[0] ?? 'Option';
    default:
      return 'Sample text';
  }
}

export function sampleRow(columns: readonly SheetColumn[], outputs: readonly TaskOutput[], taskName: string): string[] {
  const named = outputs.filter((o) => o.label.trim() !== '');
  const keys = effectiveKeys(named);
  const field = (f: RunField): string =>
    ({
      run_date: '2026-11-18',
      status: 'succeeded',
      task: taskName || 'Your task',
      goal: 'What you asked the agent to do',
      result: 'Paid the loan.',
      run_link: 'https://console.example.test/runs/…',
      report_link: 'https://console.example.test/reports/…',
      cost: '$0.12',
      steps: '14',
    })[f];
  return columns.map((c) => (c.value.kind === 'field' ? field(c.value.field) : (() => { const i = keys.indexOf((c.value as { key: string }).key); return i >= 0 ? sampleValue(named[i]!) : '—'; })()));
}

export const outputKeyOf = outputKey;

// ---- Saving ----

/** The request body of one draft (`POST /tasks/{id}/deliveries`, or the changed parts of a `PATCH`). */
export function configBody(d: DeliveryDraft): Record<string, unknown> {
  if (d.kind === 'email') {
    const c = d.config as EmailConfig;
    const cc = (c.cc ?? []).filter(Boolean);
    return { via: c.via, to: c.to, ...(cc.length > 0 ? { cc } : {}), ...(c.subject?.trim() ? { subject: c.subject.trim() } : {}), attach: c.attach, includeOutputs: c.includeOutputs, includeSensitive: c.includeSensitive };
  }
  if (d.kind === 'webhook') {
    const c = d.config as WebhookConfig;
    return { url: c.url.trim(), includeOutputs: c.includeOutputs, includeReportLink: c.includeReportLink, includeSensitive: c.includeSensitive };
  }
  if (d.kind === 'sheet_row') {
    const c = d.config as SheetRowConfig;
    return {
      connectionId: c.connectionId,
      ...(c.fileId ? { fileId: c.fileId } : {}),
      ...(c.sheet?.trim() ? { sheet: c.sheet.trim() } : {}),
      ...(c.newTitle?.trim() && !c.fileId ? { newTitle: c.newTitle.trim() } : {}),
      columns: c.columns.map((col) => ({ header: col.header.trim(), value: col.value })),
      createIfMissing: c.fileId ? false : c.createIfMissing,
      includeSensitive: c.includeSensitive,
    };
  }
  const c = d.config as FolderConfig;
  return { target: c.target, files: c.files, nameTemplate: c.nameTemplate.trim() };
}

export type SyncOp =
  | { op: 'delete'; id: string }
  | { op: 'create'; key: string; body: { kind: DeliveryKind; config: Record<string, unknown>; enabled: boolean; when: DeliveryWhen; position: number } }
  | { op: 'update'; id: string; key: string; body: { config?: Record<string, unknown>; enabled?: boolean; when?: DeliveryWhen; position?: number } };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Whether a draft differs from the saved delivery it came from. */
export function changed(d: DeliveryDraft, saved: TaskDelivery | undefined, position: number): boolean {
  if (!saved) return true;
  return saved.enabled !== d.enabled || saved.when !== d.when || saved.position !== position || !same(configBody({ ...draftFromDelivery(saved) }), configBody(d));
}

/** Whether the list differs from what the server holds (the form is then dirty). */
export function listChanged(drafts: readonly DeliveryDraft[], saved: readonly TaskDelivery[]): boolean {
  if (drafts.length !== saved.length) return true;
  return drafts.some((d, i) => changed(d, saved.find((s) => s.id === d.id), i));
}

/** The requests that make the server's list the owner's: deletes first (they free room), then each draft in order with its position. */
export function planSync(saved: readonly TaskDelivery[], drafts: readonly DeliveryDraft[]): SyncOp[] {
  const ops: SyncOp[] = [];
  const keep = new Set(drafts.flatMap((d) => (d.id ? [d.id] : [])));
  for (const s of saved) if (!keep.has(s.id)) ops.push({ op: 'delete', id: s.id });
  drafts.forEach((d, position) => {
    const before = d.id ? saved.find((s) => s.id === d.id) : undefined;
    if (!d.id || !before) {
      ops.push({ op: 'create', key: d.key, body: { kind: d.kind, config: configBody(d), enabled: d.enabled, when: d.when, position } });
      return;
    }
    if (!changed(d, before, position)) return;
    const body: { config?: Record<string, unknown>; enabled?: boolean; when?: DeliveryWhen; position?: number } = {};
    if (!same(configBody(draftFromDelivery(before)), configBody(d))) body.config = configBody(d);
    if (before.enabled !== d.enabled) body.enabled = d.enabled;
    if (before.when !== d.when) body.when = d.when;
    if (before.position !== position) body.position = position;
    ops.push({ op: 'update', id: d.id, key: d.key, body });
  });
  return ops;
}

/** The server's refusal of a delivery in words the owner can act on. */
export function deliveryErrorText(error: unknown): string {
  const e = error as { code?: string; message?: string; details?: { issues?: { path?: unknown; message?: unknown }[]; addresses?: string[] } } | null;
  if (e?.code === 'RECIPIENT_NOT_CONFIRMED') return `These addresses are not confirmed yet: ${(e.details?.addresses ?? []).join(', ') || 'one of them'}. Confirm them, or save the delivery switched off.`;
  if (e?.code === 'INVALID_DELIVERY' && Array.isArray(e.details?.issues) && e.details.issues.length > 0) {
    const first = e.details.issues[0]!;
    const path = Array.isArray(first.path) ? first.path.join('.') : String(first.path ?? '');
    return `${path ? `${path}: ` : ''}${String(first.message ?? 'not valid')}`;
  }
  if (e?.code === 'DESTINATION_BLOCKED') return 'That address cannot be used: it must be a public https address.';
  return e?.message || 'The delivery could not be saved';
}
