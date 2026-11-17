import { z } from 'zod';

import { agentPolicySpecSchema } from '../policies/agent-policy.schema';
import { parsePolicyRef } from '../policies/builtin-policies';
import { RUN_STATUSES, STOP_REASON_FILTERS } from '../tasks/runs.schemas';

/** How a tool reaches the console: its own REST API, as the caller. */
export interface McpContext {
  api<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  /** Raw bytes of a GET (screenshots). */
  bytes(path: string): Promise<{ mime: string; data: Buffer }>;
}

export type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  input: z.ZodObject;
  call(args: Record<string, unknown>, ctx: McpContext): Promise<McpToolResult>;
}

const text = (v: unknown): McpToolResult => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const id = z.string().uuid();
/** A policy reference: an own policy's UUID or `builtin:<economy|balanced|thorough|unlimited>`. */
const policyRef = z
  .string()
  .trim()
  .max(64)
  .refine((v) => parsePolicyRef(v) !== null, { message: 'A policy id: a UUID or builtin:<economy|balanced|thorough|unlimited>' });
const policyIdParam = policyRef.describe("An agent policy: its id from policies_list (a UUID, or builtin:economy|balanced|thorough|unlimited). It sets the budgets and the model tiers of the run.");
const POLICY_NOTE =
  'A policy holds the run budgets (actions, model calls, active minutes, tokens, cost; `null` means unlimited) and the model tiers (fast, standard, frontier; start tier and the highest tier a stalled run may escalate to). ' +
  'Pick models through tiers, not model ids: pins are an advanced override. ';
const cronParam = z.string().min(9).max(100).describe('A 5-field cron expression: minute hour day-of-month month day-of-week, for example "0 9 * * 1-5".');
/** One schedule of `task_create`: what `POST /tasks` takes in `schedules[]`, in the tools' snake_case. */
const scheduleItem = z.object({
  cron: cronParam,
  timezone: z.string().optional().describe("An IANA time zone; leave it out to use the time zone of the user's profile."),
  enabled: z.boolean().optional().describe('false creates the schedule paused.'),
  policy_id: policyIdParam.optional().describe("Runs of this schedule use this agent policy instead of the task's."),
});
const profile = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/).default('default').describe('Browser profile (its own cookies and sign-ins)');

/** One browser action through an external session (recorded as a step). */
function action(name: string, description: string, input: z.ZodObject, build: (a: Record<string, unknown>) => Record<string, unknown>): McpTool {
  return {
    name,
    description,
    input: input.extend({ session_id: id.describe('From browser_open') }),
    async call(args, ctx) {
      const r = await ctx.api<{ state: string; result?: Record<string, unknown>; error?: string }>('POST', `/browser/sessions/${String(args.session_id)}/actions`, { action: build(args) });
      if (r.state !== 'succeeded') return { ...text(`${name} ${r.state}: ${r.error ?? ''}`), isError: true };
      if ((name === 'browser_screenshot' || name === 'browser_desktop_screenshot') && typeof r.result?.url_path === 'string') {
        const img = await ctx.bytes(String(r.result.url_path).replace(/^\/api/, ''));
        const marks = Array.isArray(r.result.marks) ? r.result.marks : null;
        return {
          content: [
            { type: 'image', data: img.data.toString('base64'), mimeType: img.mime },
            ...(marks ? [{ type: 'text' as const, text: `marks (CSS pixels): ${JSON.stringify(marks)}` }] : []),
          ],
        };
      }
      if (name === 'browser_text' && typeof r.result?.text === 'string') return text(r.result.text);
      return text(r.result ?? 'ok');
    },
  };
}

/** An option: a bare label (its own id) or `{ id, label, description }`. */
const option = z.union([
  z.string().min(1).max(100),
  z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), label: z.string().min(1).max(100), description: z.string().max(200).optional() }),
]);
const constraints = z
  .object({
    max_length: z.number().int().min(1).max(4096).optional().describe('text: the longest answer'),
    pattern: z.string().min(1).max(200).optional().describe('text: a regular expression the whole answer must match'),
    multiline: z.boolean().optional().describe('text: allow several lines'),
    min: z.number().optional().describe('number: the smallest value'),
    max: z.number().optional().describe('number: the largest value'),
    step: z.number().positive().optional().describe('number: the increment (from min, or 0)'),
    unit: z.string().min(1).max(20).optional().describe('number: shown after the value, e.g. kg'),
    min_selections: z.number().int().min(0).max(10).optional().describe('multi_choice: at least this many'),
    max_selections: z.number().int().min(1).max(10).optional().describe('multi_choice: at most this many'),
  })
  .strict();
const CONSTRAINT_KEYS = { max_length: 'maxLength', pattern: 'pattern', multiline: 'multiline', min: 'min', max: 'max', step: 'step', unit: 'unit', min_selections: 'minSelections', max_selections: 'maxSelections' } as const;
const KINDS = ['captcha', 'code', 'passkey', 'login', 'confirmation', 'other'] as const;
/** The longest an MCP tool waits for an answer, in seconds (long-polled in waits of at most 30 s). */
export const MAX_TOOL_WAIT_S = 300;

/** The question fields of a tool's arguments (snake_case) as the REST contract's (camelCase). */
export function questionBody(a: Record<string, unknown>): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((a.constraints as Record<string, unknown> | undefined) ?? {})) {
    if (v !== undefined) c[CONSTRAINT_KEYS[k as keyof typeof CONSTRAINT_KEYS]] = v;
  }
  const options = (a.options as unknown[] | undefined) ?? (a.choices as unknown[] | undefined);
  return {
    ...(a.kind !== undefined ? { kind: a.kind } : {}),
    prompt: a.prompt,
    input: a.input,
    ...(options && options.length ? { options } : {}),
    ...(Object.keys(c).length ? { constraints: c } : {}),
    ...(a.confirm_label !== undefined ? { confirmLabel: a.confirm_label } : {}),
    ...(a.deny_label !== undefined ? { denyLabel: a.deny_label } : {}),
    ...(a.risk !== undefined ? { risk: a.risk } : {}),
    ...(a.timeout_s !== undefined ? { timeoutMs: Number(a.timeout_s) * 1000 } : {}),
  };
}

interface QuestionView {
  id: string;
  input: string;
  prompt: string;
  status: string;
  expiresAt: string;
  response: { outcome: string; value?: string; values?: string[]; valueWithheld?: boolean; channel?: string } | null;
}

/** What a tool returns about a question: never more than the REST API (a secret is never returned). */
function questionResult(q: QuestionView) {
  return {
    question_id: q.id,
    status: q.status,
    input: q.input,
    expires_at: q.expiresAt,
    ...(q.response
      ? {
          outcome: q.response.outcome,
          ...(q.response.value !== undefined ? { value: q.response.value } : {}),
          ...(q.response.values !== undefined ? { values: q.response.values } : {}),
          ...(q.response.channel ? { channel: q.response.channel } : {}),
        }
      : {}),
    ...(q.status === 'pending' ? { hint: 'Still pending: call question_status with wait_s to keep waiting.' } : {}),
  };
}

/** Wait up to `waitS` seconds for a question to settle, in long polls of at most 30 s. */
async function awaitQuestion(ctx: McpContext, id: string, waitS: number, first?: QuestionView): Promise<QuestionView> {
  const deadline = Date.now() + Math.min(Math.max(waitS, 0), MAX_TOOL_WAIT_S) * 1000;
  let q = first ?? (await ctx.api<QuestionView>('GET', `/questions/${id}`));
  while (q.status === 'pending' && Date.now() < deadline) {
    const waitMs = Math.min(30_000, deadline - Date.now());
    q = await ctx.api<QuestionView>('GET', `/questions/${id}?waitMs=${waitMs}`);
  }
  return q;
}

export const MCP_INSTRUCTIONS = `Hexactra runs real browsers for the user, on their own machines and profiles, through this console.
Two ways to work:
1. Delegate: run_goal (or task_run) hands a goal to Hexactra's own browser agent; follow it with run_status. It asks the person for CAPTCHAs, codes and confirmations itself.
2. Drive: browser_open, then browser_* tools step by step; every action is recorded and the user can stop you at any time.
3. Policies: every delegated run follows an agent policy (budgets and model tiers). policies_list shows them; pass policy_id to run_goal, task_run, task_create, task_update or schedule_create to choose one, otherwise the user's default applies.
   Schedules: task_create takes schedules, schedule_preview checks a cron expression before it is saved, task_pause and task_resume switch all of a task's schedules. You cannot delete runs: the user's run history is theirs to erase.
4. Ask: ask_human asks the user a question with no browser involved (text, choice, multi_choice, number, confirm, none, takeover) and can wait for the answer (wait_s); question_status follows it. The user answers on any of their devices.
You act with the user's full authority on their own machines, like a person at the computer: look at the page (browser_screenshot with marks), act by selector or by position with real mouse and keyboard events (browser_click_at, browser_hover_at, browser_drag, browser_scroll_at, browser_type_keys, browser_key), run JavaScript (browser_evaluate), and reach the whole desktop for native dialogs and file pickers (browser_desktop_*).
When only the person can help (a code sent to their phone, a passkey, a password you do not have, a CAPTCHA puzzle you cannot pass), call browser_request_human and wait (browser_handoff_status); type codes with browser_type_secret, so you never see them. Close sessions with browser_close.`;

export const MCP_TOOLS: McpTool[] = [
  // --- delegate to the console's goal runner -------------------------------
  {
    name: 'run_goal',
    description: "Hand a goal to Hexactra's browser agent (it plans and acts by itself). Returns the run id; follow it with run_status. Without policy_id the run uses the user's default agent policy (see policies_list).",
    input: z.object({ goal: z.string().min(1).max(4000), profile, policy_id: policyIdParam.optional() }),
    call: async (a, ctx) => text(await ctx.api('POST', '/runs', { goal: a.goal, profile: a.profile, ...(a.policy_id !== undefined ? { policyId: a.policy_id } : {}) })),
  },
  {
    name: 'run_status',
    description:
      'A run: status (queued, running, waiting_human = needs the person, succeeded, failed, cancelled), result, and its latest steps. ' +
      'Also the agent policy it runs under (`policy`), its tier (`tier`, `currentTier`, `escalations`), its cost (`costUsd`, `costKnown`, `modelCalls`), its budget use (`budget`: the effective limits, what it used and the percent of each) and why it stopped (`stopReason`).',
    input: z.object({ run_id: id, steps: z.number().int().min(0).max(50).default(10) }),
    async call(a, ctx) {
      const r = await ctx.api<{ steps?: unknown[] } & Record<string, unknown>>('GET', `/runs/${String(a.run_id)}`);
      const steps = (r.steps ?? []).slice(-Number(a.steps));
      return text({ ...r, steps });
    },
  },
  {
    name: 'runs_list',
    description:
      'Runs, newest first, each with its agent policy, tier, cost, budget use and stop reason. Filter with status, task_id and stop_reason. ' +
      'Without limit or cursor it returns the most recent runs as a list. With limit (1 to 100) or cursor it returns one page, { items, nextCursor }: pass nextCursor back as cursor for the next page; null means the end.',
    input: z.object({
      status: z.enum(RUN_STATUSES).optional(),
      task_id: z.union([z.literal('none'), id]).optional().describe('Runs of this task; "none" is the runs without a task.'),
      stop_reason: z.enum(STOP_REASON_FILTERS).optional().describe('Why the run stopped; "budget" is every budget_* reason.'),
      limit: z.number().int().min(1).max(100).optional().describe('Page size; asks for a page instead of a list.'),
      cursor: z.string().min(1).max(500).optional().describe('nextCursor of the previous page, with the same filters.'),
    }),
    async call(a, ctx) {
      const query = new URLSearchParams();
      if (a.status !== undefined) query.set('status', String(a.status));
      if (a.task_id !== undefined) query.set('taskId', String(a.task_id));
      if (a.stop_reason !== undefined) query.set('stopReason', String(a.stop_reason));
      if (a.limit !== undefined || a.cursor !== undefined) {
        query.set('envelope', '1');
        if (a.limit !== undefined) query.set('limit', String(a.limit));
        if (a.cursor !== undefined) query.set('cursor', String(a.cursor));
      }
      const qs = query.toString();
      return text(await ctx.api('GET', `/runs${qs ? `?${qs}` : ''}`));
    },
  },
  { name: 'run_cancel', description: 'Stop a run (after its current step).', input: z.object({ run_id: id }), call: async (a, ctx) => text(await ctx.api('POST', `/runs/${String(a.run_id)}/cancel`, {})) },
  { name: 'tasks_list', description: 'Saved tasks (reusable goals with a profile, allowed sites and an agent policy that sets budgets and models).', input: z.object({}), call: async (_a, ctx) => text(await ctx.api('GET', '/tasks')) },
  {
    name: 'task_create',
    description:
      'Save a task. allowed_domains limits where the agent may go (empty = any site). policy_id picks the agent policy (budgets and model tiers); without it the task follows the user\'s default policy. ' +
      'schedules creates the task with its schedules in one step (at most 10): each is a 5-field cron expression with an optional timezone, policy_id and enabled; one invalid schedule creates nothing. Check an expression first with schedule_preview.',
    input: z.object({
      name: z.string().min(1).max(200),
      goal: z.string().min(1).max(4000),
      profile,
      allowed_domains: z.array(z.string()).max(50).default([]),
      policy_id: policyIdParam.optional(),
      schedules: z.array(scheduleItem).max(10).optional(),
    }),
    call: async (a, ctx) =>
      text(
        await ctx.api('POST', '/tasks', {
          name: a.name,
          goal: a.goal,
          profile: a.profile,
          allowedDomains: a.allowed_domains,
          ...(a.policy_id !== undefined ? { policyId: a.policy_id } : {}),
          ...(a.schedules !== undefined
            ? {
                schedules: (a.schedules as z.infer<typeof scheduleItem>[]).map((sc) => ({
                  cron: sc.cron,
                  ...(sc.timezone !== undefined ? { timezone: sc.timezone } : {}),
                  ...(sc.enabled !== undefined ? { enabled: sc.enabled } : {}),
                  ...(sc.policy_id !== undefined ? { policyId: sc.policy_id } : {}),
                })),
              }
            : {}),
        }),
      ),
  },
  {
    name: 'task_update',
    description: 'Change a saved task; only the fields you pass change.',
    input: z.object({ task_id: id, name: z.string().min(1).max(200).optional(), goal: z.string().min(1).max(4000).optional(), profile: profile.optional(), allowed_domains: z.array(z.string()).max(50).optional(), policy_id: policyIdParam.nullable().optional().describe('The task\'s agent policy; null makes it follow the user\'s default policy.') }),
    call: async (a, ctx) =>
      text(
        await ctx.api('PATCH', `/tasks/${String(a.task_id)}`, {
          ...(a.name !== undefined ? { name: a.name } : {}),
          ...(a.goal !== undefined ? { goal: a.goal } : {}),
          ...(a.profile !== undefined ? { profile: a.profile } : {}),
          ...(a.allowed_domains !== undefined ? { allowedDomains: a.allowed_domains } : {}),
          ...(a.policy_id !== undefined ? { policyId: a.policy_id } : {}),
        }),
      ),
  },
  {
    name: 'task_run',
    description: 'Run a saved task now. Returns the run. policy_id runs it under another agent policy for this run only ("Run with..."); otherwise the task\'s or the default policy applies.',
    input: z.object({ task_id: id, policy_id: policyIdParam.optional() }),
    call: async (a, ctx) => text(await ctx.api('POST', `/tasks/${String(a.task_id)}/runs`, a.policy_id !== undefined ? { policyId: a.policy_id } : {})),
  },
  {
    name: 'schedule_create',
    description: 'Run a task on a schedule: a 5-field cron expression (at most every 5 minutes). timezone is an IANA time zone; leave it out to use the time zone of the user\'s profile (UTC when the profile has none). policy_id makes the scheduled runs use that agent policy instead of the task\'s.',
    input: z.object({ task_id: id, cron: cronParam, timezone: z.string().optional(), policy_id: policyIdParam.optional() }),
    call: async (a, ctx) => text(await ctx.api('POST', '/schedules', { taskId: a.task_id, cron: a.cron, ...(a.timezone !== undefined ? { timezone: a.timezone } : {}), ...(a.policy_id !== undefined ? { policyId: a.policy_id } : {}) })),
  },
  {
    name: 'schedule_preview',
    description:
      'Check a schedule before saving it: what the cron expression means in words and when it fires next, or why it would be refused (not valid, more often than every 5 minutes, unknown time zone). Saves nothing. ' +
      "Leave timezone out to use the time zone of the user's profile.",
    input: z.object({ cron: cronParam, timezone: z.string().optional(), count: z.number().int().min(1).max(10).optional().describe('How many next firings to list (default 5).') }),
    call: async (a, ctx) => text(await ctx.api('POST', '/schedules/preview', { cron: a.cron, ...(a.timezone !== undefined ? { timezone: a.timezone } : {}), ...(a.count !== undefined ? { count: a.count } : {}) })),
  },
  {
    name: 'task_pause',
    description:
      "Pause a task: disable every schedule it has, so it no longer starts by itself. It can still be started with task_run, and a run that is going finishes. A task without a schedule answers NO_SCHEDULES. Returns the task with its summary.",
    input: z.object({ task_id: id }),
    call: async (a, ctx) => text(await ctx.api('POST', `/tasks/${String(a.task_id)}/schedules/pause`, {})),
  },
  {
    name: 'task_resume',
    description: 'Resume a paused task: enable every schedule it has and compute their next firing. Returns the task with its summary.',
    input: z.object({ task_id: id }),
    call: async (a, ctx) => text(await ctx.api('POST', `/tasks/${String(a.task_id)}/schedules/resume`, {})),
  },
  { name: 'schedules_list', description: 'Task schedules.', input: z.object({}), call: async (_a, ctx) => text(await ctx.api('GET', '/schedules')) },
  { name: 'inbox_list', description: "What the user's agents are waiting for (CAPTCHAs, codes, sign-ins, confirmations). Relay these to the user.", input: z.object({}), call: async (_a, ctx) => text(await ctx.api('GET', '/inbox')) },
  {
    name: 'inbox_answer',
    description:
      "Relay the USER's answer to a waiting request (never invent one). Name it by question_id (from inbox_list or ask_human) or by run_id. " +
      'outcome completed with value for text/choice (an option id)/number/confirm ("approve" or "deny")/secret, values (option ids) for multi_choice, completed alone for none/takeover; cancelled to decline.',
    input: z.object({
      question_id: id.optional(),
      run_id: id.optional(),
      outcome: z.enum(['completed', 'cancelled']),
      value: z.union([z.string().max(4096), z.number()]).optional(),
      values: z.array(z.string().max(64)).max(10).optional(),
    }),
    async call(a, ctx) {
      if (Boolean(a.question_id) === Boolean(a.run_id)) return { ...text('Give question_id or run_id (one of them).'), isError: true };
      const body = { outcome: a.outcome, ...(a.value !== undefined ? { value: a.value } : {}), ...(a.values !== undefined ? { values: a.values } : {}) };
      if (a.question_id) return text(questionResult(await ctx.api<QuestionView>('POST', `/questions/${String(a.question_id)}/answer`, { ...body, channel: 'mcp' })));
      return text(await ctx.api('POST', `/inbox/${String(a.run_id)}/respond`, body));
    },
  },
  {
    name: 'ask_human',
    description:
      'Ask the user a question that needs no browser (they answer on the web app, the Android app, the CLI or a notification). ' +
      'input: text, choice (one of options), multi_choice (several), number, confirm (approve/deny; risk "high" by default, which only signed-in channels may answer), none or takeover (they press Done). ' +
      'Never ask for a password or a code here (use browser_request_human with input secret). With wait_s (at most 300) the call waits for the answer; otherwise follow it with question_status.',
    input: z.object({
      prompt: z.string().min(1).max(2000),
      input: z.enum(['none', 'text', 'choice', 'multi_choice', 'number', 'confirm', 'takeover']),
      kind: z.enum(KINDS).default('other'),
      options: z.array(option).max(10).optional().describe('choice and multi_choice'),
      constraints: constraints.optional(),
      confirm_label: z.string().min(1).max(40).optional(),
      deny_label: z.string().min(1).max(40).optional(),
      risk: z.enum(['low', 'high']).optional().describe('confirm only'),
      timeout_s: z.number().int().min(10).max(86_400).optional().describe('How long the question stays open (default 1 hour)'),
      wait_s: z.number().int().min(0).max(MAX_TOOL_WAIT_S).default(0).describe('Wait this long for the answer'),
      agent_name: z.string().min(1).max(100).default('mcp agent'),
    }),
    async call(a, ctx) {
      const q = await ctx.api<QuestionView>('POST', '/questions', { ...questionBody(a), asker: a.agent_name });
      return text(questionResult(Number(a.wait_s) > 0 ? await awaitQuestion(ctx, q.id, Number(a.wait_s), q) : q));
    },
  },
  {
    name: 'question_status',
    description: 'A question: pending, answered (with outcome, value or values), cancelled (declined) or expired. With wait_s (at most 300) waits while it is pending. A secret is never returned.',
    input: z.object({ question_id: id, wait_s: z.number().int().min(0).max(MAX_TOOL_WAIT_S).default(0) }),
    call: async (a, ctx) => text(questionResult(await awaitQuestion(ctx, String(a.question_id), Number(a.wait_s)))),
  },

  // --- agent policies (budgets and model tiers of a run) --------------------
  {
    name: 'policies_list',
    description:
      'The agent policies you can run under: the built-ins (economy, balanced, thorough, unlimited) and the user\'s own. For each: id, name, builtin, isDefault, the model tiers (startTier to maxTier), a budget summary and hasNoHardStop (every budget limit is unlimited). ' +
      POLICY_NOTE +
      'Pass an id as policy_id to run_goal, task_create, task_update, task_run or schedule_create.',
    input: z.object({}),
    async call(_a, ctx) {
      const list = await ctx.api<Array<{ id: string; name: string; description: string | null; builtin: boolean; isDefault: boolean; hasNoHardStop: boolean; version: number; spec: { models: { startTier: string; maxTier: string }; budget: Record<string, number | null> }; usage: unknown }>>('GET', '/agent-policies');
      return text(
        list.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          builtin: p.builtin,
          isDefault: p.isDefault,
          version: p.version,
          tiers: `${p.spec.models.startTier} -> ${p.spec.models.maxTier}`,
          budget: p.spec.budget,
          hasNoHardStop: p.hasNoHardStop,
          usage: p.usage,
        })),
      );
    },
  },
  {
    name: 'policy_get',
    description: 'One agent policy with its full spec (models, budget, stall detection, context). `null` in a budget limit means unlimited. ' + POLICY_NOTE,
    input: z.object({ policy_id: policyIdParam }),
    call: async (a, ctx) => text(await ctx.api('GET', `/agent-policies/${encodeURIComponent(String(a.policy_id))}`)),
  },
  {
    name: 'policy_create',
    description:
      'Create an agent policy from a full spec (get an existing one with policy_get and change it, or duplicate a built-in\'s spec). Names are unique among the user\'s policies. ' +
      POLICY_NOTE +
      'The spec is validated by the console; the error lists what is wrong.',
    input: z.object({ name: z.string().trim().min(1).max(100), description: z.string().trim().max(500).nullable().optional(), spec: agentPolicySpecSchema }),
    call: async (a, ctx) => text(await ctx.api('POST', '/agent-policies', { name: a.name, ...(a.description !== undefined ? { description: a.description } : {}), spec: a.spec })),
  },
  {
    name: 'policy_update',
    description:
      'Change one of the user\'s own agent policies (built-ins are read-only: create a copy). Only the fields you pass change, but `spec` replaces the whole spec, so start from policy_get. ' +
      'Pass version (from policy_get) to refuse the change when someone edited the policy meanwhile (412 POLICY_VERSION_CONFLICT); omit it to overwrite. Runs already started keep the policy they started with.',
    input: z.object({
      policy_id: policyIdParam,
      name: z.string().trim().min(1).max(100).optional(),
      description: z.string().trim().max(500).nullable().optional(),
      spec: agentPolicySpecSchema.optional(),
      version: z.number().int().min(0).optional().describe('The `version` you read; the update is refused when it moved'),
    }),
    call: async (a, ctx) =>
      text(
        await ctx.api(
          'PATCH',
          `/agent-policies/${encodeURIComponent(String(a.policy_id))}`,
          { ...(a.name !== undefined ? { name: a.name } : {}), ...(a.description !== undefined ? { description: a.description } : {}), ...(a.spec !== undefined ? { spec: a.spec } : {}) },
          a.version !== undefined ? { 'if-match': String(a.version) } : undefined,
        ),
      ),
  },
  {
    name: 'policy_set_default',
    description: "Choose the user's default agent policy, used by every run that names none (tasks, schedules and run_goal without policy_id). null goes back to builtin:balanced.",
    input: z.object({ policy_id: policyIdParam.nullable() }),
    call: async (a, ctx) => text(await ctx.api('PUT', '/agent-policies/default', { policyId: a.policy_id })),
  },
  {
    name: 'policies_export',
    description:
      'Export agent policies as the portable JSON file the console imports (no ids, users or secrets). ids: "all" (default; the built-ins and the user\'s own policies) or a comma-separated list of policy ids (built-ins allowed, as templates). include_pins false strips model pins so the file works on any deployment. Hand the result to policies_import.',
    input: z.object({ ids: z.string().max(8000).default('all'), include_pins: z.boolean().default(true) }),
    call: async (a, ctx) => text(await ctx.api('GET', `/agent-policies/export?ids=${encodeURIComponent(String(a.ids))}&includePins=${String(a.include_pins)}`)),
  },
  {
    name: 'policies_import',
    description:
      'Import agent policies from a file made by policies_export (pass its JSON as `file`; at most 100 policies and 256 KB). on_conflict decides what happens when the user already has a policy of that name: rename (default; adds " (2)"), skip, or replace (overwrites theirs). Returns created, replaced, skipped and warnings.',
    input: z.object({ file: z.record(z.string(), z.unknown()).describe('The exported file, as JSON'), on_conflict: z.enum(['rename', 'skip', 'replace']).default('rename') }),
    call: async (a, ctx) => text(await ctx.api('POST', '/agent-policies/import', { file: a.file, onConflict: a.on_conflict })),
  },
  { name: 'hosts_list', description: 'Browser hosts with their mode (unattended, attended or container), whether they can share a desktop, their profiles and running browsers.', input: z.object({}), call: async (_a, ctx) => text(await ctx.api('GET', '/fleet/hosts')) },

  // --- drive a browser directly (an external session) ----------------------
  {
    name: 'browser_open',
    description: 'Open a browser session on a profile. Every action is recorded as a run the user can watch and stop. Returns session_id.',
    input: z.object({ profile, goal: z.string().min(1).max(4000).describe('What you are about to do (shown to the user)'), allowed_domains: z.array(z.string()).max(50).default([]), agent_name: z.string().max(200).default('mcp agent') }),
    call: async (a, ctx) => {
      const r = await ctx.api<{ runId: string }>('POST', '/browser/sessions', { profile: a.profile, goal: a.goal, allowedDomains: a.allowed_domains, actor: a.agent_name });
      return text({ session_id: r.runId });
    },
  },
  action('browser_navigate', 'Open a URL.', z.object({ url: z.string().max(2000) }), (a) => ({ type: 'navigate', url: a.url })),
  action('browser_elements', 'Interactive elements with CSS selectors.', z.object({}), () => ({ type: 'elements', max_elements: 80 })),
  action('browser_text', 'Visible text of the page or of one element.', z.object({ selector: z.string().max(2000).optional() }), (a) => ({ type: 'text', ...(a.selector ? { selector: a.selector } : {}), max_chars: 8000 })),
  action('browser_click', 'Click an element.', z.object({ selector: z.string().max(2000) }), (a) => ({ type: 'click', selector: a.selector })),
  action('browser_type', 'Type text into an input (never secrets: use browser_type_secret).', z.object({ selector: z.string().max(2000), text: z.string().max(10000), submit: z.boolean().default(false) }), (a) => ({ type: 'type', selector: a.selector, text: a.text, clear: true, submit: a.submit })),
  action('browser_press', 'Press a key (Enter, Tab, Escape…).', z.object({ key: z.string().max(40) }), (a) => ({ type: 'press', key: a.key })),
  action('browser_scroll', 'Scroll vertically by pixels.', z.object({ dy: z.number().int().min(-20000).max(20000) }), (a) => ({ type: 'scroll', dy: a.dy })),
  action('browser_wait_for', 'Wait for an element (up to 15 s).', z.object({ selector: z.string().max(2000) }), (a) => ({ type: 'wait_for', selector: a.selector, timeout_ms: 15000 })),
  action('browser_back', 'Go back.', z.object({}), () => ({ type: 'back' })),
  action('browser_tabs', 'List tabs.', z.object({}), () => ({ type: 'tabs' })),
  action('browser_screenshot', 'A screenshot of the page in CSS pixels (the coordinates browser_click_at takes). marks=true boxes and numbers the interactive elements and lists them with their boxes.', z.object({ marks: z.boolean().default(true) }), (a) => ({ type: 'screenshot', ...(a.marks ? { marks: true } : {}) })),
  action('browser_evaluate', 'Run JavaScript in the page and get its JSON value (the last expression is the value; top-level await works).', z.object({ script: z.string().min(1).max(100_000) }), (a) => ({ type: 'evaluate', script: a.script, await_promise: true })),
  action('browser_click_at', 'Real mouse click at viewport coordinates from browser_screenshot.', z.object({ x: z.number().int().min(0), y: z.number().int().min(0), button: z.enum(['left', 'middle', 'right']).default('left'), double: z.boolean().default(false), modifiers: z.array(z.enum(['alt', 'ctrl', 'meta', 'shift'])).default([]) }), (a) => ({ type: 'click_at', x: a.x, y: a.y, button: a.button, ...(a.double ? { click_count: 2 } : {}), modifiers: a.modifiers })),
  action('browser_hover_at', 'Move the mouse to viewport coordinates (hover menus, tooltips).', z.object({ x: z.number().int().min(0), y: z.number().int().min(0) }), (a) => ({ type: 'mouse', op: 'move', x: a.x, y: a.y })),
  action('browser_drag', 'Real mouse drag between two viewport points.', z.object({ from_x: z.number().int().min(0), from_y: z.number().int().min(0), to_x: z.number().int().min(0), to_y: z.number().int().min(0) }), (a) => ({ type: 'drag', from_x: a.from_x, from_y: a.from_y, to_x: a.to_x, to_y: a.to_y })),
  action('browser_scroll_at', 'Mouse-wheel scroll at a viewport point.', z.object({ x: z.number().int().min(0), y: z.number().int().min(0), dy: z.number().int().min(-20000).max(20000) }), (a) => ({ type: 'scroll_at', x: a.x, y: a.y, dx: 0, dy: a.dy })),
  action('browser_type_keys', 'Type into the focused element with real keyboard events.', z.object({ text: z.string().min(1).max(10000) }), (a) => ({ type: 'type_keys', text: a.text })),
  action('browser_key', 'Press a key with modifiers (key "a" with ["ctrl"]).', z.object({ key: z.string().min(1).max(40), modifiers: z.array(z.enum(['alt', 'ctrl', 'meta', 'shift'])).default([]) }), (a) => ({ type: 'key', key: a.key, modifiers: a.modifiers })),
  action('browser_desktop_screenshot', "A screenshot of the computer's whole screen (screen pixels).", z.object({}), () => ({ type: 'desktop_screenshot' })),
  action('browser_desktop_click', 'Click anywhere on the computer screen.', z.object({ x: z.number().int().min(0), y: z.number().int().min(0), button: z.enum(['left', 'middle', 'right']).default('left'), double: z.boolean().default(false) }), (a) => ({ type: 'desktop_click', x: a.x, y: a.y, button: a.button, ...(a.double ? { click_count: 2 } : {}) })),
  action('browser_desktop_type', 'Type into whatever has focus on the computer (a native dialog, another window).', z.object({ text: z.string().min(1).max(10000) }), (a) => ({ type: 'desktop_type', text: a.text })),
  action('browser_desktop_key', 'Press a key chord on the computer: Return, Escape, ctrl+l, alt+F4.', z.object({ key: z.string().min(1).max(64) }), (a) => ({ type: 'desktop_key', key: a.key })),
  action('browser_desktop_scroll', 'Scroll the computer screen by wheel clicks at a point.', z.object({ x: z.number().int().min(0), y: z.number().int().min(0), dy: z.number().int().min(-100).max(100) }), (a) => ({ type: 'desktop_scroll', x: a.x, y: a.y, dy: a.dy })),
  action('browser_desktop_drag', 'Drag on the computer screen.', z.object({ from_x: z.number().int().min(0), from_y: z.number().int().min(0), to_x: z.number().int().min(0), to_y: z.number().int().min(0) }), (a) => ({ type: 'desktop_drag', from_x: a.from_x, from_y: a.from_y, to_x: a.to_x, to_y: a.to_y })),
  {
    name: 'browser_request_human',
    description:
      'Ask the person for help in this browser session (CAPTCHA, code, passkey, login, a choice, a number, a confirmation, or taking over the browser). It appears in their Inbox and notifications. ' +
      'input: none (they act, then Done), text, secret (type it with browser_type_secret), choice, multi_choice, number, confirm (approve/deny), takeover. Then poll browser_handoff_status.',
    input: z.object({
      session_id: id,
      kind: z.enum(KINDS),
      prompt: z.string().min(1).max(2000),
      input: z.enum(['none', 'text', 'secret', 'choice', 'multi_choice', 'number', 'confirm', 'takeover']).default('none'),
      options: z.array(option).max(10).optional().describe('choice and multi_choice'),
      choices: z.array(option).max(10).optional().describe('The older name of options'),
      constraints: constraints.optional(),
      confirm_label: z.string().min(1).max(40).optional(),
      deny_label: z.string().min(1).max(40).optional(),
      risk: z.enum(['low', 'high']).optional().describe('confirm only'),
      timeout_s: z.number().int().min(10).max(86_400).optional(),
    }),
    call: async (a, ctx) => text(await ctx.api('POST', `/browser/sessions/${String(a.session_id)}/handoffs`, questionBody(a))),
  },
  {
    name: 'browser_handoff_status',
    description: 'Whether the person answered. A text or choice answer is returned; a secret never is (type it with browser_type_secret).',
    input: z.object({ session_id: id, handoff_id: id }),
    call: async (a, ctx) => text(await ctx.api('GET', `/browser/sessions/${String(a.session_id)}/handoffs/${String(a.handoff_id)}`)),
  },
  action('browser_type_secret', 'Type the code or password the person gave in a handoff, without you seeing it (the fabric types it; the console never holds it).', z.object({ handoff_id: id, selector: z.string().max(2000), clear: z.boolean().default(true), submit: z.boolean().default(false) }), (a) => ({ type: 'type_handoff_secret', handoffId: a.handoff_id, selector: a.selector, clear: a.clear, submit: a.submit })),
  {
    name: 'browser_close',
    description: 'End the session, saying whether you succeeded.',
    input: z.object({ session_id: id, success: z.boolean().default(true), result: z.string().max(8000).optional() }),
    call: async (a, ctx) => text(await ctx.api('DELETE', `/browser/sessions/${String(a.session_id)}`, { success: a.success, ...(a.result ? { result: a.result } : {}) })),
  },
];

/**
 * Tools that only read (MCP `readOnlyHint`): clients such as OpenClaw may run
 * them without asking. Every other tool acts and is announced as such.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'run_status', 'runs_list', 'tasks_list', 'schedule_preview', 'policies_list', 'policy_get', 'policies_export', 'schedules_list', 'inbox_list', 'hosts_list',
  'browser_elements', 'browser_text', 'browser_tabs', 'browser_screenshot', 'browser_desktop_screenshot', 'browser_handoff_status', 'question_status',
]);
