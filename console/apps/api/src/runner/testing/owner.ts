// The owner of a scenario (E38.6): a question port that records what the agent asked, and the answer the scenario scripts for it, folded
// into the run's memory the way the host does on a resumed job (`runner/host/start.ts`): the answer line the model reads, the approved
// target the risk gate lets through once, the secret handoff `type_handoff_secret` types. The host's database round trip is not here: a
// scenario checks the harness and the browser layer, not the question broker.
import { answerLine } from '../browser/request-human-spec';
import { clearUnknown, type HarnessMemory, type OpenedQuestion, type QuestionPort, type QuestionSpec } from '../harness';
import type { OwnerRule } from './scenario.schema';
import type { OwnerSecrets } from './site';

export interface AskedQuestion {
  handoffId: string;
  spec: QuestionSpec;
  /** How many site activations had happened when it was asked: what "asked before the click" compares. */
  activationsAtAsk: number;
  /** How many actions had reached the browser. */
  actionsAtAsk: number;
  answered: { rule: OwnerRule; completed: boolean } | null;
}

/** Records the questions. `now` says where the site is, so each question knows what had happened before it. */
export class OwnerQuestions implements QuestionPort {
  readonly asked: AskedQuestion[] = [];
  constructor(private readonly where: () => { activations: number; actions: number }) {}
  parse(raw: Record<string, unknown>) {
    if (typeof raw.prompt !== 'string' || !raw.prompt) return { ok: false as const, message: 'prompt: required' };
    return { ok: true as const, spec: raw as unknown as QuestionSpec };
  }
  prepare(spec: QuestionSpec): QuestionSpec {
    return spec;
  }
  async open(spec: QuestionSpec): Promise<OpenedQuestion> {
    const handoffId = `handoff-${this.asked.length + 1}`;
    const { activations, actions } = this.where();
    this.asked.push({ handoffId, spec, activationsAtAsk: activations, actionsAtAsk: actions, answered: null });
    return { handoffId, expiresAt: null, questionId: null };
  }
  /** The question the run now waits for. */
  get pending(): AskedQuestion | null {
    return [...this.asked].reverse().find((q) => q.answered === null) ?? null;
  }
}

const matches = (rule: OwnerRule, q: QuestionSpec): boolean =>
  (!rule.when.kind || rule.when.kind === q.kind) && (!rule.when.input || rule.when.input === q.input) && (!rule.when.promptIncludes || q.prompt.includes(rule.when.promptIncludes));

/** The rules still to use, and the first that fits a question. A rule answers once unless it says `repeat`. */
export class OwnerScript {
  private readonly used = new Set<OwnerRule>();
  constructor(
    private readonly rules: OwnerRule[],
    private readonly secrets: OwnerSecrets,
  ) {}

  find(spec: QuestionSpec): OwnerRule | null {
    return this.rules.find((r) => (r.repeat || !this.used.has(r)) && matches(r, spec)) ?? null;
  }

  /** Answers the pending question with the matching rule and folds the answer into the memory. False: nobody answers, the run keeps waiting. */
  answer(q: AskedQuestion, memory: HarnessMemory & { secretHandoffId?: string | null }): boolean {
    const rule = this.find(q.spec);
    if (!rule) return false;
    this.used.add(rule);
    const { input, kind } = q.spec;
    let completed = true;
    let value: string | undefined;
    switch (rule.answer) {
      case 'approve':
        value = 'approve';
        break;
      case 'deny':
        // A yes/no card answers "deny"; any other kind of ask is declined.
        if (input === 'confirm') value = 'deny';
        else completed = false;
        break;
      case 'decline':
        completed = false;
        break;
      case 'secret':
        this.secrets.put(q.handoffId, rule.value ?? '');
        break;
      case 'credentials':
        this.secrets.put(q.handoffId, rule.password ?? '');
        value = rule.value;
        break;
      case 'text':
      case 'choice':
        value = rule.value;
        break;
      case 'done':
        break;
    }
    q.answered = { rule, completed };
    if (!completed) {
      memory.log.push('The person did not help (handoff cancelled, declined). Do not retry the same request; finish if you cannot continue.');
      return true;
    }
    const options = Array.isArray(q.spec.options) ? (q.spec.options as { id: string; label: string }[]) : null;
    if (input === 'secret' || input === 'credentials') memory.secretHandoffId = q.handoffId;
    const approved = kind === 'confirmation' && (input !== 'confirm' || value === 'approve');
    const gate = (q.spec.gate as { category: string | null; label: string | null; host: string | null } | undefined) ?? null;
    // The approval covers the target the gate stopped, never any later one; a confirmation the agent asked on its own names no target.
    if (approved && gate) {
      memory.confirmedTarget = { category: gate.category, label: gate.label, host: gate.host };
      clearUnknown(memory, memory.confirmedTarget);
    }
    if (approved) memory.pendingConfirmation = { prompt: q.spec.prompt, tries: 0 };
    memory.log.push(answerLine({ input, kind, value, options, unit: null, rememberLabel: null }));
    return true;
  }
}
