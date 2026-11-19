// Templates and safe text for deliveries (E39.6, #603). A subject or a file name template may use a fixed list of placeholders; the
// values are inserted as TEXT, one line, length-capped, and can never introduce a header or a path separator. What a run returned
// (an output, the task's name) is data: it fills a placeholder and does nothing else.
import { FILE_NAME_MAX, SUBJECT_MAX, TEMPLATE_VALUE_MAX } from './deliveries.constants';

/** `{{task}}`, `{{date}}`, `{{status}}`, `{{output:<key>}}`. Spaces inside the braces are allowed. */
export const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_:]+)\s*\}\}/g;
export const FIXED_PLACEHOLDERS = ['task', 'date', 'status'] as const;
const OUTPUT_PLACEHOLDER = /^output:([a-z][a-z0-9_]{0,39})$/;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/g;
// eslint-disable-next-line no-control-regex
const HAS_CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;
/** Characters a file name may not carry on a common file system, and the bidi controls that disguise one. */
// eslint-disable-next-line no-control-regex
const FILE_UNSAFE = /[\\/:*?"<>|\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

export const hasControl = (s: string): boolean => HAS_CONTROL.test(s);

/** One visible line: every control character and line break becomes a space, runs of spaces collapse, the ends are trimmed, then it is cut. */
export function singleLine(text: string, max: number): string {
  const flat = text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…` : flat;
}

/**
 * A file name from text: no separator, no `..`, no reserved character, no control character, no leading dot or trailing dot or space, never empty.
 * `/` and `\` become a space, `..` becomes a dot, so a value can name a file and never a place.
 */
export function safeFileName(text: string, max = FILE_NAME_MAX): string {
  let s = text.replace(FILE_UNSAFE, ' ').replace(/\.{2,}/g, '.').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (s.length > max) s = s.slice(0, max).replace(/[.\s]+$/, '');
  return s || 'run';
}

/** The placeholders a template names, in order. */
export function placeholdersOf(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

/** What is wrong with a template at setup: a line break or control character, an unknown placeholder, an output the task does not define, a stray brace. */
export function templateProblems(template: string, outputKeys: ReadonlySet<string> | null, opts: { maxLength?: number } = {}): string[] {
  const problems: string[] = [];
  if (hasControl(template)) problems.push('must not contain line breaks or control characters');
  if (template.length > (opts.maxLength ?? SUBJECT_MAX)) problems.push(`must be at most ${opts.maxLength ?? SUBJECT_MAX} characters`);
  for (const name of placeholdersOf(template)) {
    const out = OUTPUT_PLACEHOLDER.exec(name);
    if ((FIXED_PLACEHOLDERS as readonly string[]).includes(name)) continue;
    if (!out) problems.push(`{{${name}}} is not a placeholder (use {{task}}, {{date}}, {{status}} or {{output:<key>}})`);
    else if (outputKeys && !outputKeys.has(out[1]!)) problems.push(`{{output:${out[1]}}} names an output the task does not define`);
  }
  const rest = template.replace(PLACEHOLDER, '');
  if (/\{\{|\}\}/.test(rest)) problems.push('has an unclosed {{ }}');
  return problems;
}

export interface TemplateValues {
  task: string;
  date: string;
  status: string;
  /** The masked text of an output, by key. */
  output(key: string): string | undefined;
}

/**
 * Fills a template. A value is flattened to one line and capped before it goes in; the result of a `line` is one line, and of a `filename`
 * is a safe name. A missing output is empty. Nothing here can add a recipient, an address or a path: only text.
 */
export function renderTemplate(template: string, values: TemplateValues, kind: 'line' | 'filename', max = kind === 'line' ? SUBJECT_MAX : FILE_NAME_MAX): string {
  const filled = template.replace(PLACEHOLDER, (_all, name: string) => {
    const out = OUTPUT_PLACEHOLDER.exec(name);
    const raw = out ? values.output(out[1]!) : name === 'task' ? values.task : name === 'date' ? values.date : name === 'status' ? values.status : '';
    return singleLine(raw ?? '', TEMPLATE_VALUE_MAX);
  });
  return kind === 'line' ? singleLine(filled, max) : safeFileName(filled, max);
}
