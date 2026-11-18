// What the question card reads from a tool result (#467): the pending
// questions of `inbox_list`, or the one question of `ask_human` /
// `question_status` (with its state), plus the console URL and the scopes.
import { questionFromBlock, questionFromInbox, type CardQuestion } from './shared/question';
import { scopesOf } from './shared/scopes';
import type { CardKey } from './shared/supersede';
import { obj, str, structured, type ToolResultLike } from './shared/text';

/** The only server tools this bundle calls (scripts/check-bundle.mjs checks the built file names no other). */
export const QUESTION_CARD_TOOLS = ['inbox_list', 'question_card_answer', 'question_status'] as const;
export type QuestionCardTool = (typeof QUESTION_CARD_TOOLS)[number];

/** How often the list refreshes while it is visible and something is pending. */
export const REFRESH_MS = 15_000;

export interface QuestionResult {
  /** `list`: inbox_list (every pending question); `single`: one question (ask_human, question_status). */
  source: 'list' | 'single';
  questions: CardQuestion[];
  /** One question that is no longer pending (single): its final state. */
  status?: string;
  raw: Record<string, unknown>;
  appUrl?: string;
  scopes: string[] | null;
  key?: CardKey;
}

function keyOf(s: Record<string, unknown>): CardKey | undefined {
  const k = obj(s.card_key);
  return k && typeof k.created_at === 'number' && typeof k.seq === 'number' ? { created_at: k.created_at, seq: k.seq } : undefined;
}

/** A tool result as the card's data, or `undefined` (an error, or something else). */
export function questionResultOf(r: ToolResultLike | undefined | null): QuestionResult | undefined {
  if (!r || r.isError) return undefined;
  const s = structured(r);
  if (!s) return undefined;
  const common = { raw: s, scopes: scopesOf(s), ...(str(s.app_url) ? { appUrl: str(s.app_url) } : {}), ...(keyOf(s) ? { key: keyOf(s) } : {}) };
  if (Array.isArray(s.items)) {
    const questions = s.items.map(questionFromInbox).filter((q): q is CardQuestion => q !== undefined);
    return { source: 'list', questions, ...common };
  }
  const q = questionFromBlock(s.question);
  if (!q) return undefined;
  return { source: 'single', questions: [q], ...(str(s.status) ? { status: str(s.status) } : {}), ...common };
}

/** A kind of question in a word, for its chip. */
export const KIND_LABEL: Readonly<Record<string, string>> = {
  captcha: 'CAPTCHA',
  code: 'Code',
  passkey: 'Passkey',
  login: 'Sign-in',
  confirmation: 'Confirm',
  other: 'Question',
};
