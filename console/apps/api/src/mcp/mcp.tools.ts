import { z } from 'zod';

/** How a tool reaches the console: its own REST API, as the caller. */
export interface McpContext {
  api<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T>;
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
      if (name === 'browser_screenshot' && typeof r.result?.url_path === 'string') {
        const img = await ctx.bytes(String(r.result.url_path).replace(/^\/api/, ''));
        return { content: [{ type: 'image', data: img.data.toString('base64'), mimeType: img.mime }] };
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
3. Ask: ask_human asks the user a question with no browser involved (text, choice, multi_choice, number, confirm, none, takeover) and can wait for the answer (wait_s); question_status follows it. The user answers on any of their devices.
Rules: never try to bypass a CAPTCHA or a bot check, never guess a code or a password. Call browser_request_human and wait (browser_handoff_status); type codes with browser_type_secret, so you never see them. Ask before buying, paying or submitting anything irreversible. Close sessions with browser_close.`;

export const MCP_TOOLS: McpTool[] = [
  // --- delegate to the console's goal runner -------------------------------
  {
    name: 'run_goal',
    description: "Hand a goal to Hexactra's browser agent (it plans and acts by itself). Returns the run id; follow it with run_status.",
    input: z.object({ goal: z.string().min(1).max(4000), profile }),
    call: async (a, ctx) => text(await ctx.api('POST', '/runs', { goal: a.goal, profile: a.profile })),
  },
  {
    name: 'run_status',
    description: 'A run: status (queued, running, waiting_human = needs the person, succeeded, failed, cancelled), result, and its latest steps.',
    input: z.object({ run_id: id, steps: z.number().int().min(0).max(50).default(10) }),
    async call(a, ctx) {
      const r = await ctx.api<{ steps?: unknown[] } & Record<string, unknown>>('GET', `/runs/${String(a.run_id)}`);
      const steps = (r.steps ?? []).slice(-Number(a.steps));
      return text({ ...r, steps });
    },
  },
  { name: 'runs_list', description: 'Recent runs.', input: z.object({ status: z.enum(['queued', 'running', 'waiting_human', 'succeeded', 'failed', 'cancelled']).optional() }), call: async (a, ctx) => text(await ctx.api('GET', `/runs${a.status ? `?status=${String(a.status)}` : ''}`)) },
  { name: 'run_cancel', description: 'Stop a run (after its current step).', input: z.object({ run_id: id }), call: async (a, ctx) => text(await ctx.api('POST', `/runs/${String(a.run_id)}/cancel`, {})) },
  { name: 'tasks_list', description: 'Saved tasks (reusable goals with a profile, allowed sites and budgets).', input: z.object({}), call: async (_a, ctx) => text(await ctx.api('GET', '/tasks')) },
  {
    name: 'task_create',
    description: 'Save a task. allowed_domains limits where the agent may go (empty = any site).',
    input: z.object({ name: z.string().min(1).max(200), goal: z.string().min(1).max(4000), profile, allowed_domains: z.array(z.string()).max(50).default([]) }),
    call: async (a, ctx) => text(await ctx.api('POST', '/tasks', { name: a.name, goal: a.goal, profile: a.profile, allowedDomains: a.allowed_domains })),
  },
  {
    name: 'task_update',
    description: 'Change a saved task; only the fields you pass change.',
    input: z.object({ task_id: id, name: z.string().min(1).max(200).optional(), goal: z.string().min(1).max(4000).optional(), profile: profile.optional(), allowed_domains: z.array(z.string()).max(50).optional() }),
    call: async (a, ctx) =>
      text(
        await ctx.api('PATCH', `/tasks/${String(a.task_id)}`, {
          ...(a.name !== undefined ? { name: a.name } : {}),
          ...(a.goal !== undefined ? { goal: a.goal } : {}),
          ...(a.profile !== undefined ? { profile: a.profile } : {}),
          ...(a.allowed_domains !== undefined ? { allowedDomains: a.allowed_domains } : {}),
        }),
      ),
  },
  { name: 'task_run', description: 'Run a saved task now. Returns the run.', input: z.object({ task_id: id }), call: async (a, ctx) => text(await ctx.api('POST', `/tasks/${String(a.task_id)}/runs`, {})) },
  {
    name: 'schedule_create',
    description: 'Run a task on a schedule: a 5-field cron expression in an IANA time zone (at most every 5 minutes).',
    input: z.object({ task_id: id, cron: z.string().min(9).max(100), timezone: z.string().default('UTC') }),
    call: async (a, ctx) => text(await ctx.api('POST', '/schedules', { taskId: a.task_id, cron: a.cron, timezone: a.timezone })),
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
  { name: 'hosts_list', description: 'Browser hosts with their profiles and running browsers.', input: z.object({}), call: async (_a, ctx) => text(await ctx.api('GET', '/fleet/hosts')) },

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
  action('browser_screenshot', 'A screenshot of the page.', z.object({}), () => ({ type: 'screenshot' })),
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
  'run_status', 'runs_list', 'tasks_list', 'schedules_list', 'inbox_list', 'hosts_list',
  'browser_elements', 'browser_text', 'browser_tabs', 'browser_screenshot', 'browser_handoff_status', 'question_status',
]);
