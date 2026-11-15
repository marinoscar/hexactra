import type { QuestionConstraints, QuestionInput, QuestionOption } from './questions.js';

/** `GET /api/inbox` items (apps/api/src/browser/inbox.controller.ts). */
export interface InboxItem {
  questionId: string;
  /** Null for a free-standing question (answered through /api/questions/:id/answer). */
  runId: string | null;
  goal: string;
  askedBy: string;
  kind: string;
  prompt: string;
  input: QuestionInput;
  /** Option ids; `options` carries the labels. */
  choices: string[];
  options: QuestionOption[] | null;
  constraints: QuestionConstraints | null;
  confirmLabel: string | null;
  denyLabel: string | null;
  risk: 'low' | 'high' | null;
  pageTitle: string | null;
  viewerUrl: string | null;
  expiresAt: string;
}

/** The short reference `inbox list` prints: the run for a run's question, else the question. */
export function inboxRef(i: Pick<InboxItem, 'runId' | 'questionId'>): string {
  return (i.runId ?? i.questionId).slice(0, 8);
}

/** Read one line from stdin (for a secret: never an argument, so it stays out of shell history). */
export async function readStdinLine(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) {
    data += String(chunk);
    if (data.includes('\n')) break;
  }
  return data.split('\n')[0]!.trim();
}
