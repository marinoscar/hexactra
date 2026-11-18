// The question contract as the web app reads it (GET /api/questions/:id and
// GET /api/inbox; apps/api/src/questions/questions.contract.ts).
import { answerLabel } from '@app/shared/question-rules';

export type QuestionInput = 'none' | 'text' | 'secret' | 'choice' | 'multi_choice' | 'number' | 'confirm' | 'takeover';

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
}

export interface QuestionResponse {
  outcome: 'completed' | 'cancelled';
  value?: string;
  values?: string[];
  valueWithheld: boolean;
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
}

export const KIND_LABEL: Record<string, string> = {
  captcha: 'CAPTCHA',
  code: 'Code',
  passkey: 'Passkey',
  login: 'Sign-in',
  confirmation: 'Confirm',
  other: 'Question',
};

/** Who asked, in words: `agent:packer` → "packer", `run:<id>` → "your browser agent", `user:<id>` → "you". */
export function askerText(askedBy: string): string {
  const [who, ...rest] = askedBy.split(':');
  const name = rest.join(':');
  if (who === 'agent') return name || 'an agent';
  if (who === 'run') return 'your browser agent';
  if (who === 'user') return 'you';
  return askedBy;
}

/** The final state of a settled question, in words (a secret is never shown). */
export function answerText(q: Pick<Question, 'status' | 'response' | 'input' | 'options' | 'constraints' | 'confirmLabel' | 'denyLabel'>): string {
  if (q.status === 'pending') return 'Waiting for an answer';
  if (q.status === 'expired') return 'This question expired before anyone answered.';
  const r = q.response;
  const via = r?.channel ? ` (from ${r.channel})` : '';
  if (!r || r.outcome === 'cancelled') return `Declined${via}.`;
  if (r.valueWithheld) return `Answered${via}. The secret went to the agent and is not shown.`;
  const words = answerLabel(q, r);
  if (r.values) return `Answered${via}: ${words}`;
  if (r.value !== undefined) {
    if (q.input === 'confirm') return r.value === 'approve' ? `Approved${via}: ${words}` : `Denied${via}: ${words}`;
    return `Answered${via}: ${words}`;
  }
  return `Done${via}.`;
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
  return status === 409 || status === 410;
}

/** "4 min 05 s" until `iso` (or "expired"). */
export function remaining(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now;
  if (!(ms > 0)) return 'expired';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min ${String(sec).padStart(2, '0')} s`;
  return `${sec} s`;
}
