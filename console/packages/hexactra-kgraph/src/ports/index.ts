// The ports of the Knowledge Graph: the only way the package reaches the outside world. A host implements them; `./testing` has an in-memory
// fake of each. Each port's doc comment says what a correct binding guarantees.
import type { Evidence, Mode, Procedure, ProcedureVersion, VersionState } from '../schema';

/** The outcome a store records against a version or one of its steps. */
export type EvidenceOutcome = 'success' | 'failure' | 'repair';

/**
 * Where procedures and versions live.
 *
 * A correct binding guarantees:
 * - **Owner isolation.** Every call is scoped to `owner`; no call returns or changes another owner's record, even given its id.
 * - **Versions are immutable.** `putVersion` refuses an id that exists; only `setVersionState` and `recordEvidence` change a stored version.
 * - **State moves are atomic and checked.** `setVersionState` applies only when the stored state equals `expected` (compare-and-set) and
 *   returns false otherwise; it never applies a move `canTransition` refuses.
 * - **One active version.** `activate` leaves exactly one `active` version per procedure, in one transaction.
 * - **Deleting is complete.** `deleteAll` removes every procedure, version and evidence row of the owner.
 * - **Site lookups are exact.** `listActiveProceduresForSites` matches a site only on its exact registrable domain (never a subdomain, a
 *   suffix or a lookalike) and returns only procedures whose `activeVersion` is in the `active` state.
 */
export interface ProcedureStorePort {
  getProcedure(owner: string, id: string): Promise<Procedure | null>;
  findProcedureForTask(owner: string, task: string): Promise<Procedure | null>;
  listProcedures(owner: string): Promise<Procedure[]>;
  /** Create or update a procedure's name, `activeVersion` and `updatedAt`. */
  putProcedure(procedure: Procedure): Promise<void>;
  getVersion(owner: string, id: string): Promise<ProcedureVersion | null>;
  /** Newest first. */
  listVersions(owner: string, procedure: string): Promise<ProcedureVersion[]>;
  /** Store a new version. Throws when the id exists or the procedure is not the owner's. */
  putVersion(owner: string, version: ProcedureVersion): Promise<void>;
  /** Compare-and-set the state. True when it moved. */
  setVersionState(owner: string, version: string, expected: VersionState, next: VersionState): Promise<boolean>;
  /**
   * Make a version the procedure's one active version, atomically: its state moves `from` → (`verified` →) `active` by compare-and-set,
   * the procedure's earlier active version becomes `retired`, and the procedure's `activeVersion` is set. From `candidate` it passes through
   * `verified`. True when it moved; false when the state was not `from` (another job won) or the move is not allowed.
   */
  activate(owner: string, version: string, from: 'candidate' | 'verified' | 'suspended'): Promise<boolean>;
  /** Add one outcome to the version's evidence, and to the step's when `step` is given. Returns the version's evidence after it. */
  recordEvidence(owner: string, version: string, step: string | null, outcome: EvidenceOutcome, at: string): Promise<Evidence>;
  /**
   * The owner's procedures whose active version declares one of `sites` (registrable domains, compared exactly), each with that version,
   * ordered by procedure id. An empty `sites` returns nothing. A procedure with no active version, or whose `activeVersion` is not in the
   * `active` state, is never returned. The input `matchProcedures` (`./match`) ranks.
   */
  listActiveProceduresForSites(owner: string, sites: readonly string[]): Promise<{ procedure: Procedure; version: ProcedureVersion }[]>;
  /** Delete everything learned for the owner. Returns the number of procedures removed. */
  deleteAll(owner: string): Promise<number>;
}

/** What a host's tool call returned. */
export interface ToolInvocation {
  /** Whether the tool reported success. */
  ok: boolean;
  /** The text the tool returned (what a model would have read). */
  text: string;
  /** A structured value when the tool returns one (an account tool's JSON); `extract` and `result_shape` read it. */
  value?: unknown;
  /** A digest of the result that holds no typed value (the host decides how it is computed). */
  digest: string;
  /** A gate refused the call (a site gate, a risk gate, a budget). */
  refused: boolean;
  /** The owner pressed Stop: the executor must not run another step. */
  stopped: boolean;
  /** The owner paused the run: the executor must not run another step until resumed. */
  paused: boolean;
}

export interface ToolCallRequest {
  tool: string;
  /** Arguments already resolved from their bindings. A secret binding arrives as a reference the host's secret path types, never a value. */
  args: Record<string, unknown>;
  /** The procedure step this call runs, for the trace. */
  step: string;
  commitClass: boolean;
}

/**
 * Runs a tool.
 *
 * A correct binding guarantees: every call goes through the host's one tool wrapper (in the console, `executeTool`), so Stop, Pause, the gates,
 * the trace span and intent recording apply exactly as for a model-chosen call; it reports a gate refusal, a Stop or a Pause instead of
 * throwing; a commit-class call whose earlier outcome is unknown is never sent again.
 */
export interface ToolInvokerPort {
  invoke(request: ToolCallRequest): Promise<ToolInvocation>;
}

/** What a check observes. */
export interface ProbedLocation {
  url: string;
}

/**
 * Reads the state a check needs, without acting.
 *
 * A correct binding guarantees: no call changes the page, the desktop or an account; a value that is not available is `null`, never a guess;
 * no typed value, secret or image is returned (a view digest is a hash of structure, not text).
 */
export interface StateProbePort {
  location(): Promise<ProbedLocation | null>;
  viewDigest(): Promise<string | null>;
  /** Whether an element is present, by selector. */
  elementPresent(selector: string): Promise<boolean | null>;
}

export interface JudgeRequest {
  /** The task's goal: the owner's own words. */
  goal: string;
  /** The declared inputs, resolved. Never secret material (the validator refuses such a flow). */
  inputs: Record<string, unknown>;
  /** The fixed output schema: field names, types and enum values. */
  output: readonly { name: string; type: 'string' | 'number' | 'boolean' | 'enum'; values?: readonly string[] }[];
}

export interface JudgeResult {
  ok: boolean;
  /** The parsed result, one key per output field, when `ok`. */
  value?: Record<string, unknown>;
  /** Model usage, for the ledger. */
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
}

/**
 * One small model call with a fixed output schema.
 *
 * A correct binding guarantees: the model sees only the goal, the inputs and the schema (no page text as instruction, no secret); the call
 * goes through the host's model routing and budgets (in the console, `tierRequest(snapshot, 'fast')`); a result that does not match the schema
 * is `ok: false`, never a partial value.
 */
export interface LocateRequest {
  /** The step in the procedure's own terms: never an instruction from a run. */
  tool: string;
  role: string | null;
  label: string | null;
  anchor: string | null;
  /** The page's controls, numbered (page text is data). */
  elements: readonly { n: number; role: string | null; name: string | null; tag: string | null }[];
}

export interface JudgePort {
  judge(request: JudgeRequest): Promise<JudgeResult>;
  /**
   * Rung 4 of the recovery ladder (E46.16): one narrow model call that names the numbered control the step means, or null ("not here").
   * Optional: a host without it skips the rung. The caller checks the answer (the number exists; the role fits) before using it.
   */
  locate?(request: LocateRequest): Promise<{ mark: number | null }>;
}

/** Time. A correct binding guarantees `sleep` resolves early (without throwing) when the run is stopped. */
export interface ClockPort {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

/** Ids. A correct binding guarantees every id is unique and matches the schema's id pattern. */
export interface IdPort {
  next(prefix: string): string;
}

/** Attributes of a span, counter or log line. Never a typed value, a secret or page text. */
export type TelemetryAttributes = Record<string, string | number | boolean>;

/**
 * Telemetry. A correct binding guarantees it never throws into the caller and never records a typed value, a secret or page text.
 */
export interface TelemetryPort {
  span<T>(name: string, attributes: TelemetryAttributes, fn: () => Promise<T>): Promise<T>;
  count(name: string, value: number, attributes?: TelemetryAttributes): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, attributes?: TelemetryAttributes): void;
}

export const noopTelemetry: TelemetryPort = Object.freeze({
  span: <T>(_name: string, _attributes: TelemetryAttributes, fn: () => Promise<T>) => fn(),
  count: () => undefined,
  log: () => undefined,
});

/** The settings that decide whether a task uses the Knowledge Graph. Every level defaults to off. */
export interface KgraphSwitches {
  deployment: boolean;
  user: boolean;
  task: Mode;
  /** "Run with AI only this time": the run ignores the graph (nothing replayed, nothing captured). */
  aiOnlyThisRun: boolean;
  /** Chat goals never use the feature: only saved tasks. */
  savedTask: boolean;
}

/** The effective mode of a run: `off` unless every level allows it. */
export function effectiveMode(s: KgraphSwitches): Mode {
  if (!s.deployment || !s.user || !s.savedTask || s.aiOnlyThisRun || s.task === 'off') return 'off';
  return s.task;
}

/** Every port a host binds. */
export interface KgraphPorts {
  store: ProcedureStorePort;
  tools: ToolInvokerPort;
  probe: StateProbePort;
  judge: JudgePort;
  clock: ClockPort;
  ids: IdPort;
  telemetry: TelemetryPort;
}
