// The question contract as the web app reads it (GET /api/questions/:id and
// GET /api/inbox; apps/api/src/questions/questions.contract.ts).

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
  const label = (id: string) => q.options?.find((o) => o.id === id)?.label ?? id;
  if (r.valueWithheld) return `Answered${via}. The secret went to the agent and is not shown.`;
  if (r.values) return `Answered${via}: ${r.values.map(label).join(', ')}`;
  if (r.value !== undefined) {
    if (q.input === 'choice') return `Answered${via}: ${label(r.value)}`;
    if (q.input === 'confirm') return r.value === 'approve' ? `Approved${via}: ${q.confirmLabel ?? 'Approve'}` : `Denied${via}: ${q.denyLabel ?? 'Deny'}`;
    if (q.input === 'number' && q.constraints?.unit) return `Answered${via}: ${r.value} ${q.constraints.unit}`;
    return `Answered${via}: ${r.value}`;
  }
  return `Done${via}.`;
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
