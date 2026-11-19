// How a mail trigger fills a task's parameters from the message (E39.8, #605): a fixed value, a header field (`subject`, `from`,
// `date`) or a value captured by a pattern the owner writes against the subject or the text body. No model call. A value is data:
// it fills a parameter exactly as a value typed into a form does, so it is checked by that parameter's own rules and appears in the
// goal only between the data markers. It cannot change a run's allowed sites, policy, approvals or confirmations (those are the
// task's settings, never text). A value that does not pass is simply missing: the run then waits on the form.
import { z } from 'zod';
import { MAX_VALUE_LENGTH, normalizeValue, patternProblem, type TaskParameter } from '@app/shared/task-params';

import { CAPTURE_TEXT_CHARS } from './mail-triggers.constants';

export const HEADER_FIELDS = ['subject', 'from', 'date'] as const;
export type HeaderField = (typeof HEADER_FIELDS)[number];
export const CAPTURE_SOURCES = ['subject', 'text'] as const;

const fixed = z.object({ fixed: z.string().trim().min(1).max(MAX_VALUE_LENGTH) }).strict();
const header = z.object({ header: z.enum(HEADER_FIELDS) }).strict();
const capture = z
  .object({
    capture: z
      .object({
        source: z.enum(CAPTURE_SOURCES),
        pattern: z.string().min(1).max(200).describe('A regular expression with exactly one group; the group is the value. No back-references or nested quantifiers.'),
        ignoreCase: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export const inputSourceSchema = z.union([fixed, header, capture]);
export type InputSource = z.infer<typeof inputSourceSchema>;
export const mailInputsSchema = z.record(z.string().min(1).max(80), inputSourceSchema).refine((r) => Object.keys(r).length <= 20, { message: 'At most 20 inputs' });
export type MailInputs = z.infer<typeof mailInputsSchema>;

/** Capturing groups of a pattern (named ones included; `(?:`, lookarounds and escaped parentheses are not). */
export function groupCount(pattern: string): number {
  let n = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === '(') {
      if (pattern[i + 1] !== '?') n++;
      else if (pattern[i + 2] === '<' && pattern[i + 3] !== '=' && pattern[i + 3] !== '!') n++;
    }
  }
  return n;
}

/** Why a capture pattern cannot be used, or null: the safe-pattern check of task parameters, and exactly one group. */
export function capturePatternProblem(pattern: string): string | null {
  const p = patternProblem(pattern);
  if (p) return p;
  const groups = groupCount(pattern);
  return groups === 1 ? null : `The pattern needs exactly one group ( ) that holds the value (it has ${groups})`;
}

export interface InputIssue {
  key: string;
  message: string;
}

/**
 * The inputs of a trigger checked against its task's parameters: every key a parameter, none sensitive, a fixed value that passes the
 * parameter's rules, a pattern that is safe. Returns the cleaned inputs and the issues per key.
 */
export function checkMailInputs(params: readonly TaskParameter[], inputs: MailInputs | null | undefined): { inputs: MailInputs | null; issues: InputIssue[] } {
  const issues: InputIssue[] = [];
  const out: MailInputs = {};
  for (const [name, src] of Object.entries(inputs ?? {})) {
    const def = params.find((p) => p.key === name);
    if (!def) {
      issues.push({ key: name, message: 'Not a parameter of this task' });
      continue;
    }
    if (def.sensitive) {
      issues.push({ key: name, message: 'A sensitive parameter is asked for in the console when the run starts: it never takes a value from an email' });
      continue;
    }
    if ('fixed' in src) {
      const r = normalizeValue(def, src.fixed, { timeZone: 'UTC' });
      if (r.error !== undefined) {
        issues.push({ key: name, message: r.error });
        continue;
      }
    }
    if ('capture' in src) {
      const problem = capturePatternProblem(src.capture.pattern);
      if (problem) {
        issues.push({ key: name, message: problem });
        continue;
      }
    }
    out[name] = src;
  }
  return { inputs: Object.keys(out).length ? out : null, issues };
}

/** What the mapping reads from a message. */
export interface MailFacts {
  subject: string;
  /** The From address (not the display name). */
  from: string | null;
  /** The message's own date. */
  date: string | null;
  /** The plain text body, when the mapping needs one. */
  text?: string | null;
}

export const needsBody = (inputs: MailInputs | null | undefined): boolean => Object.values(inputs ?? {}).some((s) => 'capture' in s && s.capture.source === 'text');

// eslint-disable-next-line no-control-regex
const LINE_BREAKS = /[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g;
const oneLine = (s: string): string => s.replace(LINE_BREAKS, ' ').replace(/\s+/g, ' ').trim();

/** The capture of a pattern in a text, as one clean line; null when it does not match. Never cut: a value over the parameter's limit is refused by the parameter's rules and is then missing. */
export function captureValue(c: { source: 'subject' | 'text'; pattern: string; ignoreCase?: boolean }, facts: MailFacts): string | null {
  if (capturePatternProblem(c.pattern)) return null;
  const source = c.source === 'subject' ? facts.subject : (facts.text ?? '');
  const hay = source.slice(0, CAPTURE_TEXT_CHARS);
  let m: RegExpExecArray | null;
  try {
    m = new RegExp(c.pattern, c.ignoreCase ? 'iu' : 'u').exec(hay);
  } catch {
    return null;
  }
  const v = m?.[1] === undefined ? '' : oneLine(m[1]);
  return v || null;
}

/** The values for the run: by parameter key, only the ones the message gave. They go in as presets: the parameter's rules are applied by the starter. */
export function mapInputs(inputs: MailInputs | null | undefined, facts: MailFacts): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, src] of Object.entries(inputs ?? {})) {
    let v: string | null = null;
    if ('fixed' in src) v = src.fixed;
    else if ('header' in src) {
      if (src.header === 'subject') v = oneLine(facts.subject);
      else if (src.header === 'from') v = facts.from;
      else v = facts.date ? new Date(facts.date).toISOString().slice(0, 10) : null;
    } else v = captureValue(src.capture, facts);
    if (v) out[key] = v;
  }
  return out;
}
