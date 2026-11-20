// The chat thread's pure parts (#486): how messages merge, what a row shows,
// and the words of the header. No React here, so they are tested directly.
import type { Chat, ChatListItem, ChatMessage, ChatRun } from '../types/chat';

/** The path of a chat, of the new-chat screen, and of the list. */
export const chatPaths = {
  list: '/chat',
  new: '/chat/new',
  chat: (id: string) => `/chat/${id}`,
} as const;

/** What an untitled chat is called until its first message names it. */
export const UNTITLED_CHAT = 'New chat';
export const chatTitle = (chat: Pick<Chat, 'title'> | null | undefined): string => chat?.title.trim() || UNTITLED_CHAT;

/** The longest message the API takes (`CHAT_MESSAGE_MAX` in apps/api/src/chat/chat.schemas.ts). */
export const CHAT_MESSAGE_MAX = 8000;

/** What the new-chat screen offers to start from. */
export const EXAMPLE_PROMPTS = [
  'Find the cheapest direct flight from San José to Lisbon in March and tell me the dates.',
  'Check when my next electricity bill is due and how much it is.',
  'Compare three well-reviewed travel strollers under $150 and summarise the differences.',
] as const;

/**
 * The thread after new messages arrive: one row per `seq`, oldest first. The
 * stream resends from where the page subscribed when it reconnects, and a
 * sent message comes back both from its POST and from the stream, so the
 * same `seq` can arrive more than once: the newest copy wins.
 */
export function mergeMessages(prev: readonly ChatMessage[], incoming: readonly ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return prev as ChatMessage[];
  const bySeq = new Map(prev.map((m) => [m.seq, m]));
  for (const m of incoming) bySeq.set(m.seq, m);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** The newest `seq` the page holds; 0 for an empty thread. */
export const lastSeq = (messages: readonly ChatMessage[]): number => messages[messages.length - 1]?.seq ?? 0;

/** The suggested answers of a clarifying question (`meta.options`), at most four short strings. */
export function clarifyOptions(message: Pick<ChatMessage, 'kind' | 'meta'>): string[] {
  if (message.kind !== 'clarify') return [];
  const options = (message.meta as { options?: unknown } | null)?.options;
  return Array.isArray(options) ? options.filter((o): o is string => typeof o === 'string' && o.trim().length > 0).slice(0, 4) : [];
}

/** The calendar day of a message in the given time zone, as `YYYY-MM-DD`. */
function dayKey(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/** "Today", "Yesterday", or the date in words. */
export function dayLabel(iso: string, timeZone: string, now: number = Date.now()): string {
  const key = dayKey(iso, timeZone);
  if (key === dayKey(new Date(now).toISOString(), timeZone)) return 'Today';
  if (key === dayKey(new Date(now - 86_400_000).toISOString(), timeZone)) return 'Yesterday';
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso));
}

export type ThreadRow = { type: 'day'; key: string; label: string } | { type: 'message'; key: string; message: ChatMessage };

/** The thread as rows: a day separator before the first message of each day. */
export function threadRows(messages: readonly ChatMessage[], timeZone: string, now: number = Date.now()): ThreadRow[] {
  const rows: ThreadRow[] = [];
  let day = '';
  for (const message of messages) {
    const key = dayKey(message.createdAt, timeZone);
    if (key !== day) {
      day = key;
      rows.push({ type: 'day', key: `day-${key}`, label: dayLabel(message.createdAt, timeZone, now) });
    }
    rows.push({ type: 'message', key: message.id, message });
  }
  return rows;
}

const RUN_WORDS: Record<string, string> = { queued: 'Starting the browser…', running: 'Working in the browser…', waiting_human: 'Waiting for you', paused: 'Paused' };
/** The same words for a run that has not opened a browser (E41.3): a job done with the owner's accounts may never open one. */
const RUN_WORDS_NO_BROWSER: Record<string, string> = { ...RUN_WORDS, queued: 'Starting…', running: 'Working…' };

/** The line under the chat's title: what is happening right now, or nothing. */
export function chatSubtitle(state: { chat: Pick<Chat, 'status'> | null; thinking: boolean; run: Pick<ChatRun, 'status' | 'hasBrowser'> | null }): string {
  if (state.chat?.status === 'archived') return 'Archived';
  // An older console does not say (`hasBrowser` absent): its words stay as they were.
  const words = state.run?.hasBrowser === false ? RUN_WORDS_NO_BROWSER : RUN_WORDS;
  if (state.run && words[state.run.status]) return words[state.run.status]!;
  if (state.thinking) return 'Thinking…';
  return '';
}

/** One line for a chat in the list: what was said last. */
export function previewLine(item: Pick<ChatListItem, 'preview'>): string {
  const p = item.preview;
  if (!p) return 'No messages yet';
  if (p.kind === 'run') return `Started: ${p.text}`;
  if (p.kind === 'result') return `Result: ${p.text}`;
  if (p.kind === 'task_draft') return 'Drafted a task';
  if (p.kind === 'request') return `Asked you: ${p.text}`;
  if (p.kind === 'memory') return p.text.startsWith('Offered to save') ? p.text : 'Suggested remembering something';
  return p.role === 'user' ? `You: ${p.text}` : p.text;
}
