// The tools of the owner's MCP servers (E39.9, #606): one `RunnerTool` per tool the owner enabled on a connection the run lists, built when
// a job starts from the stored catalogue (`McpRunService.toolsFor`) and registered like any other tool (group `connection:<id>`).
//
//   * The model's name is `<label_slug>__<tool_name>` and its description is prefixed with the connection's label; every description is
//     cleaned and capped. One fixed line in the instructions says these tools come from third parties (`MCP_TRUST_LINE`).
//   * `read` tools (the OWNER marked them) are called without asking. `write` tools go through the connection gate of #604: a card the
//     server builds from the validated arguments, the same call once approved, and "Don't ask again" per connection and tool. They are
//     commit-class: an intent step before the request, and an unknown outcome is never repeated blindly.
//   * Arguments are validated against the tool's stored JSON schema BEFORE any request, then redacted of every credential. The result is
//     redacted, capped, marked untrusted and wrapped; images, audio and resource links are dropped.
//   * At the moment of a call the stored tool is checked again (same hash, same mode, enabled): a tool the owner switched off, or that
//     changed, since the job started is refused.
import { z } from 'zod';

import type { QuestionAction } from '../../../../questions/questions.contract';
import { checkArguments, schemaUsable, type ArgsCheck } from '../../../../connections/mcp/mcp-validate';
import { redactArgs } from '../../../../connections/mcp/mcp-redact';
import { labelSlug, modelToolName } from '../../../../connections/mcp/mcp-text';
import { MCP_TRUST_LINE } from '../../../../connections/mcp/mcp.constants';
import type { McpRunTool } from '../../../../connections/mcp/mcp-run.service';
import type { SnapshotConnection } from '../../../../policies/policy-snapshot';
import { clip, defineRunnerTool, LEASE_LOST_TEXT, type RunnerTool, type ToolFamily } from '@marinoscar/hexactra-agent';
import { ATTR } from '../../../trace-attributes';
import type { HostContext } from '../../context';
import type { HostDeps } from '../../deps';
import { settle } from './commit';
import { CONNECTION_GATE, hashArgs, openCallIntent, recordStep, refusal, takeRead, wrapMcpContent, type ConnectionDecision, type ConnectionGateRequest } from './support';

/** The most a read returns before the run's own read caps apply. */
const READ_CHARS = 20_000;
const WRITE_CHARS = 4_000;
const FIELDS_ON_CARD = 20;

const asArgs = (raw: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(raw ?? {})) as Record<string, unknown>;
const invalid = (v: Extract<ArgsCheck, { ok: false }>): string =>
  v.unsupported ? "This tool's schema cannot be checked, so it was not called." : `The arguments are not valid for this tool (${v.issues.join('; ')}). Fix them and retry. Nothing was sent.`;

/** What a step may keep about arguments: their names and the size or kind of each value, never a value. */
export function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args).slice(0, 30)) {
    out[k.slice(0, 60)] = typeof v === 'string' ? `${v.length} characters` : Array.isArray(v) ? `${v.length} items` : v !== null && typeof v === 'object' ? 'an object' : v;
  }
  return out;
}

const shown = (v: unknown): string => clip(typeof v === 'string' ? v : JSON.stringify(v), 300);

/** The card's fields, from the validated arguments: a readable list, values truncated. */
function fieldLines(args: Record<string, unknown>): { label: string; value: string }[] {
  const entries = Object.entries(args);
  const lines = entries.slice(0, FIELDS_ON_CARD).map(([k, v]) => ({ label: clip(k, 60), value: shown(v) }));
  return entries.length > FIELDS_ON_CARD ? [...lines, { label: 'More', value: `${entries.length - FIELDS_ON_CARD} more fields not shown` }] : lines;
}

const nameOf = (t: McpRunTool): string => t.title || t.name;

interface WritePlan {
  request: ConnectionGateRequest;
  safe: Record<string, unknown>;
  stepArgs: Record<string, unknown>;
}

async function planWrite(ctx: HostContext, def: McpRunTool, name: string, raw: unknown): Promise<WritePlan | string> {
  const mcp = ctx.ext.d.mcp!;
  const live = await mcp.check(ctx.run.userId, def.connectionId, def.name, { hash: def.hash, mode: 'write' });
  if (!live.ok) return live.text;
  const args = asArgs(raw);
  const valid = checkArguments(def.hash, def.inputSchema, args);
  if (!valid.ok) return invalid(valid);
  const safe = redactArgs(args, await mcp.exactSecrets(ctx.run.userId));
  const what = `call "${clip(nameOf(def), 100)}" on "${def.connectionLabel}"`;
  const action: QuestionAction = {
    connectionId: def.connectionId,
    connectionLabel: def.connectionLabel,
    tool: name,
    display: what,
    summary: `call ${clip(nameOf(def), 100)} on ${def.connectionLabel}`,
    lines: [{ label: 'Server', value: def.connectionLabel }, { label: 'Tool', value: clip(nameOf(def), 200) }, ...fieldLines(safe)],
    hash: hashArgs({ tool: name, connection: def.connectionId, version: def.hash, args: safe }),
  };
  const request: ConnectionGateRequest = { tool: name, connection: { id: def.connectionId, label: def.connectionLabel, provider: 'mcp' }, action, summary: `Call ${clip(nameOf(def), 100)} on ${def.connectionLabel}` };
  return { request, safe, stepArgs: { connection: def.connectionLabel, tool: def.name, arguments: summarizeArgs(safe) } };
}

const calledOn = (def: McpRunTool): string => `called ${clip(nameOf(def), 100)} on ${def.connectionLabel}`;
const attrs = (ctx: HostContext, effect: 'read' | 'write'): void => ctx.ports.telemetry.toolAttributes({ [ATTR.connectionProvider]: 'mcp', [ATTR.connectionEffect]: effect });
const notes = (out: { truncated: boolean; dropped: string }, extra = false): string[] => [...(out.truncated || extra ? ['The result was cut at the size limit.'] : []), ...(out.dropped ? [`Dropped (not text): ${out.dropped}.`] : [])];

async function runRead(ctx: HostContext, def: McpRunTool, name: string, raw: unknown): Promise<string> {
  const refused = await ctx.preflight();
  if (refused) return refused;
  const started = Date.now();
  const args = asArgs(raw);
  const stepArgs = { connection: def.connectionLabel, tool: def.name, arguments: summarizeArgs(args) };
  const valid = checkArguments(def.hash, def.inputSchema, args);
  if (!valid.ok) {
    await recordStep(ctx, name, started, stepArgs, false, 'the arguments were not valid; nothing was sent');
    return invalid(valid);
  }
  attrs(ctx, 'read');
  const mcp = ctx.ext.d.mcp!;
  const safe = redactArgs(args, await mcp.exactSecrets(ctx.run.userId));
  const out = await mcp.call(ctx.run.userId, def.connectionId, def.name, safe, { expect: { hash: def.hash, mode: 'read' }, signal: ctx.ports.control.abortSignal, maxChars: READ_CHARS });
  if (out.kind !== 'ok') {
    await recordStep(ctx, name, started, stepArgs, false, clip(out.text, 300));
    return out.text;
  }
  const taken = takeRead(ctx, { chars: out.text.length });
  if (taken.refused) {
    await recordStep(ctx, name, started, stepArgs, false, 'a read cap of the run was reached');
    return taken.refused;
  }
  const text = out.text.slice(0, taken.chars);
  await recordStep(ctx, name, started, stepArgs, !out.isError, out.isError ? `${def.connectionLabel} reported an error` : calledOn(def), { content: text });
  return wrapMcpContent(def.connectionLabel, { result: text, ...(out.isError ? { isError: true } : {}), ...(notes(out, taken.cut).length ? { notes: notes(out, taken.cut) } : {}) });
}

async function runWrite(ctx: HostContext, def: McpRunTool, name: string, raw: unknown, decision: ConnectionDecision): Promise<string> {
  const plan = await planWrite(ctx, def, name, raw);
  if (typeof plan === 'string') return plan;
  const refused = await ctx.preflight();
  if (refused) return refused;
  const started = Date.now();
  await ctx.setActivity('acting', { action: { type: name }, timeoutMs: 60_000 });
  const seqBefore = ctx.state.seq;
  const check = "check with one of this server's read tools whether it happened";
  const intent = await openCallIntent(ctx, name, def.connectionId, plan.stepArgs, `call "${clip(nameOf(def), 100)}" on "${def.connectionLabel}"; before anything else, ${check}`);
  if (intent === null) return LEASE_LOST_TEXT;
  attrs(ctx, 'write');
  const unknownApproval = (): void => void ((ctx.memory.connections ??= {}).approved = null);
  try {
    const out = await ctx.ext.d.mcp!.call(ctx.run.userId, def.connectionId, def.name, plan.safe, { expect: { hash: def.hash, mode: 'write' }, signal: ctx.ports.control.abortSignal, maxChars: WRITE_CHARS });
    if (out.kind === 'ok') {
      await recordStep(ctx, name, started, plan.stepArgs, !out.isError, out.isError ? `${def.connectionLabel} reported an error` : calledOn(def), { intent });
      await settle(ctx, decision, name, seqBefore);
      return wrapMcpContent(def.connectionLabel, { result: out.text, ...(out.isError ? { isError: true } : {}), ...(notes(out).length ? { notes: notes(out) } : {}) });
    }
    if (out.kind === 'failed' && out.unknown) {
      await recordStep(ctx, name, started, plan.stepArgs, false, `${clip(out.text, 200)} The outcome is not known.`, { intent });
      unknownApproval();
      return `${out.text} It may or may not have happened. Do not repeat it blindly: ${check}, and if you cannot tell, ask the owner.`;
    }
    // Certainly nothing was done (not allowed, not signed in, the arguments refused): the owner's approval stands for a retry.
    await recordStep(ctx, name, started, plan.stepArgs, false, clip(out.text, 300), { intent });
    return out.text;
  } finally {
    await ctx.setActivity('thinking');
  }
}

function describe(def: McpRunTool): string {
  const title = def.title ? `${def.title}. ` : '';
  return clip(`[${def.connectionLabel}] ${title}${def.description}`.trim(), 700);
}

function build(def: McpRunTool, name: string, parameters: z.ZodTypeAny, first: boolean): RunnerTool<HostContext> {
  const common = {
    name,
    group: `connection:${def.connectionId}`,
    family: mcpFamilyId(def.connectionId),
    description: describe(def),
    parameters,
    strict: false as const,
    ...(first ? { usage: MCP_TRUST_LINE } : {}),
    available: (ctx: HostContext) => Boolean(ctx.ext.d.mcp) && ctx.ext.connections.list.some((c) => c.connectionId === def.connectionId),
  };
  if (def.mode === 'read') return defineRunnerTool({ ...common, execute: (ctx: HostContext, args: unknown) => runRead(ctx, def, name, args) }) as unknown as RunnerTool<HostContext>;
  return defineRunnerTool({
    ...common,
    commits: true,
    gated: {
      [CONNECTION_GATE]: async (ctx: HostContext, args: unknown): Promise<ConnectionGateRequest> => {
        const plan = await planWrite(ctx, def, name, args);
        return typeof plan === 'string' ? refusal(name, plan) : plan.request;
      },
    },
    execute: (ctx: HostContext, args: unknown, gate: Readonly<Record<string, unknown>>) => runWrite(ctx, def, name, args, gate[CONNECTION_GATE] as ConnectionDecision),
  }) as unknown as RunnerTool<HostContext>;
}

/** The family id of an MCP server's tools (E41.2): one family per server. */
export const mcpFamilyId = (connectionId: string): string => `mcp:${connectionId}`;

/**
 * One family per MCP server the run is offered tools of (E41.2): the owner's label as the title, the server's own `instructions` (third-party
 * text: cleaned and capped when stored, and only ever in this line, under `MCP_TRUST_LINE`) or, when it gave none, the first tool titles.
 */
export function mcpFamilies(defs: readonly McpRunTool[]): ToolFamily<HostContext>[] {
  const byServer = new Map<string, McpRunTool[]>();
  for (const d of defs) byServer.set(d.connectionId, [...(byServer.get(d.connectionId) ?? []), d]);
  return [...byServer.values()].map((tools) => {
    const first = tools[0]!;
    const names = tools.slice(0, 5).map((t) => clip(t.title || t.name, 60));
    const own = first.serverInstructions?.trim();
    return {
      id: mcpFamilyId(first.connectionId),
      title: first.connectionLabel,
      whenToUse: own || `Tools the owner added from "${first.connectionLabel}": ${names.join(', ')}${tools.length > 5 ? ', …' : ''}.`,
      rank: 20,
      toolbox: () => `"${first.connectionLabel}" (${tools.length} tool${tools.length === 1 ? '' : 's'})`,
    };
  });
}

/** The tools of the MCP connections a run lists and their families (E41.2). */
export async function mcpToolset(d: Pick<HostDeps, 'mcp'>, userId: string, list: readonly SnapshotConnection[]): Promise<{ tools: RunnerTool<HostContext>[]; families: ToolFamily<HostContext>[] }> {
  const { tools, defs } = await buildMcp(d, userId, list);
  return { tools, families: mcpFamilies(defs) };
}

/**
 * The tools of the MCP connections a run lists, in the order of the list and then by name, at most 40. A tool whose schema cannot be both
 * offered to a model and checked here is left out. Empty without the connections module, with the deployment switch off, or with none.
 */
export async function mcpTools(d: Pick<HostDeps, 'mcp'>, userId: string, list: readonly SnapshotConnection[]): Promise<RunnerTool<HostContext>[]> {
  return (await buildMcp(d, userId, list)).tools;
}

async function buildMcp(d: Pick<HostDeps, 'mcp'>, userId: string, list: readonly SnapshotConnection[]): Promise<{ tools: RunnerTool<HostContext>[]; defs: McpRunTool[] }> {
  const chosen = list.filter((c) => c.provider === 'mcp');
  if (!d.mcp || chosen.length === 0) return { tools: [], defs: [] };
  const defs = await d.mcp.toolsFor(userId, chosen.map((c) => ({ connectionId: c.connectionId, access: c.access })));
  const taken = new Set<string>();
  const out: RunnerTool<HostContext>[] = [];
  const used: McpRunTool[] = [];
  for (const def of defs) {
    if (!schemaUsable(def.hash, def.inputSchema)) continue;
    let parameters: z.ZodTypeAny;
    try {
      parameters = z.fromJSONSchema(def.inputSchema as never) as z.ZodTypeAny;
      z.toJSONSchema(parameters, { unrepresentable: 'throw' });
    } catch {
      continue;
    }
    out.push(build(def, modelToolName(labelSlug(def.connectionLabel), def.name, taken), parameters, out.length === 0));
    used.push(def);
  }
  return { tools: out, defs: used };
}

