// Steps the owner confirmed that a run then carried out (#540). Pure, no I/O.
//
// After a person approves a `confirmation` handoff, the next successful action
// is the one they allowed (a payment, an order, a message sent). It is kept on
// the run (`runs.confirmed_actions`) so a run that then does not succeed says
// so, and "Run again" asks before it repeats the job.
import { maskSensitive } from '../tasks/mask';

/** One confirmed action, as stored. The prompt is cut and masked; never a typed value or a secret. */
export interface ConfirmedAction {
  /** The step's `seq`. */
  seq: number;
  /** The question the person approved, at most 300 characters, masked. */
  prompt: string;
  /** The action's name (`click`, `click_at`, `key`, …). */
  action: string;
  /** ISO time it was carried out. */
  at: string;
}

/** At most this many entries per run. */
export const MAX_CONFIRMED_ACTIONS = 20;
/** The stored prompt's length. */
export const CONFIRMED_PROMPT_MAX = 300;

/** Read `runs.confirmed_actions`: malformed entries are dropped. */
export function readConfirmedActions(value: unknown): ConfirmedAction[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is ConfirmedAction => !!v && typeof v === 'object' && typeof v.seq === 'number' && typeof v.prompt === 'string' && typeof v.action === 'string' && typeof v.at === 'string')
    .map((v) => ({ seq: v.seq, prompt: v.prompt, action: v.action, at: v.at }));
}

/** The prompt as it is stored: whitespace folded, cut to 300 characters, masked. */
export function storedPrompt(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  const cut = flat.length > CONFIRMED_PROMPT_MAX ? `${flat.slice(0, CONFIRMED_PROMPT_MAX - 1)}…` : flat;
  return maskSensitive(cut).text;
}

/** The list with one more entry (the oldest twenty are kept). */
export function appendConfirmedAction(current: unknown, entry: { seq: number; prompt: string; action: string; at: Date }): ConfirmedAction[] {
  const list = readConfirmedActions(current);
  if (list.length >= MAX_CONFIRMED_ACTIONS) return list;
  return [...list, { seq: entry.seq, prompt: storedPrompt(entry.prompt), action: entry.action.slice(0, 64), at: entry.at.toISOString() }];
}

/** The prompt shortened for a sentence. */
function quoted(prompt: string, max = 120): string {
  return prompt.length > max ? `${prompt.slice(0, max - 1)}…` : prompt;
}

/**
 * The sentence a run that carried out a confirmed step, and did not succeed, leads its result with.
 * Null when there is nothing to say.
 */
export function confirmedLead(actions: readonly ConfirmedAction[], status: string): string | null {
  if (actions.length === 0 || status === 'succeeded') return null;
  const last = actions[actions.length - 1]!;
  const more = actions.length > 1 ? ` (and ${actions.length - 1} earlier confirmed step${actions.length > 2 ? 's' : ''})` : '';
  return `The step you confirmed was carried out (step ${last.seq}: '${quoted(last.prompt)}')${more}, but the run ended before it could check the outcome. Check before you run it again.`;
}

/** A result with the lead sentence in front, when there is one. */
export function withConfirmedLead(text: string, actions: readonly ConfirmedAction[], status: string): string {
  const lead = confirmedLead(actions, status);
  if (!lead) return text;
  return text.trim() ? `${lead}\n\n${text}` : lead;
}

/** How many of a run's last log lines a wrap-up without words reports. */
const NO_REPORT_LINES = 5;

/** The result of a wrap-up where the model called no `finish` (#540): the run's own last steps, masked. */
export function noReportResult(log: readonly string[]): string {
  const last = log.filter((l) => /^\d+\. /.test(l)).slice(-NO_REPORT_LINES);
  const lines = (last.length ? last : log.slice(-NO_REPORT_LINES)).map((l) => maskSensitive(l.length > 400 ? `${l.slice(0, 399)}…` : l).text);
  return lines.length ? `Stopped before the agent could report. Last steps:\n${lines.join('\n')}` : 'Stopped before the agent could report.';
}
