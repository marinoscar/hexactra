// How a run's steps read in the API (#541): the masked question a step asked
// or answered, whether it has a trace picture, and never the object key.
import { maskSensitive } from './mask';

/** The question columns a step's view reads. */
export interface StepQuestionRow {
  id: string;
  kind: string;
  input: string;
  prompt: string;
  options: unknown;
  /** A form's field definitions (E40.2); absent in older selects. */
  fields?: unknown;
  risk: string | null;
  status: string;
  response: unknown;
}

/** A step as stored, with its question when it has one. */
export interface StepRow {
  screenshotKey?: string | null;
  screenshotMoment?: string | null;
  screenshotMasked?: number | null;
  screenshotNote?: string | null;
  questionId?: string | null;
  question?: StepQuestionRow | null;
  [k: string]: unknown;
}

/** The question of a step, as the trace shows it: prompt, options and answer value masked; a secret's value never. */
export interface StepQuestionView {
  id: string;
  kind: string;
  input: string;
  prompt: string;
  options: { id: string; label: string }[] | null;
  risk: string | null;
  status: string;
  answer: { outcome: string; value?: string; valueWithheld: boolean; channel: string | null; answeredAt: string | null; fields?: { key: string; label: string; value?: string; provided: true }[] } | null;
}

const mask = (s: string) => maskSensitive(s).text;
const SECRET_INPUTS = new Set(['secret', 'credentials']);

/**
 * The masked view of a step's question. `maskText` is the masking of each text (default `maskSensitive`); the
 * export (#542) passes the identity and masks the whole file at once, so `masking.hits` counts the question too.
 */
export function stepQuestionView(q: StepQuestionRow, maskText: (s: string) => string = mask): StepQuestionView {
  const options = Array.isArray(q.options)
    ? (q.options as { id?: unknown; label?: unknown }[])
        .filter((o) => o && typeof o.id === 'string' && typeof o.label === 'string')
        .map((o) => ({ id: o.id as string, label: maskText(o.label as string) }))
    : null;
  const r = q.response && typeof q.response === 'object' ? (q.response as Record<string, unknown>) : null;
  let answer: StepQuestionView['answer'] = null;
  if (r && typeof r.outcome === 'string') {
    const withheld = r.valueWithheld === true || SECRET_INPUTS.has(q.input);
    const raw = Array.isArray(r.values) ? (r.values as unknown[]).filter((v) => typeof v === 'string').join(', ') : typeof r.value === 'string' ? r.value : null;
    answer = {
      outcome: r.outcome,
      ...(!withheld && raw ? { value: maskText(raw.slice(0, 1_000)) } : {}),
      valueWithheld: withheld,
      channel: typeof r.channel === 'string' ? r.channel : null,
      answeredAt: typeof r.answeredAt === 'string' ? r.answeredAt : null,
      ...(q.input === 'form' ? { fields: formAnswerFields(q.fields, r.fields, maskText) } : {}),
    };
  }
  return { id: q.id, kind: q.kind, input: q.input, prompt: maskText(q.prompt), options, risk: q.risk, status: q.status, answer };
}

/**
 * A form's answer (E40.2, #686): one row per field the owner filled, with its label and its masked value. A field
 * marked sensitive shows that it was provided, never its value. The stored values are already masked (#538).
 */
function formAnswerFields(defs: unknown, given: unknown, maskText: (s: string) => string): { key: string; label: string; value?: string; provided: true }[] {
  if (!given || typeof given !== 'object') return [];
  const byKey = new Map((Array.isArray(defs) ? (defs as { key?: unknown; label?: unknown; sensitive?: unknown }[]) : []).filter((d) => d && typeof d.key === 'string').map((d) => [d.key as string, d]));
  return Object.entries(given as Record<string, unknown>)
    .filter((e): e is [string, string] => typeof e[1] === 'string')
    .slice(0, 50)
    .map(([key, value]) => {
      const def = byKey.get(key);
      const label = typeof def?.label === 'string' ? def.label : key;
      return { key, label: maskText(label.slice(0, 200)), ...(def?.sensitive === true ? {} : { value: maskText(value.slice(0, 1_000)) }), provided: true as const };
    });
}

/** A step for the API: `hasScreenshot` and the moment instead of the object key; the masked question when it has one. */
export function stepView<S extends StepRow>(step: S): Omit<S, 'screenshotKey' | 'question'> & { hasScreenshot: boolean; question: StepQuestionView | null } {
  const { screenshotKey, question, ...rest } = step;
  return { ...rest, hasScreenshot: Boolean(screenshotKey), question: question ? stepQuestionView(question) : null };
}

/** What the step queries select of a question. */
export const STEP_QUESTION_SELECT = { id: true, kind: true, input: true, prompt: true, options: true, fields: true, risk: true, status: true, response: true } as const;
