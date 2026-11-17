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
};

const PERMISSIONS = [
  'tasks:read', 'tasks:write', 'runs:read', 'runs:write', 'fleet:read', 'fleet:write', 'fleet:desktop', 'notes:read', 'notes:write',
  'agent_policies:read', 'agent_policies:write', 'system_settings:read', 'system_settings:write', 'fabric_config:read', 'fabric_config:write',
  'users:read', 'allowlist:read', 'jobs:read', 'webhooks:read', 'system_webhooks:read', 'alerts:read', 'ai:use', 'ai_config:read', 'storage_config:read',
  'db_backup:read', 'telemetry:read', 'push:read', 'broadcasts:read', 'groups:read', 'organizations:read',
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

/** `"<METHOD> <path>"` to the response `data`. A function gets the request URL. */
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
  'GET /tasks': [task(IDS.task, 'Check fare'), task('11111111-1111-4111-8111-111111111112', 'Weekly groceries order with a long task name that wraps', { hostId: null, hostFallback: true, allowedDomains: [], policyId: IDS.policy })],
  // The task page (#428) reads the task with its summary, and its statistics.
  [`GET /tasks/${IDS.task}`]: task(IDS.task, 'Check fare', { createdAt: iso(-40 * 86_400_000), updatedAt: iso(-3 * 86_400_000), summary: taskSummary }),
  [`GET /tasks/${IDS.task}/stats`]: taskStats,
  'GET /schedules': [{ id: 'schedule-1', taskId: IDS.task, cron: '0 9 * * 1-5', timezone: 'Etc/UTC', enabled: true, concurrency: 'skip', nextRunAt: iso(5 * 3_600_000), lastRunAt: null, consecutiveFailures: 0, policyId: null }],
  'GET /runs': runs,
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
  'GET /notes': [{ id: 'note-1', title: 'A first note', body: '', archived: false }, { id: 'note-2', title: 'A note with a long title that has to wrap on a narrow phone screen', body: '', archived: true }],
};

/** The ids a mock run puts in the parameterized routes. */
export const MOCK_IDS = { liveRun: IDS.liveRun, finishedRun: IDS.finishedRun, task: IDS.task, host: IDS.host, question: IDS.question, policy: IDS.policy, group: IDS.group };
