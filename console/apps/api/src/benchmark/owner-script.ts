// The scripted owner's rules (E44.3, #741), as plain functions: which rule answers which question of a trial's run, and the answer in
// the question broker's own words. No database and no Nest, so every rule is unit-tested.
//
// A rule answers once unless it says `repeat`. Which rules are spent is never stored: it is recomputed from the run's questions, oldest
// first, so the same questions always give the same answers, on any replica and after a crash.
import type { QuestionAnswerInput } from '../questions/questions.contract';
import type { AskedQuestion, OwnerAnswer, OwnerRule } from './suite/types';

/** The channel the scripted owner's answers are recorded under: what tells its answers from a person's. */
export const BENCHMARK_ANSWER_CHANNEL = 'benchmark';

/** The cards a run shows its owner without waiting on them (a suggested memory, an offer to save a sign-in). The scripted owner never answers one. */
export const OWNER_CARD_INPUTS: readonly string[] = ['memory', 'save_login', 'form'];

/** A question of a trial's run, as the script reads it. */
export interface ScriptQuestion {
  id: string;
  kind: string;
  input: string;
  prompt: string;
  status: string;
  answeredChannel: string | null;
  createdAt: Date;
  options?: unknown;
}

const fits = (rule: OwnerRule, q: Pick<ScriptQuestion, 'kind' | 'input' | 'prompt'>): boolean =>
  (!rule.kind || rule.kind === q.kind) && (!rule.input || rule.input === q.input) && (!rule.match || q.prompt.toLowerCase().includes(rule.match.toLowerCase()));

/**
 * The rule for each question, oldest first: the rule that answered it (it was answered on the benchmark channel), the rule that would
 * answer it now (it is pending), or null. A question a person or the run itself settled spends no rule.
 */
export function scriptRules(rules: readonly OwnerRule[], questions: readonly ScriptQuestion[]): Map<string, OwnerRule | null> {
  const used = new Set<OwnerRule>();
  const out = new Map<string, OwnerRule | null>();
  for (const q of [...questions].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))) {
    const ours = q.status === 'pending' || q.answeredChannel === BENCHMARK_ANSWER_CHANNEL;
    const rule = ours && !OWNER_CARD_INPUTS.includes(q.input) ? (rules.find((r) => (r.repeat || !used.has(r)) && fits(r, q)) ?? null) : null;
    if (rule) used.add(rule);
    out.set(q.id, rule);
  }
  return out;
}

/**
 * A rule's answer as the question broker takes it, or null when the answer does not suit the question (text for a yes/no card, a
 * choice the card does not offer): the question is then one nobody scripted. Never `remember`, never `rememberRule`: an answer cannot
 * make a saved approval, a memory or a saved login.
 */
export function brokerAnswer(answer: OwnerAnswer, q: Pick<ScriptQuestion, 'input' | 'options'>): QuestionAnswerInput | null {
  const options = Array.isArray(q.options) ? (q.options as { id?: unknown; label?: unknown }[]) : [];
  switch (answer.type) {
    case 'approve':
      if (q.input === 'confirm') return { outcome: 'completed', value: 'approve' };
      // A request to do something by hand, acknowledged: nothing was typed.
      return q.input === 'none' ? { outcome: 'completed' } : null;
    case 'deny':
      return q.input === 'confirm' ? { outcome: 'completed', value: 'deny' } : { outcome: 'cancelled' };
    case 'text': {
      if (q.input === 'text' || q.input === 'secret') return { outcome: 'completed', value: answer.text };
      if (q.input === 'number') return Number.isFinite(Number(answer.text)) ? { outcome: 'completed', value: Number(answer.text) } : null;
      if (q.input === 'choice' || q.input === 'multi_choice') {
        const wanted = answer.text.trim().toLowerCase();
        const option = options.find((o) => String(o.id).toLowerCase() === wanted || String(o.label ?? '').trim().toLowerCase() === wanted);
        if (!option) return null;
        return q.input === 'choice' ? { outcome: 'completed', value: String(option.id) } : { outcome: 'completed', values: [String(option.id)] };
      }
      return null;
    }
    case 'credentials':
      // Fixture credentials of the challenge site (derived from the seed): the password goes to the fabric only, like any sign-in.
      if (q.input === 'credentials') return { outcome: 'completed', value: answer.username, secret: answer.password };
      return q.input === 'secret' ? { outcome: 'completed', value: answer.password } : null;
  }
}

/** The questions as the grader sees them, oldest first: what was asked, and what the scripted owner answered (`none`: nobody did). */
export function askedQuestions(rules: readonly OwnerRule[], questions: readonly ScriptQuestion[], mask: (text: string) => string): AskedQuestion[] {
  const matched = scriptRules(rules, questions);
  return [...questions]
    .filter((q) => !OWNER_CARD_INPUTS.includes(q.input))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    .map((q) => ({
      kind: q.kind,
      input: q.input,
      prompt: mask(q.prompt),
      at: q.createdAt.getTime(),
      answered: q.answeredChannel === BENCHMARK_ANSWER_CHANNEL ? (matched.get(q.id)?.answer.type ?? 'none') : 'none',
    }));
}
