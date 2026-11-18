// Sending an answer from a widget (#467): `question_card_answer` through the
// host (an app-only tool: the answer is recorded under channel
// `mcp-app.<client>`), then one short message to the conversation so it
// continues. Shared by the question card and the run card.
import { answerLabel, type RuleAnswer } from '@app/shared/question-rules';

import type { HostBridge } from './bridge';
import type { CardQuestion } from './question';
import { clip, firstText, obj, str, structured } from './text';

export type AnswerOutcome =
  /** Recorded: the answer in words. */
  | { kind: 'sent'; label: string; declined: boolean }
  /** Someone answered first (another device): their answer in words. */
  | { kind: 'already'; label: string }
  | { kind: 'expired' }
  /** The server refused it (validation, channel rule): its sentence; the form stays editable. */
  | { kind: 'refused'; message: string }
  /** The host did not send it (the user declined the host's prompt, or no host). */
  | { kind: 'not_sent' };

/** The answer in the question's own words, from a result's value/values. */
function labelOf(q: CardQuestion, s: Record<string, unknown>): string {
  const values = Array.isArray(s.values) ? s.values.filter((x): x is string => typeof x === 'string') : undefined;
  const outcome = s.outcome === 'cancelled' ? 'cancelled' : 'completed';
  return answerLabel(q, { outcome, ...(values ? { values } : {}), ...(str(s.value) !== undefined ? { value: str(s.value) } : {}) });
}

export async function sendAnswer<T extends string>(host: HostBridge<T>, tool: T, q: CardQuestion, answer: RuleAnswer): Promise<AnswerOutcome> {
  let r;
  try {
    r = await host.callTool(tool, { question_id: q.id, ...answer });
  } catch {
    return { kind: 'not_sent' };
  }
  if (r.isError) return { kind: 'refused', message: firstText(r) || 'The answer was not accepted.' };
  const s = structured(r) ?? {};
  if (s.status === 'expired') return { kind: 'expired' };
  if (s.already_answered === true) return { kind: 'already', label: labelOf(q, s) };
  return { kind: 'sent', label: answerLabel(q, answer), declined: answer.outcome === 'cancelled' };
}

/** The message that tells the assistant the question was answered (short: hosts cap `ui/message`). */
export function answeredMessage(o: Extract<AnswerOutcome, { kind: 'sent' }>): string {
  return o.declined ? "I declined the agent's question." : `I answered the agent's question: ${clip(o.label, 160)}`;
}

/** Tell the conversation, when the host lets the widget (failures change nothing: the answer is recorded). */
export async function tellConversation<T extends string>(host: HostBridge<T>, o: AnswerOutcome): Promise<boolean> {
  if (o.kind !== 'sent') return false;
  try {
    await host.sendMessage(answeredMessage(o));
    return true;
  } catch {
    return false;
  }
}

/** The settled state of a question as `question_status` answers it, or `null` while it is pending. */
export function settledOf(q: CardQuestion, r: unknown): { kind: 'already'; label: string } | { kind: 'expired' } | { kind: 'declined' } | null {
  const s = obj(r);
  if (!s) return null;
  if (s.status === 'expired') return { kind: 'expired' };
  if (s.status === 'cancelled') return { kind: 'declined' };
  if (s.status === 'answered') return { kind: 'already', label: labelOf(q, s) };
  return null;
}
