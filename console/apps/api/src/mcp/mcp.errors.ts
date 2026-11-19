// How a failed REST call becomes a tool result a model can act on (#462,
// "Errors"). One place: the tools throw `McpApiError` (built by the
// dispatcher's in-process REST client) and the dispatcher maps it here.
// Never a raw REST string, never "Internal Server Error", never a stack.
import { APP_LIMIT_CODES, appLimitSentence, type AppLimitCode } from '../connected-apps/connected-apps.errors';
import type { McpToolResult } from './mcp.results';

/** A REST route answered with an error (status 400 and up). */
export class McpApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
    /** Seconds from `Retry-After` (429). */
    readonly retryAfterS?: number,
  ) {
    super(message);
    this.name = 'McpApiError';
  }
}

/** What the model is pointed at when an id is unknown: the thing and the tool that lists it. */
const NOT_FOUND_BY_CODE: Readonly<Record<string, [thing: string, list: string]>> = {
  RUN_NOT_FOUND: ['run', 'runs_list'],
  TASK_NOT_FOUND: ['task', 'tasks_list'],
  SCHEDULE_NOT_FOUND: ['schedule', 'schedules_list'],
  POLICY_NOT_FOUND: ['agent policy', 'policies_list'],
  QUESTION_NOT_FOUND: ['question', 'inbox_list'],
  SESSION_NOT_FOUND: ['browser session', 'browser_open (to start a new one)'],
  HOST_NOT_FOUND: ['machine', 'hosts_list'],
  PROFILE_NOT_FOUND: ['browser profile', 'hosts_list'],
};

function notFoundByTool(tool: string): [string, string] {
  if (tool.startsWith('browser_')) return ['browser session', 'browser_open (to start a new one)'];
  if (tool.startsWith('policy') || tool.startsWith('policies')) return ['agent policy', 'policies_list'];
  if (tool.startsWith('schedule')) return ['task', 'tasks_list'];
  if (tool.startsWith('task')) return ['task', 'tasks_list'];
  if (tool === 'question_status' || tool === 'inbox_answer' || tool === 'ask_human') return ['question', 'inbox_list'];
  if (tool === 'hosts_list') return ['machine', 'hosts_list'];
  return ['run', 'runs_list'];
}

/** The next step after a conflict, by the route's code. */
const CONFLICT_NEXT_STEP: Readonly<Record<string, string>> = {
  RUN_LIVE: 'Wait for the run to finish (run_status) or stop it with run_cancel, then try again.',
  RUN_FINISHED: 'The run has already finished, so it cannot be paused: read it with run_status.',
  RUN_NOT_PAUSED: 'The run is not paused: read it with run_status. To hold a running run use run_pause.',
  RUN_NOT_PAUSABLE: 'An external agent drives this run, so it cannot be paused here.',
  RUN_BUSY: 'Wait a moment and try again; follow the run with run_status.',
  RUN_NOT_LIVE: 'The run has already finished: read it with run_status.',
  NOT_WAITING: 'Nothing is waiting for an answer any more: check run_status or inbox_list.',
  INVALID_RUN_TRANSITION: 'Read the run with run_status to see its current state.',
  NO_SCHEDULES: 'The task has no schedule: add one with schedule_create.',
  SCHEDULE_LIMIT: 'A task has at most 10 schedules: run it with task_run instead, or ask the user to remove a schedule in the console.',
  POLICY_VERSION_CONFLICT: 'Someone changed the policy meanwhile: read it again with policy_get and retry with its new version.',
  POLICY_NAME_TAKEN: 'Choose another name (policies_list shows the names in use).',
  POLICY_BUILTIN_READONLY: 'Built-in policies are read-only: create a copy with policy_create.',
  POLICY_IN_USE: 'The policy is in use by tasks or schedules.',
  POLICY_IS_DEFAULT: "The policy is the user's default: choose another default with policy_set_default first.",
  ALREADY_ANSWERED: 'Read the answer with question_status.',
  TAKEOVER_ACTIVE: 'A person is controlling the browser right now: wait, then check browser_handoff_status or take a browser_screenshot.',
  TAKEOVER_HELD: 'A person is controlling the browser right now: wait, then check browser_handoff_status or take a browser_screenshot.',
  HANDOFF_PENDING: 'The person has not answered yet: check browser_handoff_status.',
  SESSION_ENDED: 'The session has ended: open a new one with browser_open.',
  SESSION_CANCELLED: 'The user stopped this session: do not continue it; open a new one only if they ask.',
  CONFIRMATION_REQUIRED: 'Do not try another way around it. Tell the user what you want to do and ask them to approve it in Hexactra (Inbox), then call the same tool again with the same arguments within 2 minutes of their approval.',
  CONFIRMATION_PENDING: 'The user has not approved it yet: wait for them to approve it in Hexactra (Inbox), then call the same tool again with the same arguments.',
  CONFIRMATION_DENIED: 'The user said no: do not do it, and tell them.',
};

/** Codes that mean the browser machine could not be reached. */
const MACHINE_CODES = new Set(['FABRIC_UNREACHABLE', 'FABRIC_NOT_CONFIGURED', 'FABRIC_UNAUTHORIZED', 'FABRIC_ERROR', 'NO_BROWSER', 'HOST_COMMAND_FAILED']);

/** A REST message that says nothing useful to a model. */
function generic(message: string): boolean {
  return message === '' || /^(internal server error|an unexpected error occurred|bad request|not found|forbidden|conflict)$/i.test(message.trim());
}

/** `allowedDomains` → `allowed_domains`: field names as the tools take them. */
function snake(path: string): string {
  return path.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function issuesOf(details: unknown): { path: string; message: string }[] {
  const issues = (details as { issues?: unknown } | undefined)?.issues;
  if (!Array.isArray(issues)) return [];
  return issues
    .filter((i): i is { path: unknown; message: unknown } => i !== null && typeof i === 'object')
    .map((i) => ({ path: snake(Array.isArray(i.path) ? i.path.join('.') : String(i.path ?? '')), message: String(i.message ?? '') }));
}

/** The error result of one tool: a sentence, `isError`, and the stable code in `structuredContent`. */
export function errorOutcome(text: string, code: string, extra: { status?: number; requestId?: string } = {}): McpToolResult {
  const withId = extra.requestId ? `${text} (request ${extra.requestId})` : text;
  return {
    content: [{ type: 'text', text: withId }],
    isError: true,
    structuredContent: { code, message: text, ...(extra.status !== undefined ? { status: extra.status } : {}), ...(extra.requestId ? { requestId: extra.requestId } : {}) },
  };
}

/** Map a REST failure of `tool` to the result the model sees (the table of #462). */
export function mapApiError(e: McpApiError, tool: string): McpToolResult {
  const { status, code, requestId } = e;
  const message = e.message.trim();
  const extra = { status, requestId };
  // A per-app limit (#464): its own sentence (connected-apps.errors.ts), naming where the user changes it.
  if ((APP_LIMIT_CODES as readonly string[]).includes(code)) {
    return errorOutcome(generic(message) ? appLimitSentence(code as AppLimitCode, (e.details ?? {}) as never) : message, code, extra);
  }
  if (status === 400 || status === 422) {
    const issues = issuesOf(e.details);
    const what = issues.length ? issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ') : message;
    const named = code && code !== 'BAD_REQUEST' && code !== 'VALIDATION_ERROR' && code !== 'UNPROCESSABLE_ENTITY' ? ` (${code})` : '';
    return errorOutcome(`Invalid arguments: ${what}${named}`, code || 'INVALID_ARGUMENTS', extra);
  }
  if (status === 401) return errorOutcome('Hexactra did not accept the credentials of this connection: the user has to sign in again or reconnect.', 'UNAUTHORIZED', extra);
  if (status === 403) return errorOutcome('Your Hexactra account is not allowed to do this.', code || 'FORBIDDEN', extra);
  if (status === 404) {
    const [thing, list] = NOT_FOUND_BY_CODE[code] ?? notFoundByTool(tool);
    return errorOutcome(`No ${thing} with that id. Use ${list} to find it.`, code || 'NOT_FOUND', extra);
  }
  if (MACHINE_CODES.has(code)) {
    const reason = generic(message) ? 'no browser machine answered' : message.replace(/\.$/, '');
    return errorOutcome(`Hexactra could not reach a browser machine: ${reason}. The user can check Machines in the console.`, code, extra);
  }
  if (status === 409 || status === 412) {
    const next = CONFLICT_NEXT_STEP[code];
    const base = generic(message) ? 'The request conflicts with the current state.' : message.replace(/\.?$/, '.');
    return errorOutcome(`${base}${code ? ` (${code})` : ''}${next ? ` ${next}` : ''}`, code || 'CONFLICT', extra);
  }
  if (status === 429) {
    const wait = e.retryAfterS ?? retryAfterOf(e.details) ?? 30;
    return errorOutcome(`Too many requests. Wait ${wait} seconds.`, 'RATE_LIMITED', extra);
  }
  if (status >= 500) {
    const reason = generic(message) ? 'the server could not complete the request' : message.replace(/\.$/, '');
    return errorOutcome(`Hexactra could not reach a browser machine: ${reason}. The user can check Machines in the console.`, 'UNAVAILABLE', extra);
  }
  return errorOutcome(generic(message) ? `The request failed (${status}).` : message, code || `HTTP_${status}`, extra);
}

function retryAfterOf(details: unknown): number | undefined {
  const ms = (details as { retryAfterMs?: unknown } | undefined)?.retryAfterMs;
  return typeof ms === 'number' && ms > 0 ? Math.ceil(ms / 1000) : undefined;
}

/** Anything a tool threw that is not a REST answer: a short sentence, never a stack. */
export function mapUnknownError(e: unknown, tool: string): McpToolResult {
  if (e instanceof McpApiError) return mapApiError(e, tool);
  const raw = e instanceof Error ? e.message : String(e);
  const reason = generic(raw) ? 'an unexpected error' : raw.split('\n')[0].slice(0, 500);
  return errorOutcome(`${tool} failed: ${reason}.`, 'TOOL_FAILED');
}
