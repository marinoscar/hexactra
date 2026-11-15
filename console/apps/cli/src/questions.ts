import type { ApiClient } from '@marinoscar/platform-cli/api-client';

/** The input types (apps/api/src/questions/questions.contract.ts). */
export const QUESTION_INPUTS = ['none', 'text', 'secret', 'choice', 'multi_choice', 'number', 'confirm', 'takeover'] as const;
export type QuestionInput = (typeof QUESTION_INPUTS)[number];

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

/** `GET /api/questions/:id` (a secret value is never returned). */
export interface Question {
  id: string;
  askedBy: string;
  runId: string | null;
  browserBound: boolean;
  input: QuestionInput;
  kind: string;
  prompt: string;
  options: QuestionOption[] | null;
  constraints: QuestionConstraints | null;
  confirmLabel: string | null;
  denyLabel: string | null;
  risk: 'low' | 'high' | null;
  status: 'pending' | 'answered' | 'cancelled' | 'expired';
  response: { outcome: 'completed' | 'cancelled'; value?: string; values?: string[]; valueWithheld: boolean; channel?: string; by?: string; answeredAt: string } | null;
  pageTitle: string | null;
  viewerUrl: string | null;
  createdAt: string;
  expiresAt: string;
}

/** An answer body for `POST /api/questions/:id/answer` (or the inbox's respond). */
export interface AnswerBody {
  outcome: 'completed' | 'cancelled';
  value?: string;
  values?: string[];
}

/** The answer flags of `questions answer` and `inbox answer`. Exactly one is used. */
export interface AnswerFlags {
  value?: string;
  values?: string;
  choice?: string;
  approve?: boolean;
  deny?: boolean;
  done?: boolean;
  decline?: boolean;
  secretStdin?: boolean;
}

/** The flag a question's input type is answered with. */
export function flagFor(input: string): string {
  switch (input) {
    case 'secret':
      return '--secret-stdin';
    case 'text':
    case 'number':
      return '--value';
    case 'choice':
      return '--choice';
    case 'multi_choice':
      return '--values';
    case 'confirm':
      return '--approve or --deny';
    default:
      return '--done';
  }
}

/**
 * The answer body the flags give. A secret is read from stdin only (never
 * an argument, so it stays out of shell history and process lists).
 */
export async function answerFromFlags(o: AnswerFlags, input: string, readSecret: () => Promise<string>): Promise<AnswerBody> {
  const given = (['value', 'values', 'choice', 'approve', 'deny', 'done', 'decline', 'secretStdin'] as const).filter((k) => o[k] !== undefined && o[k] !== false);
  if (given.length > 1) throw new Error(`Give one answer, not ${given.map((k) => `--${k === 'secretStdin' ? 'secret-stdin' : k}`).join(' and ')}.`);
  if (o.decline) return { outcome: 'cancelled' };
  if (o.secretStdin) {
    const v = await readSecret();
    if (!v) throw new Error('No secret on stdin.');
    return { outcome: 'completed', value: v };
  }
  if (o.value !== undefined) return { outcome: 'completed', value: o.value };
  if (o.choice !== undefined) return { outcome: 'completed', value: o.choice };
  if (o.values !== undefined) return { outcome: 'completed', values: o.values.split(',').map((v) => v.trim()).filter(Boolean) };
  if (o.approve) return { outcome: 'completed', value: 'approve' };
  if (o.deny) return { outcome: 'completed', value: 'deny' };
  if (o.done) return { outcome: 'completed' };
  throw new Error(`This question needs ${flagFor(input)} (or --decline).`);
}

/** Follow a question for up to `waitS` seconds, in long polls of at most 30 s. */
export async function waitForQuestion(api: ApiClient, id: string, waitS: number, first?: Question): Promise<Question> {
  const deadline = Date.now() + Math.max(0, waitS) * 1000;
  let q = first ?? (await api.get<Question>(`/questions/${id}`));
  while (q.status === 'pending' && Date.now() < deadline) {
    const waitMs = Math.min(30_000, deadline - Date.now());
    q = await api.get<Question>(`/questions/${id}`, { query: { waitMs }, timeoutMs: waitMs + 15_000 });
  }
  return q;
}

/** One line per option, `id) label — description`. */
export function optionLines(q: Pick<Question, 'options'>): string[] {
  return (q.options ?? []).map((o) => `${o.id}) ${o.label}${o.description ? ` — ${o.description}` : ''}`);
}

/** What the constraints ask, in words (or ''). */
export function constraintText(q: Pick<Question, 'input' | 'constraints'>): string {
  const c = q.constraints ?? {};
  const parts: string[] = [];
  if (c.min !== undefined) parts.push(`min ${c.min}`);
  if (c.max !== undefined) parts.push(`max ${c.max}`);
  if (c.step !== undefined) parts.push(`step ${c.step}`);
  if (c.unit) parts.push(`in ${c.unit}`);
  if (c.maxLength !== undefined) parts.push(`at most ${c.maxLength} characters`);
  if (c.pattern) parts.push(`format /${c.pattern}/`);
  if (c.multiline) parts.push('several lines allowed');
  if (c.minSelections !== undefined) parts.push(`choose at least ${c.minSelections}`);
  if (c.maxSelections !== undefined) parts.push(`choose at most ${c.maxSelections}`);
  return parts.join(', ');
}

/** The answer of a settled question, in words (a secret is never shown). */
export function answerText(q: Question): string {
  if (q.status === 'pending') return 'pending';
  if (q.status === 'expired') return 'expired';
  const r = q.response;
  if (!r || r.outcome === 'cancelled') return 'declined';
  const label = (id: string) => q.options?.find((o) => o.id === id)?.label ?? id;
  const via = r.channel ? ` (via ${r.channel})` : '';
  if (r.valueWithheld) return `answered (secret withheld)${via}`;
  if (r.values) return `answered: ${r.values.map(label).join(', ')}${via}`;
  if (r.value !== undefined) {
    if (q.input === 'choice') return `answered: ${label(r.value)}${via}`;
    if (q.input === 'confirm') return `${r.value === 'approve' ? 'approved' : 'denied'}${via}`;
    if (q.input === 'number' && q.constraints?.unit) return `answered: ${r.value} ${q.constraints.unit}${via}`;
    return `answered: ${r.value}${via}`;
  }
  return `done${via}`;
}
