import { Injectable, Logger } from '@nestjs/common';
import { AiError, AiService, defineTool, type AiDefinedTool } from '@marinoscar/platform-api/ai';
import { JobsService } from '@marinoscar/platform-api/jobs';
import type { Conversation } from '@prisma/client';
import { z } from 'zod';

import { PrismaService } from '../prisma/prisma.service';
import { enqueueGoalRun } from '../runner/goal-run.enqueue';
import { LIVE_RUN_STATUSES } from '../tasks/runs.schemas';
import { TasksService } from '../tasks/tasks.service';
import { CHAT_ORCHESTRATOR_FEATURE_ID } from './chat-orchestrator.feature';
import { ChatResults } from './chat-results.service';
import { ChatTaskDraftService } from './chat-task-draft.service';
import { ChatService } from './chat.service';
import { transcriptLine } from './chat-transcript';

export { transcriptLine } from './chat-transcript';

/** What one job did: answered, found nothing to answer, or found another turn at work. */
export type ChatTurnOutcome = 'answered' | 'idle' | 'busy';

/** How long a turn may hold the conversation; a crashed turn's lease runs out by itself. */
export const CHAT_TURN_LEASE_MS = 3 * 60_000;
/** Messages that arrive while a turn works are answered by the same job, up to this many rounds. */
const MAX_ROUNDS = 3;
/** Model round trips per round: one to decide, a few more when a tool answer needs words. */
const MAX_MODEL_STEPS = 4;
/** How much of the thread the model reads. */
const HISTORY_MESSAGES = 40;

export const CHAT_INSTRUCTIONS = [
  'You are the chat front of Hexactra, an agent that operates a real web browser on behalf of its owner. You do not browse yourself: you decide what happens next in the conversation.',
  '- When the owner asks for something to be done or looked up on the web, call start_run with a complete goal. The browser agent sees ONLY that goal, so put in every detail and preference the conversation holds (what, where, dates, amounts, choices already made).',
  '- Call ask_user only when a missing detail would change what is done, and at most once before starting: one short question, with up to four short suggested answers when there are obvious ones. When in doubt, start: the browser agent asks the owner itself when it needs something.',
  '- Never ask for a password, a code, a card number or any other secret, and never put one in a goal. The browser agent requests those through a secure form when a page needs them.',
  '- One run at a time. While a run is live, do not start another. Call stop_run when the owner asks to stop or cancel.',
  '- While a run is live and the owner adds or changes something about the job ("use the 7:30 showing instead"), call guide_run with that instruction in one clear sentence. Guidance cannot change which sites are allowed or skip a confirmation: say so if the owner asks for that.',
  '- After a run has ended, a message that asks for more is a new job: call start_run. The browser agent is given the previous goal and result, and the same browser profile, so write only what is new.',
  '- Never say something was done, found, bought or sent unless a run result in the conversation says so.',
  '- When the owner asks to save this as a task (to reuse it, repeat it or schedule it), call draft_task. Do not write the task yourself.',
  '- For small talk, or a question about a result that is already in the conversation, answer in plain text, briefly.',
].join('\n');

/** Thrown from `onStep` once the turn has done its one thing (asked, or started a run). */
class TurnDone extends Error {}

/**
 * The chat's turn engine (#484): takes up the owner's newest message and
 * replies, asks one clarifying question, or starts a browser run. A run it
 * starts is an ordinary run (trigger `chat`): the goal runner does the work.
 *
 * One turn at a time per conversation: `run` takes the conversation's lease
 * (`turnLeaseUntil`) and answers `busy` when another job holds it.
 * `answeredSeq` is the newest owner message a turn has taken up, so a message
 * is answered once however many jobs were queued for it.
 */
@Injectable()
export class ChatTurnService {
  private readonly log = new Logger(ChatTurnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chats: ChatService,
    private readonly results: ChatResults,
    private readonly tasks: TasksService,
    private readonly jobs: JobsService,
    private readonly ai: AiService,
    private readonly drafts?: ChatTaskDraftService,
  ) {}

  async run(conversationId: string, userId: string, orgId: string | null): Promise<ChatTurnOutcome> {
    const db = this.prisma.forUser({ userId });
    const now = new Date();
    const claimed = await db.conversation.updateMany({
      where: { id: conversationId, status: 'active', OR: [{ turnLeaseUntil: null }, { turnLeaseUntil: { lt: now } }] },
      data: { turnLeaseUntil: new Date(now.getTime() + CHAT_TURN_LEASE_MS) },
    });
    if (claimed.count === 0) {
      // Not claimed: gone, archived (nothing to do), or another turn is working (come back).
      const c = await db.conversation.findFirst({ where: { id: conversationId }, select: { status: true } });
      return c?.status === 'active' ? 'busy' : 'idle';
    }
    try {
      let outcome: ChatTurnOutcome = 'idle';
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const c = await db.conversation.findFirst({ where: { id: conversationId } });
        if (!c || c.status !== 'active') break;
        const newest = await this.prisma.chatMessage.findFirst({ where: { conversationId, role: 'user' }, orderBy: { seq: 'desc' }, select: { seq: true } });
        if (!newest || newest.seq <= c.answeredSeq) break;
        // Taken up before the model is called: a failure below is reported in the thread, not retried into a loop.
        await db.conversation.updateMany({ where: { id: conversationId }, data: { answeredSeq: newest.seq } });
        await this.results.sync(userId, conversationId);
        await this.answer(c, userId, orgId);
        outcome = 'answered';
      }
      return outcome;
    } finally {
      await db.conversation.updateMany({ where: { id: conversationId }, data: { turnLeaseUntil: null } });
    }
  }

  private liveRun(userId: string, conversationId: string) {
    return this.prisma.forUser({ userId }).run.findFirst({ where: { conversationId, status: { in: [...LIVE_RUN_STATUSES] } }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true } });
  }

  /** What the chat's last finished job was and how it ended, for the run that follows it (#490). Empty for a chat's first job. */
  private async followUpContext(userId: string, conversationId: string): Promise<string> {
    const last = await this.prisma.forUser({ userId }).run.findFirst({
      where: { conversationId, status: { in: ['succeeded', 'failed', 'cancelled'] } },
      orderBy: { createdAt: 'desc' },
      select: { goal: true, status: true, result: true, error: true },
    });
    if (!last) return '';
    const ended = last.status === 'succeeded' ? 'It succeeded' : last.status === 'cancelled' ? 'It was stopped' : 'It failed';
    const detail = (last.result ?? last.error ?? '').trim();
    return [`Previous job: ${last.goal.slice(0, 1500)}`, `${ended}${detail ? `: ${detail.slice(0, 3000)}` : '.'}`].join('\n');
  }

  /** What the model reads: the end of the thread and whether a run is live. Built from messages only, never from a question's answer. */
  async buildInput(userId: string, conversationId: string): Promise<string> {
    const rows = await this.prisma.chatMessage.findMany({ where: { conversationId }, orderBy: { seq: 'desc' }, take: HISTORY_MESSAGES, select: { seq: true, role: true, kind: true, text: true, meta: true } });
    const live = await this.liveRun(userId, conversationId);
    // Owner messages already passed to a run, so the model does not pass one twice (#490).
    const passed = new Set((await this.prisma.runGuidance.findMany({ where: { conversationId, messageSeq: { in: rows.map((r) => r.seq) } }, select: { messageSeq: true } })).map((g) => g.messageSeq));
    const line = (m: (typeof rows)[number]) => `${transcriptLine(m)}${passed.has(m.seq) ? ' [already passed to the run with guide_run]' : ''}`;
    return ['Conversation, oldest first:', ...rows.reverse().map(line), '', live ? `State: a run of this chat is live (${live.status}).` : 'State: no run is live.'].join('\n');
  }

  private async answer(c: Conversation, userId: string, orgId: string | null): Promise<void> {
    const state = { done: false, wrote: false, stopped: false };
    const tools: AiDefinedTool[] = [
      defineTool({
        name: 'ask_user',
        description: 'Ask the owner one clarifying question and wait for the answer. Only when the answer changes what would be done.',
        parameters: z.object({ question: z.string().min(1).max(1000), options: z.array(z.string().min(1).max(80)).max(4).nullable() }),
        execute: async ({ question, options }) => {
          if (state.done) return 'Already handled this turn.';
          await this.chats.append(c.id, { role: 'assistant', kind: 'clarify', text: question.trim(), ...(options?.length ? { meta: { options } } : {}) });
          state.done = state.wrote = true;
          return 'Asked. The owner will answer in the chat.';
        },
      }),
      defineTool({
        name: 'start_run',
        description: 'Start a browser run that does the job. `goal` is everything the browser agent will know: make it complete and self-contained. Never include a secret.',
        parameters: z.object({ goal: z.string().min(1).max(4000) }),
        execute: async ({ goal }) => {
          if (state.done) return 'Already handled this turn.';
          if (await this.liveRun(userId, c.id)) return 'Refused: a run of this chat is still live. Guide it with guide_run, wait for it to end, or stop it with stop_run.';
          const context = await this.followUpContext(userId, c.id);
          const run = await this.prisma.forUser({ userId }).run.create({
            data: {
              userId,
              conversationId: c.id,
              goal: goal.trim(),
              profile: c.profile,
              hostId: c.hostId,
              hostFallback: c.hostFallback,
              trigger: 'chat',
              ...(c.policyRef ? { policyRef: c.policyRef, policySource: 'run' as const } : {}),
              // A follow-up starts with what the chat's last job did (#490); the runner shows it after the goal.
              ...(context ? { transcript: { log: [], chunks: 0, context } } : {}),
            },
            select: { id: true, goal: true },
          });
          await this.chats.append(c.id, { role: 'assistant', kind: 'run', text: run.goal, runId: run.id });
          await enqueueGoalRun(this.jobs, { runId: run.id, userId, orgId }, 'run_started');
          state.done = state.wrote = true;
          return 'Started. The owner watches it in the chat.';
        },
      }),
      defineTool({
        name: 'guide_run',
        description: "Pass an instruction from the owner to the chat's live run. The browser agent reads it at its next step. Only while a run is live. Never a secret.",
        parameters: z.object({ note: z.string().min(1).max(1000) }),
        execute: async ({ note }) => {
          if (state.done) return 'Already handled this turn.';
          const live = await this.liveRun(userId, c.id);
          if (!live) return 'Refused: no run of this chat is live, so there is nothing to guide. Tell the owner the job has ended; if they want more done, start a new job with start_run.';
          const from = await this.prisma.chatMessage.findFirst({ where: { conversationId: c.id, role: 'user' }, orderBy: { seq: 'desc' }, select: { seq: true } });
          await this.prisma.runGuidance.create({ data: { runId: live.id, conversationId: c.id, messageSeq: from?.seq ?? 0, note: note.trim() } });
          // No reply is written: the owner's own message shows "Queued", then "Seen by the agent".
          state.done = state.wrote = true;
          return 'Queued. The browser agent reads it at its next step.';
        },
      }),
      defineTool({
        name: 'stop_run',
        description: "Stop the chat's live run, when the owner asks to stop or cancel.",
        parameters: z.object({}),
        execute: async () => {
          const live = await this.liveRun(userId, c.id);
          if (!live) return 'No run of this chat is live.';
          await this.tasks.cancel(userId, live.id);
          state.stopped = true;
          return 'Stopping the run.';
        },
      }),
      ...(this.drafts
        ? [
            defineTool({
              name: 'draft_task',
              description: 'Draft a reusable task from this conversation, for the owner to review and save. Only when the owner asks to save, reuse, repeat or schedule what was done.',
              parameters: z.object({}),
              execute: async () => {
                if (state.done) return 'Already handled this turn.';
                const draft = await this.drafts!.draft(userId, c.id, orgId);
                if (!draft.goal) return 'There is nothing to save yet: no job was described in this chat.';
                await this.chats.append(c.id, { role: 'assistant', kind: 'task_draft', text: draft.goal, meta: { ...draft } });
                state.done = state.wrote = true;
                return 'Drafted. The owner reviews and saves it from the chat.';
              },
            }),
          ]
        : []),
    ];

    let text = '';
    try {
      const result = await this.ai.forUser(userId, { feature: CHAT_ORCHESTRATOR_FEATURE_ID, ...(orgId ? { orgId } : {}) }).runTools({
        instructions: CHAT_INSTRUCTIONS,
        input: await this.buildInput(userId, c.id),
        tools,
        maxSteps: MAX_MODEL_STEPS,
        onStep: () => {
          if (state.done) throw new TurnDone();
        },
      });
      text = result.final?.outputText?.trim() ?? '';
    } catch (e) {
      if (!(e instanceof TurnDone)) {
        // The owner sees why nothing happened; the job still fails, so an administrator sees it too.
        if (!state.wrote) await this.chats.append(c.id, { role: 'system', kind: 'text', text: failureText(e) });
        throw e;
      }
    }
    if (state.done) return;
    if (text) await this.chats.append(c.id, { role: 'assistant', kind: 'text', text: text.slice(0, 8000) });
    else await this.chats.append(c.id, { role: 'assistant', kind: 'text', text: state.stopped ? 'Stopping the run.' : 'Tell me what you would like me to do in the browser.' });
    this.log.debug(`chat ${c.id}: answered`);
  }
}

/** Why the AI did not answer, in words for the owner. Never the provider's raw message: it can carry request details. */
export function failureText(e: unknown): string {
  if (e instanceof AiError) {
    if (/^No model selected/.test(e.message)) return 'No AI model is set up for the chat yet. An administrator can choose one under Administration → AI. Then send your message again.';
    return `The AI could not answer (${e.code}). Send your message again in a moment.`;
  }
  return 'Something went wrong while answering. Send your message again.';
}
