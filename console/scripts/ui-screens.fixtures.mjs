// Canned API answers for `npm run ui:screens -- --mock`: enough data for the
// console's own pages to render as they do with a real account. Every name is a
// placeholder. A packaged (platform) page whose endpoint is not listed here gets
// a 404 and shows its error or empty state; the run lists those endpoints at the
// end, so nobody mistakes "rendered without data" for "rendered".

const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();

export const IDS = {
  task: '11111111-1111-4111-8111-111111111111',
  host: '22222222-2222-4222-8222-222222222222',
  liveRun: '33333331-3333-4333-8333-333333333333',
  finishedRun: '33333334-3333-4333-8333-333333333333',
  question: '55555555-5555-4555-8555-555555555555',
  policy: '66666666-6666-4666-8666-666666666666',
  group: '77777777-7777-4777-8777-777777777777',
  app: '88888888-8888-4888-8888-888888888888',
};

const PERMISSIONS = [
  'tasks:read', 'tasks:write', 'runs:read', 'runs:write', 'runs:delete', 'fleet:read', 'fleet:write', 'fleet:desktop', 'notes:read', 'notes:write',
  'agent_policies:read', 'agent_policies:write', 'system_settings:read', 'system_settings:write', 'fabric_config:read', 'fabric_config:write',
  'users:read', 'allowlist:read', 'jobs:read', 'webhooks:read', 'system_webhooks:read', 'alerts:read', 'ai:use', 'ai_config:read', 'storage_config:read',
  'db_backup:read', 'telemetry:read', 'push:read', 'broadcasts:read', 'groups:read', 'organizations:read',
  'connected_apps:read', 'connected_apps:write', 'oauth_clients:read', 'oauth_clients:write',
];

const limits = { maxActions: 60, maxModelCalls: 120, maxActiveMinutes: 20, maxInputTokens: null, maxOutputTokens: null, maxCostUsd: 2 };
const spec = {
  schemaVersion: 1,
  models: { startTier: 'standard', maxTier: 'frontier', allowProviderFallback: true },
  budget: { ...limits, warnAtPercent: 80 },
  stall: { maxConsecutiveFailures: 4, maxRepeatedAction: 3, noProgressActions: 10, onStall: 'nudge_then_escalate', maxEscalations: 2 },
  context: { screenshotsKept: 2, pruneBatch: 10, callsPerChunk: 10, observationChars: 6000 },
};
const policy = (id, name, extra = {}) => ({
  id, name, description: `${name}: a placeholder policy for the layout check`, version: 1, builtin: id.startsWith('builtin:'), spec, isDefault: false,
  usage: { tasks: 1, schedules: 0 }, hasNoHardStop: false, createdAt: iso(-86_400_000), updatedAt: iso(-3_600_000), ...extra,
});
const policies = [
  policy('builtin:economy', 'Economy'),
  policy('builtin:balanced', 'Balanced', { isDefault: true }),
  policy(IDS.policy, 'Careful shopping with a rather long policy name', { version: 3 }),
];

const budget = {
  effective: { actions: 60, modelCalls: 120, activeMinutes: 20, inputTokens: null, outputTokens: null, cost: 2, warnAtPercent: 80 },
  used: { actions: 21, modelCalls: 44, activeMinutes: 6.5, inputTokens: 412_000, outputTokens: 9_800, cost: 1.71 },
  percent: { actions: 35, modelCalls: 36.7, activeMinutes: 32.5, inputTokens: null, outputTokens: null, cost: 85.5 },
  source: { actions: 'policy', modelCalls: 'policy', activeMinutes: 'ceiling', inputTokens: null, outputTokens: null, cost: 'policy' },
  costKnown: true,
};
const step = (seq, kind, action, summary, extra = {}) => ({
  id: `step-${seq}`, seq, kind, action, ok: true, summary, args: null, reasoning: null, durationMs: 800 + seq * 37, createdAt: iso(-600_000 + seq * 9_000), ...extra,
});
const steps = [
  step(1, 'action', 'navigate', 'Opened https://flights.example.test/search?from=coast&to=capital&date=next-tuesday&passengers=1&cabin=economy', { reasoning: 'Start at the fare search.' }),
  step(2, 'observe', null, 'Read the page'),
  step(3, 'observe', null, 'Read the results'),
  step(4, 'action', 'click', 'Clicked "Sort by price"', { args: { selector: '#results > header button[data-sort="price"]' } }),
  step(5, 'action', 'click', 'Clicked the first fare', { ok: false, reasoning: 'The element moved while the list re-sorted.' }),
  step(6, 'routing', null, '', { args: { from: 'standard', to: 'frontier', reason: 'stuck on a repeated click at the same place; a stronger model looks at the page' } }),
  step(7, 'action', 'click_at', 'Clicked the first fare at (612, 340)', { args: { x: 612, y: 340 } }),
  step(8, 'action', 'type', 'Typed the passenger name', { args: { selector: 'input[name="passenger"]', text_length: 14 } }),
  step(9, 'routing', null, '', { args: { from: 'frontier', to: 'standard', reason: 'progressing' } }),
  ...Array.from({ length: 16 }, (_, i) => step(10 + i, 'action', 'scroll', `Scrolled the fare list (${i + 1})`)),
];
const run = (id, status, extra = {}) => ({
  id, taskId: IDS.task, status, trigger: 'manual', actor: null,
  goal: 'Find the cheapest fare from the coast to the capital next Tuesday and hold it for me',
  profile: 'travel', result: null, error: null, cancelRequested: false, stepCount: steps.length,
  policy: { id: 'builtin:balanced', name: 'Balanced', version: 1, source: 'user_default', builtin: true },
  tier: { start: 'standard', max: 'frontier', current: 'frontier', escalations: 1, model: 'provider-a:model-large-2026' },
  currentTier: 'frontier', budget, stopReason: null, costUsd: 1.71, costKnown: true, modelCalls: 44,
  createdAt: iso(-600_000), finishedAt: null, steps, ...extra,
});
const liveRun = run(IDS.liveRun, 'running', {
  activity: { phase: 'acting', action: 'click_at', args: { x: 612, y: 340 }, reason: 'Choose the cheapest fare in the list', startedAt: iso(-4_000), timeoutMs: 45_000, target: { x: 612, y: 340 }, note: 'On Frontier: the click did not land twice.' },
});
const finishedRun = run(IDS.finishedRun, 'failed', {
  stopReason: 'budget_cost', result: 'Compared 3 of 5 fares; the cheapest so far is 120 on the 9:00 departure.', error: 'Cost budget exhausted',
  finishedAt: iso(-60_000), budget: { ...budget, used: { ...budget.used, cost: 2.01 }, percent: { ...budget.percent, cost: 100.5 } },
});
const runs = [liveRun, run('33333332-3333-4333-8333-333333333333', 'waiting_human'), run('33333333-3333-4333-8333-333333333333', 'succeeded', { stopReason: 'finished', result: 'Held the 9:00 fare.' }), finishedRun]
  .map(({ steps: _steps, ...rest }) => rest);

const question = {
  questionId: IDS.question, id: IDS.question, runId: runs[1].id, goal: runs[1].goal, handoffId: 'handoff-1', askedBy: `run:${runs[1].id}`, browserBound: true,
  prompt: 'Enter the 6-digit code sent to your phone to finish signing in', choices: [], pageTitle: 'Sign in', status: 'pending', response: null,
  createdAt: iso(-60_000), expiresAt: iso(600_000), answeredAt: null, kind: 'code', input: 'secret', options: null, constraints: { maxLength: 6 },
  confirmLabel: null, denyLabel: null, risk: null, viewerUrl: null,
};
const confirmation = {
  ...question, questionId: '55555555-5555-4555-8555-555555555556', id: '55555555-5555-4555-8555-555555555556', runId: null, goal: '', handoffId: null,
  askedBy: 'agent:packer', browserBound: false, prompt: 'Book the 9:00 departure for 120?', pageTitle: null, kind: 'confirmation', input: 'confirm',
  constraints: null, confirmLabel: 'Book it', denyLabel: 'Do not book', risk: 'high',
};

const hosts = [
  {
    id: IDS.host, name: 'mini-pc', version: '0.9.2', online: true, browserConnected: true, onDemand: true, draining: false, viewerUrl: null, mode: 'unattended', desktop: true,
    profiles: [{ name: 'default', running: false }, { name: 'travel', running: true }, { name: 'a-profile-with-a-very-long-name-0123', running: false }], lastSeen: iso(-60_000),
  },
  {
    id: '22222222-2222-4222-8222-222222222223', name: 'cloud-box-with-a-long-host-name.example.test', version: '0.9.1', online: false, browserConnected: false, onDemand: true,
    draining: true, viewerUrl: null, mode: 'container', desktop: false, profiles: [{ name: 'default', running: false }], lastSeen: iso(-86_400_000),
  },
];

const tierDef = (model) => ({ model, reasoningEffort: null, maxOutputTokens: null, fallbackModel: null });
const tiers = { fast: tierDef('provider-a:model-small'), standard: tierDef('provider-a:model-mid'), frontier: tierDef('provider-a:model-large-2026') };
const effectiveTier = (model) => ({ model, provider: 'provider-a', modelSource: 'deployment', borrowedFrom: null, reasoningEffort: null, maxOutputTokens: null, fallbackModel: null, vision: true, tools: true, usable: true, problem: null });

const task = (id, name, extra = {}) => ({
  id, name, goal: 'Find the cheapest fare from the coast to the capital next Tuesday and hold it for me', profile: 'travel', hostId: IDS.host, hostFallback: false,
  allowedDomains: ['flights.example.test', '*.rail.example.test'], confirmRiskyActions: true, policyId: null,
  spend30d: { runs: 12, succeeded: 9, costUsd: 14.2, costKnown: true, inputTokens: 3_100_000, outputTokens: 92_000 }, ...extra,
});

const taskSchedule = (id, description, extra = {}) => ({
  id, cron: '0 9 * * 1-5', timezone: 'Etc/UTC', enabled: true, concurrency: 'skip', nextRunAt: iso(5 * 3_600_000), lastRunAt: iso(-19 * 3_600_000), consecutiveFailures: 0, description, policyId: null, ...extra,
});
/** `summary` of `GET /tasks/:id?include=summary`: two schedules (one failing, one paused with a policy override) and a finished last run. */
const taskSummary = {
  schedules: [
    taskSchedule('33333333-3333-4333-8333-333333333331', 'Monday to Friday at 09:00', { consecutiveFailures: 3 }),
    taskSchedule('33333333-3333-4333-8333-333333333332', 'On day 1 of every month at 07:30', { enabled: false, nextRunAt: null, lastRunAt: null, policyId: IDS.policy, timezone: 'Europe/Madrid' }),
  ],
  scheduleState: 'partial',
  nextRunAt: iso(5 * 3_600_000),
  lastRun: { id: IDS.finishedRun, status: 'failed', trigger: 'schedule', createdAt: iso(-19 * 3_600_000), finishedAt: iso(-19 * 3_600_000 + 200_000) },
  liveRunId: null,
  runCounts: { total: 148, last7d: { succeeded: 12, failed: 1, cancelled: 0 } },
  policy: { id: 'builtin:balanced', name: 'Balanced', builtin: true, isDefault: true },
};
/** `GET /tasks/:id/stats`: 30 days, whatever `days` asks for. */
const taskStats = {
  days: 30, timezone: 'Etc/UTC',
  totals: { runs: 26, succeeded: 23, failed: 2, cancelled: 1, successRate: 0.92, costUsd: 4.2, costKnown: true },
  avgDurationSeconds: 200, p95DurationSeconds: 540, avgSteps: 12.4, avgCostPerSuccessUsd: 0.18,
  series: Array.from({ length: 30 }, (_, i) => ({ date: iso(-(29 - i) * 86_400_000).slice(0, 10), succeeded: (i * 7) % 4, failed: i % 6 === 0 ? 1 : 0, cancelled: i % 13 === 5 ? 1 : 0, costUsd: 0.1 })),
  stopReasons: [{ reason: 'finished', count: 23 }, { reason: 'budget_cost', count: 2 }, { reason: 'cancelled', count: 1 }],
};

// ---- The pages of E32 (#432): the task list and form, the runs list, Home and Run history ----

const SECOND_TASK = '11111111-1111-4111-8111-111111111112';
const THIRD_TASK = '11111111-1111-4111-8111-111111111113';
/** The rows of `/tasks`: scheduled and failing, paused with its own policy, never scheduled and never run. */
const taskRows = [
  task(IDS.task, 'Check fare', { createdAt: iso(-40 * 86_400_000), updatedAt: iso(-3 * 86_400_000), summary: taskSummary }),
  task(SECOND_TASK, 'Weekly groceries order with a long task name that wraps on a phone', {
    hostId: null, hostFallback: true, allowedDomains: [], policyId: IDS.policy, createdAt: iso(-20 * 86_400_000), updatedAt: iso(-86_400_000),
    spend30d: { runs: 4, succeeded: 4, costUsd: 0.9, costKnown: false, inputTokens: 400_000, outputTokens: 12_000 },
    summary: {
      schedules: [taskSchedule('33333333-3333-4333-8333-333333333341', 'Every Saturday at 08:00', { cron: '0 8 * * 6', enabled: false, nextRunAt: null })],
      scheduleState: 'paused', nextRunAt: null,
      lastRun: { id: '33333333-3333-4333-8333-333333333333', status: 'succeeded', trigger: 'manual', createdAt: iso(-2 * 86_400_000), finishedAt: iso(-2 * 86_400_000 + 300_000) },
      liveRunId: null, runCounts: { total: 4, last7d: { succeeded: 1, failed: 0, cancelled: 0 } },
      policy: { id: IDS.policy, name: 'Careful shopping with a rather long policy name', builtin: false, isDefault: false },
    },
  }),
  task(THIRD_TASK, 'Read the morning report', {
    allowedDomains: [], confirmRiskyActions: false, createdAt: iso(-3_600_000), updatedAt: iso(-3_600_000), spend30d: { runs: 0, succeeded: 0, costUsd: null, costKnown: true, inputTokens: 0, outputTokens: 0 },
    summary: { schedules: [], scheduleState: 'none', nextRunAt: null, lastRun: null, liveRunId: IDS.liveRun, runCounts: { total: 0, last7d: { succeeded: 0, failed: 0, cancelled: 0 } }, policy: { id: 'builtin:balanced', name: 'Balanced', builtin: true, isDefault: true } },
  }),
];
/** `GET /tasks`: a page with `envelope`, the plain array without (the runs page's task filter, the pickers). */
const tasksList = (url) => (url.searchParams.has('envelope') ? { items: taskRows, nextCursor: null, total: taskRows.length } : taskRows.map(({ summary: _summary, ...rest }) => rest));

/** The rows of `/runs`: one of each status, a budget stop, a stall, an unpriced run and a one-off run with a long goal. */
const listRun = (n, status, extra = {}) => {
  const { steps: _steps, activity: _activity, ...row } = run(`3333334${n}-3333-4333-8333-333333333333`, status, {
    taskName: 'Check fare', budget: undefined, startedAt: iso(-(n + 1) * 3_600_000), createdAt: iso(-(n + 1) * 3_600_000), finishedAt: iso(-(n + 1) * 3_600_000 + 240_000), ...extra,
  });
  return row;
};
const runRows = [
  { ...runs[0], taskName: 'Check fare', startedAt: iso(-600_000) },
  { ...runs[1], taskName: 'Check fare', startedAt: iso(-900_000), costUsd: 0.4 },
  listRun(1, 'succeeded', { stopReason: 'finished', result: 'Held the 9:00 fare.', costUsd: 0.31, trigger: 'schedule' }),
  listRun(2, 'failed', { stopReason: 'budget_cost', costUsd: 2.01, trigger: 'schedule', policy: { id: IDS.policy, name: 'Careful shopping with a rather long policy name', version: 3, source: 'task', builtin: false } }),
  listRun(3, 'failed', { stopReason: 'stalled', costUsd: 0.74, costKnown: false, trigger: 'mcp', origin: 'mcp', client: { id: IDS.app, name: 'chatgpt.com', verified: true } }),
  listRun(4, 'cancelled', { stopReason: 'cancelled', costUsd: null, trigger: 'api', origin: 'cli' }),
  listRun(5, 'succeeded', {
    taskId: null, taskName: null, stopReason: 'finished', costUsd: 0.12,
    goal: 'Open the supplier portal at https://portal.example.test/orders/2026/11/overview?tab=open&sort=due, export the open orders as a spreadsheet and say how many are due this week',
  }),
];
const LIVE = new Set(['queued', 'running', 'waiting_human']);
/** `GET /runs`: a page with `envelope` (the live subset for `state=live`), the plain array without (what the audit's older pages read). */
const runsList = (url) => {
  if (!url.searchParams.has('envelope')) return runs;
  const state = url.searchParams.get('state');
  const taskId = url.searchParams.get('taskId');
  const items = runRows.filter((r) => (state === 'live' ? LIVE.has(r.status) : state === 'finished' ? !LIVE.has(r.status) : true) && (!taskId || r.taskId === taskId));
  return { items, nextCursor: null };
};
const runCounts = { total: 5_012, live: 2, byStatus: { queued: 0, running: 1, waiting_human: 1, succeeded: 4_180, failed: 702, cancelled: 128 }, costUsd: 1_284.37, costKnown: false };

const weekDays = Array.from({ length: 7 }, (_, i) => ({ date: iso(-(6 - i) * 86_400_000).slice(0, 10), succeeded: 3 + ((i * 5) % 4), failed: i % 3 === 0 ? 2 : 0, cancelled: i === 4 ? 1 : 0, costUsd: 0.6 + i * 0.2 }));
/** `GET /home/summary`: every block with data (a question, two live runs, firings, finished runs, a week, machines). */
const homeSummary = {
  generatedAt: iso(0), timezone: 'Etc/UTC',
  needsYou: {
    count: 2,
    items: [
      { questionId: question.questionId, runId: question.runId, kind: 'code', input: 'secret', prompt: question.prompt, risk: null, expiresAt: iso(600_000), createdAt: iso(-60_000), goal: question.goal },
      { questionId: confirmation.questionId, runId: null, kind: 'confirmation', input: 'confirm', prompt: confirmation.prompt, risk: 'high', expiresAt: iso(1_800_000), createdAt: iso(-30_000), goal: null },
    ],
  },
  liveRuns: {
    count: 2, running: 1,
    items: [
      { id: IDS.liveRun, taskId: IDS.task, taskName: 'Check fare', goal: liveRun.goal, status: 'running', activity: { phase: 'acting', action: 'click_at', reason: 'Choose the cheapest fare in the list', startedAt: iso(-4_000), note: null }, stepCount: 25, startedAt: iso(-600_000), hostId: IDS.host, hostName: 'mini-pc', policyName: 'Balanced', currentTier: 'frontier', startTier: 'standard', budgetPercent: 85.5, budgetWarnPercent: 80 },
      { id: runs[1].id, taskId: null, taskName: null, goal: runRows[6].goal, status: 'waiting_human', activity: null, stepCount: 9, startedAt: iso(-900_000), hostId: IDS.host, hostName: 'mini-pc', policyName: 'Careful shopping with a rather long policy name', currentTier: 'standard', startTier: 'standard', budgetPercent: null, budgetWarnPercent: null },
    ],
  },
  upcoming: {
    items: [
      { scheduleId: 'up-1', taskId: IDS.task, taskName: 'Check fare', nextRunAt: iso(5 * 3_600_000), description: 'Monday to Friday at 09:00', timezone: 'Etc/UTC' },
      { scheduleId: 'up-2', taskId: SECOND_TASK, taskName: taskRows[1].name, nextRunAt: iso(29 * 3_600_000), description: 'Every Saturday at 08:00', timezone: 'Europe/Madrid' },
    ],
    pausedCount: 1, failingCount: 1,
  },
  recentRuns: {
    items: runRows.filter((r) => !LIVE.has(r.status)).map((r) => ({ id: r.id, taskId: r.taskId, taskName: r.taskName, goal: r.goal, status: r.status, trigger: r.trigger, createdAt: r.createdAt, startedAt: r.startedAt, finishedAt: r.finishedAt, stepCount: r.stepCount, stopReason: r.stopReason, costUsd: r.costUsd, costKnown: r.costKnown, origin: r.origin ?? 'web', client: r.client ?? null, error: r.status === 'failed' ? 'Cost budget exhausted' : null })),
  },
  week: { totals: { succeeded: 31, failed: 6, cancelled: 1, successRate: 0.84, costUsd: 8.4, costKnown: false, budgetStops: 3, stalled: 1 }, series: weekDays },
  fleet: { total: 2, online: 1, disabled: 1, stale: false, hosts: hosts.map((h) => ({ id: h.id, name: h.name, online: h.online, draining: h.draining, mode: h.mode })) },
  counts: { tasks: taskRows.length, runs: runCounts.total },
};

/** `POST /schedules/preview`: words and five firings for what the editor sends; a refusal for an every-minute expression. */
const schedulePreview = (_url, body) => {
  const cron = body?.cron ?? '0 9 * * 1-5';
  if (/^\*(\/[1-4])? /.test(cron)) return { valid: false, code: 'CRON_TOO_FREQUENT', message: 'A schedule may run at most every 5 minutes.' };
  const description = { '0 9 * * 1-5': 'Monday to Friday at 09:00', '0 8 * * 6': 'Every Saturday at 08:00', '30 7 1 * *': 'On day 1 of every month at 07:30', '0 9 * * *': 'Every day at 09:00' }[cron] ?? `Custom schedule (${cron})`;
  return { valid: true, cron, timezone: body?.timezone ?? 'Etc/UTC', description, next: Array.from({ length: body?.count ?? 5 }, (_, i) => `${iso((i + 1) * 86_400_000).slice(0, 10)}T09:00:00.000Z`), intervalSeconds: 86_400 };
};

// Connected AI apps (#464).
const appLimits = { policyId: null, allowedPolicyIds: [], allowedDomains: ['shop.example.test'], maxConcurrentRuns: 2, dailyRunLimit: 50, dailyCostLimitUsd: 5, confirmPurchases: true, paused: false };
const connectedApps = [
  {
    clientId: IDS.app, grantId: '99999998-9999-4999-8999-999999999999', name: 'chatgpt.com', displayName: 'ChatGPT', selfName: 'ChatGPT', host: 'chatgpt.com', logoUri: null, verified: true, removed: false,
    connectedAt: iso(-12 * 86_400_000), lastUsedAt: iso(-3_600_000),
    scopes: [
      { id: 'runs:read', label: 'See runs', consent: 'See your runs, tasks, schedules and machines', risk: 'low' },
      { id: 'runs:write', label: 'Delegate', consent: 'Give goals to your Hexactra agent, start and stop runs', risk: 'low' },
      { id: 'inbox:read', label: 'Inbox', consent: 'See questions your agent is waiting on', risk: 'low' },
      { id: 'browser:drive', label: 'Drive browser', consent: 'Control a browser on your machines directly, step by step', risk: 'elevated' },
      { id: 'browser:evaluate', label: 'JavaScript', consent: 'Run JavaScript in pages you are signed in to', risk: 'high' },
    ],
    limits: appLimits,
    usage: { runs30d: 14, costUsd30d: 3.82, costKnown: true, lastRunAt: iso(-3_600_000), liveRuns: 1, runsToday: 3, costTodayUsd: 0.64 },
  },
  {
    clientId: '88888889-8888-4888-8888-888888888888', grantId: '99999997-9999-4999-8999-999999999999', name: 'Claude Code', displayName: 'Claude Code', selfName: 'Claude Code', host: null, logoUri: null, verified: true, removed: false,
    connectedAt: iso(-2 * 86_400_000), lastUsedAt: null,
    scopes: [{ id: 'runs:write', label: 'Delegate', consent: 'Give goals to your Hexactra agent, start and stop runs', risk: 'low' }],
    limits: { ...appLimits, allowedDomains: [], paused: true },
    usage: { runs30d: 0, costUsd30d: 0, costKnown: true, lastRunAt: null, liveRuns: 0, runsToday: 0, costTodayUsd: 0 },
  },
];
const preflight = {
  mcpUrl: 'https://console.example.test/api/mcp',
  admin: true,
  ready: false,
  checks: [
    { id: 'oauth_enabled', status: 'pass', title: 'Sign-in for AI apps is on', detail: 'AI apps can ask you to sign in with your Hexactra account.', fix: null },
    { id: 'public_url', status: 'pass', title: 'The console is on a public HTTPS address', detail: 'https://console.example.test', fix: null },
    { id: 'well_known', status: 'fail', title: 'The sign-in documents answer from the internet', detail: 'https://console.example.test/.well-known/oauth-protected-resource/api/mcp answered HTML (the web app), not the resource document.', fix: { who: 'admin', path: '/admin/settings/oauth-clients', text: 'Make the proxy in front of the console pass /.well-known/oauth-* to the API (Administration → Doctor shows the details).' } },
  ],
  clients: [
    { id: 'chatgpt', allowed: true, hosts: ['chatgpt.com'], detail: 'ChatGPT may connect.' },
    { id: 'claude', allowed: false, hosts: ['claude.ai'], detail: 'Allow claude.ai in Administration → OAuth clients.' },
    { id: 'claude-code', allowed: true, hosts: ['loopback'], detail: 'Claude Code may connect from your computer.' },
    { id: 'other', allowed: null, hosts: [], detail: "The app's host must be allowed in Administration → OAuth clients, or use a personal access token." },
  ],
};

/** `"<METHOD> <path>"` to the response `data`. A function gets the request URL and its JSON body. */
export const RESPONSES = {
  'POST /auth/refresh': { accessToken: 'ui-screens-token', expiresIn: 900 },
  'GET /auth/providers': { providers: [{ name: 'google', enabled: true }] },
  'GET /auth/me': { id: '99999999-9999-4999-8999-999999999999', email: 'person.a@example.test', displayName: 'Person A', roles: ['admin'], permissions: PERMISSIONS, isActive: true, tenancyMode: 'single' },
  'GET /user-settings': { settings: { profile: { timezone: 'Etc/UTC' } }, version: 1, browserAgent: { defaultPolicyRef: 'builtin:balanced', tiers: {} } },
  'GET /system-settings': {
    version: 3,
    agentPricing: { currency: 'USD', models: { 'provider-a:model-small': { inputPerMTok: 0.25, outputPerMTok: 1.25 }, 'provider-a:model-mid': { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 }, 'provider-a:model-large-2026': { inputPerMTok: 15, outputPerMTok: 75, cachedInputPerMTok: 1.5 } } },
    browserAgentTiers: tiers,
    browserAgentCeilings: { ...limits, maxActiveMinutes: 60, maxCostUsd: 10 },
  },
  'GET /tasks': tasksList,
  // The task page (#428) reads the task with its summary, and its statistics.
  [`GET /tasks/${IDS.task}`]: taskRows[0],
  // The schedule editor (the form, the task page), Home, the runs list's counts and Run history (#432).
  'POST /schedules/preview': schedulePreview,
  'GET /schedules/defaults': { timezone: 'Etc/UTC', source: 'profile' },
  'GET /home/summary': homeSummary,
  'GET /runs/counts': runCounts,
  'GET /runs/retention': { keepDays: 90, keepPerTask: 200, keepFailedDays: null, saved: true, maxKeepDays: 365, floorHours: 24 },
  'GET /runs/retention/preview': { wouldDelete: 1_840, finished: 5_010, oldestKept: iso(-89 * 86_400_000), costUsd: 412.5, maxKeepDays: 365, capped: false, floorHours: 24 },
  [`GET /tasks/${IDS.task}/stats`]: taskStats,
  'GET /schedules': (url) => (url.searchParams.get('taskId') === SECOND_TASK ? taskRows[1] : taskRows[0]).summary.schedules.map((sc) => ({ ...sc, taskId: url.searchParams.get('taskId') ?? IDS.task })),
  'GET /runs': runsList,
  [`GET /runs/${IDS.liveRun}`]: liveRun,
  [`GET /runs/${IDS.liveRun}/viewer`]: { hostId: IDS.host, hostName: 'mini-pc', desktop: true },
  [`GET /runs/${IDS.finishedRun}`]: finishedRun,
  'GET /fleet/hosts': hosts,
  [`GET /fleet/hosts/${IDS.host}`]: hosts[0],
  [`GET /fleet/hosts/${IDS.host}/takeover`]: null,
  [`POST /fleet/hosts/${IDS.host}/viewer-session`]: { hostId: IDS.host, wsPath: `/viewer/${IDS.host}/websockify`, expiresAt: iso(3_600_000) },
  'POST /fleet/enrollments': { enrollmentToken: 'hxe_placeholder', expiresAt: iso(900_000), command: 'curl -fsSL https://console.example.test/install.sh | sh -s -- agent install --url https://console.example.test --enrollment-token hxe_placeholder_0123456789abcdef --mode unattended' },
  'GET /inbox': [question, confirmation],
  [`GET /questions/${IDS.question}`]: question,
  'GET /agent-policies': policies,
  [`GET /agent-policies/${IDS.policy}`]: policies[2],
  'GET /agent-policies/default': { policyId: 'builtin:balanced' },
  'GET /agent-policies/model-tiers/effective': { policy: null, tiers: { fast: effectiveTier('provider-a:model-small'), standard: effectiveTier('provider-a:model-mid'), frontier: effectiveTier('provider-a:model-large-2026') } },
  'GET /fabric/connection': { url: 'http://fabric-control:8787', tokenSet: true, source: 'settings', updatedAt: iso(-86_400_000) },
  'GET /connected-apps': connectedApps,
  'GET /connected-apps/preflight': preflight,
  [`GET /connected-apps/${IDS.app}`]: connectedApps[0],
  'GET /notes': [{ id: 'note-1', title: 'A first note', body: '', archived: false }, { id: 'note-2', title: 'A note with a long title that has to wrap on a narrow phone screen', body: '', archived: true }],
};

/** The ids a mock run puts in the parameterized routes. */
export const MOCK_IDS = { liveRun: IDS.liveRun, finishedRun: IDS.finishedRun, task: IDS.task, host: IDS.host, question: IDS.question, policy: IDS.policy, group: IDS.group, app: IDS.app };
