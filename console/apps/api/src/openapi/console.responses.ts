// Response shapes of the console's own routes, for the OpenAPI document (and
// so for the generated SDK in packages/sdk). `@ApiDataResponse` wraps each in
// the platform's `{ data }` envelope. They describe what the services return;
// the tests in test/sdk.db.spec.ts exercise them through the SDK.
import { runClientSchema, runOriginSchema } from '../connected-apps/connected-apps.schemas';
import { connectionSelectionViewSchema } from '../connections/agent-connections';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { TIERS } from '../policies/agent-policy.schema';
import { policySummarySchema } from '../policies/policies.schemas';
import { BUDGET_KEYS, RUN_STOP_REASONS } from '../runner/budget';

const iso = z.string().describe('ISO 8601 timestamp');
const runStatus = z.enum(['queued', 'running', 'waiting_human', 'paused', 'succeeded', 'failed', 'cancelled']);

const paramType = z.enum(['text', 'number', 'money', 'date', 'choice', 'phone', 'email']);
const paramConstraints = z.object({ min: z.number().optional(), max: z.number().optional(), maxLength: z.number().int().optional(), pattern: z.string().optional() });

/** A task parameter (#552): one `{{Name}}` placeholder of the goal. */
export const taskParameterResponseSchema = z.object({
  key: z.string().describe('The placeholder\'s key (`Phone Number` → `phone_number`)'),
  label: z.string(),
  type: paramType,
  required: z.boolean(),
  options: z.array(z.string()).optional().describe('choice: the options'),
  help: z.string().optional(),
  default: z
    .union([z.object({ value: z.string() }), z.object({ memory: z.object({ id: z.uuid(), attribute: z.string() }) })])
    .optional()
    .describe("A fixed value, or an attribute of one of the owner's memories resolved when the task runs"),
  constraints: paramConstraints.optional(),
  sensitive: z.boolean().optional().describe('Asked for every time in the signed-in console, typed by the browser, never stored or shown to the model'),
});

/** A field of a `form` question (#552): a task run's missing parameter. */
export const formFieldResponseSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: paramType,
  required: z.boolean(),
  options: z.array(z.string()).optional(),
  help: z.string().optional(),
  constraints: paramConstraints.optional(),
});

/** A run's parameter value as the API returns it (#552): masked, with where it came from. */
export const runInputResponseSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.string().describe('Masked like the rest of the run (#538); a sensitive value is never stored: "[provided at run time]"'),
  source: z.enum(['provided', 'default', 'memory', 'asked', 'schedule', 'saved_details']),
});

export const taskResponseSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  name: z.string(),
  goal: z.string(),
  profile: z.string(),
  hostId: z.uuid().nullable(),
  hostFallback: z.boolean().describe('When the chosen host cannot take a run, run on another available one'),
  allowedDomains: z.array(z.string()),
  maxSteps: z.number().int().meta({ deprecated: true }).describe('Deprecated: see `policyId`'),
  maxMinutes: z.number().int().meta({ deprecated: true }).describe('Deprecated: see `policyId`'),
  confirmRiskyActions: z.boolean(),
  useSavedLogins: z.boolean().describe("Whether the agent may sign in from the owner's saved logins on this task's runs (E37.3)"),
  useSavedIdentity: z.boolean().describe("Whether the agent may fill identity details from the owner's saved details on this task's runs (E37.6); the model never reads a value"),
  useSavedCards: z.boolean().describe("Whether the agent may pay with a saved card on this task's runs (E37.7), under the owner's per-merchant approval and amount limit; the model never reads a card value"),
  unattendedPayments: z.enum(['ask', 'allow']).describe('`ask`: an unattended run that signed in with a saved login keeps the confirmation before payments on; `allow`: it follows `confirmRiskyActions`'),
  needsBrowser: z.enum(['auto', 'always', 'never']).describe("Whether the task's runs open a browser (E39.7): `auto` opens it at the first browser tool when the run has connections, `always` at the start, `never` offers no browser tool"),
  connections: z.array(connectionSelectionViewSchema).describe('The connections the agent may use in this task, and how (E39.7). Empty: none; nothing is available by default.'),
  model: z.string().nullable().meta({ deprecated: true }).describe('Deprecated: see `policyId`'),
  policyId: z.string().nullable().describe("The task's agent policy (an own policy's UUID or `builtin:<key>`); null follows the user's default"),
  parameters: z.array(taskParameterResponseSchema).nullable().describe("The goal's `{{Name}}` parameters, in order of appearance (#552); empty or null when it has none"),
  spend30d: z
    .object({
      runs: z.number().int().describe('Runs created in the last 30 days'),
      costUsd: z.number().describe('USD spent on model calls by those runs; a lower bound while costKnown is false'),
      costKnown: z.boolean().describe('False when a call of those runs could not be priced (its model has no price)'),
      tokens: z.number().int().describe('Input plus output tokens'),
      succeeded: z.number().int().describe('Of those runs, how many succeeded'),
      avgSuccessCostUsd: z.number().nullable().describe('The average cost of one successful run (USD; a lower bound while costKnown is false); null with no successful run'),
    })
    .describe("What the task's runs spent in the last 30 days"),
  createdAt: iso,
  updatedAt: iso,
});
export class TaskResponseDto extends createZodDto(taskResponseSchema) {}

export const runActivitySchema = z
  .object({
    phase: z.enum(['starting', 'looking', 'thinking', 'acting']),
    action: z.string().optional().describe('The fabric action being run (acting only)'),
    args: z.record(z.string(), z.unknown()).optional().describe('Redacted like step args'),
    reason: z.string().optional().describe('Why the model chose the action'),
    startedAt: iso,
    timeoutMs: z.number().int().optional().describe('How long the host has before the action times out'),
    target: z
      .object({ x: z.number(), y: z.number(), w: z.number().optional(), h: z.number().optional() })
      .optional()
      .describe('Where on the page it acts, in page screenshot (CSS viewport) pixels: a point, or a box with w and h'),
    note: z.string().optional().describe('Why the run is on a stronger model, while it is (for example "Escalated to Frontier (stuck: repeated click on #submit)")'),
  })
  .describe('What a running run is doing right now; null when it is not running');

const budgetNumbers = z.record(z.enum(BUDGET_KEYS), z.number().nullable());
/**
 * The effective limits plus `warnAtPercent`, as one object. (A record of the
 * budget keys intersected with `{ warnAtPercent }` gave a JSON Schema no
 * value can match: its `propertyNames` enum refuses `warnAtPercent`, and MCP
 * clients that check `structuredContent` against `outputSchema` refused
 * every run with a budget, #466.)
 */
const effectiveBudget = z.object({
  actions: z.number().nullable(),
  modelCalls: z.number().nullable(),
  activeMinutes: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  cost: z.number().nullable(),
  warnAtPercent: z.number().int(),
}) satisfies z.ZodType<Record<(typeof BUDGET_KEYS)[number], number | null> & { warnAtPercent: number }>;

/** What a run may spend and has spent (#404). */
export const runBudgetSchema = z
  .object({
    effective: effectiveBudget
      .describe('The limits the run is held to, fixed at its start: the policy budget clamped by the deployment ceilings. `null` is unlimited. Active time is in minutes, cost in USD.'),
    used: z.record(z.enum(BUDGET_KEYS), z.number()).describe('What the run has used so far, in the same units (active time includes the stretch in progress).'),
    percent: budgetNumbers.describe('Percent of each limit used, one decimal; `null` for an unlimited budget.'),
    source: z.record(z.enum(BUDGET_KEYS), z.enum(['policy', 'ceiling']).nullable()).describe('Where each limit came from: the `policy`, or the deployment `ceiling` that clamped it. `null` when unlimited.'),
    costKnown: z.boolean().describe('False when a call could not be priced: `used.cost` is then "at least".'),
    enforcement: z
      .enum(['hard', 'soft'])
      .describe('`hard`: a used-up budget ends the run. `soft`: a chat run (trigger `chat`), whose owner is present: its limits are shown and warned about, never enforced (#537).'),
    over: z.array(z.enum(BUDGET_KEYS)).describe('The budgets at or over their limit, in check order. A soft-budget run keeps working past them.'),
  })
  .describe('The run budget: `null` on a run that has not started or that was snapshotted before budgets were enforced.');

/** Which model tier a run is on (#408). */
export const runTierSchema = z
  .object({
    start: z.enum(TIERS).describe('The tier the policy starts runs on'),
    max: z.enum(TIERS).describe('The highest tier the run may escalate to'),
    current: z.enum(TIERS).describe('The tier the run is on now: the start tier until a stall escalates it'),
    escalations: z.number().int().describe('How many times the run escalated'),
    model: z.string().nullable().describe("The current tier's model, as `provider:modelId`; null when none was resolved"),
  })
  .describe("The run's model tier, from its policy snapshot: null until the run has started.");

export const runResponseSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  taskId: z.uuid().nullable(),
  conversationId: z.uuid().nullable().describe('The chat that started the run (trigger `chat`); null for every other run'),
  status: runStatus,
  trigger: z.enum(['manual', 'schedule', 'api', 'mcp', 'external', 'chat']),
  origin: runOriginSchema,
  client: runClientSchema.nullable(),
  goal: z.string(),
  profile: z.string(),
  hostId: z.uuid().nullable(),
  hostFallback: z.boolean(),
  sessionId: z.uuid().nullable(),
  handoffId: z.uuid().nullable(),
  actor: z.string().nullable().describe('Who drove an external run'),
  result: z.string().nullable(),
  error: z.string().nullable(),
  cancelRequested: z.boolean(),
  cancelRequestedAt: iso.nullable().describe('When the owner pressed Stop (E38.1); null if they did not. The start of the stop-latency measure.'),
  pauseRequested: z.boolean().describe('The owner pressed Pause (E38.2): the run pauses before its next action, or once its question is answered. Stays true while it is `paused`; Resume clears it.'),
  pausedAt: iso.nullable().describe('When the run was paused (`paused` only, until it runs again); null otherwise'),
  stepCount: z.number().int(),
  activity: runActivitySchema.nullable(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  policy: policySummarySchema.nullable(),
  stopReason: z.enum(RUN_STOP_REASONS).nullable().describe('Why the run stopped (typed): finished, budget_* (actions, model_calls, active_time, input_tokens, output_tokens, cost), stalled, cancelled, error or no_model. Null while it runs and on runs from before this field.'),
  budget: runBudgetSchema.nullable(),
  tier: runTierSchema.nullable(),
  currentTier: z.enum(['fast', 'standard', 'frontier']).nullable().describe('The model tier the run is on now. It moves up when the run stalls and back down after progress. Null before the run starts.'),
  escalations: z.number().int().describe('How many times the run moved to a stronger tier because it stalled'),
  traceId: z.string().nullable().describe("The OpenTelemetry trace id (32 hex characters) of the run's latest job, to find the run in the deployment's trace collector (docs/runbooks/operations.md, \"Reading a run's trace\"). Null before the first job and with the telemetry slice off. A queued chat run holds the chat turn's trace until its first job starts."),
  cachedInputTokens: z.number().int().describe('Input tokens the provider served from its cache (part of inputTokens)'),
  modelCalls: z.number().int().describe('Model calls (provider round trips) made so far'),
  costUsd: z.number().describe('USD spent on model calls, from the admin price table (agentPricing); a lower bound while costKnown is false'),
  costKnown: z.boolean().describe('False once a call could not be priced because its model has no price: show costUsd as "at least"'),
  confirmedActions: z
    .array(
      z.object({
        seq: z.number().int().describe("The step's sequence number"),
        prompt: z.string().describe('The question the owner approved, at most 300 characters, masked'),
        action: z.string().describe('The action carried out (click, click_at, key, …)'),
        at: iso.describe('When it was carried out'),
      }),
    )
    .describe('Steps the owner confirmed that the run then carried out (#540), oldest first; empty when none. "Run again" asks before repeating such a run.'),
  usedSavedLogins: z
    .array(
      z.object({
        provider: z.string().describe('The secrets provider that held the login (`vault`)'),
        itemName: z.string().describe("The saved login's name as the owner gave it (\"Shop login\"), never its username, password or code"),
        origin: z.string().describe('The site the login was used on (`https://shop.example.test`)'),
        at: iso.describe('When it was first used in this run'),
      }),
    )
    .describe('The saved logins the run signed in with (E37.3), oldest first; empty when it used none. "Signed in with: Shop login" on the run page.'),
  usedSavedIdentity: z
    .array(
      z.object({
        provider: z.string().describe('The secrets provider that held the details (`vault`)'),
        itemName: z.string().describe("The saved identity item's name as the owner gave it (\"Passport\")"),
        label: z.string().describe('The field filled, by its label (\"Date of birth\"): never its value'),
        origin: z.string().describe('The site it was filled on'),
        at: iso.describe('When it was first filled in this run'),
      }),
    )
    .describe('The identity details the run filled (E37.6), oldest first; labels only, empty when it filled none. "Filled from your saved details: Date of birth, ID number" on the run page.'),
  usedSavedCards: z
    .array(
      z.object({
        provider: z.string().describe('The secrets provider that held the card (`vault`)'),
        itemName: z.string().describe("The saved card's name as the owner gave it"),
        brand: z.string().nullable().describe('The card network (`visa`), or null'),
        last4: z.string().nullable().describe('The last four digits, or null: never more'),
        merchant: z.string().describe("The merchant's host as the page reported it"),
        origin: z.string().describe("The merchant's origin the card was typed on"),
        currency: z.string().describe('ISO 4217'),
        declaredAmount: z.string().describe('The amount the agent declared before paying, a decimal with two places'),
        confirmedAmount: z.string().nullable().describe('The amount the agent read on the confirmation page, or null while unknown'),
        mismatch: z.boolean().describe('The confirmed amount differs from the declared one by more than the tolerance'),
        at: iso.describe('When the card was typed'),
      }),
    )
    .describe('The saved cards the run paid with (E37.7), oldest first; empty when it used none. "Paid with Visa ending 4242 at shop.example.test: 42.50 USD" on the run page; a warning when the declared and the confirmed amounts differ.'),
  inputs: z.array(runInputResponseSchema).nullable().optional().describe("The task parameter values the run was started with (#552), masked, with their source; null for a run without parameters"),
  memoryIds: z.array(z.uuid()).describe('The owner\'s memories this run used (#553): the ones its goal names. A deleted memory leaves its id.'),
  createdAt: iso,
  startedAt: iso.nullable(),
  finishedAt: iso.nullable(),
});
export class RunResponseDto extends createZodDto(runResponseSchema) {}

/** A run in a list (`GET /runs`): the run, with its task's name and a budget only while it is live. */
export const runListItemResponseSchema = runResponseSchema.extend({
  taskName: z.string().nullable().describe("The run's task name; null for a run without a task (ad-hoc, external) or whose task was deleted"),
  budget: runBudgetSchema.nullable().describe('The run budget while the run is live (queued, running, waiting_human, paused); null on a finished run in a list (read it from `GET /runs/{id}`).'),
  confirmedActions: z.number().int().describe('How many steps the owner confirmed that the run carried out (#540); the steps themselves are on `GET /runs/{id}`.'),
});
export class RunListItemResponseDto extends createZodDto(runListItemResponseSchema) {}

/** `GET /runs?envelope=1`: one page of runs. */
export const runPageResponseSchema = z.object({
  items: z.array(runListItemResponseSchema),
  nextCursor: z.string().nullable().describe('Pass it as `cursor` to read the next page; null on the last page. Opaque: do not parse or build it.'),
});
export class RunPageResponseDto extends createZodDto(runPageResponseSchema) {}

/** `GET /runs/counts`. */
export const runCountsResponseSchema = z.object({
  total: z.number().int().describe('Runs that match the filter'),
  live: z.number().int().describe('Of those: queued + running + waiting_human + paused'),
  byStatus: z.object({
    queued: z.number().int(),
    running: z.number().int(),
    waiting_human: z.number().int(),
    paused: z.number().int(),
    succeeded: z.number().int(),
    failed: z.number().int(),
    cancelled: z.number().int(),
  }),
  costUsd: z.number().nullable().describe('USD spent by the matching runs; null when none of them made a model call. A lower bound while costKnown is false'),
  costKnown: z.boolean().describe('False when a matching run had a call that could not be priced'),
});
export class RunCountsResponseDto extends createZodDto(runCountsResponseSchema) {}

export const runStepResponseSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  seq: z.number().int(),
  kind: z
    .string()
    .describe(
      'action | handoff | finish | error | note | routing (a tier change or provider fallback, with `args` { from, to, reason }; not an action) | guidance (an owner message from the chat, masked; not an action) | end (the closing step with the final screen; not an action). A `handoff` step with `action: "answered"` is the owner\'s answer (not an action).',
    ),
  action: z.string().nullable(),
  args: z.record(z.string(), z.unknown()).nullable().describe('Redacted: typed text is its length, URLs lose their query'),
  ok: z.boolean(),
  summary: z.string(),
  reasoning: z.string().nullable(),
  hasScreenshot: z.boolean().describe('The step has a masked trace screenshot (#541): `GET /runs/{id}/steps/{seq}/screenshot`'),
  screenshotMoment: z.enum(['question', 'before_confirmed', 'after_confirmed', 'failure', 'final']).nullable().describe('The key moment the step records a screen for'),
  screenshotMasked: z.number().int().nullable().describe('How many regions the extension masked in the picture'),
  screenshotNote: z.enum(['unavailable', 'masked_failed', 'no_storage', 'capped']).nullable().describe('Why a key moment has no picture'),
  questionId: z.uuid().nullable().describe('The question the step asked or answered'),
  question: z
    .object({
      id: z.uuid(),
      kind: z.string(),
      input: z.string(),
      prompt: z.string().describe('Masked'),
      options: z.array(z.object({ id: z.string(), label: z.string() })).nullable().describe('Labels masked'),
      risk: z.string().nullable(),
      status: z.string(),
      answer: z
        .object({
          outcome: z.string(),
          value: z.string().optional().describe('Masked; absent when the value is withheld (a secret, a sign-in)'),
          valueWithheld: z.boolean(),
          channel: z.string().nullable(),
          answeredAt: z.string().nullable(),
        })
        .nullable(),
    })
    .nullable()
    .describe('The question this step asked or answered, masked (#541); null for any other step'),
  durationMs: z.number().int().nullable(),
  createdAt: iso,
});
export class RunDetailResponseDto extends createZodDto(
  runResponseSchema.extend({
    steps: z.array(runStepResponseSchema),
    memories: z
      .array(z.object({ id: z.uuid(), label: z.string(), status: z.enum(['active', 'superseded', 'archived']) }))
      .describe('The memories of `memoryIds` that still exist, with their labels (#553): the run page says "Used: …"'),
  }),
) {}

const questionInput = z
  .enum(['none', 'text', 'secret', 'choice', 'multi_choice', 'number', 'confirm', 'takeover', 'credentials', 'memory', 'form', 'save_login'])
  .describe('`form` (#552): a task run\'s missing parameter values, asked before it starts. `memory` (#553): a memory the agent proposes. `save_login` (E37.4b): "Save this login?" after the owner signed in by hand; only the server creates one, and only the signed-in web and Android app answer it');
const saveLoginCard = z
  .object({
    site: z.string().describe('The host of the sign-in page'),
    domain: z.string().describe('Its registrable domain: the unit "Never for this site" is remembered at'),
    name: z.string().describe('The name the agent suggests; the owner edits it on the card'),
    username: z.string().describe('The username the owner typed (the password is never shown, returned or stored by the console)'),
    valueExpiresAt: z.string().describe('When the fabric stops holding the password: after it the card says it is too late to save'),
  })
  .describe('save_login (E37.4b): what the card shows');
const memoryProposal = z
  .object({
    kind: z.enum(['person', 'account', 'preference', 'fact']),
    label: z.string(),
    aliases: z.array(z.string()),
    attributes: z.record(z.string(), z.string()),
    supersedes: z.uuid().nullable().describe('The active memory whose values this would replace'),
  })
  .describe('memory (#553): the proposed memory');
const questionOption = z.object({ id: z.string(), label: z.string(), description: z.string().optional() });
const questionConstraints = z.object({
  maxLength: z.number().int().optional(),
  pattern: z.string().optional(),
  multiline: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  unit: z.string().optional(),
  minSelections: z.number().int().optional(),
  maxSelections: z.number().int().optional(),
});
const questionRememberable = z.object({
  kind: z.enum(['gate', 'ask', 'connection']),
  host: z.string().describe("The registrable domain of the page the browser reported; for a `connection` question, the connection's id"),
  category: z.string().nullable().describe('gate: payment, purchase, send, delete or submit'),
  matchKey: z.string().describe('gate: the element\'s label; ask: the topic'),
  summary: z.string().describe("What the owner reads: \"Press 'Pay' on bankofamerica.com\""),
  scopes: z.array(z.enum(['everywhere', 'this_task', 'this_chat'])).optional().describe('Where a rule may be limited to: this task or this chat when the run has one'),
  requiresLimit: z.boolean().optional().describe('A saved card (E37.7): the owner\'s amount limit is required for "Don\'t ask again"; the answer is refused without it'),
  currency: z.string().optional().describe('A saved card: the currency of the limit and of the purchase'),
  amount: z.string().optional().describe('A saved card: the purchase this approval is for, a decimal with two places'),
  recipients: z.array(z.string()).optional().describe('A connection call that reaches people (E39.7): the addresses the approved call reaches; "Don\'t ask again" remembers these people (`rememberRule.recipientsFrom: these`) or anyone at their domains (`domain`)'),
});
const questionAction = z
  .object({
    connectionId: z.uuid(),
    connectionLabel: z.string(),
    tool: z.string().describe('The tool the agent called: `mail_send`, `calendar_create_event`, `sheet_append_rows`, ...'),
    lines: z.array(z.object({ label: z.string(), value: z.string() })).describe('The labelled facts the card shows: from, to, subject, a body preview, an event\'s time and attendees, a file\'s name and the cells'),
    body: z.string().optional().describe('The whole text for "show all" (at most 20,000 characters)'),
    hash: z.string().optional().describe('A hash of the validated arguments the card shows; only that exact call goes through once approved'),
  })
  .describe("A call through one of the owner's connections this question asks to approve (E39.7), built by the server from the tool's validated arguments. Set by the server only.");
export const questionAnswerResponseSchema = z.object({
  outcome: z.enum(['completed', 'cancelled']),
  value: z.string().optional().describe('Never present for a secret; for a sign-in (credentials), the username'),
  values: z.array(z.string()).optional(),
  valueWithheld: z.boolean().describe('True for a secret and a sign-in: the secret or password went to the browser, single use, and is never returned'),
  remember: z.boolean().optional().describe('The person\'s choice for the question\'s "remember me" option'),
  ruleId: z.uuid().optional().describe('The saved approval this answer created or found ("Don\'t ask again", #555)'),
  fields: z.record(z.string(), z.string()).optional().describe('form: the values given, masked'),
  memoryId: z.uuid().optional().describe('memory (#553): the memory the approved proposal saved'),
  neverForSite: z.boolean().optional().describe('save_login (E37.4b): declined with "Never for this site"'),
  savedAs: z.string().optional().describe('save_login (E37.4b): the name the login was saved under'),
  channel: z.string().optional(),
  by: z.string().optional().describe('Who answered, e.g. user:<id>'),
  answeredAt: iso,
});

export const questionResponseSchema = z.object({
  id: z.uuid(),
  askedBy: z.string().describe('run:<id>, agent:<name> or user:<id>'),
  runId: z.uuid().nullable(),
  handoffId: z.uuid().nullable(),
  browserBound: z.boolean(),
  input: questionInput,
  kind: z.string(),
  prompt: z.string(),
  options: z.array(questionOption).nullable(),
  constraints: questionConstraints.nullable(),
  confirmLabel: z.string().nullable(),
  denyLabel: z.string().nullable(),
  risk: z.enum(['low', 'high']).nullable(),
  rememberLabel: z.string().nullable().describe('credentials and secret: the site\'s "remember me" option, in the page\'s words'),
  fields: z.array(formFieldResponseSchema).nullable().describe('form (#552): the missing values of a task run, asked at once before it starts; answer with `fields: { key: value }`'),
  gate: z
    .object({ host: z.string().nullable(), category: z.string(), label: z.string().nullable() })
    .nullable()
    .describe('The commitment the confirmation gate stopped (#550): the page host the browser reported, the category and the element label. Set by the server only.'),
  rememberable: questionRememberable
    .nullable()
    .describe('What "Don\'t ask again" would remember (#555): the kind, the site, the category and the label or topic, and the summary the owner reads. Computed by the server only; null when the question cannot be remembered.'),
  action: questionAction.nullable().describe("The call through one of the owner's connections this question asks to approve (E39.7); null for every other question"),
  status: z.enum(['pending', 'answered', 'cancelled', 'expired']),
  response: questionAnswerResponseSchema.nullable(),
  pageTitle: z.string().nullable(),
  viewerUrl: z.string().nullable(),
  createdAt: iso,
  expiresAt: iso,
  answeredAt: iso.nullable(),
  client: runClientSchema.nullable().describe('The AI app that asked; null when no app did'),
  blocking: z.boolean().describe('False for a question no run waits on: a memory proposal (#553)'),
  proposal: memoryProposal.nullable(),
  saveLogin: saveLoginCard.nullable(),
  conversationId: z.uuid().nullable().describe('The chat a memory proposal came from (#553)'),
});
export class QuestionResponseDto extends createZodDto(questionResponseSchema) {}

export const inboxItemResponseSchema = z.object({
  questionId: z.uuid(),
  /** Null for a free-standing question (answer it with POST /api/questions/{id}/answer). */
  runId: z.uuid().nullable(),
  conversationId: z.uuid().nullable().describe('The chat whose run asks (#488): the request is answered in that chat. Null for every other request.'),
  goal: z.string(),
  handoffId: z.uuid().nullable(),
  askedBy: z.string(),
  kind: z.string(),
  prompt: z.string(),
  input: questionInput,
  /** The option ids (each bare-string option is its own id); `options` has the labels. */
  choices: z.array(z.string()),
  options: z.array(questionOption).nullable(),
  constraints: questionConstraints.nullable(),
  confirmLabel: z.string().nullable(),
  denyLabel: z.string().nullable(),
  risk: z.enum(['low', 'high']).nullable(),
  rememberLabel: z.string().nullable().describe('credentials and secret: the site\'s "remember me" option, in the page\'s words'),
  rememberable: questionRememberable
    .nullable()
    .describe('What "Don\'t ask again" would remember (#555): the kind, the site, the category and the label or topic, and the summary the owner reads. Computed by the server only; null when the question cannot be remembered.'),
  fields: z.array(formFieldResponseSchema).nullable().optional().describe('form (#552): the fields to fill'),
  pageTitle: z.string().nullable(),
  viewerUrl: z.string().nullable(),
  createdAt: iso,
  expiresAt: iso,
  blocking: z.boolean().describe('False for a memory proposal (#553) and "Save this login?" (E37.4b): no run waits on it; the Inbox lists it in its own group'),
  proposal: memoryProposal.nullable(),
  saveLogin: saveLoginCard.nullable(),
});
export class InboxItemResponseDto extends createZodDto(inboxItemResponseSchema) {}

export const scheduleResponseSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  taskId: z.uuid(),
  cron: z.string(),
  timezone: z.string(),
  enabled: z.boolean(),
  concurrency: z.enum(['skip', 'queue']),
  nextRunAt: iso.nullable(),
  lastRunAt: iso.nullable(),
  lastRunId: z.uuid().nullable(),
  consecutiveFailures: z.number().int(),
  policyId: z.string().nullable().describe("Overrides the task's agent policy for scheduled runs; null follows the task"),
  inputs: z.record(z.string(), z.string()).nullable().optional().describe("Preset values for the task's parameters (#552), by key"),
  description: z.string().describe('The expression in words (English, 24-hour), e.g. "Monday to Friday at 09:00"'),
  createdAt: iso,
  updatedAt: iso,
});
export class ScheduleResponseDto extends createZodDto(scheduleResponseSchema) {}

export const fleetHostResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  online: z.boolean(),
  browserConnected: z.boolean(),
  onDemand: z.boolean(),
  mode: z.enum(['unattended', 'attended', 'container']).nullable().describe('How the host runs its browsers; null for older agents'),
  desktop: z.boolean().describe('The host can share its desktop through the fabric'),
  draining: z.boolean(),
  viewerUrl: z.string().nullable(),
  profiles: z.array(z.object({ name: z.string(), running: z.boolean() })),
  lastSeen: iso,
});
export class FleetHostResponseDto extends createZodDto(fleetHostResponseSchema) {}

export class OkResponseDto extends createZodDto(z.object({ ok: z.literal(true) })) {}
