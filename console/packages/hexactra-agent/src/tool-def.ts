// What a tool is (E38.5). A tool is data plus one function: it imports neither the loop nor another tool, and reaches the outside only
// through the context it is given.
import type { z } from 'zod';

import type { QuestionSpec } from './ports';
import type { AnyContext } from './run-context';

/** The step a gate's refusal leaves: recorded by the wrapper as a failed action, so the run page and the model's log show it. */
export interface RefusalStep {
  action: string;
  args: Record<string, unknown>;
  summary: string;
  reasoning?: string;
}

/** What a gate answers for one call. */
export type GateVerdict =
  | { kind: 'allow'; data?: unknown }
  | { kind: 'refuse'; text: string; step?: RefusalStep }
  /** Open the question and tell the model to wait: no built-in gate asks yet (a refusal that tells the model to ask is the rule today). */
  | { kind: 'ask'; question: QuestionSpec; text: string };

/** What the gates that let a call through left for the tool, by gate name (a matched saved approval, the gated target). */
export type GateDecision = Readonly<Record<string, unknown>>;

/**
 * A tool call's description of itself for one gate. Which gates apply, and what each looks at, is the tool's `gated` map: gate name to
 * a function that reads the call (and the page, through the context) and returns the gate's request.
 */
export type GateRequestFn<C extends AnyContext, P extends z.ZodTypeAny> = (ctx: C, args: z.output<P>) => unknown | Promise<unknown>;

export interface RunnerTool<C extends AnyContext = AnyContext, P extends z.ZodTypeAny = z.ZodTypeAny> {
  /** The name the model calls it by. Permanent once runs exist: a rename changes what a model has learned. */
  name: string;
  /** Deprecated: `family` supersedes it (E41.2). Kept for what reads it; `toolFamilyOf` uses `family ?? group`. */
  group: string;
  /** The tool's family (E41.2): `browser`, `desktop`, `accounts`, `mcp:<connectionId>`, `human`, `control`, `secrets`, `memory`. A registered `ToolFamily` with this id describes it to the model. */
  family?: string;
  description: string;
  parameters: P;
  /**
   * `false` offers the schema to the provider without strict function calling: a tool whose schema is a third party's (an MCP server's)
   * has optional fields and open objects that strict mode refuses. Absent: strict, as every built-in tool is.
   */
  strict?: boolean;
  /**
   * The parameters this run's model is given, when they depend on the run (the `finish` tool takes the task's outputs). Must be a pure
   * function of the run's own facts, so the offered schema is identical in every round. Without it `parameters` is offered.
   */
  parametersFor?(ctx: C): z.ZodTypeAny;
  /** The tool can do something irreversible (a click that passes the risk gate, typing a secret, later sending mail): the call is commit-class and its action is intent-recorded. */
  commits?: boolean;
  /**
   * `fill` (E54.1): the tool leaves the page where it is (typing into a field, reading, scrolling), so when the policy lets a reply carry
   * several actions the reply may go on after it; a function decides from the call's arguments (typing that also submits is not fill).
   * Absent: the tool may change the page, and ends the reply's batch.
   */
  batch?: 'fill' | ((args: z.output<P>) => boolean);
  /** Which gates apply, and what each looks at. */
  gated?: Readonly<Record<string, GateRequestFn<C, P>>>;
  /** Hides the tool when it cannot be used (vision off, no desktop, a connection not enabled for this run). */
  available?(ctx: C): boolean;
  /** A short usage note for the instructions. Notes are ordered deterministically so the stable prefix stays byte-identical between rounds. */
  usage?: string;
  /** Does the work through the context and returns the text the model reads. */
  execute(ctx: C, args: z.output<P>, gate: GateDecision): Promise<string> | string;
}

/** Identity function that fixes the generics of a tool definition. */
export function defineRunnerTool<C extends AnyContext, P extends z.ZodTypeAny>(def: RunnerTool<C, P>): RunnerTool<C, P> {
  return def;
}
