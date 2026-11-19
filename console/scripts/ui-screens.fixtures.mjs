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
  chatRun: '33333335-3333-4333-8333-333333333333',
  traceRun: '33333336-3333-4333-8333-333333333333',
  question: '55555555-5555-4555-8555-555555555555',
  policy: '66666666-6666-4666-8666-666666666666',
  group: '77777777-7777-4777-8777-777777777777',
  chat: '88888888-8888-4888-8888-888888888888',
  app: '8888888a-8888-4888-8888-888888888888',
  // Task parameters (#556): a task with three, the run waiting for its values, and a run that used them.
  paramTask: '11111111-1111-4111-8111-111111111119',
  formQuestion: '55555555-5555-4555-8555-555555555559',
  paramRun: '33333339-3333-4333-8333-333333333333',
  // The memory `GET /memories` lists as "My wife".
  memory: 'a1000000-0000-4000-8000-000000000001',
};

const PERMISSIONS = [
  'chat:read', 'chat:write', 'tasks:read', 'tasks:write', 'runs:read', 'runs:write', 'runs:delete', 'fleet:read', 'fleet:write', 'fleet:desktop', 'notes:read', 'notes:write',
  'agent_policies:read', 'agent_policies:write', 'approvals:read', 'approvals:write', 'system_settings:read', 'system_settings:write', 'fabric_config:read', 'fabric_config:write',
  'users:read', 'allowlist:read', 'jobs:read', 'webhooks:read', 'system_webhooks:read', 'alerts:read', 'ai:use', 'ai_config:read', 'storage_config:read',
  'db_backup:read', 'telemetry:read', 'push:read', 'broadcasts:read', 'groups:read', 'organizations:read',
  'connected_apps:read', 'connected_apps:write', 'oauth_clients:read', 'oauth_clients:write',
  'memories:read', 'memories:write', 'secrets:read', 'secrets:write',
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
  // The memories its goal used (#553): the run page says "Used: …".
  memoryIds: ['aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
  memories: [{ id: 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa', label: 'My partner', status: 'active' }, { id: 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaaa', label: 'Checking account', status: 'active' }],
  // The cards it paid with (E37.7): brand, last four, the shop and the declared and the confirmed amount; the second one differs.
  usedSavedCards: [
    { provider: 'vault', itemName: 'Everyday card', brand: 'visa', last4: '4242', merchant: 'checkout.shop.example.com', origin: 'https://checkout.shop.example.com', currency: 'USD', declaredAmount: '42.50', confirmedAmount: '42.50', mismatch: false, at: iso(-3_000_000) },
    { provider: 'vault', itemName: 'Virtual card', brand: 'mastercard', last4: '4444', merchant: 'a-very-long-shop-name-for-narrow-screens.example.co.uk', origin: 'https://a-very-long-shop-name-for-narrow-screens.example.co.uk', currency: 'USD', declaredAmount: '18.00', confirmedAmount: '24.99', mismatch: true, at: iso(-2_000_000) },
  ],
});
/** A chat run over its soft action limit that still finished (#537). */
const chatRun = run(IDS.chatRun, 'succeeded', {
  trigger: 'chat', taskId: null, stopReason: 'finished', result: 'Sent the payment and checked it shows as completed.', finishedAt: iso(-30_000), stepCount: 64,
  budget: { ...budget, used: { ...budget.used, actions: 64 }, percent: { ...budget.percent, actions: 106.7 }, enforcement: 'soft', over: ['actions'] },
});
/**
 * A chat run's trace (#544): two questions with their answers, the owner's guidance, a confirmed
 * step and five masked key-moment pictures (drawn by ui-screens.mjs from TRACE_FRAMES).
 */
const traceQ1 = '5555555a-5555-4555-8555-555555555555';
const traceQ2 = '5555555b-5555-4555-8555-555555555555';
const traceStep = (seq, kind, action, summary, extra = {}) => ({
  ...step(seq, kind, action, summary), hasScreenshot: false, screenshotMoment: null, screenshotMasked: null, screenshotNote: null, questionId: null, question: null, ...extra,
});
const confirmQuestion = {
  id: traceQ1, kind: 'confirmation', input: 'confirm', risk: 'high', status: 'answered', options: null,
  prompt: 'Pay $42.00 to Example Utilities from the checking account ending 0659? The bill covers October and November; the payment is sent today and cannot be cancelled once it is processed.',
  answer: { outcome: 'completed', value: 'approve', valueWithheld: false, channel: 'web', answeredAt: iso(-540_000 + 38_000) },
};
const signInQuestion = {
  id: traceQ2, kind: 'login', input: 'credentials', risk: null, status: 'answered', options: null,
  prompt: 'Sign in to bills.example.test to see the latest bill.',
  answer: { outcome: 'completed', valueWithheld: true, channel: 'cli', answeredAt: iso(-585_000) },
};
const traceSteps = [
  traceStep(1, 'action', 'navigate', 'Opened https://bills.example.test/account'),
  traceStep(2, 'handoff', 'ask', 'Sign in to bills.example.test to see the latest bill.', { questionId: traceQ2, question: signInQuestion, hasScreenshot: true, screenshotMoment: 'question', screenshotMasked: 1 }),
  traceStep(3, 'handoff', 'answered', 'The owner provided the sign-in', { questionId: traceQ2, question: signInQuestion }),
  traceStep(4, 'observe', 'text', 'Read the bill'),
  traceStep(5, 'guidance', null, 'The owner added: pay it from checking, not the card'),
  traceStep(6, 'handoff', 'confirm', confirmQuestion.prompt.slice(0, 120), { questionId: traceQ1, question: confirmQuestion, hasScreenshot: true, screenshotMoment: 'before_confirmed', screenshotMasked: 2 }),
  traceStep(7, 'handoff', 'answered', 'The owner allowed it', { questionId: traceQ1, question: confirmQuestion }),
  traceStep(8, 'action', 'click', 'Clicked "Pay $42.00"', { hasScreenshot: true, screenshotMoment: 'after_confirmed', screenshotMasked: 2 }),
  traceStep(9, 'action', 'click', 'The receipt link did not respond', { ok: false, hasScreenshot: true, screenshotMoment: 'failure', screenshotMasked: 0 }),
  traceStep(10, 'end', null, 'The run ended', { hasScreenshot: true, screenshotMoment: 'final', screenshotMasked: 2 }),
];
const traceRun = run(IDS.traceRun, 'succeeded', {
  trigger: 'chat', taskId: null, goal: 'Pay the electricity bill from the checking account', profile: 'default',
  stopReason: 'finished', result: 'Paid $42.00 to Example Utilities; the confirmation number is on the final screen.', finishedAt: iso(-480_000),
  stepCount: 7, steps: traceSteps, budget: null, costUsd: 0.38,
  confirmedActions: [{ seq: 8, prompt: 'Pay $42.00 to Example Utilities from the checking account ending 0659?', action: 'click', at: iso(-530_000) }],
});
/** The placeholder pictures of the trace run, by step: a title, a header colour and the masked boxes. */
export const TRACE_FRAMES = {
  2: { title: 'bills.example.test: sign in', header: '#00695c', masks: [[400, 360, 480, 60]] },
  6: { title: 'bills.example.test: pay $42.00?', header: '#3949ab', masks: [[120, 250, 300, 40], [700, 250, 300, 40]] },
  8: { title: 'bills.example.test: payment sent', header: '#2e7d32', masks: [[120, 250, 300, 40], [120, 370, 240, 40]] },
  9: { title: 'bills.example.test: receipt', header: '#c62828', masks: [] },
  10: { title: 'bills.example.test: done', header: '#455a64', masks: [[120, 250, 300, 40], [120, 490, 260, 40]] },
};
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
  // "Don't ask again" (#555): what the server says the approval would remember.
  rememberable: { kind: 'gate', host: 'example.com', category: 'purchase', matchKey: 'Book it', summary: "Press 'Book it' on example.com", scopes: ['everywhere', 'this_task'] },
};

/** A payment with a saved card (E37.7): the shop, the card by brand and last four, the amount and what is bought; "Don't ask again" needs a limit. */
const cardConfirmation = {
  ...question, questionId: '55555555-5555-4555-8555-555555555557', id: '55555555-5555-4555-8555-555555555557', runId: null, goal: '', handoffId: null,
  askedBy: 'agent:packer', browserBound: false, pageTitle: null, kind: 'confirmation', input: 'confirm', constraints: null, confirmLabel: 'Allow this payment', denyLabel: 'Do not pay', risk: 'high',
  prompt: 'The agent wants to pay with Visa ending 4242 at checkout.shop.example.com: 42.50 USD for Order #1001, two books. The card number, expiry and code are typed by the system and are never shown to the agent. Allow this payment?',
  rememberable: { kind: 'gate', host: 'example.com', category: 'payment', matchKey: 'saved card usd', summary: 'Pay with Visa ending 4242 on example.com', scopes: ['everywhere', 'this_task'], requiresLimit: true, currency: 'USD', amount: '42.50' },
};

/** A memory the agent proposes (#553): a quiet, non-blocking request, in the chat and the Inbox. */
const memoryProposal = {
  ...question, questionId: '5555555a-5555-4555-8555-555555555555', id: '5555555a-5555-4555-8555-555555555555', runId: null, goal: 'The agent suggests remembering something.', handoffId: null,
  askedBy: `chat:${IDS.chat}`, browserBound: false, prompt: 'The agent suggests remembering something.', pageTitle: null, kind: 'memory', input: 'memory', constraints: null,
  expiresAt: iso(7 * 86_400_000), blocking: false, conversationId: IDS.chat,
  proposal: { kind: 'person', label: 'My partner', aliases: ['partner'], attributes: { name: 'Person B', phone: '555-010-6020', relation: 'partner' }, supersedes: null },
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
// Chat (#486): a thread with every kind of message, and the list beside it.
const chatBase = { status: 'active', profile: 'default', hostId: null, hostFallback: true, policyId: null, allowedDomains: [], confirmRiskyActions: true, createdAt: iso(-3 * 86_400_000), updatedAt: iso(-60_000) };
const chatMessage = (seq, role, kind, text, extra = {}) => ({ id: `99999999-0000-4000-8000-${String(seq).padStart(12, '0')}`, seq, role, kind, text, runId: null, meta: null, createdAt: iso(-(20 - seq) * 60_000 - (seq < 3 ? 86_400_000 : 0)), ...extra });
const chatMessages = [
  chatMessage(1, 'user', 'text', 'Order the usual groceries for Saturday morning.'),
  chatMessage(2, 'assistant', 'run', 'Order the usual weekly groceries for delivery on Saturday morning.', { runId: IDS.finishedRun }),
  chatMessage(3, 'assistant', 'result', 'Ordered 14 items for delivery on Saturday between 9 and 11 AM. Total: $86.40.', { runId: IDS.finishedRun, meta: { status: 'succeeded', stopReason: 'finished', costUsd: 0.21, costKnown: true, stepCount: 14 } }),
  // Saved from the chat (#489): the line links to the task.
  chatMessage(4, 'system', 'text', 'Saved as the task "Weekly groceries".', { meta: { taskId: IDS.task } }),
  chatMessage(5, 'user', 'text', 'Book two cinema tickets for the new space film tonight.'),
  chatMessage(6, 'assistant', 'clarify', 'Which showing would you like?', { meta: { options: ['4:30 PM', '7:30 PM', 'The latest one'] } }),
  chatMessage(7, 'user', 'text', '7:30 PM, somewhere in the middle of the room please. If the middle rows are full, the row right behind them is fine too.'),
  // The live run: its Browser card shows the run's picture (the mocked screenshot).
  chatMessage(8, 'assistant', 'run', 'Book 2 tickets for the 7:30 PM showing of the new space film tonight at the usual cinema, middle rows preferred, otherwise the row right behind them.', { runId: IDS.liveRun }),
  // The agent offers to remember a person the owner named (#553): the "Remember this?" card.
  chatMessage(9, 'assistant', 'memory', 'Suggested remembering: My partner', { meta: { questionId: memoryProposal.id } }),
];
const chatRow = (id, title, extra = {}) => ({ ...chatBase, id, title, lastMessageAt: iso(-120_000), preview: { role: 'assistant', kind: 'run', text: 'Book 2 tickets for the 7:30 PM showing of the new space film tonight.' }, liveRun: null, ...extra });
const chatRows = [
  chatRow(IDS.chat, 'Book two cinema tickets for the new space film tonight', { liveRun: { id: IDS.liveRun, status: 'running' } }),
  chatRow('88888888-8888-4888-8888-888888888881', 'Compare three well-reviewed travel strollers under $150 and summarise the differences', { lastMessageAt: iso(-3_600_000), preview: { role: 'assistant', kind: 'result', text: 'The Glide Pro is the lightest at 6.1 kg.' } }),
  chatRow('88888888-8888-4888-8888-888888888882', 'Electricity bill', { lastMessageAt: iso(-2 * 86_400_000), preview: { role: 'user', kind: 'text', text: 'When is it due?' } }),
  chatRow('88888888-8888-4888-8888-888888888883', '', { lastMessageAt: iso(-9 * 86_400_000), preview: null }),
];

/** Saved approvals (#554). */
const approvalRules = [
  { id: '5a000000-0000-4000-8000-000000000001', kind: 'gate', host: 'bank.example.com', category: 'payment', matchKey: 'pay', summary: "Press 'Pay' on bank.example.com", taskId: null, taskName: null, conversationId: null, maxAmount: null, expiresAt: null, enabled: true, createdFromQuestionId: null, useCount: 4, lastUsedAt: iso(-2 * 86_400_000), lastUsedRunId: IDS.finishedRun, createdAt: iso(-20 * 86_400_000), updatedAt: iso(-20 * 86_400_000) },
  { id: '5a000000-0000-4000-8000-000000000002', kind: 'ask', host: 'bank.example.com', category: null, matchKey: 'choose_date', summary: 'Choose dates on bank.example.com', taskId: null, taskName: null, conversationId: null, maxAmount: null, expiresAt: null, enabled: true, createdFromQuestionId: null, useCount: 0, lastUsedAt: null, lastUsedRunId: null, createdAt: iso(-10 * 86_400_000), updatedAt: iso(-10 * 86_400_000) },
  { id: '5a000000-0000-4000-8000-000000000003', kind: 'gate', host: 'a-very-long-shop-name-for-narrow-screens.example.co.uk', category: 'purchase', matchKey: 'place your order', summary: "Press 'Place your order and pay with the saved card ending 1111' on a-very-long-shop-name-for-narrow-screens.example.co.uk", taskId: IDS.task, taskName: 'Weekly groceries', conversationId: null, maxAmount: 50, expiresAt: iso(40 * 86_400_000), enabled: false, createdFromQuestionId: null, useCount: 1, lastUsedAt: iso(-30 * 86_400_000), lastUsedRunId: null, createdAt: iso(-60 * 86_400_000), updatedAt: iso(-5 * 86_400_000) },
];

/** A saved card's approval (E37.7): bound to the shop and the card, with its required limit. */
approvalRules.push({ id: '5a000000-0000-4000-8000-000000000004', kind: 'gate', host: 'shop.example.com', category: 'payment', matchKey: 'saved card usd', cardRef: 'vault:7f1c2e9a-0000-4000-8000-0000000000c1', summary: 'Pay with Visa ending 4242 on shop.example.com', taskId: null, taskName: null, conversationId: null, maxAmount: 100, expiresAt: iso(25 * 86_400_000), enabled: true, createdFromQuestionId: null, useCount: 3, lastUsedAt: iso(-86_400_000), lastUsedRunId: IDS.finishedRun, createdAt: iso(-6 * 86_400_000), updatedAt: iso(-6 * 86_400_000) });

/** Secrets (#593): the provider card in each state; the page's own address says which (`?state=`). */
const vaultBase = { provider: 'vault', status: 'connected', configured: true, source: 'user', baseUrl: 'https://vault.example.test', clientId: 'hexactra', hasClientSecret: true, redirectUri: 'https://console.example.test/api/secrets/vault/callback', scopes: ['vault:items_read', 'vault:items_fill', 'vault:identity_read', 'vault:identity_fill', 'vault:cards_read', 'vault:cards_fill', 'offline_access'], vaultUserId: 'abcdef12-0000-4000-8000-000000000000', agentAccess: 'on', connectedAt: iso(-5 * 86_400_000), lastUsedAt: iso(-3_600_000), lastSuccessAt: iso(-3_600_000), lastErrorCode: null, connecting: false };
const stateOf = (referer) => (referer ? (new URL(referer).searchParams.get('state') ?? 'connected') : 'connected');
const secretsStatus = (_url, _body, referer) => {
  const st = stateOf(referer);
  const vault = st === 'not_connected' ? { ...vaultBase, status: 'not_configured', configured: false, source: 'none', baseUrl: null, clientId: null, hasClientSecret: false, scopes: [], vaultUserId: null, agentAccess: 'unknown', connectedAt: null, lastUsedAt: null, lastSuccessAt: null } : st === 'needs_reconnect' ? { ...vaultBase, status: 'needs_reconnect', lastErrorCode: 'UNAUTHORIZED' } : vaultBase;
  return { agentUse: { deployment: st !== 'deployment_off', user: st === 'connected' || st === 'empty', effective: st === 'connected' || st === 'empty' }, providers: { vault } };
};
const secretsActivity = (_url, _body, referer) =>
  stateOf(referer) === 'empty'
    ? { items: [], providerActivityUrl: 'https://vault.example.test/settings/agent-activity' }
    : {
        providerActivityUrl: 'https://vault.example.test/settings/agent-activity',
        items: [
          { id: 'ac000000-0000-4000-8000-000000000001', at: iso(-3_600_000), event: 'release', runId: IDS.finishedRun, site: 'app.example.test', loginName: 'Shop login', field: 'password', outcome: 'typed', refused: false, matches: null },
          { id: 'ac000000-0000-4000-8000-000000000002', at: iso(-3_660_000), event: 'release', runId: IDS.finishedRun, site: 'app.example.test', loginName: 'Shop login', field: 'username', outcome: 'typed', refused: false, matches: null },
          { id: 'ac000000-0000-4000-8000-000000000003', at: iso(-3_700_000), event: 'lookup', runId: IDS.finishedRun, site: 'app.example.test', field: null, outcome: 'ok', refused: false, matches: 1 },
          { id: 'ac000000-0000-4000-8000-000000000004', at: iso(-26 * 3_600_000), event: 'release', runId: null, site: 'a-look-alike-of-a-long-shop-name.example.co.uk', field: 'password', outcome: 'origin_mismatch', refused: true, matches: null },
          { id: 'ac000000-0000-4000-8000-000000000005', at: iso(-30 * 3_600_000), event: 'release', runId: IDS.liveRun, site: 'shop.example.test', field: 'one_time_code', outcome: 'rate_limited', refused: true, matches: null },
        ],
      };
const secretsReach = (_url, _body, referer) =>
  stateOf(referer) === 'empty'
    ? { listing: 'per_origin', items: [] }
    : { listing: 'per_origin', items: [{ site: 'app.example.test', fields: ['username', 'password', 'one_time_code'], uses: 7, lastUsedAt: iso(-3_600_000), lastRunId: IDS.finishedRun }, { site: 'shop.example.test', fields: ['username', 'password'], uses: 2, lastUsedAt: iso(-5 * 86_400_000), lastRunId: null }] };

/** Identity details (#595): the items the owner saved, with field labels and flags; never a value. */
const secretsIdentity = (_url, _body, referer) => {
  const st = stateOf(referer);
  if (st === 'not_connected') return { available: false, reason: 'not_connected', items: [], manageUrl: null };
  if (st === 'needs_reconnect') return { available: false, reason: 'needs_reconnect', items: [], manageUrl: 'https://vault.example.test' };
  if (st === 'deployment_off') return { available: false, reason: 'switched_off', items: [], manageUrl: 'https://vault.example.test' };
  if (st === 'empty') return { available: true, reason: 'ok', items: [], manageUrl: 'https://vault.example.test' };
  return {
    available: true,
    reason: 'ok',
    manageUrl: 'https://vault.example.test',
    items: [
      { name: 'Passport', fields: [{ label: 'Full name', sensitive: false }, { label: 'Date of birth', sensitive: true }, { label: 'ID number', sensitive: true }, { label: 'Country', sensitive: false }] },
      { name: 'Home address and a long name that has to wrap on a narrow phone screen', fields: [{ label: 'Address line 1', sensitive: false }, { label: 'City', sensitive: false }, { label: 'Postal code', sensitive: false }, { label: 'Phone', sensitive: false }] },
    ],
  };
};

/** The cards granted for one shop (E37.7): brand, last four, expiry and the limit; never a number or a code. */
const secretsCards = (url, _body, referer) => {
  const st = stateOf(referer);
  const merchant = url.searchParams.get('merchant') ?? '';
  if (st === 'not_connected') return { available: false, reason: 'not_connected', merchant: null, cards: [], manageUrl: null };
  if (st === 'empty' || /nowhere/.test(merchant)) return { available: true, reason: 'ok', merchant: `https://${merchant}`, cards: [], manageUrl: 'https://vault.example.test' };
  return {
    available: true,
    reason: 'ok',
    merchant: 'https://shop.example.com',
    manageUrl: 'https://vault.example.test',
    cards: [
      { name: 'Everyday card', brand: 'visa', last4: '4242', expires: '09/2031', limit: { maxAmount: '500.00', currency: 'USD', includesSecurityCode: false, expiresAt: null } },
      { name: 'Virtual card with a long name that has to wrap on a narrow phone screen', brand: 'mastercard', last4: '4444', expires: '03/2030', limit: { maxAmount: '20.00', currency: 'USD', includesSecurityCode: true, expiresAt: iso(30 * 86_400_000) } },
    ],
  };
};

/** `"<METHOD> <path>"` to the response `data`. A function gets the request URL and its JSON body. */
const memory = (id, kind, label, attributes, extra = {}) => ({
  id, kind, label, aliases: [], attributes, note: null, status: 'active', source: 'owner', sourceRunId: null, sourceConversationId: null,
  supersededById: null, lastUsedAt: null, createdAt: '2026-11-10T09:00:00.000Z', updatedAt: '2026-11-10T09:00:00.000Z', ...extra,
});
const memories = [
  memory('a1000000-0000-4000-8000-000000000001', 'person', 'My wife', { name: 'Person A', phone: '555-010-6020', relation: 'wife' }, { aliases: ['wife', 'person a'], lastUsedAt: '2026-11-17T18:00:00.000Z' }),
  memory('a1000000-0000-4000-8000-000000000002', 'account', 'Checking account', { bank: 'Bank of Example', ending: '0659' }, { source: 'agent_proposed', sourceConversationId: IDS.chat, note: 'The account the household bills are paid from; a longer note that has to wrap on a narrow phone screen.' }),
  memory('a1000000-0000-4000-8000-000000000003', 'preference', 'Seat', { seat: 'aisle', class: 'economy' }),
  memory('a1000000-0000-4000-8000-000000000004', 'fact', 'Old address', { city: 'Example City' }, { status: 'archived' }),
];

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
    secrets: { agentUse: { enabled: true } },
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
  [`GET /runs/${IDS.chatRun}`]: chatRun,
  [`GET /runs/${IDS.traceRun}`]: traceRun,
  'GET /fleet/hosts': hosts,
  [`GET /fleet/hosts/${IDS.host}`]: hosts[0],
  [`GET /fleet/hosts/${IDS.host}/takeover`]: null,
  [`POST /fleet/hosts/${IDS.host}/viewer-session`]: { hostId: IDS.host, wsPath: `/viewer/${IDS.host}/websockify`, expiresAt: iso(3_600_000) },
  'POST /fleet/enrollments': { enrollmentToken: 'hxe_placeholder', expiresAt: iso(900_000), command: 'curl -fsSL https://console.example.test/install.sh | sh -s -- agent install --url https://console.example.test --enrollment-token hxe_placeholder_0123456789abcdef --mode unattended' },
  'GET /chats': (url) => ({ items: url.searchParams.get('status') === 'archived' ? [] : chatRows, nextCursor: null }),
  [`GET /chats/${IDS.chat}`]: { ...chatBase, id: IDS.chat, title: chatRows[0].title, lastMessageAt: iso(-120_000), messages: chatMessages, hasMore: false, liveRun: { id: IDS.liveRun, status: 'running' }, thinking: false },
  'GET /inbox': [question, confirmation, cardConfirmation, memoryProposal],
  [`GET /questions/${IDS.question}`]: question,
  [`GET /questions/${memoryProposal.id}`]: memoryProposal,
  'GET /agent-policies': policies,
  [`GET /agent-policies/${IDS.policy}`]: policies[2],
  'GET /agent-policies/default': { policyId: 'builtin:balanced' },
  'GET /agent-policies/model-tiers/effective': { policy: null, tiers: { fast: effectiveTier('provider-a:model-small'), standard: effectiveTier('provider-a:model-mid'), frontier: effectiveTier('provider-a:model-large-2026') } },
  'GET /fabric/connection': { url: 'http://fabric-control:8787', tokenSet: true, source: 'settings', updatedAt: iso(-86_400_000) },
  'GET /connected-apps': connectedApps,
  // Memories (#551): a person, an account suggested by the agent, a preference and an archived fact.
  'GET /memories': (url) => (url.searchParams.get('status') === 'all' ? memories : memories.filter((m) => m.status === 'active')),
  // Saved approvals (#554): three rules on two sites, one limited, one off.
  'GET /approval-rules': { paused: false, rules: approvalRules },
  // Secrets (#593).
  'GET /secrets/status': secretsStatus,
  'GET /secrets/activity': secretsActivity,
  'GET /secrets/reach': secretsReach,
  'GET /secrets/identity': secretsIdentity,
  'GET /secrets/cards': secretsCards,
  'GET /secrets/admin/summary': { deploymentEnabled: true, usersConnected: 3, usersNeedingReconnect: 1, usesThisWeek: 41, refusalsThisWeek: 4 },
  'GET /secrets/vault/default-client': { baseUrl: 'https://vault.example.test', clientId: 'hexactra', hasClientSecret: true, allowedHosts: [], redirectUri: 'https://console.example.test/api/secrets/vault/callback' },
  'GET /connected-apps/preflight': preflight,
  [`GET /connected-apps/${IDS.app}`]: connectedApps[0],
  'GET /notes': [{ id: 'note-1', title: 'A first note', body: '', archived: false }, { id: 'note-2', title: 'A note with a long title that has to wrap on a narrow phone screen', body: '', archived: true }],
};

// ---- Task parameters (#556): the task form with three parameters, the run dialog, the form card, a schedule's values, a run's Inputs ----

const ZELLE_GOAL = 'Send {{Amount}} today to {{Recipient phone}} using Zelle on my Bank of America account using the checking account ending in {{Account last 4}}';
const paramTask = task(IDS.paramTask, 'Zelle to my wife', {
  goal: ZELLE_GOAL, hostId: null, hostFallback: true, allowedDomains: ['bank.example.test'], policyId: null,
  parameters: [
    { key: 'amount', label: 'Amount', type: 'money', required: true, help: 'In dollars, for example 25' },
    { key: 'recipient_phone', label: 'Recipient phone', type: 'phone', required: true, default: { memory: { id: IDS.memory, attribute: 'phone' } } },
    { key: 'account_last_4', label: 'Account last 4', type: 'text', required: true, default: { value: '0659' }, constraints: { maxLength: 4 } },
  ],
  createdAt: iso(-2 * 86_400_000), updatedAt: iso(-86_400_000),
  summary: { ...taskSummary, schedules: [taskSchedule('33333333-3333-4333-8333-333333333339', 'Every month on day 1 at 09:00', { inputs: { amount: '25' } })] },
});
const formQuestion = {
  ...question, questionId: IDS.formQuestion, id: IDS.formQuestion, runId: IDS.paramRun, goal: ZELLE_GOAL, handoffId: null, askedBy: `run:${IDS.paramRun}`, browserBound: false,
  prompt: 'A few details to start "Zelle to my wife": Amount, When', pageTitle: null, kind: 'other', input: 'form', options: null, constraints: null, viewerUrl: null, risk: null,
  fields: [
    { key: 'amount', label: 'Amount', type: 'money', required: true, help: 'In dollars, for example 25' },
    { key: 'when', label: 'When', type: 'date', required: true },
    { key: 'account', label: 'Account', type: 'choice', required: true, options: ['Checking ending 0659', 'Savings ending 1234'] },
  ],
};
const paramRun = run(IDS.paramRun, 'succeeded', {
  taskId: IDS.paramTask, goal: 'Send ⟦25⟧ today to ⟦•••-•••-6020⟧ using Zelle on my Bank of America account using the checking account ending in ⟦0659⟧',
  result: 'Sent 25 to the recipient.', finishedAt: iso(-60_000),
  inputs: [
    { key: 'amount', label: 'Amount', value: '25', source: 'asked' },
    { key: 'recipient_phone', label: 'Recipient phone', value: '•••-•••-6020', source: 'memory' },
    { key: 'account_last_4', label: 'Account last 4', value: '0659', source: 'default' },
  ],
});
RESPONSES[`GET /tasks/${IDS.paramTask}`] = paramTask;
RESPONSES[`GET /tasks/${IDS.paramTask}/stats`] = RESPONSES[`GET /tasks/${IDS.task}/stats`];
RESPONSES[`GET /questions/${IDS.formQuestion}`] = formQuestion;
RESPONSES[`GET /runs/${IDS.paramRun}`] = paramRun;
RESPONSES['GET /inbox'] = [formQuestion, ...RESPONSES['GET /inbox']];

/** The ids a mock run puts in the parameterized routes. */
export const MOCK_IDS = { liveRun: IDS.liveRun, finishedRun: IDS.finishedRun, chatRun: IDS.chatRun, traceRun: IDS.traceRun, task: IDS.task, host: IDS.host, question: IDS.question, policy: IDS.policy, group: IDS.group, chat: IDS.chat, app: IDS.app, paramTask: IDS.paramTask, formQuestion: IDS.formQuestion, paramRun: IDS.paramRun };
