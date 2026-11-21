// The scripted owner (E44.3, #741): answers the question a trial's run waits on, from the challenge's rules, through the ordinary
// answer service, as the owner. It answers questions and does nothing else:
//   - never `remember`, never `rememberRule`, and `rememberAllowed: false`: an answer cannot make or widen a saved approval;
//   - a suggested memory and an offer to save a sign-in are never answered (the broker refuses them on this channel anyway);
//   - it reads no connection, no saved login and no secret: credentials in a rule are fixture values derived from the trial's seed.
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { QuestionsService } from '../questions/questions.service';
import { BENCHMARK_ANSWER_CHANNEL, OWNER_CARD_INPUTS, brokerAnswer, scriptRules, type ScriptQuestion } from './owner-script';
import { challengeById } from './suite/registry';

/** `answered`: the run continues. `unscripted`: no rule fits, the trial ends as "asked a person". `idle`: nothing to answer now. */
export type OwnerTurn = 'answered' | 'unscripted' | 'idle';

@Injectable()
export class BenchmarkOwner {
  private readonly log = new Logger(BenchmarkOwner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly questions: QuestionsService,
  ) {}

  /** The questions of a run, oldest first, as the script reads them. */
  async questionsOf(userId: string, runId: string): Promise<(ScriptQuestion & { blocking: boolean; handoffId: string | null })[]> {
    return this.prisma.question.findMany({
      where: { runId, ownerUserId: userId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, kind: true, input: true, prompt: true, status: true, answeredChannel: true, createdAt: true, options: true, blocking: true, handoffId: true },
    });
  }

  /** Answers the question a `waiting_human` trial run waits on. */
  async answer(owner: { userId: string; orgId: string | null }, trial: { id: string; challengeId: string; seed: string }, run: { id: string; handoffId: string | null }): Promise<OwnerTurn> {
    const all = await this.questionsOf(owner.userId, run.id);
    const waiting = all.find((q) => q.status === 'pending' && q.blocking && !OWNER_CARD_INPUTS.includes(q.input) && q.handoffId === run.handoffId);
    if (!waiting) return 'idle';
    const rules = challengeById(trial.challengeId)?.owner?.(trial.seed) ?? [];
    const rule = scriptRules(rules, all).get(waiting.id) ?? null;
    const input = rule ? brokerAnswer(rule.answer, waiting) : null;
    if (!input) return 'unscripted';
    try {
      await this.questions.answer({ id: owner.userId, activeOrgId: owner.orgId }, waiting.id, input, { channel: BENCHMARK_ANSWER_CHANNEL, rememberAllowed: false });
      this.log.log(`trial ${trial.id}: answered a ${waiting.kind} question (${rule!.answer.type})`);
      return 'answered';
    } catch (e) {
      // Somebody answered first, or it expired: nothing to do. An answer the card refuses is a question nobody scripted.
      if (e instanceof ConflictException) return 'idle';
      if (e instanceof BadRequestException || e instanceof ForbiddenException) return 'unscripted';
      throw e;
    }
  }
}
