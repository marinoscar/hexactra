// The question contract as the web app reads it (GET /api/questions/:id and
// GET /api/inbox; apps/api/src/questions/questions.contract.ts).
import { answerLabel } from '@app/shared/question-rules';

export type QuestionInput = 'none' | 'text' | 'secret' | 'choice' | 'multi_choice' | 'number' | 'confirm' | 'takeover' | 'credentials' | 'form' | 'memory' | 'save_login';

/** A field of a `form` question (#552): one missing value of a task run, asked before it starts. */
export interface FormField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'money' | 'date' | 'choice' | 'phone' | 'email';
  required: boolean;
  options?: string[];
  help?: string;
  constraints?: { min?: number; max?: number; maxLength?: number; pattern?: string };
  sensitive?: boolean;
}

/** A memory the agent proposes (#553): what the card shows and the owner may edit before saving. */
export interface MemoryProposal {
  kind: 'person' | 'account' | 'preference' | 'fact';
  label: string;
  aliases: string[];
  attributes: Record<string, string>;
  /** The active memory whose values this would replace. */
  supersedes: string | null;
}

/** "Save this login?" (E37.4b): what the card shows. The password is never here: it is held by the fabric and goes from there to the provider. */
export interface SaveLoginCard {
  /** The host of the sign-in page. */
  site: string;
  /** Its registrable domain: the unit "Never for this site" is remembered at. */
  domain: string;
  /** The name the agent suggests; the owner edits it. */
  name: string;
  /** The username the owner typed. */
  username: string;
  /** When the fabric stops holding the password: after it, it is too late to save. */
  valueExpiresAt: string;
}

/** What a settled "Save this login?" says when the fabric no longer held the password. */
export const SAVE_TOO_LATE_TEXT = 'Too late to save this time; it will be offered at the next sign-in.';

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface QuestionConstraints {
  maxLength?: number;
  pattern?: string;
  multiline?: boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  minSelections?: number;
  maxSelections?: number;
}

/** What a form needs to ask a question. */
export interface AskedQuestion {
  kind: string;
  input: QuestionInput;
  options: QuestionOption[] | null;
  constraints: QuestionConstraints | null;
  confirmLabel: string | null;
  denyLabel: string | null;
  risk: 'low' | 'high' | null;
  viewerUrl: string | null;
  /** credentials and secret: the site's "remember me" option, in the page's words (#527). */
  rememberLabel?: string | null;
  /** form (#552): the values to fill. */
  fields?: FormField[] | null;
  /** memory (#553): the proposed memory. */
  proposal?: MemoryProposal | null;
  /** save_login (E37.4b): the sign-in offered to be saved. */
  saveLogin?: SaveLoginCard | null;
  /** False for a memory proposal (#553) and a "Save this login?" card (E37.4b): no run waits on it. */
  blocking?: boolean;
  /** What "Don't ask again" would remember (#555), computed by the server; null or absent when it cannot be remembered. */
  rememberable?: Rememberable | null;
  /** A call through one of the owner's accounts this question asks to approve (E39.7): the card the server built. Null or absent for any other question. */
  action?: QuestionAction | null;
}

/** The scopes a saved approval may be limited to (#555). */
export type RememberScope = 'everywhere' | 'this_task' | 'this_chat';

/** What a "Don't ask again" tick makes a rule of (#555): set by the server only. */
/** The card of a call through one of the owner's accounts, built by the server from the validated call. */
export interface QuestionAction {
  connectionId: string;
  connectionLabel: string;
  tool: string;
  lines: { label: string; value: string }[];
  /** The whole text for "Show all". */
  body?: string;
  summary: string;
}

/** Which people a "Don't ask again" for a call that reaches people covers: those addresses, or anyone at their domains. */
export type RecipientsFrom = 'these' | 'domain';

export interface Rememberable {
  kind: 'gate' | 'ask' | 'connection';
  host: string;
  category: string | null;
  matchKey: string;
  /** The sentence the owner reads: "Press 'Pay' on bankofamerica.com". */
  summary: string;
  scopes?: RememberScope[];
  /** A saved card (E37.7): the amount limit is required for "Don't ask again", in `currency`; `amount` is this purchase. */
  requiresLimit?: boolean;
  currency?: string;
  amount?: string;
  /** A call that reaches people (E39.7): the addresses it reaches. */
  recipients?: string[];
}

/** The "Don't ask again" tick with its optional limits (#555). Distinct from `remember`, a site's own "remember me". */
export interface RememberRuleBody {
  enabled: true;
  scope?: RememberScope;
  maxAmount?: number;
  expiresInDays?: number;
  /** A call that reaches people: remember these people, or anyone at their domains. There is no "anyone". */
  recipientsFrom?: RecipientsFrom;
}

export interface QuestionResponse {
  outcome: 'completed' | 'cancelled';
  value?: string;
  values?: string[];
  valueWithheld: boolean;
  /** What the person chose for the "remember me" option, when one was offered. */
  remember?: boolean;
  /** form (#552): the values given, masked. */
  fields?: Record<string, string>;
  /** memory (#553): the memory the approved proposal saved. */
  memoryId?: string;
  /** The saved approval this answer made ("Don't ask again", #555). */
  ruleId?: string;
  /** save_login (E37.4b): declined with "Never for this site". */
  neverForSite?: boolean;
  /** save_login: the name the login was saved under. */
  savedAs?: string;
  channel?: string;
  by?: string;
  answeredAt: string;
}

/** `GET /api/questions/:id`. A secret value is never returned. */
export interface Question extends AskedQuestion {
  id: string;
  askedBy: string;
  runId: string | null;
  handoffId: string | null;
  browserBound: boolean;
  prompt: string;
  status: 'pending' | 'answered' | 'cancelled' | 'expired';
  response: QuestionResponse | null;
  pageTitle: string | null;
  createdAt: string;
  expiresAt: string;
  answeredAt: string | null;
}

/** `GET /api/inbox`: one pending question. */
export interface InboxItem extends AskedQuestion {
  questionId: string;
  /** Null for a free-standing question (no browser run). */
  runId: string | null;
  /** The chat whose run asks (#488): the request is answered there. Null for every other request. */
  conversationId?: string | null;
  goal: string;
  handoffId: string | null;
  askedBy: string;
  prompt: string;
  /** Option ids (older clients); `options` carries the labels. */
  choices: string[];
  pageTitle: string | null;
  createdAt: string;
  expiresAt: string;
}

/** An answer, as `POST /api/questions/:id/answer` takes it. */
export interface AnswerBody {
  outcome: 'completed' | 'cancelled';
  value?: string;
  values?: string[];
  /** credentials: the password (the username is `value`). Sent once, never kept. */
  secret?: string;
  /** The choice for the question's "remember me" option. */
  remember?: boolean;
  /** form (#552): the value of each field, by key. */
  fields?: Record<string, string>;
  /** memory (#553): the memory as the owner saves it, edited on the card. */
  memory?: { kind?: MemoryProposal['kind']; label: string; aliases?: string[]; attributes: Record<string, string> };
  /** "Don't ask again" (#555): make a saved approval of this approval. */
  rememberRule?: RememberRuleBody;
  /** save_login (E37.4b): Save, with the name as the owner edited it. */
  saveLogin?: { name: string };
  /** save_login: "Never for this site", sent with a declined answer. */
  neverForSite?: true;
}

export const KIND_LABEL: Record<string, string> = {
  captcha: 'CAPTCHA',
  code: 'Code',
  passkey: 'Passkey',
  verification: 'Bank verification',
  login: 'Sign-in',
  confirmation: 'Confirm',
  memory: 'Memory',
  other: 'Question',
};

/** Who asked, in words: `agent:packer` → "packer", `run:<id>` → "your browser agent", `user:<id>` → "you". */
export function askerText(askedBy: string): string {
  const [who, ...rest] = askedBy.split(':');
  const name = rest.join(':');
  if (who === 'agent') return name || 'an agent';
  if (who === 'run') return 'your browser agent';
  if (who === 'chat') return 'your chat';
  if (who === 'user') return 'you';
  return askedBy;
}

/** The final state of a settled question, in words (a secret is never shown). */
export function answerText(q: Pick<Question, 'status' | 'response' | 'input' | 'options' | 'constraints' | 'confirmLabel' | 'denyLabel'> & { fields?: FormField[] | null }): string {
  if (q.status === 'pending') return 'Waiting for an answer';
  if (q.status === 'expired') return q.input === 'memory' ? 'This suggestion expired. Nothing was saved.' : q.input === 'save_login' ? SAVE_TOO_LATE_TEXT : 'This question expired before anyone answered.';
  const r = q.response;
  if (q.input === 'memory') return r?.outcome === 'completed' ? 'Saved to Memories.' : 'Not saved.';
  if (q.input === 'save_login') {
    if (r?.outcome === 'completed') return r.savedAs ? `Saved as “${r.savedAs}” in your vault.` : 'Saved in your vault.';
    return r?.neverForSite ? 'Not saved. You will not be asked to save a login for this site again.' : 'Not saved.';
  }
  const via = r?.channel ? ` (from ${r.channel})` : '';
  if (!r || r.outcome === 'cancelled') return `Declined${via}.`;
  if (r.valueWithheld) return `Answered${via}. The secret went to the agent and is not shown.`;
  if (q.input === 'form') return `Provided${via}${formAnswerText(q.fields, r.fields)}`;
  const words = answerLabel(q, r);
  if (r.values) return `Answered${via}: ${words}`;
  // "Don't ask again" was ticked (#555).
  const kept = r.ruleId ? " · won't ask again" : '';
  if (r.value !== undefined) {
    if (q.input === 'confirm') return r.value === 'approve' ? `Approved${via}${kept}: ${words}` : `Denied${via}: ${words}`;
    return `Answered${via}: ${words}`;
  }
  return `Done${via}${kept}.`;
}

/** The label of a secret field, by why it is asked: short, so it fits a phone on one line. */
export function secretLabel(kind: string): 'Code' | 'Password' | 'Secret' {
  if (kind === 'code') return 'Code';
  if (kind === 'login') return 'Password';
  return 'Secret';
}

/** Whether a `pattern` constraint only lets digits through (`\d{6}`, `[0-9]+`), so a phone can show its number pad. */
export function digitsOnly(pattern: string | undefined): boolean {
  return pattern !== undefined && /^\^?(?:\\d|\[0-9\])(?:\{\d+(?:,\d*)?\}|[+*])?\$?$/.test(pattern.trim());
}

/** Whether the API refused an answer because the question is already settled (answered elsewhere, expired). */
export function isSettledError(e: unknown): boolean {
  const status = (e as { status?: number; statusCode?: number } | null)?.status ?? (e as { statusCode?: number } | null)?.statusCode;
  // A save that was refused for a reason the owner can fix (the name is taken, the vault needs reconnecting or is switched off) is
  // not a settled question: the card stays and says what to do (E37.4b).
  if (status === 409 && SAVE_RETRYABLE_CODES.includes((e as { code?: string } | null)?.code ?? '')) return false;
  return status === 409 || status === 410;
}

/**
 * Where the web app sends an answer (channel `web`): a plain decline goes to `/cancel`; everything else, a "Save this login?" decline with
 * "Never for this site" included (it carries a body), goes to `/answer`.
 */
export function answerRequest(id: string, a: AnswerBody): { path: string; body: Record<string, unknown> } {
  if (a.outcome === 'cancelled' && !a.neverForSite) return { path: `/questions/${id}/cancel`, body: { channel: 'web' } };
  return { path: `/questions/${id}/answer`, body: { ...a, channel: 'web' } };
}

/** The 409 codes of a "Save this login?" answer that leave the card open (the owner can change the name, reconnect or try again). */
export const SAVE_RETRYABLE_CODES: readonly string[] = ['SAVE_NAME_TAKEN', 'SAVE_RECONNECT', 'SAVE_DISABLED'];

/** "4 min 05 s" until `iso` (or "expired"). */
export function remaining(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now;
  if (!(ms > 0)) return 'expired';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  // A memory suggestion waits for days (#553): count them.
  if (h >= 48) return `${Math.floor(h / 24)} days`;
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min ${String(sec).padStart(2, '0')} s`;
  return `${sec} s`;
}

/** A form's given values in words, already masked by the API: ": Amount: 25 · Date: 2026-11-18" (a full stop when none). */
export function formAnswerText(fields: readonly Pick<FormField, 'key' | 'label' | 'sensitive'>[] | null | undefined, given: Record<string, string> | undefined): string {
  if (!given) return '.';
  const parts = Object.entries(given)
    .filter(([key]) => !fields?.find((f) => f.key === key)?.sensitive)
    .map(([key, v]) => `${fields?.find((f) => f.key === key)?.label ?? key}: ${v}`);
  return parts.length ? `: ${parts.join(' · ')}` : '.';
}
