// Chat-friendly runs (#463) without a database: the progress block, the
// wake-up rules of run_wait (cursor, throttle), the answerable-here table,
// the elicitation form of each question type and its sealed request state,
// the run watcher, and the run tools against a fake REST API.
import { CHANNEL_RULES, channelId, mayAnswerOn } from '../src/questions/channels/channel-rules';
import { ELICIT_FIELD, answerFromForm, argsDigest, clientCanElicitForm, elicitationRequest, elicitationSchema, mayElicit, openState, sealState } from '../src/mcp/mcp.elicitation';
import { limitsFor, type McpContext, type McpToolResult, type RunWake } from '../src/mcp/mcp.results';
import { followRun, waitForProgress } from '../src/mcp/mcp.run-follow';
import { watchRun } from '../src/mcp/mcp.run-watch';
import { MCP_TOOLS } from '../src/mcp/mcp.tools';
import {
  STEP_WAKE_MS,
  answerableHere,
  decodeCursor,
  encodeCursor,
  progressSummary,
  runProgress,
  runProgressSchema,
  stopReasonText,
  wakeVerdict,
  type ProgressQuestion,
} from '../src/mcp/run-progress';

const RID = '00000000-0000-4000-8000-000000000002';
const QID = '00000000-0000-4000-8000-000000000003';
const APP = 'https://console.example.test';

const question = (input: string, extra: Partial<ProgressQuestion> = {}): ProgressQuestion => ({ id: QID, input, prompt: 'Which size?', options: null, constraints: null, risk: null, status: 'pending', expiresAt: '2030-01-01T00:00:00.000Z', ...extra });

describe('the progress block', () => {
  const base = { id: RID, stepCount: 12, createdAt: '2026-01-01T10:00:00.000Z', startedAt: '2026-01-01T10:00:00.000Z' };
  const now = Date.parse('2026-01-01T10:01:40.000Z');

  it('a running run: the live activity line, steps, elapsed time and the console link from APP_URL', () => {
    const p = runProgress({ ...base, status: 'running', activity: { phase: 'acting', action: 'click', args: { selector: '#checkout' }, reason: 'Filling the checkout form' } }, null, { appUrl: `${APP}/`, via: 'oauth', changed: true, cursor: 'c', now });
    expect(p).toMatchObject({ run_id: RID, status: 'running', activity: 'Doing: click #checkout (Filling the checkout form)', steps_done: 12, elapsed_s: 100, needs_human: false, console_url: `${APP}/runs/${RID}` });
    expect(runProgressSchema.safeParse(p).success).toBe(true);
    expect(progressSummary(p)).toBe(`Running (1 min 40 s, 12 steps). Now: Doing: click #checkout (Filling the checkout form). Follow it: ${APP}/runs/${RID}`);
  });

  it('waiting for a person: needs_human with the typed question, and how to answer what the chat cannot', () => {
    const choice = runProgress({ ...base, status: 'waiting_human' }, question('choice', { options: [{ id: 's', label: 'Small' }] }), { appUrl: APP, via: 'oauth', changed: true, cursor: 'c', now });
    expect(choice).toMatchObject({ needs_human: true, question: { id: QID, input: 'choice', prompt: 'Which size?', options: [{ id: 's', label: 'Small' }], answerable_here: true, expires_at: '2030-01-01T00:00:00.000Z' } });
    expect(choice.question).not.toHaveProperty('how_to_answer');
    expect(progressSummary(choice)).toMatch(/^Waiting for you \(1 min 40 s, 12 steps\): Which size\? Ask the user and pass their answer on with inbox_answer/);
    const secret = runProgress({ ...base, status: 'waiting_human' }, question('secret'), { appUrl: APP, via: 'pat', changed: true, cursor: 'c', now });
    expect(secret.question).toMatchObject({ answerable_here: false, how_to_answer: `Open your Hexactra inbox to answer this: ${APP}/inbox/q/${QID}` });
    expect(progressSummary(secret)).toContain(`${APP}/inbox/q/${QID}`);
  });

  it('answerable_here follows the table: public answers always, a high-risk confirm only through a signed-in channel, never a secret or a takeover', () => {
    const table: [string, 'low' | 'high' | null, boolean, boolean][] = [
      ['text', null, true, true],
      ['choice', null, true, true],
      ['multi_choice', null, true, true],
      ['number', null, true, true],
      ['confirm', 'low', true, true],
      ['confirm', 'high', false, true],
      ['secret', null, false, false],
      ['takeover', null, false, false],
      ['none', null, false, false],
    ];
    for (const [input, risk, oauth, pat] of table) {
      expect([input, risk, answerableHere({ input, risk }, 'oauth'), answerableHere({ input, risk }, 'pat')]).toEqual([input, risk, oauth, pat]);
      // Elicited only when an OAuth app could relay it.
      expect([input, risk, mayElicit({ input, risk })]).toEqual([input, risk, oauth]);
    }
  });

  it('says why a run stopped, in words, and gives the result of a finished one', () => {
    expect(stopReasonText('budget_cost')).toBe('Stopped: it reached the cost limit of its policy');
    expect(stopReasonText('budget_actions')).toBe('Stopped: it reached the action limit of its policy');
    expect(stopReasonText('stalled')).toBe('Stopped: it was stuck and made no progress');
    expect(stopReasonText('finished')).toBeNull();
    const failed = runProgress({ ...base, status: 'failed', stopReason: 'budget_cost', finishedAt: '2026-01-01T10:00:30.000Z' }, null, { appUrl: APP, via: 'oauth', changed: true, cursor: 'c', now });
    expect(failed).toMatchObject({ stop_reason: 'Stopped: it reached the cost limit of its policy', elapsed_s: 30 });
    expect(progressSummary(failed)).toMatch(/^Failed \(30 s, 12 steps\)\. Stopped: it reached the cost limit of its policy\./);
    const done = runProgress({ ...base, status: 'succeeded', result: 'The cheapest fare is 120 EUR' }, null, { appUrl: APP, via: 'oauth', changed: true, cursor: 'c', now });
    expect(done.result).toBe('The cheapest fare is 120 EUR');
    expect(progressSummary(done)).toMatch(/^Finished .*: The cheapest fare is 120 EUR\./);
  });
});

describe('the channel rules for answers relayed by an AI app (#463)', () => {
  it('the OAuth relay and the elicitation form are not signed in: no secret, no high-risk approval; a personal access token is', () => {
    expect(channelId('mcp-elicitation.claude')).toBe('mcp-elicitation');
    for (const ch of ['mcp-oauth.chatgpt', 'mcp-elicitation.claude', 'mcp-oauth']) {
      expect(CHANNEL_RULES[channelId(ch)].signedIn).toBe(false);
      expect([ch, mayAnswerOn(ch, { input: 'secret', risk: null })]).toEqual([ch, false]);
      expect([ch, mayAnswerOn(ch, { input: 'confirm', risk: 'high' })]).toEqual([ch, false]);
      expect([ch, mayAnswerOn(ch, { input: 'confirm', risk: 'high' }, 'cancelled')]).toEqual([ch, true]);
      expect([ch, mayAnswerOn(ch, { input: 'confirm', risk: 'low' })]).toEqual([ch, true]);
      expect([ch, mayAnswerOn(ch, { input: 'choice', risk: null })]).toEqual([ch, true]);
    }
    expect(mayAnswerOn('mcp', { input: 'confirm', risk: 'high' })).toBe(true);
    expect(mayAnswerOn('web', { input: 'secret', risk: null })).toBe(true);
    expect(mayAnswerOn('some-new-channel', { input: 'secret', risk: null })).toBe(true);
  });
});

describe('when run_wait wakes', () => {
  const at = 1_000_000;
  const cur = (s: string, n: number, q: string | null = null) => ({ s, n, q, t: at });

  it('a first call reports at once only what needs no waiting: finished, or waiting for the person', () => {
    expect(wakeVerdict(null, cur('succeeded', 3), at).report).toBe(true);
    expect(wakeVerdict(null, cur('waiting_human', 3, QID), at).report).toBe(true);
    expect(wakeVerdict(null, cur('running', 3), at).report).toBe(false);
  });

  it('reports a status change and a new question, never the same one twice', () => {
    expect(wakeVerdict(cur('running', 3), cur('succeeded', 3), at).report).toBe(true);
    expect(wakeVerdict(cur('waiting_human', 3), cur('running', 3), at).report).toBe(false);
    expect(wakeVerdict(cur('queued', 0), cur('running', 0), at).report).toBe(false);
    expect(wakeVerdict(cur('running', 3), cur('running', 3, QID), at).report).toBe(true);
    expect(wakeVerdict(cur('waiting_human', 3, QID), cur('waiting_human', 3, QID), at)).toEqual({ report: false, settled: false, stepsDueAt: null });
    expect(wakeVerdict(cur('succeeded', 3), cur('succeeded', 3), at)).toEqual({ report: false, settled: true, stepsDueAt: null });
  });

  it('throttles step progress to one wake-up per 10 s', () => {
    const base = { s: 'running', n: 3, q: null, t: at };
    expect(wakeVerdict(base, cur('running', 5), at + 2_000)).toEqual({ report: false, settled: false, stepsDueAt: at + STEP_WAKE_MS });
    expect(wakeVerdict(base, cur('running', 5), at + STEP_WAKE_MS).report).toBe(true);
  });

  it('the cursor is opaque base64url and a broken one starts afresh', () => {
    const c = { s: 'running', n: 4, q: QID, t: 5 };
    expect(encodeCursor(c)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor('not a cursor')).toBeNull();
    expect(decodeCursor(Buffer.from('{"s":1}').toString('base64url'))).toBeNull();
  });
});

describe('elicitation (2026-07-28 multi round-trip)', () => {
  it('builds a one-field form schema per input type, within the specification\'s primitive schemas', () => {
    expect(elicitationSchema(question('text', { constraints: { maxLength: 20, pattern: '[A-Z]+' } }))).toEqual({
      type: 'object',
      properties: { answer: { type: 'string', title: 'Answer', minLength: 1, maxLength: 20, description: 'Must match the format [A-Z]+' } },
      required: ['answer'],
    });
    expect(elicitationSchema(question('choice', { options: [{ id: 's', label: 'Small' }, { id: 'l', label: 'Large' }] })).properties).toEqual({
      answer: { type: 'string', title: 'Answer', oneOf: [{ const: 's', title: 'Small' }, { const: 'l', title: 'Large' }] },
    });
    expect(elicitationSchema(question('multi_choice', { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], constraints: { maxSelections: 2 } })).properties).toEqual({
      answer: { type: 'array', title: 'Answer', items: { anyOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }] }, minItems: 1, maxItems: 2 },
    });
    expect(elicitationSchema(question('number', { constraints: { min: 1, max: 9, step: 1, unit: 'kg' } })).properties).toEqual({
      answer: { type: 'integer', title: 'Answer', minimum: 1, maximum: 9, description: 'A number in steps of 1, in kg' },
    });
    expect(elicitationSchema(question('confirm', { risk: 'low' })).properties).toEqual({ answer: { type: 'boolean', title: 'Approve', description: 'Yes approves, no denies' } });
    const req = elicitationRequest(question('text'));
    expect(req).toMatchObject({ method: 'elicitation/create', params: { mode: 'form', message: 'Your Hexactra agent asks: Which size?' } });
  });

  it('turns an accepted form into the answer the question takes', () => {
    expect(answerFromForm({ input: 'confirm' }, { [ELICIT_FIELD]: true })).toEqual({ outcome: 'completed', value: 'approve' });
    expect(answerFromForm({ input: 'confirm' }, { [ELICIT_FIELD]: false })).toEqual({ outcome: 'completed', value: 'deny' });
    expect(answerFromForm({ input: 'multi_choice' }, { [ELICIT_FIELD]: ['a'] })).toEqual({ outcome: 'completed', values: ['a'] });
    expect(answerFromForm({ input: 'number' }, { [ELICIT_FIELD]: 4 })).toEqual({ outcome: 'completed', value: 4 });
    expect(answerFromForm({ input: 'choice' }, {})).toBeNull();
  });

  it('reads the client capability: elicitation {} is form only, url alone is not a form', () => {
    expect(clientCanElicitForm({ elicitation: {} })).toBe(true);
    expect(clientCanElicitForm({ elicitation: { form: {} } })).toBe(true);
    expect(clientCanElicitForm({ elicitation: { url: {} } })).toBe(false);
    expect(clientCanElicitForm({})).toBe(false);
    expect(clientCanElicitForm(undefined)).toBe(false);
  });

  it('seals the request state to the caller, the call and an expiry, and refuses anything else', () => {
    const key = Buffer.alloc(32, 7);
    const args = argsDigest({ run_id: RID, wait_s: 60 });
    expect(argsDigest({ wait_s: 60, run_id: RID })).toBe(args);
    const state = { v: 1 as const, tool: 'run_wait', args, sub: 'u1', exp: Date.now() + 60_000, runId: RID, questionId: QID, cursor: null };
    const token = sealState(state, key);
    expect(openState(token, { sub: 'u1', tool: 'run_wait', args }, key)).toEqual(state);
    expect(openState(token, { sub: 'u2', tool: 'run_wait', args }, key)).toBeNull();
    expect(openState(token, { sub: 'u1', tool: 'run_goal', args }, key)).toBeNull();
    expect(openState(token, { sub: 'u1', tool: 'run_wait', args: argsDigest({ run_id: RID }) }, key)).toBeNull();
    expect(openState(token, { sub: 'u1', tool: 'run_wait', args, now: state.exp + 1 }, key)).toBeNull();
    const [body, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...state, questionId: RID })).toString('base64url');
    expect(openState(`${forged}.${mac}`, { sub: 'u1', tool: 'run_wait', args }, key)).toBeNull();
    expect(openState(`${body}.${mac}`, { sub: 'u1', tool: 'run_wait', args }, Buffer.alloc(32, 8))).toBeNull();
  });
});

describe('the run watcher', () => {
  type H = (e: { runId: string | null; kind: 'status' | 'step' | 'question' }) => void;
  function source() {
    const handlers = new Set<H>();
    return { subscribe: (h: H) => (handlers.add(h), () => void handlers.delete(h)), emit: (e: Parameters<H>[0]) => handlers.forEach((h) => h(e)), get size() { return handlers.size; } };
  }

  it('wakes on its own run only, keeps an event that came between two waits, ignores steps when asked, and unsubscribes', async () => {
    const s = source();
    const w = watchRun(RID, [s.subscribe]);
    expect(s.size).toBe(1);
    s.emit({ runId: 'other', kind: 'status' });
    s.emit({ runId: RID, kind: 'step' });
    s.emit({ runId: RID, kind: 'status' });
    await expect(w.next(1000)).resolves.toBe('status');
    const p = w.next(1000, { ignoreSteps: true });
    s.emit({ runId: RID, kind: 'step' });
    s.emit({ runId: RID, kind: 'question' });
    await expect(p).resolves.toBe('question');
    await expect(w.next(5)).resolves.toBe('timeout');
    w.close();
    expect(s.size).toBe(0);
  });

  it('a client that goes away ends the wait', async () => {
    const s = source();
    const ac = new AbortController();
    const w = watchRun(RID, [s.subscribe], ac.signal);
    const p = w.next(60_000);
    ac.abort();
    await expect(p).resolves.toBe('aborted');
    w.close();
  });
});

/** A fake console: one run and its questions, changed by the test; every REST read counted. */
function fakeConsole(kind: 'pat' | 'oauth' = 'pat') {
  const state = {
    run: { id: RID, status: 'running', stepCount: 1, createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), sessionId: 'sess-1', handoffId: null as string | null, steps: [{ seq: 1, summary: 'Opened the shop' }] } as Record<string, unknown>,
    questions: [] as Record<string, unknown>[],
    reads: 0,
    answers: [] as unknown[],
  };
  const handlers = new Set<(w: RunWake) => void>();
  let pending: RunWake | null = null;
  const ctx: McpContext = {
    async api<T>(method: string, path: string, body?: unknown): Promise<T> {
      if (method === 'GET' && path === `/runs/${RID}`) {
        state.reads += 1;
        return structuredClone(state.run) as T;
      }
      if (method === 'GET' && path.startsWith('/questions?')) return state.questions.filter((q) => q.status === 'pending') as T;
      if (method === 'GET' && path === `/questions/${QID}`) return state.questions[0] as T;
      if (method === 'POST' && path === `/questions/${QID}/answer`) {
        state.answers.push(body);
        state.questions[0] = { ...state.questions[0], status: 'answered' };
        return state.questions[0] as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    bytes: async () => ({ mime: 'image/jpeg', data: Buffer.alloc(300) }),
    credential: { kind },
    limits: limitsFor(kind),
    appUrl: APP,
    watchRun: () => ({
      next: (ms: number) =>
        new Promise<RunWake>((resolve) => {
          if (pending) {
            const p = pending;
            pending = null;
            return resolve(p);
          }
          const t = setTimeout(() => (handlers.delete(done), resolve('timeout')), ms);
          const done = (w: RunWake) => (clearTimeout(t), handlers.delete(done), resolve(w));
          handlers.add(done);
        }),
      close: () => handlers.clear(),
    }),
  };
  const publish = (w: RunWake) => {
    if (handlers.size) handlers.forEach((h) => h(w));
    else pending = w;
  };
  return { state, ctx, publish };
}

const tool = (n: string) => MCP_TOOLS.find((t) => t.name === n)!;
async function callTool(name: string, args: Record<string, unknown>, ctx: McpContext): Promise<McpToolResult> {
  const t = tool(name);
  return t.call(t.input.parse(args) as Record<string, unknown>, ctx);
}

describe('run_wait against a fake console', () => {
  afterEach(() => jest.useRealTimers());

  it('returns at once for a run that already finished', async () => {
    const f = fakeConsole();
    f.state.run = { ...f.state.run, status: 'succeeded', result: 'Done: 3 items', finishedAt: new Date().toISOString() };
    const r = await callTool('run_wait', { run_id: RID, wait_s: 60 }, f.ctx);
    expect(r.structuredContent).toMatchObject({ status: 'succeeded', changed: true, result: 'Done: 3 items' });
    expect(r.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/^Finished /) });
  });

  it('returns on a status event, reads the run only when woken, and honours since', async () => {
    jest.useFakeTimers();
    const f = fakeConsole();
    const p = callTool('run_wait', { run_id: RID, wait_s: 60 }, f.ctx);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(f.state.reads).toBe(1);
    f.state.run = { ...f.state.run, status: 'succeeded', result: 'ok' };
    f.publish('status');
    const r = (await p).structuredContent as { changed: boolean; cursor: string; status: string };
    expect(r).toMatchObject({ changed: true, status: 'succeeded' });
    expect(f.state.reads).toBe(2);
    // The same change is not reported twice: a finished run answers changed: false at once.
    const again = (await callTool('run_wait', { run_id: RID, wait_s: 60, since: r.cursor }, f.ctx)).structuredContent;
    expect(again).toMatchObject({ changed: false, status: 'succeeded' });
  });

  it('answers changed: false when wait_s passes quietly, and throttles step progress to one wake-up per 10 s', async () => {
    jest.useFakeTimers();
    const f = fakeConsole();
    const quiet = callTool('run_wait', { run_id: RID, wait_s: 3 }, f.ctx);
    await jest.advanceTimersByTimeAsync(3_000);
    const q = (await quiet).structuredContent as { changed: boolean; cursor: string };
    expect(q.changed).toBe(false);

    const stepping = callTool('run_wait', { run_id: RID, wait_s: 60, since: q.cursor }, f.ctx);
    let settled = false;
    void stepping.then(() => (settled = true));
    for (let i = 0; i < 8; i += 1) {
      await jest.advanceTimersByTimeAsync(500);
      f.state.run = { ...f.state.run, stepCount: Number(f.state.run.stepCount) + 1 };
      f.publish('step');
    }
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(STEP_WAKE_MS);
    expect((await stepping).structuredContent).toMatchObject({ changed: true, status: 'running', steps_done: 9 });
  });

  it('without a subscription it reads once and answers changed: false', async () => {
    const f = fakeConsole();
    const { watchRun: _w, ...ctx } = f.ctx;
    const r = await waitForProgress(ctx, RID, { waitS: 60, since: null });
    expect(r.changed).toBe(false);
    expect(f.state.reads).toBe(1);
  });

  it('screenshot: true adds the image, hides it while a secret is entered, and degrades to a note', async () => {
    const f = fakeConsole();
    const shot = await callTool('run_wait', { run_id: RID, wait_s: 0, screenshot: true }, f.ctx);
    expect(shot.content.map((c) => c.type)).toEqual(['text', 'image']);
    expect(shot.structuredContent).toMatchObject({ screenshot: 'included' });

    f.state.questions = [{ ...question('secret'), runId: RID }];
    const hidden = await callTool('run_status', { run_id: RID, screenshot: true }, f.ctx);
    expect(hidden.content.map((c) => c.type)).toEqual(['text']);
    expect((hidden.structuredContent as { progress: unknown }).progress).toMatchObject({ screenshot: 'hidden', screenshot_note: 'Hidden while a code or password is being entered' });

    f.state.questions = [];
    const broken = fakeConsole();
    broken.ctx.bytes = async () => {
      throw new Error('offline');
    };
    const none = await callTool('run_wait', { run_id: RID, wait_s: 0, screenshot: true }, broken.ctx);
    expect(none.structuredContent).toMatchObject({ screenshot: 'unavailable', screenshot_note: expect.stringMatching(/^No screenshot/) });

    const oauth = fakeConsole('oauth');
    oauth.ctx.bytes = async () => ({ mime: 'image/jpeg', data: Buffer.alloc(2 * 1024 * 1024) });
    const big = await callTool('run_wait', { run_id: RID, wait_s: 0, screenshot: true }, oauth.ctx);
    expect(big.content.map((c) => c.type)).toEqual(['text']);
    expect(big.structuredContent).toMatchObject({ screenshot: 'unavailable', screenshot_note: expect.stringMatching(/too large/) });
  });

  it('asks the question through the client when it can, and records an accepted answer on the elicitation channel', async () => {
    const f = fakeConsole('oauth');
    f.ctx.client = 'claude';
    f.state.run = { ...f.state.run, status: 'waiting_human' };
    f.state.questions = [{ ...question('choice', { options: [{ id: 's', label: 'Small' }] }), runId: RID }];
    f.ctx.elicitation = { available: true };
    const asked = await followRun(f.ctx, RID, { waitS: 0, since: null, screenshot: false });
    expect(asked.inputRequired?.inputRequests.hexactra_question).toMatchObject({ method: 'elicitation/create', params: { mode: 'form' } });
    expect(asked.inputRequired?.state).toMatchObject({ runId: RID, questionId: QID });

    f.ctx.elicitation = { available: true, resume: { runId: RID, questionId: QID, cursor: asked.inputRequired!.state.cursor, response: { action: 'accept', content: { answer: 's' } } } };
    const after = await followRun(f.ctx, RID, { waitS: 0, since: null, screenshot: false });
    expect(f.state.answers).toEqual([{ outcome: 'completed', value: 's', channel: 'mcp-elicitation.claude' }]);
    expect(after.inputRequired).toBeUndefined();

    // decline: the question stays pending and the block says so, without asking again.
    f.state.questions = [{ ...question('choice', { options: [{ id: 's', label: 'Small' }] }), runId: RID }];
    f.ctx.elicitation = { available: true, resume: { runId: RID, questionId: QID, cursor: null, response: { action: 'decline' } } };
    const declined = await followRun(f.ctx, RID, { waitS: 60, since: null, screenshot: false });
    expect(declined.inputRequired).toBeUndefined();
    expect(declined.progress).toMatchObject({ needs_human: true, question: { id: QID, answerable_here: true } });
  });

  it('never elicits a secret, a takeover or a high-risk confirm', async () => {
    for (const q of [question('secret'), question('takeover'), question('confirm', { risk: 'high' })]) {
      const f = fakeConsole('oauth');
      f.state.run = { ...f.state.run, status: 'waiting_human' };
      f.state.questions = [{ ...q, runId: RID }];
      f.ctx.elicitation = { available: true };
      const r = await followRun(f.ctx, RID, { waitS: 0, since: null, screenshot: false });
      expect([q.input, r.inputRequired]).toEqual([q.input, undefined]);
      expect(r.progress.question).toMatchObject({ answerable_here: false, how_to_answer: expect.stringContaining('/inbox/q/') });
    }
  });
});
