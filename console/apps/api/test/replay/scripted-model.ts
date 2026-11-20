// The model of a scripted scenario (E38.6): it plays back the tool calls the scenario lists, one list per model call. It validates each
// call's arguments against the tool's schema as a provider would, keeps every request and every tool result it read (what the model saw),
// and counts synthetic tokens. `recording` wraps any other model (a live one) to keep the same record.
import type { ModelPort, ModelRequest, ModelResult, ModelStep } from '@marinoscar/hexactra-agent';
import type { ScenarioCall } from './scenario.schema';

/** The script has no more model calls: the scenario forgot a `finish`, or the agent asked more than the script expected. */
export class ScriptExhausted extends Error {
  constructor() {
    super('the script has no more model calls');
  }
}

/** The script names a tool that is not offered this round, or gives it arguments the tool's schema refuses. */
export class ScriptError extends Error {}

/** What the model read and was shown, for the invariants that look at it. */
export interface ModelRecord {
  requests: ModelRequest[];
  /** The text of every tool result the model read. */
  results: string[];
  /** The calls made, in order. */
  calls: { tool: string; args: unknown }[];
}

export const newModelRecord = (): ModelRecord => ({ requests: [], results: [], calls: [] });

/** Defaults for the arguments a script may leave out: the strict schemas of the providers make every field required, a script need not. */
const DEFAULTS: Record<string, unknown> = {
  reason: 'scripted step',
  submit: false,
  double: false,
  modifiers: [],
  button: 'left',
  choices: null,
  options: null,
  constraints: null,
  confirm_label: null,
  deny_label: null,
  risk: null,
  remember_label: null,
  topic: null,
  parameter: null,
};

export function withDefaults(tool: string, args: Record<string, unknown> | undefined, shape?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  // Only the fields the tool has (an MCP server's tool keeps every argument it is given, so a stray default would reach the server).
  for (const [k, v] of Object.entries(DEFAULTS)) if (!(k in out) && (!shape || k in shape)) out[k] = v;
  if (tool === 'read_text' && !('selector' in out)) out.selector = null;
  if (tool === 'new_tab' && !('url' in out)) out.url = null;
  return out;
}

/** Sets every field the script left out that the tool's schema allows to be null (the connection tools' optional fields), to null. */
export function fillNullable(schema: unknown, args: Record<string, unknown>): Record<string, unknown> {
  const shape = (schema as { shape?: Record<string, { safeParse(v: unknown): { success: boolean } }> }).shape;
  if (!shape) return args;
  const out = { ...args };
  for (const [k, field] of Object.entries(shape)) if (!(k in out) && field.safeParse(null).success) out[k] = null;
  return out;
}

const tokens = (value: unknown): number => Math.ceil(JSON.stringify(value ?? '').length / 4);

export class ScriptedScenarioModel implements ModelPort {
  private readonly chunks: ScenarioCall[][];
  constructor(
    script: ScenarioCall[][],
    readonly record: ModelRecord = newModelRecord(),
  ) {
    this.chunks = script.map((c) => [...c]);
  }
  /** Model calls the script still has. */
  get remaining(): number {
    return this.chunks.length;
  }
  async runTools(req: ModelRequest): Promise<ModelResult> {
    this.record.requests.push(req);
    const chunk = this.chunks.shift();
    if (!chunk) throw new ScriptExhausted();
    let first = true;
    for (const call of chunk) {
      const tool = req.tools.find((t) => t.name === call.tool);
      if (!tool) throw new ScriptError(`the script calls "${call.tool}", which is not offered this round (offered: ${req.tools.map((t) => t.name).join(', ')})`);
      const args = fillNullable(tool.parameters, withDefaults(call.tool, call.args, (tool.parameters as { shape?: Record<string, unknown> }).shape));
      const parsed = tool.parameters.safeParse(args);
      if (!parsed.success) throw new ScriptError(`the script's arguments for "${call.tool}" are refused: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      this.record.calls.push({ tool: call.tool, args: parsed.data });
      const result = await tool.execute(parsed.data as never);
      this.record.results.push(result);
      // Synthetic, deterministic usage: the first call of a chunk pays for the whole input, the rest for the tool results added to it.
      const step: ModelStep = { response: { usage: { inputTokens: first ? tokens(req.input) + tokens(req.instructions) : tokens(result) + 20, outputTokens: 30 } } };
      first = false;
      req.onStep(step);
    }
    return { stopReason: 'steps_exhausted', outputText: '' };
  }
}

/** Wraps a model (a live one) so that the requests and the tool results it saw are kept for the invariants. */
export function recording(inner: ModelPort, record: ModelRecord): ModelPort {
  return {
    async runTools(req) {
      record.requests.push(req);
      const tools = req.tools.map((t) => ({
        ...t,
        execute: async (args: never) => {
          record.calls.push({ tool: t.name, args });
          const result = await t.execute(args);
          record.results.push(result);
          return result;
        },
      }));
      return inner.runTools({ ...req, tools });
    },
  };
}
