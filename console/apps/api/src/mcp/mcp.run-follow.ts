// Following a run from a chat (#463): read a run with its pending question,
// wait for something worth reporting (on the run's events, never a polling
// loop), answer a question the client elicited, and build the answer of
// run_wait, run_goal, task_run and run_status: the progress block, an
// optional screenshot, or an `input_required` request for the question.
import { McpApiError } from './mcp.errors';
import { ELICIT_KEY, REQUEST_STATE_TTL_MS, answerFromForm, elicitationRequest, mayElicit } from './mcp.elicitation';
import { limitsOf, type McpContent, type McpContext, type McpInputRequired, type RunWatch } from './mcp.results';
import {
  decodeCursor,
  encodeCursor,
  runProgress,
  stateOf,
  wakeVerdict,
  type AnswerVia,
  type ProgressCursor,
  type ProgressQuestion,
  type ProgressRun,
  type RunProgress,
} from './run-progress';

/** Where the console is when the context does not say (`APP_URL`'s default). */
const DEFAULT_APP_URL = 'http://localhost:3535';

export function appUrlOf(ctx: McpContext): string {
  return ctx.appUrl ?? process.env.APP_URL ?? DEFAULT_APP_URL;
}

export function viaOf(ctx: McpContext): AnswerVia {
  return ctx.credential?.kind === 'oauth' ? 'oauth' : 'pat';
}

/** The channel an answer passed on by this caller is recorded under (channel-rules.ts). */
export function relayChannel(ctx: McpContext, kind: 'relay' | 'elicitation' | 'app'): string {
  const client = ctx.client && /^[a-z0-9-]{1,20}$/.test(ctx.client) ? `.${ctx.client}` : '';
  if (kind === 'elicitation') return `mcp-elicitation${client}`;
  // The person clicked in an MCP Apps question card (#467): first-hand, but not a console sign-in.
  if (kind === 'app') return `mcp-app${client}`;
  return viaOf(ctx) === 'oauth' ? `mcp-oauth${client}` : 'mcp';
}

/** A run as the REST API answers it, with its pending question and whether a secret is being entered. */
export interface RunState {
  run: ProgressRun & Record<string, unknown>;
  question: (ProgressQuestion & { runId?: string | null; handoffId?: string | null }) | null;
  secretOpen: boolean;
}

/** One read of a run: `GET /runs/:id` (404 for another user's run) and its pending questions. */
export async function readRunState(ctx: McpContext, runId: string): Promise<RunState> {
  const run = await ctx.api<ProgressRun & Record<string, unknown>>('GET', `/runs/${runId}`);
  const raw = await ctx.api<unknown>('GET', `/questions?runId=${runId}&status=pending&limit=20`);
  const pending = (Array.isArray(raw) ? raw : []).filter((q): q is NonNullable<RunState['question']> => q !== null && typeof q === 'object' && (q as { status?: unknown }).status === 'pending');
  // The question the run waits on (its handoff's) first, else the newest.
  const handoff = typeof run.handoffId === 'string' ? pending.find((q) => q.handoffId === run.handoffId) : undefined;
  return { run, question: handoff ?? pending[0] ?? null, secretOpen: pending.some((q) => q.input === 'secret' || q.input === 'credentials') };
}

/** What a wait observed. */
export interface Observed extends RunState {
  changed: boolean;
  cursor: string;
}

/**
 * Wait up to `waitS` seconds (capped by the caller's limit) for something
 * the user would care about after `since`: a status change, a newly opened
 * question, or new steps at most once per 10 s. Subscribes to the run's
 * events once and reads the run only when one arrives (an idle waiter holds
 * no database connection). Without a subscription (none offered, or it
 * failed) it reads once and answers `changed: false`. The client going away
 * ends the wait; nothing is cancelled.
 */
export async function waitForProgress(ctx: McpContext, runId: string, opts: { waitS: number; since: string | null }): Promise<Observed> {
  const deadline = Date.now() + Math.min(Math.max(opts.waitS, 0), limitsOf(ctx).maxWaitS) * 1000;
  let base: ProgressCursor | null = decodeCursor(opts.since);
  let watch: RunWatch | undefined;
  if (opts.waitS > 0 && ctx.watchRun) {
    try {
      watch = ctx.watchRun(runId);
    } catch {
      watch = undefined;
    }
  }
  try {
    let st = await readRunState(ctx, runId);
    for (;;) {
      const now = Date.now();
      const cur = stateOf(st.run, st.question, now);
      const v = wakeVerdict(base, cur, now);
      if (v.report) return { ...st, changed: true, cursor: encodeCursor(cur) };
      // A first call measures step progress from its own start.
      if (!base) base = cur;
      if (v.settled || !watch || now >= deadline) return { ...st, changed: false, cursor: encodeCursor(base) };
      const until = Math.min(deadline, v.stepsDueAt ?? deadline);
      const woke = await watch.next(until - now, { ignoreSteps: v.stepsDueAt !== null });
      if (woke === 'aborted') return { ...st, changed: false, cursor: encodeCursor(base) };
      st = await readRunState(ctx, runId);
    }
  } finally {
    watch?.close();
  }
}

/** The progress block of an observed run. */
export function progressOf(ctx: McpContext, st: RunState, changed: boolean, cursor?: string): RunProgress {
  return runProgress(st.run, st.question, { appUrl: appUrlOf(ctx), via: viaOf(ctx), changed, cursor: cursor ?? encodeCursor(stateOf(st.run, st.question, Date.now())) });
}

/**
 * The run's current screenshot as an image block (`GET /runs/:id/screenshot`,
 * within the caller's image limit), or a note: never while a secret is being
 * entered on the run, and none for a run without a live browser.
 */
export async function runScreenshot(ctx: McpContext, st: RunState): Promise<{ content: McpContent[]; state: 'included' | 'unavailable' | 'hidden'; note?: string }> {
  if (st.secretOpen) return { content: [], state: 'hidden', note: 'Hidden while a code or password is being entered' };
  if (!st.run.sessionId || ['succeeded', 'failed', 'cancelled', 'queued'].includes(st.run.status)) {
    return { content: [], state: 'unavailable', note: 'No screenshot: the run has no live browser right now' };
  }
  try {
    const img = await ctx.bytes(`/runs/${st.run.id}/screenshot`);
    const data = img.data.toString('base64');
    const cap = limitsOf(ctx).maxImageBase64;
    if (cap !== null && data.length > cap) return { content: [], state: 'unavailable', note: `No screenshot: it is too large for this client (${data.length} base64 characters; the limit is ${cap})` };
    return { content: [{ type: 'image', data, mimeType: img.mime }], state: 'included' };
  } catch {
    return { content: [], state: 'unavailable', note: 'No screenshot: the browser machine did not send one (it may be offline)' };
  }
}

/** The outcome of applying a retried elicitation: what to do next. */
interface ResumeOutcome {
  /** The client declined or cancelled: report the state now, do not ask again in this call. */
  declined: boolean;
  /** Said with the next form when the answer was refused. */
  note?: string;
  since: string | null;
}

/** Record an answer the client's user gave in the form (the same service path as inbox_answer; channel `mcp-elicitation.<client>`). */
async function applyResume(ctx: McpContext, since: string | null): Promise<ResumeOutcome> {
  const resume = ctx.elicitation?.resume;
  if (!resume) return { declined: false, since };
  const r = resume.response;
  if (!r) return { declined: false, since: resume.cursor ?? since };
  if (r.action !== 'accept') return { declined: true, since: null };
  const q = await ctx.api<ProgressQuestion>('GET', `/questions/${resume.questionId}`);
  const answer = answerFromForm(q, r.content);
  if (!answer) return { declined: false, note: 'The last answer was empty: please answer again.', since: resume.cursor ?? since };
  try {
    await ctx.api('POST', `/questions/${resume.questionId}/answer`, { ...answer, channel: relayChannel(ctx, 'elicitation') });
  } catch (e) {
    if (!(e instanceof McpApiError)) throw e;
    if (e.status === 400) return { declined: false, note: `The last answer was not accepted: ${e.message}`, since: resume.cursor ?? since };
    // Answered elsewhere first, expired, or no longer allowed: report the state as it is.
  }
  return { declined: false, since: resume.cursor ?? since };
}

/** What a following tool answers: the observed run and its block, an image, or a request for input. */
export interface Followed {
  st: Observed;
  progress: RunProgress;
  images: McpContent[];
  inputRequired?: McpInputRequired;
}

/**
 * Follow a run for one call of run_wait, run_goal or task_run: apply a
 * retried elicitation, wait, build the progress block, and (2026-07-28,
 * when the client takes forms) ask the user a question it can answer in a
 * form instead of returning, once per question.
 */
export async function followRun(ctx: McpContext, runId: string, opts: { waitS: number; since: string | null; screenshot: boolean }): Promise<Followed> {
  const resumed = await applyResume(ctx, opts.since);
  const st = await waitForProgress(ctx, runId, { waitS: resumed.declined ? 0 : opts.waitS, since: resumed.since });
  const progress = progressOf(ctx, st, st.changed, st.cursor);
  const q = st.question;
  const resume = ctx.elicitation?.resume;
  const unseen = q !== null && (decodeCursor(resumed.since)?.q !== q.id || (resume !== undefined && !resume.response) || resumed.note !== undefined);
  if (ctx.elicitation?.available && q && !resumed.declined && unseen && mayElicit(q)) {
    const expires = Date.parse(q.expiresAt);
    return {
      st,
      progress,
      images: [],
      inputRequired: {
        inputRequests: { [ELICIT_KEY]: elicitationRequest(q, resumed.note) },
        state: { runId, questionId: q.id, cursor: encodeCursor(stateOf(st.run, q, Date.now())), expiresAt: Math.min(Date.now() + REQUEST_STATE_TTL_MS, Number.isNaN(expires) ? Infinity : expires) },
      },
    };
  }
  if (!opts.screenshot) return { st, progress, images: [] };
  const shot = await runScreenshot(ctx, st);
  return { st, progress: { ...progress, screenshot: shot.state, ...(shot.note ? { screenshot_note: shot.note } : {}) }, images: shot.content };
}
