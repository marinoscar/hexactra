// What each kind of channel may collect (epic #285), as plain functions over
// a question, so the channel that offers an answer and the route that takes
// it apply the same rule.
//
// - Public answers (choice, multi_choice, text, number, low-risk confirm)
//   can be collected on any channel.
// - A secret: every channel gets only a link to the protected page.
// - A high-risk confirm: only where the console signs the person in (web,
//   Android app, CLI/TUI); never a webhook or a push button.
// - takeover and none need the page itself.
import type { QuestionInputType, QuestionOption } from '../questions.contract';

/** The fields of a question the rules read. */
export interface RuleQuestion {
  input: QuestionInputType | string;
  risk: 'low' | 'high' | string | null;
  options: QuestionOption[] | null;
  confirmLabel?: string | null;
  denyLabel?: string | null;
}

/** Whether the answer is public: a channel that does not sign the person in (a webhook) may collect it. */
export function isPublicAnswer(q: RuleQuestion): boolean {
  switch (q.input) {
    case 'choice':
    case 'multi_choice':
    case 'text':
    case 'number':
      return true;
    case 'confirm':
      return q.risk === 'low';
    default:
      return false;
  }
}

/** One quick-answer button: what it says and the answer value it sends. */
export interface QuickAnswer {
  title: string;
  value: string;
}

const label = (s: string) => (s.length > 64 ? `${s.slice(0, 63)}…` : s);

/**
 * The notification buttons that answer a question in one tap, or `null`:
 * a low-risk confirm (Approve / Deny) or a choice with exactly two options
 * (one button each). Everything else opens the question.
 */
export function quickAnswers(q: RuleQuestion): QuickAnswer[] | null {
  if (q.input === 'confirm' && q.risk === 'low') {
    return [
      { title: label(q.confirmLabel || 'Approve'), value: 'approve' },
      { title: label(q.denyLabel || 'Deny'), value: 'deny' },
    ];
  }
  if (q.input === 'choice' && q.options?.length === 2) return q.options.map((o) => ({ title: label(o.label), value: o.id }));
  return null;
}
