// Every span, event and link attribute name of the agent traces (E38.4, #585), in one file.
//
// The names follow the OpenTelemetry GenAI semantic conventions (`gen_ai.*`, agent spans), which
// are still marked "Development". The version below is the one this file follows; when the
// convention renames something, the change is made here and nowhere else (a test pins that the
// runner and the trace module use these constants, never a literal name).
//
// No opt-in switch is needed: the conventions' stability variable (`OTEL_SEMCONV_STABILITY_OPT_IN`,
// `gen_ai_latest_experimental`) tells an instrumentation LIBRARY which version to emit. These spans
// are made by the console itself, so what is emitted is what this file says.
//
// What is deliberately absent: `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`,
// `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`. A span never carries a prompt, an answer,
// typed text, page text, a URL (the host only), a selector, a question or a secret (docs/runs.md,
// "What a trace holds"). The leak test (test/agent-trace.db.spec.ts) fails if one appears.

/** The GenAI semantic-convention version the `gen_ai.*` names below follow. */
export const GENAI_SEMCONV_VERSION = '1.37.0';

/** The instrumentation scope the spans are made under. */
export const TRACER_NAME = 'hexactra-console.agent';

/** Span names. A model call and a tool call are named after the model and the tool. */
export const SPAN = {
  runJob: (agent: string) => `invoke_agent ${agent}`,
  chunk: 'hexactra.chunk',
  modelCall: (model: string) => `chat ${model}`,
  toolCall: (tool: string) => `execute_tool ${tool}`,
  fabric: (action: string) => `hexactra.fabric ${action}`,
  askHuman: 'hexactra.ask_human',
} as const;

/** The agents that get a root span. */
export const AGENT = {
  browser: 'hexactra.browser_agent',
  chat: 'hexactra.chat_orchestrator',
} as const;

/** `gen_ai.operation.name` values. */
export const OPERATION = { invokeAgent: 'invoke_agent', chat: 'chat', executeTool: 'execute_tool' } as const;

/** Span event names (the question's two moments). */
export const EVENT = { asked: 'hexactra.question.asked', answered: 'hexactra.question.answered' } as const;

export const ATTR = {
  // GenAI conventions.
  operationName: 'gen_ai.operation.name',
  agentName: 'gen_ai.agent.name',
  providerName: 'gen_ai.provider.name',
  requestModel: 'gen_ai.request.model',
  responseModel: 'gen_ai.response.model',
  usageInputTokens: 'gen_ai.usage.input_tokens',
  usageOutputTokens: 'gen_ai.usage.output_tokens',
  usageCachedInputTokens: 'gen_ai.usage.cache_read.input_tokens',
  finishReasons: 'gen_ai.response.finish_reasons',
  toolName: 'gen_ai.tool.name',
  toolCallId: 'gen_ai.tool.call.id',
  // General conventions.
  errorType: 'error.type',
  // The console's own.
  runId: 'hexactra.run.id',
  runTrigger: 'hexactra.run.trigger',
  runOrigin: 'hexactra.run.origin',
  runStatus: 'hexactra.run.status',
  runStopReason: 'hexactra.run.stop_reason',
  jobReason: 'hexactra.job.reason',
  outcome: 'hexactra.job.outcome',
  policyId: 'hexactra.policy.id',
  tier: 'hexactra.tier',
  chunkNumber: 'hexactra.chunk.number',
  chunkModelCalls: 'hexactra.chunk.model_calls',
  chunkToolCalls: 'hexactra.chunk.tool_calls',
  costUsd: 'hexactra.cost_usd',
  fallbackModel: 'hexactra.model.fallback',
  stepSeq: 'hexactra.step.seq',
  stepOk: 'hexactra.step.ok',
  actionType: 'hexactra.action.type',
  pageHost: 'hexactra.page.host',
  gateCategory: 'hexactra.gate.category',
  fabricAction: 'hexactra.fabric.action',
  fabricOperationId: 'hexactra.fabric.operation_id',
  fabricState: 'hexactra.fabric.state',
  questionKind: 'hexactra.question.kind',
  questionInput: 'hexactra.question.input',
  questionChannel: 'hexactra.question.channel',
  questionOutcome: 'hexactra.question.outcome',
  questionWaitedMs: 'hexactra.question.waited_ms',
  conversationId: 'hexactra.conversation.id',
  linkType: 'hexactra.link.type',
} as const;

/** Why a span link exists (`hexactra.link.type`). */
export const LINK = { previousJob: 'previous_job', startedBy: 'started_by' } as const;

/** Values of `error.type` the console sets itself (an AI error's own code is used as it is). */
export const ERROR_TYPE = {
  toolError: 'tool_error',
  timeout: 'timeout',
  invalidArguments: 'invalid_arguments',
  unknownTool: 'unknown_tool',
  actionFailed: 'action_failed',
  fabricError: 'fabric_error',
  runFailed: 'run_failed',
  other: '_OTHER',
} as const;

/** Why a job started (`hexactra.job.reason`). */
export type JobReason = 'started' | 'resumed' | 'continued';
