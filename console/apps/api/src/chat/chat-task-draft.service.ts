import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AiService } from '@marinoscar/platform-api/ai';
import type { Conversation } from '@prisma/client';

import { PARAMETER_TYPES, paramKey, type TaskParameter, type TaskParameterType } from '@app/shared/task-params';

import { PrismaService } from '../prisma/prisma.service';
import { OUTPUT_TYPES, outputKey, type TaskOutput, type TaskOutputType } from '@app/shared/task-fields';
import { prepareOutputs } from '../tasks/task-outputs';
import { prepareParameters } from '../tasks/task-params';
import { CHAT_ORCHESTRATOR_FEATURE_ID } from './chat-orchestrator.feature';
import { ChatService, titleFromMessage } from './chat.service';
import { transcriptLine } from './chat-transcript';
import { withRequestOutcomes } from '../questions/chat-request-record';

/** A task drafted from a chat: what `POST /tasks` takes, for the owner to review before saving. */
export interface ChatTaskDraft {
  name: string;
  goal: string;
  profile: string;
  hostId: string | null;
  hostFallback: boolean;
  policyId: string | null;
  allowedDomains: string[];
  confirmRiskyActions: boolean;
  useSavedLogins: boolean;
  useSavedIdentity: boolean;
  useSavedCards: boolean;
  /** The goal's `{{Name}}` parameters the draft proposes (#556): checked like a saved task's; empty when nothing varies. */
  parameters: TaskParameter[];
  /** The values a run of the task would return (E39.5, #600), proposed from what the finished run reported (an amount paid, a confirmation number, a date); empty when nothing is worth keeping. */
  outputs: TaskOutput[];
  /** The chat's connections its runs used (E41.5), at the access they needed: a proposal for the form, never applied by the server. */
  connections: { connectionId: string; access: 'read' | 'read_write' }[];
}

/** The connection tools that change something: a run that used one needed read and write access. */
const WRITE_TOOLS = new Set(['mail_send', 'mail_draft', 'mail_modify', 'calendar_create_event', 'calendar_update_event', 'calendar_delete_event', 'docs_create', 'docs_append', 'sheet_append_rows', 'sheet_create', 'file_upload']);
const READ_TOOLS = new Set(['connections_list', 'mail_search', 'mail_read', 'mail_attachment_to_browser', 'calendar_list', 'calendar_free_busy', 'docs_search', 'docs_read', 'sheet_read']);

const NAME_MAX = 200;
const GOAL_MAX = 4000;
/** How much of the thread the draft is written from. */
const HISTORY_MESSAGES = 60;

export const TASK_DRAFT_INSTRUCTIONS = [
  'You turn a conversation between an owner and their browser agent into ONE reusable task for that agent.',
  'Write the goal as a complete, standalone instruction: someone who never saw the conversation must be able to run it. Fold in what the owner clarified, the choices they made and what turned out to work. Leave out one-off details that would be wrong next time (a specific date that has passed, an order number), or say how to choose them ("the next Saturday").',
  'Never include a password, a code, a card number or any other secret, and never invent facts the conversation does not contain.',
  'Parameters: a value that would change between runs (an amount, a date, a quantity) becomes a placeholder {{Name}} in the goal, with no default: it is asked every time. A person, a phone number, an email or an account ending becomes a placeholder too, with a default: the matching memory and its value name when the owner has one (listed in the input as "Memories"), otherwise the value from the conversation. Everything else stays text. Use names of letters, digits and spaces ("Amount", "Recipient phone", "Account last 4"). No placeholder when nothing varies.',
  'Outputs: the facts the owner would want to keep from every run, as a record (an amount paid, a confirmation number, a date, a remaining balance) become outputs, each with a label and a type, only when a finished run in the conversation reported them. No output when nothing is worth keeping. Never propose a password, a code or a card number as an output.',
  'Answer with JSON only, no prose and no code fence: {"name": "<a short name, at most 60 characters>", "goal": "<the instruction, at most 3000 characters>", "parameters": [{"name": "<the placeholder\'s name>", "type": "text|number|money|date|choice|phone|email", "default": "<a fixed value, optional>", "memory": "<a memory\'s label, optional>", "attribute": "<that memory\'s value name>"}], "outputs": [{"label": "<what it is, e.g. Confirmation number>", "type": "text|number|money|date|datetime|boolean|url", "help": "<where to find it, optional>"}]}',
].join('\n');

/** A parameter as the model proposes it. */
export interface DraftParameter {
  name: string;
  type: TaskParameterType;
  default?: string;
  memory?: string;
  attribute?: string;
}

function draftParameters(raw: unknown): DraftParameter[] {
  if (!Array.isArray(raw)) return [];
  const out: DraftParameter[] = [];
  for (const r of raw.slice(0, 20) as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object' || typeof r.name !== 'string' || !r.name.trim()) continue;
    const type = (PARAMETER_TYPES as readonly string[]).includes(String(r.type)) ? (r.type as TaskParameterType) : 'text';
    const p: DraftParameter = { name: r.name.trim(), type };
    if (typeof r.default === 'string' && r.default.trim()) p.default = r.default.trim();
    if (typeof r.memory === 'string' && r.memory.trim() && typeof r.attribute === 'string' && r.attribute.trim()) {
      p.memory = r.memory.trim();
      p.attribute = r.attribute.trim();
    }
    out.push(p);
  }
  return out;
}

/** An output as the model proposes it. */
export interface DraftOutput {
  label: string;
  type: TaskOutputType;
  help?: string;
}

function draftOutputs(raw: unknown): DraftOutput[] {
  if (!Array.isArray(raw)) return [];
  const out: DraftOutput[] = [];
  for (const r of raw.slice(0, 12) as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object' || typeof r.label !== 'string' || !r.label.trim()) continue;
    // A choice needs options the model is not asked for: a plain text output instead.
    const type = (OUTPUT_TYPES as readonly string[]).includes(String(r.type)) && r.type !== 'choice' ? (r.type as TaskOutputType) : 'text';
    const o: DraftOutput = { label: r.label.trim().slice(0, 80), type };
    if (typeof r.help === 'string' && r.help.trim()) o.help = r.help.trim().slice(0, 200);
    out.push(o);
  }
  return out;
}

/** The outputs a draft proposes, checked like a saved task's: keys derived, none that fail the checks; never sensitive (the owner decides that in the form). */
export function draftOutputDefinitions(proposed: readonly DraftOutput[]): TaskOutput[] {
  const seen = new Set<string>();
  const unique = proposed.filter((p) => {
    const k = outputKey(p.label);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  try {
    return prepareOutputs(unique.map((p) => ({ label: p.label, type: p.type, required: true, ...(p.help ? { help: p.help } : {}) })));
  } catch {
    return [];
  }
}

/** The `{ name, goal, parameters, outputs }` of a model answer, or null when it is not that. */
export function parseDraft(text: string): { name: string; goal: string; parameters?: DraftParameter[]; outputs?: DraftOutput[] } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as { name?: unknown; goal?: unknown; parameters?: unknown; outputs?: unknown };
    if (typeof value.goal !== 'string' || !value.goal.trim()) return null;
    const parameters = draftParameters(value.parameters);
    const outputs = draftOutputs(value.outputs);
    return { name: typeof value.name === 'string' ? value.name.trim() : '', goal: value.goal.trim(), ...(parameters.length ? { parameters } : {}), ...(outputs.length ? { outputs } : {}) };
  } catch {
    return null;
  }
}

/** One of the owner's memories as the draft may name it: its label and the names of its values, never the values. */
export interface DraftMemory {
  id: string;
  label: string;
  /** Other words for it (#551), matched like the label. */
  aliases?: string[];
  attributes: string[];
}

/**
 * The definitions a draft proposes, checked like a saved task's (#556). A
 * memory default is kept only when the owner has an active memory of that
 * label holding that value; otherwise a fixed default, otherwise asked. When
 * the definitions do not pass the checks the draft keeps the placeholders
 * without defaults, and when the goal itself is malformed, none: the owner
 * reviews every one in the task form before anything is saved.
 */
export function draftDefinitions(goal: string, proposed: readonly DraftParameter[], memories: readonly DraftMemory[]): TaskParameter[] {
  const defs = proposed.map((p) => {
    const def: Partial<TaskParameter> = { key: paramKey(p.name), label: p.name, type: p.type, required: true };
    const wanted = p.memory?.toLowerCase();
    const m = wanted ? memories.find((x) => x.label.toLowerCase() === wanted || (x.aliases ?? []).some((a) => a.toLowerCase() === wanted)) : undefined;
    const attribute = m?.attributes.find((a) => a.toLowerCase() === p.attribute?.toLowerCase());
    if (m && attribute) def.default = { memory: { id: m.id, attribute } };
    else if (p.default) def.default = { value: p.default };
    return def;
  });
  for (const attempt of [defs, defs.map(({ default: _d, ...rest }) => rest), []]) {
    try {
      return prepareParameters(goal, attempt);
    } catch {
      // Try with less.
    }
  }
  return [];
}

/**
 * Drafts a reusable task from a chat (#489). The model writes the name and
 * the goal from the thread; everything else is the chat's own run settings.
 * It reads chat messages only (`transcriptLine`), so no question's answer and
 * no secret can reach the model or the draft. When the model gives nothing
 * usable, the draft falls back to the goal of the chat's newest run, so the
 * owner always gets a form to edit.
 */
@Injectable()
export class ChatTaskDraftService {
  private readonly log = new Logger(ChatTaskDraftService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
  ) {}

  /** What the model reads: the end of the thread, oldest first. */
  async buildInput(conversationId: string, memories: readonly DraftMemory[] = []): Promise<string> {
    const rows = await withRequestOutcomes(this.prisma, await this.prisma.chatMessage.findMany({ where: { conversationId }, orderBy: { seq: 'desc' }, take: HISTORY_MESSAGES, select: { role: true, kind: true, text: true, meta: true } }));
    // The owner's memories by label and value names only: the draft names one as a default, it never copies a value from here.
    const known = memories.length ? ['Memories (label: value names):', ...memories.map((m) => `- ${m.label}: ${m.attributes.join(', ')}`), ''] : [];
    return [...known, 'Conversation, oldest first:', ...rows.reverse().map(transcriptLine)].join('\n');
  }

  /**
   * The owner's active memories (#551) for a memory-backed default: label,
   * aliases and value names, never the values. Read through the owner's
   * scoped client; the newest used first, at most 100.
   */
  async memories(userId: string): Promise<DraftMemory[]> {
    const rows = await this.prisma.forUser({ userId }).memory.findMany({
      where: { status: 'active' },
      select: { id: true, label: true, aliases: true, attributes: true },
      orderBy: [{ lastUsedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: 100,
    });
    return rows.map((r) => ({ id: r.id, label: r.label, aliases: r.aliases, attributes: r.attributes && typeof r.attributes === 'object' ? Object.keys(r.attributes as object) : [] }));
  }

  private async fallback(c: Conversation): Promise<{ name: string; goal: string; parameters?: DraftParameter[]; outputs?: DraftOutput[] }> {
    const run = await this.prisma.forUser({ userId: c.userId }).run.findFirst({ where: { conversationId: c.id }, orderBy: { createdAt: 'desc' }, select: { goal: true } });
    const first = run ? null : await this.prisma.chatMessage.findFirst({ where: { conversationId: c.id, role: 'user' }, orderBy: { seq: 'asc' }, select: { text: true } });
    return { name: c.title, goal: run?.goal ?? first?.text ?? '' };
  }

  async draft(userId: string, conversationId: string, orgId: string | null): Promise<ChatTaskDraft> {
    const c = await this.prisma.forUser({ userId }).conversation.findFirst({ where: { id: conversationId } });
    if (!c) throw new NotFoundException({ code: 'CHAT_NOT_FOUND', message: 'Chat not found' });
    let written: { name: string; goal: string; parameters?: DraftParameter[]; outputs?: DraftOutput[] } | null = null;
    const memories = await this.memories(userId);
    try {
      const response = await this.ai.forUser(userId, { feature: CHAT_ORCHESTRATOR_FEATURE_ID, ...(orgId ? { orgId } : {}) }).respond({ instructions: TASK_DRAFT_INSTRUCTIONS, input: await this.buildInput(c.id, memories) });
      written = parseDraft(response.outputText ?? '');
    } catch (e) {
      // No model, or it failed: the owner still gets a draft to edit, from what the chat already holds.
      this.log.warn(`chat ${c.id}: the task draft falls back to the run's goal: ${e instanceof Error ? e.message : String(e)}`);
    }
    const base = written ?? (await this.fallback(c));
    const goal = base.goal.slice(0, GOAL_MAX);
    return {
      name: (base.name || titleFromMessage(base.goal) || c.title || 'Task from a chat').slice(0, NAME_MAX),
      goal,
      profile: c.profile,
      hostId: c.hostId,
      hostFallback: c.hostFallback,
      policyId: c.policyRef,
      allowedDomains: c.allowedDomains,
      confirmRiskyActions: c.confirmRiskyActions,
      useSavedLogins: c.useSavedLogins,
      useSavedIdentity: c.useSavedIdentity,
      useSavedCards: c.useSavedCards,
      parameters: draftDefinitions(goal, base.parameters ?? [], memories),
      outputs: draftOutputDefinitions(base.outputs ?? []),
      connections: await this.usedConnections(userId, c.id),
    };
  }

  /**
   * The chat's connections that its runs used (E41.5): read from the runs' successful connection steps (each names its account by label, and
   * an MCP step the server's tool). Read and write when a run changed something through it (a write tool, or an MCP tool the owner set to
   * write); read otherwise. Only the chat's own connections are ever proposed, and nothing is written.
   */
  private async usedConnections(userId: string, conversationId: string): Promise<ChatTaskDraft['connections']> {
    const listed = await this.prisma.conversationConnection.findMany({ where: { conversationId, conversation: { userId } }, select: { connectionId: true, connection: { select: { label: true, provider: true } } } });
    if (listed.length === 0) return [];
    const byLabel = new Map(listed.map((l) => [l.connection.label.toLowerCase(), l]));
    const steps = await this.prisma.runStep.findMany({ where: { run: { conversationId, userId }, kind: 'action', ok: true }, select: { action: true, args: true }, take: 2000 });
    const used = new Map<string, 'read' | 'read_write'>();
    for (const s of steps) {
      const action = s.action ?? '';
      const args = (s.args ?? {}) as { connection?: unknown; tool?: unknown };
      const isMcp = action.includes('__');
      if (!isMcp && !WRITE_TOOLS.has(action) && !READ_TOOLS.has(action)) continue;
      const hit = typeof args.connection === 'string' ? byLabel.get(args.connection.toLowerCase()) : undefined;
      if (!hit) continue;
      let write = WRITE_TOOLS.has(action);
      if (isMcp && typeof args.tool === 'string') {
        const tool = await this.prisma.connectionMcpTool.findFirst({ where: { connectionId: hit.connectionId, name: args.tool }, select: { mode: true } });
        write = tool?.mode === 'write';
      }
      if (write || !used.has(hit.connectionId)) used.set(hit.connectionId, write ? 'read_write' : (used.get(hit.connectionId) ?? 'read'));
    }
    return listed.filter((l) => used.has(l.connectionId)).map((l) => ({ connectionId: l.connectionId, access: used.get(l.connectionId)! }));
  }
}
