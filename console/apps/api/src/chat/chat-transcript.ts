// How a chat thread reads to a model (#484, #489): one labelled line per
// message. Apart from the services that use it, so they can import it without
// importing each other.
import type { ChatMessage } from '@prisma/client';

/** How much of one message a model reads. */
const HISTORY_MESSAGE_CHARS = 2_000;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One line of the thread as the model reads it. Messages never hold a secret, so neither does this. */
export function transcriptLine(m: Pick<ChatMessage, 'role' | 'kind' | 'text' | 'meta'>): string {
  const text = clip(m.text.trim(), HISTORY_MESSAGE_CHARS);
  if (m.kind === 'clarify') {
    const options = (m.meta as { options?: unknown } | null)?.options;
    return `[assistant asked] ${text}${Array.isArray(options) && options.length ? ` (suggested: ${options.join(' | ')})` : ''}`;
  }
  if (m.kind === 'run') return `[run started] ${text}`;
  if (m.kind === 'result') return `[run ${String((m.meta as { status?: unknown } | null)?.status ?? 'ended')}] ${text}`;
  if (m.kind === 'task_draft') return `[task drafted] ${text}`;
  // A memory proposal (#553): the card waits for the owner; whether it was saved is not the model's to claim.
  if (m.kind === 'memory') return (m.meta as { card?: unknown } | null)?.card === 'save_login' ? `[login save offered] ${text}` : `[memory proposed] ${text}`;
  // A request a run made of the owner (E40.1): the outcome only (`meta.outcome`, filled by `withRequestOutcomes`), never a value.
  if (m.kind === 'request') {
    const outcome = (m.meta as { outcome?: unknown } | null)?.outcome;
    return `[run asked the owner] ${text}${typeof outcome === 'string' ? ` -> ${outcome}` : ''}`;
  }
  return `[${m.role}] ${text}`;
}
