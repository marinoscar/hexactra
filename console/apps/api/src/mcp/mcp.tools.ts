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

export const MCP_INSTRUCTIONS = `Hexactra runs real browsers for the user, on their own machines and profiles, through this console.
Two ways to work:
1. Delegate: run_goal (or task_run) hands a goal to Hexactra's own browser agent; follow it with run_status. It asks the person for CAPTCHAs, codes and confirmations itself.
2. Drive: browser_open, then browser_* tools step by step; every action is recorded and the user can stop you at any time.
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
    description: "Relay the USER's answer to a waiting request (never invent one). outcome completed with value for text/choice/secret, completed alone for done/approve, cancelled to decline.",
    input: z.object({ run_id: id, outcome: z.enum(['completed', 'cancelled']), value: z.string().max(4096).optional() }),
    call: async (a, ctx) => text(await ctx.api('POST', `/inbox/${String(a.run_id)}/respond`, { outcome: a.outcome, ...(a.value !== undefined ? { value: a.value } : {}) })),
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
    description: 'Ask the person for help (CAPTCHA, code, passkey, login, confirmation). It appears in their Inbox and notifications. Then poll browser_handoff_status.',
    input: z.object({ session_id: id, kind: z.enum(['captcha', 'code', 'passkey', 'login', 'confirmation', 'other']), prompt: z.string().min(1).max(2000), input: z.enum(['none', 'text', 'secret', 'choice']).default('none'), choices: z.array(z.string()).max(10).default([]) }),
    call: async (a, ctx) => text(await ctx.api('POST', `/browser/sessions/${String(a.session_id)}/handoffs`, { kind: a.kind, prompt: a.prompt, input: a.input, choices: a.choices })),
  },
  {
    name: 'browser_handoff_status',
    description: 'Whether the person answered. A text or choice answer is returned; a secret never is (type it with browser_type_secret).',
    input: z.object({ session_id: id, handoff_id: id }),
    call: async (a, ctx) => text(await ctx.api('GET', `/browser/sessions/${String(a.session_id)}/handoffs/${String(a.handoff_id)}`)),
  },
  action('browser_type_secret', 'Type the code or password the person gave in a handoff, without you seeing it.', z.object({ handoff_id: id, selector: z.string().max(2000), submit: z.boolean().default(false) }), (a) => ({ type: 'type_handoff_secret', handoffId: a.handoff_id, selector: a.selector, submit: a.submit })),
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
  'browser_elements', 'browser_text', 'browser_tabs', 'browser_screenshot', 'browser_handoff_status',
]);
