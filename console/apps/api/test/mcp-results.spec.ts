// Tool contract quality (#462) without a database: result finalisation
// (structured content, summaries, the untrusted notice), the size and time
// limits, the error table, paging of the large tools, and screenshots.
import { McpDispatcher, toolListEntry } from '../src/mcp/mcp.dispatcher';
import { MCP_SCOPE_IDS } from '../src/mcp/mcp.scopes';
import { McpApiError, mapApiError, mapUnknownError } from '../src/mcp/mcp.errors';
import { MCP_VERSIONS, type McpRequestContext } from '../src/mcp/mcp.protocol';
import {
  MAX_IMAGE_BASE64_OAUTH,
  MAX_RESULT_CHARS,
  MAX_RESULT_CHARS_OAUTH,
  UNTRUSTED_NOTICE,
  finalizeResult,
  fit,
  limitsFor,
  toolOutput,
  truncateText,
  withDeadline,
  type McpContext,
  type McpToolResult,
} from '../src/mcp/mcp.results';
import { MCP_TOOLS, type McpTool } from '../src/mcp/mcp.tools';

const tool = (n: string): McpTool => MCP_TOOLS.find((t) => t.name === n)!;
const SID = '00000000-0000-4000-8000-000000000001';
const RID = '00000000-0000-4000-8000-000000000002';
const oauth = limitsFor('oauth');
const pat = limitsFor('pat');

function textOf(r: McpToolResult): string {
  return r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

/** A context whose REST calls answer from `answer` (path → body). */
function ctxOf(answer: (method: string, path: string, body?: unknown) => unknown, kind: 'pat' | 'oauth' = 'pat', bytes?: McpContext['bytes']): McpContext {
  return {
    api: (async (method: string, path: string, body?: unknown) => answer(method, path, body)) as McpContext['api'],
    bytes: bytes ?? (async () => ({ mime: 'image/png', data: Buffer.from('x') })),
    credential: { kind },
    limits: limitsFor(kind),
  };
}

async function callTool(name: string, args: Record<string, unknown>, ctx: McpContext): Promise<McpToolResult> {
  const t = tool(name);
  return t.call(t.input.parse(args) as Record<string, unknown>, ctx);
}

describe('limits by credential kind', () => {
  it('keeps today\'s limits for PATs and sessions and tightens them for OAuth only', () => {
    for (const k of ['pat', 'jwt', 'node', undefined] as const) expect(limitsFor(k)).toEqual({ maxResultChars: 150_000, maxWaitS: 300, deadlineMs: null, maxImageBase64: null, defaultRunsLimit: null });
    expect(oauth).toEqual({ maxResultChars: 100_000, maxWaitS: 200, deadlineMs: 220_000, maxImageBase64: 1024 * 1024, defaultRunsLimit: 20 });
  });
});

describe('finalizeResult', () => {
  const out = toolOutput({ text: [{ id: 'a' }], structured: { items: [{ id: 'a' }] }, summary: '1 thing.' });

  it('older revisions get the JSON text only; newer ones the summary line, the JSON and structuredContent', () => {
    const legacy = finalizeResult(out, { structured: false, limits: pat });
    expect(legacy).toEqual({ content: [{ type: 'text', text: JSON.stringify([{ id: 'a' }], null, 2) }] });
    const modern = finalizeResult(out, { structured: true, limits: pat });
    expect(modern.structuredContent).toEqual({ items: [{ id: 'a' }] });
    const [first, ...rest] = (modern.content[0] as { text: string }).text.split('\n');
    expect(first).toBe('1 thing.');
    expect(JSON.parse(rest.join('\n'))).toEqual([{ id: 'a' }]);
    expect(modern).not.toHaveProperty('summary');
  });

  it('leads with the untrusted notice and flags structured content', () => {
    const r = finalizeResult(toolOutput({ text: 'Buy now!', structured: { text: 'Buy now!' }, summary: 's', untrusted: true }), { structured: true, limits: pat });
    expect((r.content[0] as { text: string }).text.split('\n')[0]).toBe(UNTRUSTED_NOTICE);
    expect(r.structuredContent).toEqual({ text: 'Buy now!', untrusted: true });
    const legacy = finalizeResult(toolOutput({ text: 'Buy now!', untrusted: true }), { structured: false, limits: pat });
    expect((legacy.content[0] as { text: string }).text).toBe(`${UNTRUSTED_NOTICE}\nBuy now!`);
    expect(legacy).not.toHaveProperty('untrusted');
  });
});

describe('fit (size limits)', () => {
  it('cuts text at a line boundary and says how to get the rest', () => {
    const text = Array.from({ length: 50_000 }, (_, i) => `line ${i}`).join('\n');
    const cut = truncateText(text, 10_000);
    expect(cut.length).toBeLessThanOrEqual(10_000);
    expect(cut).toMatch(/\n\[Truncated: \d+ more characters\. Ask for less/);
    expect(cut.split('\n[Truncated')[0].endsWith('\n')).toBe(false);
    expect(cut.split('\n[Truncated')[0]).toMatch(/line \d+$/);
  });

  it('trims the largest list of structured content to the limit', () => {
    const items = Array.from({ length: 5000 }, (_, i) => ({ id: i, name: 'x'.repeat(100) }));
    const r = fit({ content: [{ type: 'text', text: JSON.stringify(items) }], structuredContent: { items, nextCursor: null } }, { maxResultChars: 100_000 });
    expect(JSON.stringify(r.structuredContent).length).toBeLessThanOrEqual(100_000);
    expect(r.structuredContent).toMatchObject({ truncated: true, nextCursor: null });
    expect((r.structuredContent as { omitted: number }).omitted).toBeGreaterThan(0);
    expect(textOf(r).length).toBeLessThanOrEqual(100_000);
  });
});

describe('every tool stays within the limits with the largest plausible answer', () => {
  const big = 'y'.repeat(2_000);
  const run = (i: number) => ({ id: RID, status: 'succeeded', stepCount: 50, costUsd: 1, costKnown: true, result: big, error: null, goal: big, transcript: [{ role: 'user', content: big }], policySnapshot: { big } , n: i });
  const step = (seq: number) => ({ id: RID, runId: RID, seq, kind: 'action', action: 'click', args: { s: big }, ok: true, summary: big, reasoning: big, screenshotKey: null, durationMs: 1, createdAt: 'now' });
  /** The biggest thing each REST route could answer. */
  function huge(method: string, path: string): unknown {
    // The learned procedures (E46.22): 200 procedures, each with 500 steps, 50 parameters and 50 outputs with long labels.
    if (method === 'GET' && path.startsWith('/kgraph/procedures/')) {
      const steps = Array.from({ length: 500 }, (_, i) => ({ id: `s${i}`, kind: 'call', label: big, tool: 'click', target: big, usesAi: false, commitClass: false, health: 'healthy' }));
      return { id: 'kgp-1', taskId: RID, taskName: big, name: big, state: 'active', health: 'healthy', activeVersion: { steps, parameters: Array.from({ length: 50 }, (_, i) => ({ name: `${i}${big}`, type: 'string', sensitive: false, required: true })), outputs: Array.from({ length: 50 }, () => ({ name: big, sensitive: false })) } };
    }
    if (method === 'GET' && path.startsWith('/kgraph/procedures')) return { enabled: true, procedures: Array.from({ length: 200 }, (_, i) => ({ id: `kgp-${i}` })) };
    if (method === 'GET' && path.startsWith('/tasks/') && path.endsWith('/kgraph')) return { taskId: RID, mode: 'reuse', available: true };
    if (path.startsWith('/browser/sessions/') && path.endsWith('/actions')) {
      return {
        state: 'succeeded',
        result: {
          text: 'z'.repeat(200_000),
          truncated: true,
          elements: Array.from({ length: 1000 }, (_, i) => ({ selector: `#el-${i}-${'s'.repeat(200)}`, tag: 'a', text: 't'.repeat(100), href: `https://example.test/${'p'.repeat(300)}` })),
          tabs: Array.from({ length: 500 }, (_, i) => ({ id: i, url: `https://example.test/${'u'.repeat(500)}`, title: 'T'.repeat(500) })),
          value: 'v'.repeat(500_000),
        },
      };
    }
    // The trace file (#542): the run and 2,000 steps with big summaries, arguments and reasoning.
    if (path.startsWith('/runs/') && path.includes('/export')) return { type: 'hexactra.run-trace', formatVersion: 1, partial: false, masking: { applied: true, patternsVersion: 1, hits: {} }, run: { id: RID, status: 'failed', goal: big, result: big, error: big }, policy: null, budget: null, models: [], steps: Array.from({ length: 2000 }, (_, i) => ({ ...step(i), question: { prompt: big }, screenshot: null })), chat: Array.from({ length: 200 }, (_, i) => ({ seq: i, role: 'user', kind: 'text', text: big, at: 'now' })) };
    if (path.startsWith('/runs/') && method === 'GET') return { ...run(0), steps: Array.from({ length: 2000 }, (_, i) => step(i)) };
    if (path.startsWith('/runs')) return method === 'GET' ? (path.includes('envelope') ? { items: Array.from({ length: 100 }, (_, i) => run(i)), nextCursor: 'c' } : Array.from({ length: 500 }, (_, i) => run(i))) : run(0);
    if (path.startsWith('/questions')) return { id: RID, input: 'text', prompt: big, status: 'answered', expiresAt: 'now', response: { outcome: 'completed', value: 'v'.repeat(4096) } };
    if (method === 'GET' && path === '/agent-policies') return Array.from({ length: 500 }, (_, i) => ({ id: `p${i}`, name: big, description: big, builtin: false, isDefault: false, hasNoHardStop: false, version: 1, spec: { models: { startTier: 'fast', maxTier: 'frontier' }, budget: {} }, usage: {} }));
    if (path.startsWith('/agent-policies/import')) return { created: Array.from({ length: 100 }, (_, i) => ({ index: i, id: 'x', name: big })), replaced: [], skipped: [], warnings: [], errors: [] };
    if (method === 'GET' && path.startsWith('/tasks?')) return { items: Array.from({ length: 100 }, (_, i) => ({ id: RID, name: big, goal: big, summary: { scheduleState: 'active', schedules: [{ enabled: true, description: big }], nextRunAt: null, lastRun: null, liveRunId: null } })), nextCursor: 'c', total: 2000 };
    if (method === 'GET' && ['/tasks', '/schedules', '/inbox', '/fleet/hosts'].includes(path)) return Array.from({ length: 2000 }, (_, i) => ({ id: i, name: big, goal: big }));
    return { id: RID, name: big, goal: big, spec: { x: 'q'.repeat(400_000) }, valid: true, description: big, policyId: 'p', status: 'pending', created: [], replaced: [], skipped: [] };
  }
  const ARGS: Record<string, Record<string, unknown>> = {
    run_goal: { goal: 'g' }, run_status: { run_id: RID, steps: 50 }, run_wait: { run_id: RID, screenshot: true }, run_card_poll: { run_id: RID, screenshot: true }, runs_list: {}, run_cancel: { run_id: RID }, run_pause: { run_id: RID }, run_resume: { run_id: RID }, run_export: { run_id: RID }, tasks_list: {}, task_create: { name: 'n', goal: 'g' }, task_update: { task_id: RID }, task_run: { task_id: RID },
    schedule_create: { task_id: RID, cron: '0 9 * * 1-5' }, schedule_preview: { cron: '0 9 * * 1-5' }, task_pause: { task_id: RID }, task_resume: { task_id: RID }, schedules_list: {}, inbox_list: {},
    inbox_answer: { question_id: RID, outcome: 'completed', value: 'x' }, question_card_answer: { question_id: RID, outcome: 'completed', value: 'x' }, ask_human: { prompt: 'p', input: 'text' }, question_status: { question_id: RID }, policies_list: {}, policy_get: { policy_id: 'builtin:balanced' },
    policy_create: { name: 'n', spec: {} }, policy_update: { policy_id: 'builtin:balanced' }, policy_set_default: { policy_id: null }, policies_export: {}, policies_import: { file: {} }, hosts_list: {}, browser_open: { goal: 'g' },
    procedures_list: { limit: 50 }, procedure_get: { procedure_id: 'kgp-1' }, procedure_run: { procedure_id: 'kgp-1', inputs: { Customer: 'ACME' } },
    browser_request_human: { session_id: SID, kind: 'other', prompt: 'p' }, browser_handoff_status: { session_id: SID, handoff_id: RID }, browser_close: { session_id: SID },
  };
  const args = (t: McpTool): Record<string, unknown> => {
    if (ARGS[t.name]) return ARGS[t.name];
    // A browser action: the smallest valid arguments.
    const shape = t.input.shape as Record<string, { safeParse(v: unknown): { success: boolean } }>;
    const a: Record<string, unknown> = { session_id: SID };
    for (const [k, s] of Object.entries(shape)) {
      if (k === 'session_id' || s.safeParse(undefined).success) continue;
      a[k] = ['x', 'y', 'from_x', 'from_y', 'to_x', 'to_y', 'dy'].includes(k) ? 1 : k === 'handoff_id' ? RID : 'x';
    }
    return a;
  };

  it.each(MCP_TOOLS.map((t) => [t.name]))('%s', async (name) => {
    const t = tool(name);
    // Bypass the policy spec schema for policy_create (it is the console's own validation, not the size).
    const parsed = name === 'policy_create' ? { name: 'n', spec: {} } : (t.input.parse(args(t)) as Record<string, unknown>);
    for (const [kind, limits] of [['pat', pat], ['oauth', oauth]] as const) {
      const ctx = ctxOf(huge, kind, async () => ({ mime: 'image/png', data: Buffer.alloc(100_000) }));
      const raw = await t.call(parsed, ctx);
      const r = finalizeResult(raw, { structured: true, limits });
      expect([name, kind, textOf(r).length <= limits.maxResultChars]).toEqual([name, kind, true]);
      if (r.structuredContent) expect([name, kind, JSON.stringify(r.structuredContent).length <= limits.maxResultChars]).toEqual([name, kind, true]);
      expect(JSON.stringify(r)).not.toMatch(/transcript|policySnapshot|Internal Server Error/);
    }
  });
});

describe('paging of the large tools', () => {
  const page = 'abcdefghij'.repeat(5_000); // 50,000 characters
  const act = (result: Record<string, unknown>) => (method: string, path: string, body?: unknown) => {
    if (path.endsWith('/actions')) return { state: 'succeeded', result, body };
    throw new Error(`unexpected ${method} ${path}`);
  };

  it('browser_text reads one page from an offset, says whether there is more, and marks it untrusted', async () => {
    const sent: unknown[] = [];
    const ctx = ctxOf((m, p, b) => {
      sent.push(b);
      const max = (b as { action: { max_chars: number } }).action.max_chars;
      return act({ text: page.slice(0, max), truncated: page.length > max, url: 'https://example.test/', title: 'Shop' })(m, p);
    });
    const first = await callTool('browser_text', { session_id: SID }, ctx);
    expect(sent[0]).toEqual({ action: { type: 'text', max_chars: 20_000 } });
    expect(first.structuredContent).toMatchObject({ offset: 0, total_chars: null, has_more: true, untrusted: true, title: 'Shop' });
    expect((first.structuredContent as { text: string }).text).toHaveLength(20_000);
    expect(textOf(first)).toMatch(/call browser_text with offset=20000/);
    const last = await callTool('browser_text', { session_id: SID, offset: 40_000, max_chars: 20_000 }, ctx);
    expect(sent[1]).toEqual({ action: { type: 'text', max_chars: 60_000 } });
    expect(last.structuredContent).toMatchObject({ offset: 40_000, total_chars: 50_000, has_more: false });
    expect((last.structuredContent as { text: string }).text).toBe(page.slice(40_000));
    expect(finalizeResult(last, { structured: false, limits: pat }).content[0]).toMatchObject({ text: expect.stringMatching(new RegExp(`^${UNTRUSTED_NOTICE.replace(/[()]/g, '\\$&')}`)) });
  });

  it('browser_elements returns limit elements from offset', async () => {
    const elements = Array.from({ length: 450 }, (_, i) => ({ selector: `#e${i}`, tag: 'a', text: `E${i}` }));
    const sent: unknown[] = [];
    const ctx = ctxOf((m, p, b) => {
      sent.push(b);
      return act({ elements: elements.slice(0, (b as { action: { max_elements: number } }).action.max_elements), url: 'u', title: 't' })(m, p);
    });
    const r = await callTool('browser_elements', { session_id: SID }, ctx);
    expect(sent[0]).toEqual({ action: { type: 'elements', max_elements: 200 } });
    expect(r.structuredContent).toMatchObject({ offset: 0, returned: 200, has_more: true, untrusted: true });
    const next = await callTool('browser_elements', { session_id: SID, offset: 400, limit: 100 }, ctx);
    expect(next.structuredContent).toMatchObject({ offset: 400, returned: 50, has_more: false });
    expect((next.structuredContent as { elements: { selector: string }[] }).elements[0].selector).toBe('#e400');
  });

  it('run_status returns the last 20 steps by default, pages back with steps_before, and never the transcript', async () => {
    const steps = Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, summary: `s${i + 1}` }));
    const ctx = ctxOf(() => ({ id: RID, status: 'running', stepCount: 30, result: null, error: null, transcript: { log: [] }, policySnapshot: {}, steps }));
    const r = await callTool('run_status', { run_id: RID }, ctx);
    const v = r.structuredContent as { steps: { seq: number }[]; olderSteps: number };
    expect(v.steps.map((s) => s.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 11));
    expect(v.olderSteps).toBe(10);
    expect(v).not.toHaveProperty('transcript');
    expect(v).not.toHaveProperty('policySnapshot');
    const back = (await callTool('run_status', { run_id: RID, steps: 5, steps_before: 11 }, ctx)).structuredContent as { steps: { seq: number }[]; olderSteps: number };
    expect(back.steps.map((s) => s.seq)).toEqual([6, 7, 8, 9, 10]);
    expect(back.olderSteps).toBe(5);
    // Steps carry the agent's notes about the page: untrusted.
    expect(r.untrusted).toBe(true);
  });

  it('runs_list keeps its plain list for PATs and pages by 20 for OAuth callers', async () => {
    const paths: string[] = [];
    const answer = (_m: string, p: string) => {
      paths.push(p);
      return p.includes('envelope=1') ? { items: [{ id: RID, result: null }], nextCursor: 'next' } : [{ id: RID, result: null }];
    };
    const patR = await callTool('runs_list', {}, ctxOf(answer, 'pat'));
    expect(paths[0]).toBe('/runs');
    expect(JSON.parse(textOf(patR))).toEqual([{ id: RID, result: null }]);
    expect(patR.structuredContent).toEqual({ items: [{ id: RID, result: null }], nextCursor: null });
    const oauthR = await callTool('runs_list', {}, ctxOf(answer, 'oauth'));
    expect(paths[1]).toBe('/runs?envelope=1&limit=20');
    expect(oauthR.structuredContent).toEqual({ items: [{ id: RID, result: null }], nextCursor: 'next' });
  });
});

describe('screenshots', () => {
  const marks = [{ n: 1, selector: '#buy', x: 10, y: 20, w: 30, h: 40, text: 'Buy' }];
  const shot = (data: Buffer, kind: 'pat' | 'oauth') =>
    ctxOf(() => ({ state: 'succeeded', result: { url_path: '/api/browser/sessions/s/artifacts/a', marks } }), kind, async () => ({ mime: 'image/jpeg', data }));

  it('returns the image as captured with its marks (scale 1) within the limits for an OAuth caller', async () => {
    // A fixture JPEG-sized payload of 600 KiB: 800 KiB of base64, under the 1 MiB cap.
    const r = await callTool('browser_screenshot', { session_id: SID }, shot(Buffer.alloc(600 * 1024, 1), 'oauth'));
    expect(r.isError).toBeFalsy();
    expect(r.content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
    expect((r.content[0] as { data: string }).data.length).toBeLessThanOrEqual(MAX_IMAGE_BASE64_OAUTH);
    const t = (r.content[1] as { text: string }).text;
    expect(t.startsWith(UNTRUSTED_NOTICE)).toBe(true);
    expect(JSON.parse(t.slice(t.indexOf('['))).at(0)).toEqual(marks[0]);
    expect(t).toMatch(/scale 1/);
  });

  it('refuses a screenshot over 1 MiB of base64 for OAuth callers with guidance, and sends it to a PAT caller', async () => {
    const data = Buffer.alloc(900 * 1024, 1);
    const r = await callTool('browser_screenshot', { session_id: SID }, shot(data, 'oauth'));
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/screenshot too large/);
    expect(r.structuredContent).toMatchObject({ code: 'SCREENSHOT_TOO_LARGE' });
    expect((await callTool('browser_screenshot', { session_id: SID }, shot(data, 'pat'))).content[0]).toMatchObject({ type: 'image' });
  });
});

describe('the error table', () => {
  const run = (e: McpApiError, t = 'run_status') => mapApiError(e, t);

  it('400/422 validation: "Invalid arguments: <field>: <message>"', () => {
    const r = run(new McpApiError(400, 'VALIDATION_ERROR', 'Validation failed', { issues: [{ path: ['allowedDomains', 0], message: 'Invalid' }] }, 'req-1'));
    expect(textOf(r)).toBe('Invalid arguments: allowed_domains.0: Invalid (request req-1)');
    expect(r).toMatchObject({ isError: true, structuredContent: { code: 'VALIDATION_ERROR', status: 400, requestId: 'req-1' } });
    expect(textOf(run(new McpApiError(422, 'UNPROCESSABLE_ENTITY', 'Choose between 1 and 2 options')))).toBe('Invalid arguments: Choose between 1 and 2 options');
    expect(textOf(run(new McpApiError(400, 'CRON_TOO_FREQUENT', 'A schedule may run at most every 5 minutes')))).toMatch(/^Invalid arguments: .*\(CRON_TOO_FREQUENT\)$/);
  });

  it('403: the account is not allowed', () => {
    const r = run(new McpApiError(403, 'FORBIDDEN', 'Insufficient permissions'), 'task_create');
    expect(textOf(r)).toBe('Your Hexactra account is not allowed to do this.');
    expect(r.structuredContent).toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });

  it('404: names the thing and the tool that lists it', () => {
    expect(textOf(run(new McpApiError(404, 'RUN_NOT_FOUND', 'Run not found')))).toBe('No run with that id. Use runs_list to find it.');
    expect(textOf(run(new McpApiError(404, 'NOT_FOUND', 'Task not found'), 'task_update'))).toBe('No task with that id. Use tasks_list to find it.');
    expect(textOf(run(new McpApiError(404, 'NOT_FOUND', 'x'), 'policy_get'))).toBe('No agent policy with that id. Use policies_list to find it.');
  });

  it('409/412 with a code: the route\'s message and the next step', () => {
    expect(textOf(run(new McpApiError(409, 'NO_SCHEDULES', 'The task has no schedules'), 'task_pause'))).toBe('The task has no schedules. (NO_SCHEDULES) The task has no schedule: add one with schedule_create.');
    expect(textOf(run(new McpApiError(409, 'RUN_LIVE', 'The run is still live')))).toMatch(/run_cancel/);
    expect(textOf(run(new McpApiError(412, 'POLICY_VERSION_CONFLICT', 'The policy changed'), 'policy_update'))).toMatch(/POLICY_VERSION_CONFLICT.*policy_get/);
    expect(textOf(run(new McpApiError(409, 'TAKEOVER_ACTIVE', 'A person is controlling this browser'), 'browser_click'))).toMatch(/person is controlling/);
  });

  it('429: wait N seconds', () => {
    expect(textOf(run(new McpApiError(429, 'TOO_MANY_REQUESTS', 'Too Many Requests', undefined, undefined, 12)))).toBe('Too many requests. Wait 12 seconds.');
    expect(textOf(run(new McpApiError(429, 'TOO_MANY_REQUESTS', 'x', { retryAfterMs: 2500 })))).toBe('Too many requests. Wait 3 seconds.');
  });

  it('5xx, an unreachable fabric or no browser: could not reach a browser machine, never "Internal Server Error"', () => {
    const five = run(new McpApiError(500, 'INTERNAL_ERROR', 'Internal Server Error', undefined, 'req-9'));
    expect(textOf(five)).toBe('Hexactra could not reach a browser machine: the server could not complete the request. The user can check Machines in the console. (request req-9)');
    expect(textOf(run(new McpApiError(502, 'FABRIC_UNREACHABLE', 'The fabric did not answer')))).toMatch(/^Hexactra could not reach a browser machine: The fabric did not answer\./);
    expect(textOf(run(new McpApiError(409, 'NO_BROWSER', 'No host is online')))).toMatch(/could not reach a browser machine: No host is online/);
    for (const r of [five, mapUnknownError(new Error('Internal Server Error'), 'run_goal'), mapUnknownError(new Error('boom\n    at x (y.ts:1)'), 'run_goal')]) {
      expect(textOf(r)).not.toMatch(/Internal Server Error|    at /);
    }
  });
});

describe('time limits', () => {
  afterEach(() => jest.useRealTimers());

  it('withDeadline answers the timeout result and leaves no timer behind', async () => {
    jest.useFakeTimers();
    const p = withDeadline(new Promise<string>(() => undefined), 220_000, () => 'late');
    await jest.advanceTimersByTimeAsync(220_000);
    await expect(p).resolves.toBe('late');
    await expect(withDeadline(Promise.resolve('now'), 220_000, () => 'late')).resolves.toBe('now');
    expect(jest.getTimerCount()).toBe(0);
    await expect(withDeadline(Promise.resolve('x'), null, () => 'late')).resolves.toBe('x');
  });

  function dispatcher(inject: () => Promise<unknown>) {
    return new McpDispatcher({ httpAdapter: { getInstance: () => ({ inject }) } } as never);
  }
  // An OAuth token here holds every scope: the scope gate (#460) is tested in mcp-access.spec.ts.
  const rctx = (kind: string): McpRequestContext => ({ version: '2025-06-18', flags: MCP_VERSIONS['2025-06-18'], credential: { kind, ...(kind === 'oauth' ? { scopes: [...MCP_SCOPE_IDS] } : {}) } as never });
  const call = (name: string, args: Record<string, unknown>) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

  it('an OAuth call returns before 220 s with a "still working" result; a PAT call keeps waiting', async () => {
    jest.useFakeTimers();
    const d = dispatcher(() => new Promise(() => undefined));
    const out = d.dispatch(call('question_status', { question_id: RID, wait_s: 300 }), rctx('oauth'), 'Bearer x');
    await jest.advanceTimersByTimeAsync(220_000);
    const r = (await out)!.body.result as McpToolResult;
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/still working after 220 seconds.*question_status/);

    let settled = false;
    void d.dispatch(call('question_status', { question_id: RID }), rctx('pat'), 'Bearer x').then(() => (settled = true));
    await jest.advanceTimersByTimeAsync(400_000);
    expect(settled).toBe(false);
  });

  it('an OAuth caller waits at most 200 s for an answer', async () => {
    jest.useFakeTimers();
    const polls: number[] = [];
    const pending = { id: RID, input: 'text', prompt: 'p', status: 'pending', expiresAt: 'later', response: null };
    const ctx = ctxOf((_m, p) => {
      const w = /waitMs=(\d+)/.exec(p);
      if (w) polls.push(Number(w[1]));
      return new Promise((resolve) => setTimeout(() => resolve(pending), w ? Number(w[1]) : 0));
    }, 'oauth');
    const r = callTool('question_status', { question_id: RID, wait_s: 300 }, ctx);
    await jest.advanceTimersByTimeAsync(300_000);
    expect((await r).structuredContent).toMatchObject({ status: 'pending' });
    expect(polls.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(200_000);
    expect(polls.reduce((a, b) => a + b, 0)).toBeGreaterThan(190_000);
  });
});

describe('tools/list entries', () => {
  it('carry title and outputSchema only on revisions that have them, and all four hints always', () => {
    const t = tool('run_status');
    const modern = toolListEntry(t, MCP_VERSIONS['2025-06-18']);
    expect(modern).toMatchObject({ name: 'run_status', title: 'Check a run', annotations: { title: 'Check a run', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
    expect(modern.outputSchema).toMatchObject({ type: 'object', properties: { id: {}, steps: {} } });
    expect((modern.outputSchema as { additionalProperties?: unknown }).additionalProperties).toBeUndefined();
    const legacy = toolListEntry(t, MCP_VERSIONS['2025-03-26']);
    expect(legacy).not.toHaveProperty('title');
    expect(legacy).not.toHaveProperty('outputSchema');
    expect(legacy.annotations).toEqual(modern.annotations);
    expect(MAX_RESULT_CHARS).toBe(150_000);
    expect(MAX_RESULT_CHARS_OAUTH).toBe(100_000);
  });
});
