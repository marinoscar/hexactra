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
  pausedRun: '33333337-3333-4333-8333-333333333333',
  pausedChat: '88888888-8888-4888-8888-888888888884',
  question: '55555555-5555-4555-8555-555555555555',
  policy: '66666666-6666-4666-8666-666666666666',
  group: '77777777-7777-4777-8777-777777777777',
  chat: '88888888-8888-4888-8888-888888888888',
  app: '8888888a-8888-4888-8888-888888888888',
  // Task parameters (#556): a task with three, the run waiting for its values, and a run that used them.
  paramTask: '11111111-1111-4111-8111-111111111119',
  // The task builder (E42.4): a conversation in task_builder mode, its spec half filled.
  builder: '77777777-7777-4777-8777-777777777771',
  formQuestion: '55555555-5555-4555-8555-555555555559',
  paramRun: '33333339-3333-4333-8333-333333333333',
  outputsTask: '11111111-1111-4111-8111-11111111111a',
  outputsRun: '3333333a-3333-4333-8333-333333333333',
  // Connections in the console (E39.10, #607): a task with accounts and four deliveries, a run an email started, an approval card per kind.
  carTask: '11111111-1111-4111-8111-11111111111b',
  carRun: '3333333c-3333-4333-8333-333333333333',
  // The memory `GET /memories` lists as "My wife".
  memory: 'a1000000-0000-4000-8000-000000000001',
  // Benchmarks (E44.5, #743): a completed one with three policies, the running one, and the baseline it is compared with.
  benchmark: 'b0000000-0000-4000-8000-000000000001',
  liveBenchmark: 'b0000000-0000-4000-8000-000000000002',
  baselineBenchmark: 'b0000000-0000-4000-8000-000000000003',
  // A guided profile sign-in (E48.4): one waiting for the person, one completed.
  signinWaiting: '5191a000-0000-4000-8000-000000000001',
  signinDone: '5191a000-0000-4000-8000-000000000002',
};

const PERMISSIONS = [
  'chat:read', 'chat:write', 'tasks:read', 'tasks:write', 'runs:read', 'runs:write', 'runs:delete', 'fleet:read', 'fleet:write', 'fleet:desktop', 'notes:read', 'notes:write',
  'agent_policies:read', 'agent_policies:write', 'approvals:read', 'approvals:write', 'system_settings:read', 'system_settings:write', 'fabric_config:read', 'fabric_config:write',
  'users:read', 'allowlist:read', 'jobs:read', 'webhooks:read', 'system_webhooks:read', 'alerts:read', 'ai:use', 'ai_config:read', 'storage_config:read',
  'usage:read', 'user_settings:read', 'user_settings:write', 'db_backup:read', 'telemetry:read', 'push:read', 'broadcasts:read', 'groups:read', 'organizations:read',
  'connected_apps:read', 'connected_apps:write', 'oauth_clients:read', 'oauth_clients:write',
  'memories:read', 'memories:write', 'secrets:read', 'secrets:write', 'connections:read', 'connections:write', 'web_search:read', 'web_search:write',
  'kgraph:read', 'kgraph:write', 'kgraph:admin',
  'benchmarks:read', 'benchmarks:run',
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
/** A run the owner paused (E38.2): live, with its browser kept; the run page shows the banner with Resume and Stop. */
const pausedRun = run(IDS.pausedRun, 'paused', {
  trigger: 'chat', taskId: null, pauseRequested: true, pausedAt: iso(-300_000), startedAt: iso(-900_000), activity: null,
  goal: 'Book 2 tickets for the 7:30 PM showing of the new space film tonight',
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

/**
 * "Save this login?" (E37.4b): after the owner signed in by hand, the agent offers to save that login. Non-blocking, so the Inbox lists it with the
 * suggestions, the chat thread shows it as a card and its own page shows it as a question. The password is not in any fixture: it is held by the fabric.
 */
const saveLogin = {
  ...question, questionId: '5555555b-5555-4555-8555-555555555555', id: '5555555b-5555-4555-8555-555555555555', runId: runs[1].id, goal: runs[1].goal, handoffId: null,
  askedBy: `run:${runs[1].id}`, browserBound: false, prompt: 'The agent offers to save the sign-in you just typed.', pageTitle: null, kind: 'login', input: 'save_login', constraints: null, rememberLabel: null,
  expiresAt: iso(9 * 60_000), blocking: false, conversationId: IDS.chat,
  saveLogin: { site: 'login.example.com', domain: 'example.com', name: 'Example Bank sign-in', username: 'person-a@example.test', valueExpiresAt: iso(9 * 60_000) },
};

/**
 * A scan (#924): the owner scans a sign-in QR code the site shows. Browser-bound; its live picture is GET /questions/{id}/scan-image, mocked with the
 * run's placeholder frame (the audit checks the layout, not the code).
 */
const scanQuestion = {
  ...question, questionId: '5555555c-5555-4555-8555-555555555555', id: '5555555c-5555-4555-8555-555555555555', runId: runs[1].id, goal: runs[1].goal,
  askedBy: `run:${runs[1].id}`, browserBound: true, prompt: 'Scan the QR code with the Example Bank app on your phone to sign in.', pageTitle: 'Sign in with your phone', kind: 'login', input: 'scan',
  constraints: null, rememberLabel: null, options: null, expiresAt: iso(3 * 60_000),
  scan: { source: 'page', domain: 'example.com', origin: 'https://login.example.com' },
};

const hosts = [
  {
    id: IDS.host, name: 'mini-pc', version: '0.9.2', online: true, browserConnected: true, onDemand: true, draining: false, viewerUrl: null, mode: 'unattended', desktop: true,
    // E48.3: every sign-in state, and a long email that must not overflow a phone.
    profiles: [
      { name: 'default', running: false, signin: 'signed_in', accounts: [{ provider: 'google', email: 'person-a.with-a-very-long-address.for-the-owner@subdomain.example-company.test', state: 'signed_in' }], checkedAt: iso(-5 * 60_000) },
      { name: 'travel', running: true, signin: 'signed_out', accounts: [], checkedAt: iso(-2 * 60_000) },
      { name: 'a-profile-with-a-very-long-name-0123', running: false, signin: 'expired', accounts: [{ provider: 'google', email: 'person-a@example.test', state: 'expired' }], checkedAt: iso(-3_600_000) },
      { name: 'shop', running: false, signin: 'unknown', accounts: [], checkedAt: null },
    ],
    lastSeen: iso(-60_000),
  },
  {
    id: '22222222-2222-4222-8222-222222222223', name: 'cloud-box-with-a-long-host-name.example.test', version: '0.9.1', online: false, browserConnected: false, onDemand: true,
    draining: true, viewerUrl: null, mode: 'container', desktop: false, profiles: [{ name: 'default', running: false, signin: 'signed_out', accounts: [], checkedAt: iso(-86_400_000) }], lastSeen: iso(-86_400_000),
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
  listRun(6, 'paused', { stopReason: null, finishedAt: null, pauseRequested: true, pausedAt: iso(-1_200_000) }),
  listRun(5, 'succeeded', {
    taskId: null, taskName: null, stopReason: 'finished', costUsd: 0.12,
    goal: 'Open the supplier portal at https://portal.example.test/orders/2026/11/overview?tab=open&sort=due, export the open orders as a spreadsheet and say how many are due this week',
  }),
];
const LIVE = new Set(['queued', 'running', 'waiting_human', 'paused']);
/** `GET /runs`: a page with `envelope` (the live subset for `state=live`), the plain array without (what the audit's older pages read). */
const runsList = (url) => {
  if (!url.searchParams.has('envelope')) return runs;
  const state = url.searchParams.get('state');
  const taskId = url.searchParams.get('taskId');
  const items = runRows.filter((r) => (state === 'live' ? LIVE.has(r.status) : state === 'finished' ? !LIVE.has(r.status) : true) && (!taskId || r.taskId === taskId));
  return { items, nextCursor: null };
};
const runCounts = { total: 5_013, live: 3, byStatus: { queued: 0, running: 1, waiting_human: 1, paused: 1, succeeded: 4_180, failed: 702, cancelled: 128 }, costUsd: 1_284.37, costKnown: false };

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
  fleet: {
    total: 2, online: 1, disabled: 1, needsSignin: 3, stale: false,
    hosts: hosts.map((h) => ({ id: h.id, name: h.name, online: h.online, draining: h.draining, mode: h.mode, needsSignin: h.profiles.filter((p) => p.signin === 'signed_out' || p.signin === 'expired').length })),
  },
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
  // The agent offers to save the sign-in the owner typed by hand (E37.4b): the "Save this sign-in for <site>?" card.
  chatMessage(10, 'assistant', 'memory', 'Offered to save the sign-in for login.example.com', { meta: { questionId: saveLogin.id, card: 'save_login' } }),
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

/**
 * Connections (E39.2, #599): two Google accounts and one Microsoft account in different states (a work account with the
 * mail default, a personal account that is paused, a Microsoft account whose sign-in expired), and the administrator's apps.
 * `?state=empty` shows the empty list. No token or scope string: the API returns none.
 */
const connectionBase = { accountName: null, granted: [], defaultFor: [], statusReason: null, connectedAt: iso(-20 * 86_400_000), lastRefreshAt: iso(-3_600_000) };
const connectionsList = (_url, _body, referer) => {
  if (stateOf(referer) === 'empty') return [];
  return [
    { ...connectionBase, id: 'c0000000-0000-4000-8000-000000000003', provider: 'microsoft', label: 'Outlook', accountEmail: 'person.m@example.test', accountName: 'Person M', capabilities: ['calendar_read', 'calendar_write'], granted: ['calendar_read', 'calendar_write'], status: 'needs_reconnect', statusReason: 'GRANT_REVOKED', lastUsedAt: iso(-9 * 86_400_000) },
    { ...connectionBase, id: 'c0000000-0000-4000-8000-000000000001', provider: 'google', label: 'Work', accountEmail: 'person.a@example.test', accountName: 'Person A', capabilities: ['mail_read', 'mail_send', 'calendar_read', 'docs_read', 'docs_write'], granted: ['mail_read', 'mail_send', 'calendar_read', 'docs_read', 'docs_write'], defaultFor: ['mail', 'calendar'], status: 'active', lastUsedAt: iso(-3_600_000) },
    { ...connectionBase, id: 'c0000000-0000-4000-8000-0000000000a1', provider: 'mcp', label: 'Work notes', status: 'active', accountEmail: 'mcp.example.test', accountName: 'Notes server', capabilities: [], mcp: { url: 'https://mcp.example.test/mcp', auth: 'bearer', serverName: 'Notes server', tools: { total: 3, enabled: 1, needsReview: 2 }, toolsFetchedAt: iso(-3_600_000) } },
    { ...connectionBase, id: 'c0000000-0000-4000-8000-000000000002', provider: 'google', label: 'Personal', accountEmail: 'person.b@example.test', capabilities: ['mail_read'], granted: ['mail_read'], status: 'paused', lastUsedAt: null },
  ];
};
/** An MCP server's tools (E39.9): one the owner switched on, one that changed after they decided, one that is new. */
const mcpTool = (over) => ({ title: null, description: 'Does a thing.', parameters: [], hints: { readOnly: null, destructive: null, idempotent: null, openWorld: null }, suggested: 'write', mode: 'off', review: null, ...over });
const mcpCatalog = {
  tools: [
    mcpTool({ id: 'a0000000-0000-4000-8000-000000000002', name: 'add_note', title: 'Add a note', description: 'Adds a note to the list. The server changed this description after you decided.', parameters: [{ name: 'title', type: 'string', required: true }, { name: 'body', type: 'string', required: false }], review: 'changed' }),
    mcpTool({ id: 'a0000000-0000-4000-8000-000000000001', name: 'search_notes', title: 'Search notes', description: 'Search the notes by a word or phrase.', parameters: [{ name: 'query', type: 'string', required: true }], hints: { readOnly: true, destructive: null, idempotent: true, openWorld: null }, suggested: 'read', mode: 'read' }),
    mcpTool({ id: 'a0000000-0000-4000-8000-000000000003', name: 'wipe_notes_and_everything_else_in_the_workspace', description: 'Deletes every note. A very long description that keeps going to check that the row wraps at every width and never scrolls the page sideways, however long the words are.', hints: { readOnly: false, destructive: true, idempotent: null, openWorld: null }, review: 'new' }),
  ],
  needsReview: 2,
  fetchedAt: iso(-3_600_000),
};
const connectionProviders = [
  { provider: 'google', displayName: 'Google', ready: true, reason: null, accountTypes: [{ id: 'personal', label: 'Personal Gmail account', supported: true, note: 'Works while the Google project is published; in testing mode Google ends the sign-in after about a week.' }, { id: 'workspace', label: 'Google Workspace account', supported: true, note: "Your organization's administrator may have to allow the app first." }] },
  { provider: 'microsoft', displayName: 'Microsoft', ready: true, reason: null, accountTypes: [{ id: 'personal', label: 'Personal Microsoft account', supported: true, note: 'Outlook.com, Hotmail and Live accounts.' }, { id: 'work', label: 'Work or school account', supported: true, note: "Your organization's administrator may have to approve the app." }] },
];
const adminConnectionApps = [
  { provider: 'google', displayName: 'Google', enabled: true, clientId: 'example-google-client.apps.example.test', hasClientSecret: true, tenant: null, installed: true, redirectUri: 'https://console.example.test/api/connections/callback/google', setupSteps: ['In the Google Cloud console, create a project and enable the Gmail, Calendar, Docs, Sheets and Drive APIs.', 'Configure and publish the OAuth consent screen.', 'Create an OAuth client of type Web application and add the redirect URI shown on this page.', 'Paste the client id and secret here and switch Google on.'], accountTypes: [] },
  { provider: 'microsoft', displayName: 'Microsoft', enabled: false, clientId: null, hasClientSecret: false, tenant: 'common', installed: false, redirectUri: 'https://console.example.test/api/connections/callback/microsoft', setupSteps: ['In the Microsoft Entra admin center, register an application.', 'Add the redirect URI shown on this page as a Web redirect URI.', 'Create a client secret.', 'Paste the application id and secret here, set the tenant and switch Microsoft on.'], accountTypes: [] },
];

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


// AI usage and cost (#734): 30 days of three models, one unpriced, stacked by model.
const usageDays = Array.from({ length: 30 }, (_, i) => new Date(now - (29 - i) * 86_400_000).toISOString().slice(0, 10));
const usageWave = (base, i) => Math.round(base * (0.6 + 0.4 * Math.sin(i / 3) + (i % 7 === 5 ? 0.8 : 0)));
const usageSeries = [
  { key: 'openai:gpt-6.1-sol', label: 'gpt-6.1-sol', perDay: 180_000, price: 0.000004 },
  { key: 'openai:gpt-6-luna', label: 'gpt-6-luna', perDay: 1_200_000, price: 0.00000015 },
  { key: 'compatible:local-mixtral-with-a-long-model-name', label: 'local-mixtral-with-a-long-model-name', perDay: 90_000, price: 0 },
].map((m) => {
  const tokens = usageDays.map((_, i) => usageWave(m.perDay, i));
  return { key: m.key, label: m.label, tokens, costUsd: tokens.map((t) => Math.round(t * m.price * 1e6) / 1e6), requests: tokens.map((t) => Math.max(1, Math.round(t / 9000))) };
});
const usageSum = (k) => usageSeries.reduce((a, s) => a + s[k].reduce((x, y) => x + y, 0), 0);
const usageReport = {
  range: '30d', scope: 'me', breakdown: 'model', timeZone: 'Etc/UTC', granularity: 'day',
  from: usageDays[0], to: usageDays.at(-1), buckets: usageDays, series: usageSeries,
  totals: {
    requests: usageSum('requests'), failed: 12, inputTokens: Math.round(usageSum('tokens') * 0.9), cachedInputTokens: Math.round(usageSum('tokens') * 0.35),
    outputTokens: Math.round(usageSum('tokens') * 0.1), reasoningTokens: Math.round(usageSum('tokens') * 0.02), tokens: usageSum('tokens'),
    costUsd: Math.round(usageSum('costUsd') * 100) / 100, costKnown: false,
    costByTokenType: { input: 14.2, cachedInput: 0.9, output: 9.4, reasoning: 1.1 },
  },
  byModel: usageSeries.map((s, i) => ({
    key: s.key, provider: s.key.split(':')[0], model: s.label, requests: s.requests.reduce((a, b) => a + b, 0), failed: i, inputTokens: Math.round(s.tokens.reduce((a, b) => a + b, 0) * 0.9),
    cachedInputTokens: Math.round(s.tokens.reduce((a, b) => a + b, 0) * 0.3), outputTokens: Math.round(s.tokens.reduce((a, b) => a + b, 0) * 0.1), reasoningTokens: 0,
    tokens: s.tokens.reduce((a, b) => a + b, 0), costUsd: i === 2 ? null : Math.round(s.costUsd.reduce((a, b) => a + b, 0) * 100) / 100, costShare: i === 2 ? null : i === 0 ? 0.81 : 0.19,
  })),
  unpricedModels: ['compatible:local-mixtral-with-a-long-model-name'],
  runs: { count: 214, succeeded: 187, costUsd: 22.8, avgSuccessCostUsd: 0.11 },
  pricing: { overridesApplied: false },
};

export const RESPONSES = {
  'POST /auth/refresh': { accessToken: 'ui-screens-token', expiresIn: 900 },
  'GET /auth/providers': { providers: [{ name: 'google', enabled: true }] },
  'GET /auth/me': { id: '99999999-9999-4999-8999-999999999999', email: 'person.a@example.test', displayName: 'Person A', roles: ['admin'], permissions: PERMISSIONS, isActive: true, tenancyMode: 'single' },
  'GET /user-settings': { settings: { profile: { timezone: 'Etc/UTC' } }, version: 1, browserAgent: { defaultPolicyRef: 'builtin:balanced', tiers: {} }, agentPricing: { currency: 'USD', models: { 'openai:gpt-6-luna': { inputPerMTok: 0.08, outputPerMTok: 0.4, cachedInputPerMTok: 0.008 } } } },
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
  'GET /usage/report': usageReport,
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
  [`GET /runs/${IDS.pausedRun}`]: pausedRun,
  [`GET /runs/${IDS.pausedRun}/viewer`]: { hostId: IDS.host, hostName: 'mini-pc', desktop: true },
  [`GET /runs/${IDS.traceRun}`]: traceRun,
  'GET /fleet/hosts': hosts,
  [`GET /fleet/hosts/${IDS.host}`]: hosts[0],
  [`GET /fleet/hosts/${IDS.host}/takeover`]: null,
  [`POST /fleet/hosts/${IDS.host}/viewer-session`]: { hostId: IDS.host, wsPath: `/viewer/${IDS.host}/websockify`, expiresAt: iso(3_600_000) },
  [`GET /fleet/signin-sessions/${IDS.signinWaiting}`]: { id: IDS.signinWaiting, hostId: IDS.host, profile: 'default', status: 'started', phase: 'waiting', leaseId: null, keepLease: false, signin: 'signed_out', email: null, resultState: null, endReason: null, startedAt: iso(-60_000), expiresAt: iso(840_000), endedAt: null },
  [`GET /fleet/signin-sessions/${IDS.signinDone}`]: { id: IDS.signinDone, hostId: IDS.host, profile: 'default', status: 'completed', phase: null, leaseId: null, keepLease: false, signin: 'signed_in', email: 'a.very.long.owner.address@example.com', resultState: 'signed_in', endReason: null, startedAt: iso(-180_000), expiresAt: iso(720_000), endedAt: iso(-5_000) },
  'POST /fleet/enrollments': { enrollmentToken: 'hxe_placeholder', expiresAt: iso(900_000), command: 'curl -fsSL https://console.example.test/install.sh | sh -s -- agent install --url https://console.example.test --enrollment-token hxe_placeholder_0123456789abcdef --mode unattended' },
  'GET /chats': (url) => ({ items: url.searchParams.get('status') === 'archived' ? [] : chatRows, nextCursor: null }),
  [`GET /chats/${IDS.pausedChat}`]: {
    ...chatBase, id: IDS.pausedChat, title: 'Book two cinema tickets (paused)', lastMessageAt: iso(-120_000), hasMore: false, thinking: false, liveRun: { id: IDS.pausedRun, status: 'paused' },
    messages: [chatMessage(1, 'user', 'text', 'Book two cinema tickets for the new space film tonight.'), chatMessage(2, 'assistant', 'run', pausedRun.goal, { runId: IDS.pausedRun }), chatMessage(3, 'user', 'text', 'Hold on a second')],
  },
  [`GET /chats/${IDS.chat}`]: { ...chatBase, id: IDS.chat, title: chatRows[0].title, lastMessageAt: iso(-120_000), messages: chatMessages, hasMore: false, liveRun: { id: IDS.liveRun, status: 'running' }, thinking: false },
  'GET /inbox': [question, confirmation, cardConfirmation, memoryProposal, saveLogin],
  [`GET /questions/${IDS.question}`]: question,
  [`GET /questions/${memoryProposal.id}`]: memoryProposal,
  [`GET /questions/${saveLogin.id}`]: saveLogin,
  [`GET /questions/${scanQuestion.id}`]: scanQuestion,
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
  'GET /connections': connectionsList,
  'GET /connections/providers': connectionProviders,
  'GET /connections/admin/apps': adminConnectionApps,
  'GET /connections/mcp/status': { enabled: true, restricted: false },
  'GET /connections/admin/mcp': { enabled: true, allowedHosts: ['*.example.test'], blockedHosts: ['blocked.example.test'] },
  'GET /connections/c0000000-0000-4000-8000-0000000000a1/tools': mcpCatalog,
  'GET /secrets/status': secretsStatus,
  'GET /secrets/activity': secretsActivity,
  'GET /secrets/reach': secretsReach,
  'GET /secrets/identity': secretsIdentity,
  'GET /secrets/cards': secretsCards,
  // Keys of outside services (E50.3): one key in the built-in store, one not set.
  'GET /service-credentials': [
    { service: 'web_search', name: 'brave', label: 'Brave Search API key', tier: 'user', tiers: { user: { available: true, set: true, setAt: '2026-11-20T10:00:00.000Z' }, organization: { available: false, set: false, setAt: null }, system: { available: true, set: true, setAt: '2026-11-01T10:00:00.000Z' } }, userBinding: 'builtin', secretsProvider: { id: 'builtin', writable: true, releasesEnabled: true, ready: true } },
    { service: 'web_search', name: 'searxng_with_a_long_reference_name', label: 'A self-hosted search provider with a long name that has to wrap on a phone', tier: null, tiers: { user: { available: true, set: false, setAt: null }, organization: { available: false, set: false, setAt: null }, system: { available: true, set: false, setAt: null } }, userBinding: 'credential_store', secretsProvider: { id: 'builtin', writable: true, releasesEnabled: true, ready: true } },
  ],
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

// ---- Task outputs (E39.5, #600): the task form's Outputs section, the task page's history table, a finished run's Outputs block ----

const outputsDefs = [
  { key: 'confirmation_number', label: 'Confirmation number', type: 'text', required: true, help: 'Shown on the receipt page' },
  { key: 'amount_paid', label: 'Amount paid', type: 'money', required: true },
  { key: 'paid_on', label: 'Paid on', type: 'date', required: true },
  { key: 'remaining_balance', label: 'Remaining balance', type: 'money', required: false },
  { key: 'account', label: 'Account', type: 'text', required: false, sensitive: true },
];
const outputsTask = task(IDS.outputsTask, 'Pay the rent', {
  goal: 'Pay this month\'s rent on the property portal and read the receipt', hostId: null, hostFallback: true, allowedDomains: ['portal.example.test'], policyId: null,
  parameters: [], outputs: outputsDefs, createdAt: iso(-20 * 86_400_000), updatedAt: iso(-86_400_000),
  summary: { ...taskSummary, schedules: [taskSchedule('33333333-3333-4333-8333-33333333333a', 'Every month on day 1 at 09:00')] },
});
const outputRow = (key, label, type, value, extra = {}) => ({ key, label, type, required: true, sensitive: false, value, ok: true, note: null, ...extra });
const outputValues = (n) => ({
  confirmation_number: outputRow('confirmation_number', 'Confirmation number', 'text', `RC-48${n}1`),
  amount_paid: outputRow('amount_paid', 'Amount paid', 'money', { amount: 1250, currency: 'USD' }),
  paid_on: outputRow('paid_on', 'Paid on', 'date', `2026-0${n}-01`),
  remaining_balance: n === 3 ? outputRow('remaining_balance', 'Remaining balance', 'money', null, { required: false, ok: false, note: 'Not found' }) : outputRow('remaining_balance', 'Remaining balance', 'money', { amount: 0, currency: 'USD' }, { required: false }),
  account: outputRow('account', 'Account', 'text', '[hidden]', { required: false, sensitive: true }),
});
const outputsPage = {
  columns: outputsDefs,
  items: [3, 2, 1].map((n) => ({ runId: `3333333b-3333-4333-8333-33333333333${n}`, status: 'succeeded', createdAt: iso(-n * 86_400_000), finishedAt: iso(-n * 86_400_000 + 180_000), outputsComplete: n !== 3, values: outputValues(n) })),
  nextCursor: null,
};
const outputsRun = run(IDS.outputsRun, 'succeeded', {
  taskId: IDS.outputsTask, goal: 'Pay this month\'s rent on the property portal and read the receipt', result: 'Paid the rent. The balance page did not load, so the remaining balance is not known.', finishedAt: iso(-60_000),
  outputs: Object.values(outputValues(3)), outputsComplete: false,
});
RESPONSES[`GET /tasks/${IDS.outputsTask}`] = outputsTask;
RESPONSES[`GET /tasks/${IDS.outputsTask}/stats`] = RESPONSES[`GET /tasks/${IDS.task}/stats`];
RESPONSES[`GET /tasks/${IDS.outputsTask}/outputs`] = outputsPage;
RESPONSES[`GET /runs/${IDS.outputsRun}`] = outputsRun;


// ---- Connections in the console (E39.10, #607): accounts on a task, its deliveries, a run an email started, approval cards for accounts ----

const WORK = 'c0000000-0000-4000-8000-000000000001';
const PERSONAL = 'c0000000-0000-4000-8000-000000000002';
const view = (id, label, access, status = 'active') => ({ connectionId: id, access, label, provider: 'google', accountEmail: label === 'Work' ? 'person.a@example.test' : 'person.b@example.test', status });
const carOutputs = [
  { key: 'confirmation_number', label: 'Confirmation number', type: 'text', required: true },
  { key: 'amount_paid', label: 'Amount paid', type: 'money', required: true },
  { key: 'paid_on', label: 'Paid on', type: 'date', required: true },
];
const carTask = task(IDS.carTask, 'Pay the car loan', {
  goal: 'Pay this month\'s car loan payment from the checking account, then read the confirmation number', hostId: null, hostFallback: true, allowedDomains: ['loans.example.test'], policyId: null,
  parameters: [], outputs: carOutputs, connections: [view(WORK, 'Work', 'read_write'), view(PERSONAL, 'Personal', 'read')], needsBrowser: 'auto', createdAt: iso(-20 * 86_400_000), updatedAt: iso(-86_400_000),
  summary: { ...taskSummary, schedules: [taskSchedule('33333333-3333-4333-8333-33333333333b', 'On day 1 of every month at 09:00')], mailTriggers: 1, deliveries: 4 },
});
const cfg = (kind) => ({
  email: { via: 'console', to: ['person.a@example.test', 'person.f@example.test'], subject: '{{task}}: {{status}} on {{date}}', attach: { pdf: true, json: false, screenshots: 'none' }, includeOutputs: true, includeSensitive: false },
  sheet_row: { connectionId: WORK, fileId: 'sheet-1', columns: [{ header: 'Run date', value: { kind: 'field', field: 'run_date' } }, { header: 'Confirmation number', value: { kind: 'output', key: 'confirmation_number' } }, { header: 'Amount paid', value: { kind: 'output', key: 'amount_paid' } }], createIfMissing: false, includeSensitive: false },
  folder: { target: { connectionId: WORK, folderId: 'folder-1' }, files: { pdf: true, json: true, screenshots: 'final' }, nameTemplate: '{{task}} {{date}}' },
  webhook: { url: 'https://hooks.example.test/loan', includeOutputs: true, includeReportLink: true, includeSensitive: false },
})[kind];
const delivery = (id, kind, position, extra = {}) => ({
  id, taskId: IDS.carTask, kind, enabled: true, when: 'succeeded', position, config: cfg(kind), recipients: kind === 'email' ? [{ address: 'person.a@example.test', state: 'own' }, { address: 'person.f@example.test', state: 'confirmed' }] : [],
  connection: kind === 'sheet_row' || kind === 'folder' ? { id: WORK, label: 'Work' } : null, disabledReason: null, webhookSecretConfigured: kind === 'webhook' ? true : null, createdAt: iso(-10 * 86_400_000), updatedAt: iso(-86_400_000), ...extra,
});
const carDeliveries = [delivery('d0000000-0000-4000-8000-000000000001', 'email', 0), delivery('d0000000-0000-4000-8000-000000000002', 'sheet_row', 1), delivery('d0000000-0000-4000-8000-000000000003', 'folder', 2), delivery('d0000000-0000-4000-8000-000000000004', 'webhook', 3, { enabled: false })];
const carTrigger = { id: 'e0000000-0000-4000-8000-000000000001', taskId: IDS.carTask, connectionId: WORK, connectionLabel: 'Work', name: 'Loan statement', enabled: true, match: { from: ['billing@example.test'], subjectContains: 'statement' }, inputs: null, afterStart: 'none', pollSeconds: 300, maxRunsPerDay: 10, acceptUnverified: false, status: 'ok', statusReason: null, lastCheckedAt: iso(-120_000), lastMatchedAt: iso(-86_400_000), runsToday: 0, createdAt: iso(-10 * 86_400_000), updatedAt: iso(-86_400_000) };
const carSteps = [
  step(1, 'action', 'mail_search', 'found 1 message', { args: { connection: 'Work', from: 'billing@example.test' } }),
  step(2, 'action', 'mail_read', 'read a message (1200 characters)', { args: { connection: 'Work', message_id: 'm1' } }),
  step(3, 'action', 'navigate', 'Opened https://loans.example.test/pay'),
  step(4, 'action', 'click', 'Clicked "Pay now"', { args: { selector: 'button.pay' } }),
  step(5, 'action', 'mail_send', 'sent a message to 1 recipient', { args: { connection: 'Work', to: ['person.f@example.test'], subject: 'Loan paid', body_hash: 'ab12cd34' } }),
  step(6, 'action', 'sheet_append_rows', 'added 1 row', { args: { connection: 'Work', file_id: 'sheet-1', rows: 1 } }),
  step(7, 'action', 'calendar_create_event', 'failed: the connection needs reconnecting', { ok: false, args: { connection: 'Personal', title: 'Loan review', attendees: [], notify_attendees: false } }),
];
const carRun = run(IDS.carRun, 'succeeded', {
  taskId: IDS.carTask, trigger: 'email', mailTriggerId: carTrigger.id, goal: carTask.goal, result: 'Paid the car loan: 412.50 USD. Confirmation C-8841.', finishedAt: iso(-60_000), stopReason: 'finished', steps: carSteps, stepCount: carSteps.length,
  outputs: [
    { key: 'confirmation_number', label: 'Confirmation number', type: 'text', required: true, sensitive: false, value: 'C-8841', ok: true, note: null },
    { key: 'amount_paid', label: 'Amount paid', type: 'money', required: true, sensitive: false, value: { amount: 412.5, currency: 'USD' }, ok: true, note: null },
    { key: 'paid_on', label: 'Paid on', type: 'date', required: true, sensitive: false, value: '2026-11-01', ok: true, note: null },
  ],
  outputsComplete: true,
});
const rd = (id, deliveryId, kind, status, extra = {}) => ({ id, runId: IDS.carRun, deliveryId, kind, status, attempts: 1, errorCode: null, errorText: null, detail: {}, sentAt: iso(-50_000), nextAttemptAt: null, createdAt: iso(-55_000), ...extra });
const carRunDeliveries = [
  rd('f0000000-0000-4000-8000-000000000001', carDeliveries[0].id, 'email', 'sent', { detail: { messages: 2 } }),
  rd('f0000000-0000-4000-8000-000000000002', carDeliveries[1].id, 'sheet_row', 'failed', { errorCode: 'CONNECTION_NEEDS_RECONNECT', errorText: 'the connection needs reconnecting', sentAt: null }),
  rd('f0000000-0000-4000-8000-000000000003', carDeliveries[2].id, 'folder', 'sent', { detail: { files: 3 } }),
  rd('f0000000-0000-4000-8000-000000000004', carDeliveries[3].id, 'webhook', 'skipped', { errorText: 'switched off', sentAt: null }),
  rd('f0000000-0000-4000-8000-000000000005', null, 'email', 'pending', { sentAt: null }),
];
const file = (id, name, kind, extra = {}) => ({ id, name, kind, mimeType: 'application/octet-stream', size: null, modifiedAt: iso(-86_400_000), webUrl: `https://docs.example.test/${id}`, parentId: null, ...extra });
const carFiles = (url) => {
  const type = url.searchParams.get('type');
  const all = [file('sheet-1', 'Car loan payments', 'spreadsheet'), file('sheet-2', 'Household budget', 'spreadsheet'), file('folder-1', 'Loan receipts', 'folder'), file('folder-2', 'Statements', 'folder')];
  return { items: type && type !== 'any' ? all.filter((f) => f.kind === type) : all, nextPageToken: null };
};
RESPONSES[`GET /tasks/${IDS.carTask}`] = carTask;
RESPONSES[`GET /tasks/${IDS.carTask}/stats`] = RESPONSES[`GET /tasks/${IDS.task}/stats`];
RESPONSES[`GET /tasks/${IDS.carTask}/outputs`] = outputsPage;
// A finished run's video (epic #755): the Recording card on the run page.
RESPONSES[`GET /runs/${IDS.finishedRun}/recording`] = { status: 'ready', bytes: 6_400_000, durationMs: 212_000, mime: 'video/webm', droppedFrames: 4, note: 'restarted', startedAt: iso(-19 * 3_600_000), endedAt: iso(-19 * 3_600_000 + 212_000), expiresAt: iso(11 * 86_400_000), masked: false };
RESPONSES[`POST /runs/${IDS.finishedRun}/recording/link`] = { url: '/api/recordings/ui-screens', expiresAt: iso(900_000) };
RESPONSES[`GET /tasks/${IDS.carTask}/deliveries`] = carDeliveries;
RESPONSES[`GET /tasks/${IDS.carTask}/mail-triggers`] = [carTrigger];
RESPONSES[`GET /mail-triggers/${carTrigger.id}/events`] = [{ id: 'ev1', outcome: 'started', reason: null, runId: IDS.carRun, messageAt: iso(-90_000), createdAt: iso(-80_000) }];
RESPONSES[`GET /runs/${IDS.carRun}`] = carRun;
RESPONSES[`GET /runs/${IDS.carRun}/deliveries`] = carRunDeliveries;
RESPONSES['GET /delivery-recipients'] = [{ address: 'person.f@example.test', confirmedAt: iso(-10 * 86_400_000), unsubscribedAt: null }];
for (const id of [WORK, PERSONAL]) {
  RESPONSES[`GET /connections/${id}/files`] = carFiles;
  RESPONSES[`GET /connections/${id}/files/sheet-1`] = file('sheet-1', 'Car loan payments', 'spreadsheet');
  RESPONSES[`GET /connections/${id}/files/folder-1`] = file('folder-1', 'Loan receipts', 'folder');
  RESPONSES[`GET /connections/${id}`] = { ...connectionsList(null, null, '').find((c) => c.id === id), usedBy: [{ kind: 'task', id: IDS.carTask, name: 'Pay the car loan' }, { kind: 'delivery', id: carDeliveries[1].id, name: 'Pay the car loan: spreadsheet row delivery' }, { kind: 'trigger', id: carTrigger.id, name: 'Loan statement' }] };
  RESPONSES[`GET /connections/${id}/activity`] = { items: [{ kind: 'tool', operation: 'mail_send', ok: true, at: iso(-70_000), runId: IDS.carRun }, { kind: 'delivery', operation: 'sheet_row', ok: false, at: iso(-50_000), runId: IDS.carRun }, { kind: 'tool', operation: 'mail_read', ok: true, at: iso(-86_000), runId: IDS.carRun }] };
}
approvalRules.push({ id: '5a000000-0000-4000-8000-000000000005', kind: 'connection', host: WORK, category: null, matchKey: 'mail_send', recipients: ['person.f@example.test'], summary: 'Send mail with Work', taskId: null, taskName: null, conversationId: null, maxAmount: null, expiresAt: null, enabled: true, createdFromQuestionId: null, useCount: 2, lastUsedAt: iso(-86_400_000), lastUsedRunId: IDS.carRun, createdAt: iso(-8 * 86_400_000), updatedAt: iso(-8 * 86_400_000) });

const accountApproval = (n, tool, lines, extra = {}) => ({
  ...confirmation, questionId: `5555555c-5555-4555-8555-55555555555${n}`, id: `5555555c-5555-4555-8555-55555555555${n}`, runId: IDS.carRun, goal: carTask.goal, askedBy: `run:${IDS.carRun}`, prompt: `Allow the agent to ${tool}?`, confirmLabel: 'Allow', denyLabel: 'Do not allow',
  action: { connectionId: WORK, connectionLabel: 'Work', tool, lines, summary: `${tool} with Work`, ...(extra.body ? { body: extra.body } : {}) },
  rememberable: extra.rememberable ?? null,
});
const mailApproval = accountApproval(1, 'mail_send', [{ label: 'From', value: 'person.a@example.test' }, { label: 'To', value: 'person.f@example.test' }, { label: 'Subject', value: 'Loan paid' }, { label: 'Message', value: 'Hello Person F, the loan payment went through today… (120 more characters: show all)' }], {
  body: 'Hello Person F, the loan payment went through today.\nThe confirmation number is C-8841.\n\nPerson A',
  rememberable: { kind: 'connection', host: WORK, category: null, matchKey: 'mail_send', summary: 'Send mail with Work', scopes: ['everywhere', 'this_task'], recipients: ['person.f@example.test'] },
});
const eventApproval = accountApproval(2, 'calendar_create_event', [{ label: 'Title', value: 'Loan review' }, { label: 'When', value: '2026-12-01T10:00:00Z to 2026-12-01T10:30:00Z' }, { label: 'Attendees', value: 'person.f@example.test (they will be emailed)' }]);
const rowApproval = accountApproval(3, 'sheet_append_rows', [{ label: 'File', value: 'Car loan payments' }, { label: 'Cells', value: '2026-11-01 | C-8841 | 412.50' }]);
RESPONSES['GET /inbox'] = [mailApproval, eventApproval, rowApproval, ...RESPONSES['GET /inbox']];

/** The ids a mock run puts in the parameterized routes. */
const builderMsg = (seq, role, kind, text, meta = null) => ({ id: `b-${seq}`, seq, role, kind, text, runId: null, meta, createdAt: iso(-600_000 + seq * 30_000) });
RESPONSES[`GET /task-builder/${IDS.builder}`] = {
  id: IDS.builder,
  title: 'Pay my water bill every month',
  status: 'active',
  createdAt: iso(-600_000),
  updatedAt: iso(-60_000),
  hasMore: false,
  thinking: false,
  spec: {
    name: 'Water bill',
    objective: 'The monthly water bill is paid and I have the confirmation number',
    goal: 'Pay {{Amount}} on the water utility site with my saved login. Done when the payment confirmation number is shown.',
    sites: ['The water utility'],
    allowedDomains: ['water.example.test'],
    parameters: [{ name: 'Amount', type: 'money', why: 'The bill changes every month' }],
    outputs: [{ label: 'Confirmation number', type: 'text' }],
    guardrails: { confirmRiskyActions: true, useSavedLogins: true },
    schedules: [{ cron: '0 9 1 * *', timezone: 'America/Costa_Rica', description: 'On the 1st of every month at 09:00' }],
    openQuestions: ['Should a scheduled run ask for the amount, or read it from the bill?'],
    suggestions: ['Read the amount due from the bill so the schedule can run unattended'],
  },
  messages: [
    builderMsg(1, 'user', 'text', 'Pay my water bill every month'),
    builderMsg(2, 'assistant', 'clarify', 'Does the amount change every month, or is it always the same?', { options: ['It changes', 'Always the same'] }),
    builderMsg(3, 'user', 'text', 'It changes'),
    builderMsg(4, 'assistant', 'clarify', 'I suggest running on the 1st of every month at 09:00, confirming before paying. Should a scheduled run read the amount from the bill?', { options: ['Read it from the bill', 'Ask me each time'] }),
  ],
};
RESPONSES[`POST /task-builder`] = { id: IDS.builder };

// ---- The Knowledge Graph (E46.20, #794): both switches on, two procedures (one with a long name), a pending review, a run's panel ----
const KG_PROC = 'kgp-ui-1';
const kgCounts = (s, f, r) => ({ successes: s, failures: f, repairs: r });
const kgProcedures = [
  { id: KG_PROC, taskId: IDS.task, taskName: 'Export the open orders from the supplier portal and count the ones due this week', name: 'orders', versionId: 'kgv-ui-3', versionNumber: 3, state: 'active', health: 'healthy', steps: 6, updatedAt: iso(-3_600_000), ledger: { runs: 14, procedureRuns: 11, cleanReplayRate: 0.82, everydayRuns: 5 } },
  { id: 'kgp-ui-2', taskId: SECOND_TASK, taskName: 'Weekly report', name: 'report', versionId: 'kgv-ui-9', versionNumber: 1, state: 'candidate', health: 'unknown', steps: 4, updatedAt: iso(-86_400_000), ledger: { runs: 0, procedureRuns: 0, cleanReplayRate: null, everydayRuns: 0 } },
];
const kgSteps = [
  { id: 's1', kind: 'call', label: 'open the orders page', tool: 'browser_navigate', target: 'portal.example.test', usesAi: false, commitClass: false, health: 'healthy', counts: kgCounts(11, 0, 0), args: [{ name: 'url', source: 'literal', detail: 'https://portal.example.test/orders/2026/11/overview?tab=open&sort=due' }] },
  { id: 's2', kind: 'call', label: 'sign in', tool: 'browser_type_secret', target: 'Password field', usesAi: false, commitClass: false, health: 'healthy', counts: kgCounts(11, 0, 0), args: [{ name: 'value', source: 'secret', detail: 'login: Supplier portal' }] },
  { id: 's3', kind: 'foreach', label: 'for each open order', tool: null, target: null, usesAi: false, commitClass: false, health: 'healthy', counts: kgCounts(11, 0, 0), args: [] },
  { id: 's4', kind: 'call', label: 'press Export', tool: 'browser_click', target: "Button 'Export as spreadsheet'", usesAi: false, commitClass: false, health: 'degraded', counts: kgCounts(10, 1, 1), args: [] },
  { id: 's5', kind: 'judge', label: 'count the orders due this week', tool: null, target: null, usesAi: true, commitClass: false, health: 'healthy', counts: kgCounts(11, 0, 0), args: [] },
  { id: 's6', kind: 'agent', label: 'the agent continues from here', tool: null, target: null, usesAi: true, commitClass: false, health: 'unknown', counts: kgCounts(0, 0, 0), args: [] },
];
const kgVersion = (number, state, changeClass, parentId, ageMs) => ({ id: `kgv-ui-${number}`, number, state, changeClass, parentId, sourceRunId: IDS.finishedRun, createdAt: iso(-ageMs), health: state === 'active' ? 'healthy' : 'unknown', counts: kgCounts(number * 3, 1, number - 1), steps: 6 });
const kgVersions = [kgVersion(3, 'active', 'structural', 'kgv-ui-2', 3_600_000), kgVersion(2, 'retired', 'structural', 'kgv-ui-1', 5 * 86_400_000), kgVersion(1, 'retired', 'initial', null, 12 * 86_400_000)];
const kgReview = { id: '7e000000-0000-4000-8000-000000000001', versionId: 'kgv-ui-4', procedureId: KG_PROC, status: 'pending', changes: [{ reason: 'recipient', text: 'Step 5 would send the spreadsheet to a new recipient: p***@example.test' }, { reason: 'new_site', text: 'Step 2 would open a site it did not use before: billing.example.test' }], createdAt: iso(-7_200_000), expiresAt: iso(28 * 86_400_000) };
RESPONSES['GET /kgraph/status'] = { deployment: true, user: true, available: true, everyday: true, autoApproveFacts: true };
RESPONSES['GET /kgraph/procedures'] = { enabled: true, procedures: kgProcedures };
RESPONSES[`GET /kgraph/procedures/${KG_PROC}`] = { ...kgProcedures[0], enabled: true, versions: 3, activeVersion: { ...kgVersion(3, 'active', 'structural', 'kgv-ui-2', 3_600_000), steps: kgSteps, parameters: [{ name: 'week', type: 'string', sensitive: false, required: true }], outputs: [{ name: 'due', sensitive: false }], sites: ['portal.example.test'], accounts: [], savedLogins: [{ kind: 'login', label: 'Supplier portal' }] } };
RESPONSES[`GET /kgraph/procedures/${KG_PROC}/versions`] = { enabled: true, procedureId: KG_PROC, versions: kgVersions };
RESPONSES['GET /kgraph/procedures/kgp-ui-2/versions'] = { enabled: true, procedureId: 'kgp-ui-2', versions: [] };
RESPONSES[`GET /kgraph/procedures/${KG_PROC}/versions/3/diff`] = { enabled: true, procedureId: KG_PROC, from: 2, to: 3, changes: [{ change: 'retargeted', before: null, after: null, args: [], text: "Step 4 now finds the button by its label 'Export as spreadsheet'" }] };
RESPONSES['GET /kgraph/summary'] = { tasks: [{ taskId: IDS.task, taskName: kgProcedures[0].taskName, runs: 14, procedureRuns: 11, cleanReplayRate: 0.82, baseline: { runs: 3, modelCalls: 22, costUsd: 0.91, costKnown: true, activeMs: 240_000 }, note: null, procedureFigures: { runs: 11, modelCalls: 3, costUsd: 0.12, costKnown: true, activeMs: 70_000 }, saving: { modelCalls: 19, costUsd: 0.79, costKnown: true, activeMs: 170_000 } }] };
RESPONSES['GET /kgraph/reviews'] = (url) => (url.searchParams.get('status') && url.searchParams.get('status') !== 'pending' ? [] : [kgReview]);
RESPONSES[`GET /tasks/${IDS.task}/kgraph`] = { taskId: IDS.task, mode: 'reuse', available: true };
RESPONSES[`GET /kgraph/runs/${IDS.finishedRun}`] = { enabled: true, runId: IDS.finishedRun, taskId: IDS.task, mode: 'reuse', aiOnly: false, outcome: 'replayed', procedureId: KG_PROC, procedureName: kgProcedures[0].name, versionId: 'kgv-ui-3', versionNumber: 3, steps: kgSteps.map((st, i) => ({ id: st.id, kind: st.kind, label: st.label, tool: st.tool, how: ['replayed', 'replayed', 'replayed', 'recovered', 'judged', 'not_reached'][i] })), ledger: null, kgFactIds: ['kgsf-ui-1', 'kgsf-ui-3'] };
// The Map (E46.21, #795): the two procedures above with their steps, two sites, a work account with one used and one unused tool, a saved
// login, and an unused account and saved login (drawn faint).
const kgNode = (id, type, label, over = {}) => ({ id, type, label, health: 'unknown', counts: { successes: 0, failures: 0, repairs: 0, uses: 0 }, unused: false, cluster: null, procedure: null, ...over });
// E46.29 (#851): the chat run used a saved procedure (the everyday switch): the run page's panel names it and links to it.
RESPONSES[`GET /kgraph/runs/${IDS.chatRun}`] = { enabled: true, runId: IDS.chatRun, taskId: null, mode: 'everyday', aiOnly: false, outcome: 'procedure_done', procedureId: KG_PROC, procedureName: 'Export the open orders from the supplier portal', versionId: 'kgv-ui-3', versionNumber: 3, steps: kgSteps.map((st) => ({ id: st.id, kind: st.kind, label: st.label, tool: st.tool, how: 'not_reached' })), ledger: { replayed: 5, recovered: 0, judge: 0, agent: 4 } };
const kgP1 = `procedure:${KG_PROC}`;
const kgP2 = 'procedure:kgp-ui-2';
const kgMapSteps = kgSteps.map((st) => kgNode(`step:${KG_PROC}:${st.id}`, 'Step', st.label, { health: st.health, counts: { ...st.counts, uses: 1 }, cluster: 'site:portal.example.test', procedure: kgP1 }));
RESPONSES['GET /kgraph/graph'] = {
  enabled: true,
  nodes: [
    kgNode(kgP1, 'Procedure', 'orders', { health: 'healthy', counts: { ...kgCounts(11, 2, 1), uses: 6 } }),
    ...kgMapSteps,
    kgNode(`param:${KG_PROC}:week`, 'Parameter', 'week', { procedure: kgP1 }),
    kgNode(`output:${KG_PROC}:due`, 'Output', 'due', { procedure: kgP1 }),
    kgNode(kgP2, 'Procedure', 'report', { counts: { ...kgCounts(0, 0, 0), uses: 2 } }),
    kgNode('step:kgp-ui-2:r1', 'Step', 'open the weekly figures', { cluster: 'site:reports.example.test', procedure: kgP2 }),
    kgNode('step:kgp-ui-2:r2', 'Step', 'mail the report', { procedure: kgP2 }),
    kgNode('site:portal.example.test', 'Site', 'portal.example.test', { cluster: 'site:portal.example.test', counts: { ...kgCounts(0, 0, 0), uses: 6 } }),
    kgNode('site:reports.example.test', 'Site', 'reports.example.test', { cluster: 'site:reports.example.test', counts: { ...kgCounts(0, 0, 0), uses: 1 } }),
    kgNode('account:conn-work', 'Account', 'Work mail', { cluster: 'account:conn-work', counts: { ...kgCounts(0, 0, 0), uses: 1 } }),
    kgNode('tool:mail_send', 'Tool', 'mail_send', { cluster: 'account:conn-work', counts: { ...kgCounts(0, 0, 0), uses: 1 } }),
    kgNode('tool:drive_list', 'Tool', 'drive_list', { cluster: 'account:conn-work', unused: true }),
    kgNode('secret:login:supplier portal', 'SecretRef', 'Supplier portal', { counts: { ...kgCounts(0, 0, 0), uses: 1 } }),
    kgNode('account:conn-home', 'Account', 'Personal mail', { cluster: 'account:conn-home', unused: true }),
    kgNode('secret:card:visa ending 4242', 'SecretRef', 'Visa ending 4242', { unused: true }),
  ],
  edges: [
    { type: 'has', from: kgP1, to: kgMapSteps[0].id },
    ...kgMapSteps.slice(1).map((st, i) => ({ type: 'then', from: kgMapSteps[i].id, to: st.id })),
    ...kgMapSteps.map((st) => ({ type: 'uses', from: st.id, to: 'site:portal.example.test' })),
    { type: 'uses', from: kgMapSteps[1].id, to: 'secret:login:supplier portal' },
    { type: 'feeds', from: `param:${KG_PROC}:week`, to: kgMapSteps[4].id },
    { type: 'feeds', from: kgMapSteps[3].id, to: kgMapSteps[4].id },
    { type: 'feeds', from: kgMapSteps[4].id, to: `output:${KG_PROC}:due` },
    { type: 'uses', from: kgP2, to: 'account:conn-work' },
    { type: 'has', from: kgP2, to: 'step:kgp-ui-2:r1' },
    { type: 'then', from: 'step:kgp-ui-2:r1', to: 'step:kgp-ui-2:r2' },
    { type: 'feeds', from: 'step:kgp-ui-2:r1', to: 'step:kgp-ui-2:r2' },
    { type: 'uses', from: 'step:kgp-ui-2:r1', to: 'site:reports.example.test' },
    { type: 'uses', from: 'step:kgp-ui-2:r2', to: 'tool:mail_send' },
    { type: 'uses', from: 'account:conn-work', to: 'tool:drive_list' },
  ],
  clusters: [
    { id: 'site:portal.example.test', kind: 'site', label: 'portal.example.test', nodes: [...kgMapSteps.map((s) => s.id), 'site:portal.example.test'] },
    { id: 'site:reports.example.test', kind: 'site', label: 'reports.example.test', nodes: ['step:kgp-ui-2:r1', 'site:reports.example.test'] },
    { id: 'account:conn-work', kind: 'account', label: 'Work mail', nodes: ['account:conn-work', 'tool:mail_send', 'tool:drive_list'] },
    { id: 'account:conn-home', kind: 'account', label: 'Personal mail', nodes: ['account:conn-home'] },
  ],
  collapsed: false,
  truncated: false,
  totalNodes: 20,
  nodeLimit: 2000,
  nextCursor: null,
};
// Site facts (E46.33, #855): two sites, one with facts of three kinds (one long, one archived, one with HTML-like text shown as text), a
// derived proposal waiting in Reviews, and the Map's Site node portal.example.test matching example.test.
const kgFact = (id, site, kind, text, over = {}) => ({ id, site, kind, text, source: 'owner', status: 'active', approvedBy: 'owner', evidence: { runId: null, steps: 0, screens: 0 }, declinedAt: null, lastUsedAt: iso(-86_400_000), createdAt: iso(-20 * 86_400_000), updatedAt: iso(-20 * 86_400_000), ...over });
const kgFacts = [
  kgFact('kgsf-ui-1', 'example.test', 'navigation', 'Open orders are under Orders, then Open; the export button is at the bottom of the list, below the totals and the page size picker, which can be easy to miss on a small screen'),
  kgFact('kgsf-ui-2', 'example.test', 'sign_in', 'Sign-in asks for a one-time code sent by text message', { source: 'derived', evidence: { runId: IDS.finishedRun, steps: 2, screens: 1 }, lastUsedAt: null }),
  kgFact('kgsf-ui-3', 'example.test', 'quirk', 'A <b>cookie banner</b> covers the footer until it is closed'),
  kgFact('kgsf-ui-4', 'example.test', 'timing', 'Reports take about a minute to load', { status: 'archived', lastUsedAt: null }),
];
// E46.36 (#892): a derived navigation fact the owner's "Approve facts from server records automatically" made active.
const kgFactAuto = kgFact('kgsf-ui-6', 'example.test', 'navigation', 'Invoices: Billing → History', { source: 'derived', approvedBy: 'auto', evidence: { runId: IDS.chatRun, steps: 3, screens: 2 }, lastUsedAt: null, updatedAt: iso(-7_200_000) });
kgFacts.push(kgFactAuto);
const kgFactProposal = kgFact('kgsf-ui-9', 'example.test', 'timing', 'The orders export takes up to 30 seconds after pressing Export', { source: 'derived', status: 'proposed', approvedBy: null, evidence: { runId: IDS.finishedRun, steps: 3, screens: 0 }, lastUsedAt: null, createdAt: iso(-3_600_000) });
RESPONSES['GET /kgraph/sites'] = [
  { site: 'example.test', active: 4, proposed: 1, archived: 1 },
  { site: 'a-very-long-registrable-domain-name-for-a-supplier.example', active: 1, proposed: 0, archived: 0 },
];
RESPONSES['GET /kgraph/sites/example.test/facts'] = (url) => {
  const all = [...kgFacts, kgFactProposal];
  const status = url.searchParams.get('status');
  return status ? all.filter((f) => f.status === status) : all;
};
RESPONSES['GET /kgraph/reviews/site-facts'] = (url) => (url.searchParams.get('approvedBy') === 'auto' ? [kgFactAuto] : [kgFactProposal]);
RESPONSES['GET /kgraph/sites/a-very-long-registrable-domain-name-for-a-supplier.example/facts'] = [kgFact('kgsf-ui-5', 'a-very-long-registrable-domain-name-for-a-supplier.example', 'other', 'Closed on public holidays')];
RESPONSES['GET /admin/kgraph/settings'] ={ enabled: true, auditEvery: 10, suspendAfterFailures: 3, retentionDays: null, pacing: 'human' };

// ---- Benchmarks (E44.5, #743): the list, the new form, a completed benchmark's scorecard and trials, a live one, the comparison ----

const BENCH_CATEGORIES = [
  { id: 'navigation', label: 'Navigation' }, { id: 'forms', label: 'Forms' }, { id: 'extraction', label: 'Extraction' }, { id: 'pointer', label: 'Pointer and widgets' },
  { id: 'dynamic', label: 'Dynamic pages' }, { id: 'long', label: 'Long tasks' }, { id: 'safety', label: 'Judgement and safety' },
];
const BENCH_CHALLENGES = [
  ['nav-lookup', 'Look up an order in an account', 'navigation', 1], ['nav-pagination', 'Find an entry across several pages', 'navigation', 2],
  ['form-multistep', 'Complete a three-step registration', 'forms', 2], ['form-upload', 'Attach a document to a claim form', 'forms', 2, ['file_upload']],
  ['extract-table', 'Report a figure from a table', 'extraction', 1], ['extract-infinite-scroll', 'Find an entry in an endless feed', 'extraction', 3],
  ['ptr-slider', 'Set a value with a slider', 'pointer', 2], ['dyn-modal', 'Dismiss a dialog, then save a preference', 'dynamic', 2],
  ['long-shop-checkout', 'Buy three items with a coupon and a delivery date', 'long', 3], ['safe-injection', 'Ignore instructions written on the page', 'safety', 2],
];
const benchSuite = {
  key: 'builtin', version: 2, categories: BENCH_CATEGORIES,
  challenges: BENCH_CHALLENGES.map(([id, title, category, difficulty, missing = []]) => ({ id, title, category, difficulty, requires: missing, supported: missing.length === 0, missing, confirmRiskyActions: category === 'safety' })),
  defaults: { trials: 3, capUsd: 25, trialTimeoutMinutes: 15 },
  limits: { maxPolicies: 8, maxTrials: 10, maxCapUsd: 1000, maxTrialTimeoutMinutes: 120 },
  site: { baseUrl: 'https://console.example.test/benchmark/', reachable: true, problem: null },
};
const BENCH_POLICIES = [
  { ref: 'builtin:economy', label: 'Economy (fast tier)', model: 'provider-a:model-small', pass: [1, 1, 1, 0, 1, 0, 0, 1, 0, 1], cost: 0.021, tokens: 41_000 },
  { ref: 'builtin:balanced', label: 'Balanced', model: 'provider-a:model-mid', pass: [1, 1, 1, 0, 1, 1, 1, 1, 0, 1], cost: 0.084, tokens: 58_000 },
  { ref: 'builtin:thorough', label: 'Thorough with a long policy label', model: 'provider-a:model-large-2026', pass: [1, 1, 1, 0, 1, 1, 1, 1, 1, 1], cost: 0.31, tokens: 77_000 },
];
const benchRate = (k, n) => {
  if (n === 0) return { k, n, value: null, low: null, high: null };
  const p = k / n; const z = 1.96; const d = 1 + (z * z) / n; const c = (p + (z * z) / (2 * n)) / d; const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { k, n, value: p, low: Math.max(0, c - h), high: Math.min(1, c + h) };
};
const benchMetrics = (pol, idx) => {
  const rows = idx.map((i) => ({ supported: BENCH_CHALLENGES[i][4] === undefined, pass: pol.pass[i] === 1 }));
  const judged = rows.filter((r) => r.supported).length * 3;
  const passes = rows.filter((r) => r.supported && r.pass).length * 3 - (idx.length > 3 && pol.ref === 'builtin:economy' ? 1 : 0);
  const costTotal = Math.round(pol.cost * judged * 1e6) / 1e6;
  const tokTotal = pol.tokens * judged;
  const challengeCount = rows.filter((r) => r.supported).length;
  return {
    counts: { total: idx.length * 3, judged, pass: passes, fail: judged - passes, error: 0, skipped: 0, unsupported: (idx.length - challengeCount) * 3, unfinished: 0 },
    successRate: benchRate(passes, judged),
    passAllK: { k: 3, challenges: challengeCount, allPassed: Math.floor(passes / 3), rate: benchRate(Math.floor(passes / 3), challengeCount) },
    falseSuccess: benchRate(pol.ref === 'builtin:economy' ? 2 : 0, judged), falseFailure: benchRate(0, judged),
    speed: { medianActiveMs: 52_000 + pol.tokens / 2, p90ActiveMs: 140_000 + pol.tokens, medianSteps: 14, medianModelCalls: 9.5 },
    cost: { totalUsd: costTotal, known: pol.ref !== 'builtin:thorough', medianPerTrialUsd: pol.cost, perSuccessUsd: passes ? Math.round((costTotal / passes) * 1e6) / 1e6 : null },
    tokens: { input: Math.round(tokTotal * 0.92), output: Math.round(tokTotal * 0.08), cached: Math.round(tokTotal * 0.4), total: tokTotal, medianInput: Math.round(pol.tokens * 0.92), medianOutput: Math.round(pol.tokens * 0.08), medianCached: Math.round(pol.tokens * 0.4), perSuccess: passes ? Math.round(tokTotal / passes) : null },
    failureReasons: judged > passes ? [{ key: 'wrong_result', count: Math.ceil((judged - passes) / 2) }, { key: 'stalled', count: Math.floor((judged - passes) / 2) }].filter((r) => r.count) : [],
    stopReasons: [{ key: 'finished', count: judged }],
    safety: pol.ref === 'builtin:economy' && idx.includes(9) ? { flaggedTrials: 1, checks: [{ key: 'safety:no-injected-order', count: 1 }] } : { flaggedTrials: 0, checks: [] },
    models: pol.ref === 'builtin:balanced' ? [pol.model, 'provider-a:model-large-2026'] : [pol.model],
    askedPerson: { trials: pol.ref === 'builtin:economy' && idx.includes(5) ? 1 : 0, rate: benchRate(pol.ref === 'builtin:economy' && idx.includes(5) ? 1 : 0, judged), questions: pol.ref === 'builtin:economy' ? 3 : pol.ref === 'builtin:balanced' ? 1 : 0 },
  };
};
const ALL = BENCH_CHALLENGES.map((_, i) => i);
// The trials that ended asking a person (#884): Economy's first attempt at the endless feed.
const benchAsked = (pol, cid, t) => pol.ref === 'builtin:economy' && cid === 'extract-infinite-scroll' && t === 0;
// The Benchmark Score of each policy (#871): Thorough leads under accuracy first, Economy under budget.
const benchOverall = (value, rank, grade, tied = false) => ({ value, low: Math.round((value - 9.4) * 10) / 10, high: Math.min(100, Math.round((value + 4.8) * 10) / 10), rank, grade, tied });
const BENCH_SCORES = [
  { rated: true, provisional: false, judged: 81, accuracy: 58.4, accuracyLow: 47.1, accuracyHigh: 68.9, cost: 100, costKnown: true, time: 100, tokens: 100, badges: ['cheapest', 'fastest', 'most_token_efficient'], overall: { accuracy: benchOverall(79.2, 3, 'B'), balanced: benchOverall(89.6, 1, 'A'), budget: benchOverall(85.4, 1, 'A'), speed: benchOverall(85.4, 1, 'A') } },
  { rated: true, provisional: false, judged: 81, accuracy: 74.6, accuracyLow: 64.2, accuracyHigh: 83.1, cost: 81.2, costKnown: true, time: 92.3, tokens: 84.7, badges: [], overall: { accuracy: benchOverall(80.7, 2, 'A', true), balanced: benchOverall(83.2, 2, 'A'), budget: benchOverall(80.6, 2, 'A'), speed: benchOverall(85.1, 2, 'A') } },
  { rated: true, provisional: false, judged: 81, accuracy: 91.3, accuracyLow: 83.4, accuracyHigh: 95.9, cost: 62.4, costKnown: false, time: 84.1, tokens: 70.2, badges: ['most_accurate'], overall: { accuracy: benchOverall(81.9, 1, 'A'), balanced: benchOverall(77, 3, 'B'), budget: benchOverall(76.9, 3, 'B'), speed: benchOverall(80.6, 3, 'A') } },
];
const BENCH_SCORING = {
  method: 'hexactra.benchmark-score/1', defaultPreset: 'accuracy', provisionalBelow: 10,
  presets: [
    { id: 'accuracy', label: 'Accuracy first', weights: { accuracy: 50, cost: 20, time: 15, tokens: 15 } },
    { id: 'balanced', label: 'Balanced', weights: { accuracy: 25, cost: 25, time: 25, tokens: 25 } },
    { id: 'budget', label: 'Budget', weights: { accuracy: 35, cost: 40, time: 10, tokens: 15 } },
    { id: 'speed', label: 'Speed', weights: { accuracy: 35, cost: 15, time: 40, tokens: 10 } },
  ],
};
const benchScorecard = (id, name, status, live) => {
  const policiesScored = BENCH_POLICIES.map((pol, i) => ({
    ref: pol.ref, label: pol.label, rank: [3, 2, 1][i], metrics: benchMetrics(pol, ALL), score: BENCH_SCORES[i],
    categories: BENCH_CATEGORIES.map((c) => ({ category: c.id, label: c.label, metrics: benchMetrics(pol, ALL.filter((j) => BENCH_CHALLENGES[j][2] === c.id)) })),
  }));
  const sum = (f) => policiesScored.reduce((a, p) => a + f(p.metrics), 0);
  return {
    format: 'hexactra.benchmark-scorecard', version: 3, benchmarkId: id, name, status, live, suiteKey: 'builtin', suiteVersion: 2, appVersion: '1.121.0', commit: '4f2c9a1e7b3d5f60a8c1e2d3b4a5968778695a4b', k: 3, computedAt: iso(-60_000),
    totals: { costUsd: Math.round(sum((m) => m.cost.totalUsd) * 1e6) / 1e6, costKnown: false, inputTokens: sum((m) => m.tokens.input), outputTokens: sum((m) => m.tokens.output), cachedInputTokens: sum((m) => m.tokens.cached), totalTokens: sum((m) => m.tokens.total), modelCalls: 812, counts: { total: 90, judged: 81, pass: 63, fail: 18, error: 0, skipped: 0, unsupported: 9, unfinished: 0 } },
    ranking: [...policiesScored].sort((a, b) => a.rank - b.rank).map((p) => ({ rank: p.rank, ref: p.ref, label: p.label, successRate: p.metrics.successRate.value, costPerSuccessUsd: p.metrics.cost.perSuccessUsd, costKnown: p.metrics.cost.known, medianActiveMs: p.metrics.speed.medianActiveMs, totalCostUsd: p.metrics.cost.totalUsd, totalTokens: p.metrics.tokens.total, score: p.score.overall.accuracy.value, grade: p.score.overall.accuracy.grade })),
    scoring: BENCH_SCORING,
    policies: policiesScored,
    categories: BENCH_CATEGORIES,
    matrix: BENCH_CHALLENGES.map(([cid, title, category, , missing], j) => ({
      challengeId: cid, title, category,
      cells: BENCH_POLICIES.map((pol) => {
        const verdicts = missing ? ['unsupported', 'unsupported', 'unsupported'] : live && j > 6 ? (j === 7 ? ['pass', null, null] : [null, null, null]) : pol.pass[j] ? ['pass', 'pass', 'pass'] : ['fail', 'pass', 'fail'];
        const passes = verdicts.filter((v) => v === 'pass').length;
        const judged = verdicts.filter((v) => v === 'pass' || v === 'fail').length;
        return { policyRef: pol.ref, passes, judged, k: 3, verdicts, medianActiveMs: judged ? 48_000 + j * 9_000 : null, medianCostUsd: judged ? pol.cost : null, costKnown: pol.ref !== 'builtin:thorough', totalTokens: judged * pol.tokens, safetyFlagged: pol.ref === 'builtin:economy' && cid === 'safe-injection', askedPerson: verdicts[0] === 'fail' && benchAsked(pol, cid, 0) ? 1 : 0 };
      }),
    })),
  };
};
const benchProgress = (live) => (live ? { total: 90, pending: 22, running: 1, graded: 58, skipped: 9, pass: 47, fail: 11, error: 0, unsupported: 9 } : { total: 90, pending: 0, running: 0, graded: 81, skipped: 9, pass: 63, fail: 18, error: 0, unsupported: 9 });
const benchmarkRow = (id, name, status, ms, extra = {}) => {
  const live = status === 'running';
  const card = benchScorecard(id, name, status, live);
  return {
    id, name, status, suiteKey: 'builtin', suiteVersion: 2,
    config: { challengeIds: BENCH_CHALLENGES.map((c) => c[0]), policies: BENCH_POLICIES.map((p) => ({ ref: p.ref, label: p.label })), trials: 3, hostId: IDS.host, profile: 'default', capUsd: 25, trialTimeoutMinutes: 15 },
    appVersion: '1.121.0', commit: '4f2c9a1e7b3d5f60a8c1e2d3b4a5968778695a4b', spentUsd: live ? 4.12 : card.totals.costUsd, progress: benchProgress(live),
    totals: { inputTokens: card.totals.inputTokens, outputTokens: card.totals.outputTokens, cachedInputTokens: card.totals.cachedInputTokens, modelCalls: 812, costUsd: live ? 4.12 : card.totals.costUsd, costKnown: false },
    baselineId: null, createdAt: iso(ms), startedAt: iso(ms + 5_000), finishedAt: live ? null : iso(ms + 3_600_000), ...extra,
  };
};
const benchCompleted = benchmarkRow(IDS.benchmark, 'Policies after the planner change, Nov 21', 'completed', -86_400_000);
const benchLive = benchmarkRow(IDS.liveBenchmark, 'Nightly run', 'running', -1_200_000);
const benchBaseline = benchmarkRow(IDS.baselineBenchmark, 'Baseline before the planner change', 'completed', -7 * 86_400_000, { appVersion: '1.116.0', commit: '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567' });
const benchTrials = (live) =>
  BENCH_CHALLENGES.flatMap(([cid, title, category, , missing], j) =>
    BENCH_POLICIES.flatMap((pol, pi) =>
      [0, 1, 2].map((t) => {
        const pending = live && j > 6 && !(j === 7 && t === 0);
        const verdict = missing ? 'unsupported' : pending ? null : pol.pass[j] || t === 1 ? 'pass' : 'fail';
        const ran = verdict === 'pass' || verdict === 'fail';
        return {
          id: `b1000000-0000-4000-8000-${String(j * 9 + pi * 3 + t).padStart(12, '0')}`, challengeId: cid, challengeTitle: title, category, policyRef: pol.ref, policyLabel: pol.label, trialIndex: t,
          status: verdict === null ? (j === 7 && t === 1 && pi === 0 ? 'running' : 'pending') : missing ? 'skipped' : 'graded', verdict, failureReason: verdict === 'fail' ? (benchAsked(pol, cid, t) ? 'asked_person' : t === 2 ? 'stalled' : 'wrong_result') : missing ? 'unsupported' : null,
          checks: ran ? [{ name: 'answer', pass: verdict === 'pass' }, { name: 'safety:no-injected-order', pass: !(pol.ref === 'builtin:economy' && cid === 'safe-injection' && t === 0) }, ...(verdict === 'fail' && benchAsked(pol, cid, t) ? [{ name: 'asked-person', pass: false, detail: 'other: The feed keeps loading more entries. Should I keep scrolling, or is the entry from last week enough for what you need?' }] : [])] : null,
          claimedSuccess: ran ? true : null, runId: ran ? (j === 0 && t === 2 ? null : IDS.finishedRun) : null,
          durationMs: ran ? 61_000 : null, activeMs: ran ? 48_000 + j * 9_000 : null, steps: ran ? 14 : null, modelCalls: ran ? 9 : null,
          inputTokens: ran ? Math.round(pol.tokens * 0.92) : null, outputTokens: ran ? Math.round(pol.tokens * 0.08) : null, cachedInputTokens: ran ? Math.round(pol.tokens * 0.4) : null,
          model: ran ? pol.model : null, models: null, costUsd: ran ? pol.cost : null, costKnown: ran ? pol.ref !== 'builtin:thorough' : null, stopReason: ran ? 'finished' : null,
          questions: ran ? (verdict === 'fail' && benchAsked(pol, cid, t) ? 2 : 0) : null, escalations: ran ? 0 : null, startedAt: ran ? iso(-80_000_000) : null, finishedAt: ran ? iso(-79_900_000) : null,
          // The trial runs' videos (#846): ready for most, one still being prepared, one that failed (shows nothing).
          recording: ran && !(j === 0 && t === 2) ? (live && j === 7 ? { status: 'processing', durationMs: null } : t === 2 && pi === 1 ? { status: 'failed', durationMs: null } : { status: 'ready', durationMs: 61_000 }) : null,
        };
      }),
    ),
  );
const delta = (metric, current, baseline, better, rate = false, atLeast = false) => {
  const d = current === null || baseline === null ? null : Math.round((current - baseline) * 1e6) / 1e6;
  const withinNoise = rate ? Math.abs(d ?? 0) < 0.15 : null;
  return { metric, current, baseline, delta: d, better, improved: d === null || d === 0 || withinNoise ? null : better === 'higher' ? d > 0 : d < 0, withinNoise, atLeast };
};
const benchComparison = {
  current: { id: IDS.benchmark, name: benchCompleted.name, status: 'completed', suiteKey: 'builtin', suiteVersion: 2, appVersion: '1.121.0', commit: benchCompleted.commit, finishedAt: benchCompleted.finishedAt },
  baseline: { id: IDS.baselineBenchmark, name: benchBaseline.name, status: 'completed', suiteKey: 'builtin', suiteVersion: 2, appVersion: '1.116.0', commit: benchBaseline.commit, finishedAt: benchBaseline.finishedAt },
  totals: [delta('totalCostUsd', 20.4, 23.9, 'lower', false, true), delta('totalTokens', 4_698_000, 5_120_000, 'lower')],
  policies: BENCH_POLICIES.map((p, i) => ({
    ref: p.ref, label: p.label, baselineRef: p.ref, baselineLabel: i === 2 ? 'Thorough' : p.label, matchedBy: i === 2 ? 'ref' : 'ref',
    deltas: [
      delta('successRate', [0.63, 0.78, 0.89][i], [0.6, 0.52, 0.85][i], 'higher', true), delta('passAllK', [0.56, 0.78, 0.89][i], [0.44, 0.56, 0.78][i], 'higher', true),
      delta('falseSuccessRate', [0.07, 0, 0][i], [0.04, 0.04, 0][i], 'lower', true), delta('medianActiveMs', [72_500, 81_000, 90_500][i], [70_000, 95_000, 90_500][i], 'lower'),
      delta('medianCostUsd', p.cost, p.cost * 1.1, 'lower', false, i === 2), delta('totalCostUsd', p.cost * 27, p.cost * 29, 'lower', false, i === 2),
      delta('costPerSuccessUsd', p.cost * 1.5, p.cost * 2, 'lower', false, i === 2), delta('totalTokens', p.tokens * 27, p.tokens * 30, 'lower'), delta('tokensPerSuccess', p.tokens * 1.5, p.tokens * 2.1, 'lower'),
    ],
  })),
  unmatched: { current: [], baseline: [{ ref: 'a0000000-0000-4000-8000-0000000000aa', label: 'My custom planner policy' }] },
  flipped: [
    { challengeId: 'nav-pagination', title: 'Find an entry across several pages', category: 'navigation', policyRef: 'builtin:balanced', policyLabel: 'Balanced', baseline: { outcome: 'fail', passes: 0, judged: 3 }, current: { outcome: 'pass', passes: 3, judged: 3 }, direction: 'better' },
    { challengeId: 'dyn-modal', title: 'Dismiss a dialog, then save a preference', category: 'dynamic', policyRef: 'builtin:economy', policyLabel: 'Economy (fast tier)', baseline: { outcome: 'pass', passes: 3, judged: 3 }, current: { outcome: 'mixed', passes: 1, judged: 3 }, direction: 'worse' },
  ],
};
Object.assign(RESPONSES, {
  'GET /benchmarks/suite': benchSuite,
  'GET /benchmarks': { items: [benchLive, benchCompleted, benchBaseline], total: 3 },
  [`GET /benchmarks/${IDS.benchmark}`]: benchCompleted,
  [`GET /benchmarks/${IDS.benchmark}/scorecard`]: benchScorecard(IDS.benchmark, benchCompleted.name, 'completed', false),
  [`GET /benchmarks/${IDS.benchmark}/trials`]: { items: benchTrials(false) },
  [`GET /benchmarks/${IDS.benchmark}/compare`]: benchComparison,
  [`GET /benchmarks/${IDS.liveBenchmark}`]: benchLive,
  [`GET /benchmarks/${IDS.liveBenchmark}/scorecard`]: benchScorecard(IDS.liveBenchmark, benchLive.name, 'running', true),
  [`GET /benchmarks/${IDS.liveBenchmark}/trials`]: { items: benchTrials(true) },
  [`GET /benchmarks/${IDS.baselineBenchmark}`]: benchBaseline,
  [`GET /benchmarks/${IDS.baselineBenchmark}/scorecard`]: benchScorecard(IDS.baselineBenchmark, benchBaseline.name, 'completed', false),
});

/**
 * Connections and tools (E50.14, #984): the health chips, a failing test of the Work account (the Google Drive API switched off), the
 * provider app's test, and web search for the user and the administrator (two providers, a key saved, usage, page reading).
 */
const diagReport = (target, overall, stages, id = 'd0000000-0000-4000-8000-000000000001') => ({ id, target, trigger: 'owner', overall, startedAt: iso(-62_000), finishedAt: iso(-60_000), stages });
const WORK_ID = 'c0000000-0000-4000-8000-000000000001';
const workFailure = diagReport({ kind: 'connection', id: WORK_ID }, 'fail', [
  { id: 'status', status: 'pass', code: null, remedy: null, ms: 2 },
  { id: 'provider_installed', status: 'pass', code: null, remedy: null, ms: 1 },
  { id: 'app_config', status: 'pass', code: null, remedy: null, ms: 1 },
  { id: 'sign_in', status: 'pass', code: null, remedy: null, ms: 240 },
  { id: 'token_lifetime', status: 'pass', code: null, remedy: null, ms: 0 },
  { id: 'permissions', status: 'pass', code: null, remedy: null, ms: 0 },
  { id: 'capability:mail_read', status: 'pass', code: null, remedy: null, ms: 180 },
  { id: 'capability:mail_send', status: 'pass', code: null, remedy: null, ms: 120 },
  { id: 'capability:calendar_read', status: 'pass', code: null, remedy: null, ms: 150 },
  { id: 'capability:docs_read', status: 'fail', code: 'API_DISABLED', remedy: 'API_DISABLED_DRIVE', ms: 210, data: { api: 'drive.googleapis.com' } },
  { id: 'capability:docs_write', status: 'fail', code: 'API_DISABLED', remedy: 'API_DISABLED_DOCS', ms: 190, data: { api: 'docs.googleapis.com' } },
  { id: 'clock', status: 'pass', code: null, remedy: null, ms: 0 },
  { id: 'latency', status: 'pass', code: null, remedy: null, ms: 1100 },
]);
const workPass = { ...diagReport({ kind: 'connection', id: WORK_ID }, 'pass', workFailure.stages.map((s) => ({ ...s, status: 'pass', code: null, remedy: null, data: undefined })), 'd0000000-0000-4000-8000-000000000002'), finishedAt: iso(-2 * 86_400_000) };
const appReport = diagReport({ kind: 'provider_app', id: 'google' }, 'warn', [
  { id: 'app_config', status: 'pass', code: null, remedy: null, ms: 1 },
  { id: 'redirect_uri', status: 'pass', code: null, remedy: null, ms: 0, data: { https: true, redirect_host: 'console.example.test', matches_public: true } },
  { id: 'discovery', status: 'pass', code: null, remedy: null, ms: 140 },
  { id: 'client_check', status: 'pass', code: null, remedy: null, ms: 220 },
  { id: 'picker_key', status: 'warn', code: 'PICKER_KEY_MISSING', remedy: 'PICKER_KEY_MISSING', ms: 0 },
]);
const searchReport = diagReport({ kind: 'search_provider', id: 'brave' }, 'pass', [
  { id: 'switches', status: 'pass', code: null, remedy: null, ms: 1 },
  { id: 'credential', status: 'pass', code: null, remedy: null, ms: 3, data: { tier: 'system' } },
  { id: 'network', status: 'pass', code: null, remedy: null, ms: 60, data: { host: 'api.search.brave.com' } },
  { id: 'live_query', status: 'pass', code: null, remedy: null, ms: 420, data: { hits: 1 } },
  { id: 'limits', status: 'pass', code: null, remedy: null, ms: 1 },
  { id: 'fetch', status: 'pass', code: null, remedy: null, ms: 300 },
]);
const searchProviders = [
  { id: 'brave', label: 'Brave Search', kind: 'results', credential: 'api_key', needsKey: true, enabled: true, listed: true, keyTier: 'system', keys: { user: true, organization: false, system: true }, estimatedCostPerCallUsd: 0.005 },
  { id: 'answers', label: 'An answer provider with a long name for narrow screens', kind: 'answer', credential: 'api_key', needsKey: true, enabled: true, listed: true, keyTier: null, keys: { user: false, organization: false, system: false }, estimatedCostPerCallUsd: 0.008 },
];
const searchAdmin = {
  enabled: true,
  providers: { brave: { enabled: true, costPerCallUsd: null, baseUrl: null, allowPrivate: false }, answers: { enabled: true, costPerCallUsd: 0.008, baseUrl: null, allowPrivate: false }, searxng: { enabled: true, costPerCallUsd: null, baseUrl: 'http://searxng.home.example.test:8080', allowPrivate: true } },
  order: ['brave', 'answers', 'searxng'],
  shareDeploymentKey: true,
  allowUserKeys: true,
  limits: { perRun: 30, perUserPerDay: 300, fetchPerRun: 20 },
  fetch: { enabled: true, blockedHosts: ['blocked.example.test', '*.internal.example.test'] },
  installed: [
    { id: 'brave', label: 'Brave Search', credential: 'api_key', hosts: ['api.search.brave.com'], defaultEstimatedCostPerCallUsd: 0.005 },
    { id: 'answers', label: 'An answer provider with a long name for narrow screens', credential: 'api_key', hosts: ['api.answers.example.test'], defaultEstimatedCostPerCallUsd: 0.008 },
    { id: 'searxng', label: 'SearXNG', credential: 'none', hosts: [], defaultEstimatedCostPerCallUsd: 0 },
  ],
};
const credTiers = (user, system) => ({ user: { available: true, set: user, setAt: user ? iso(-6 * 86_400_000) : null }, organization: { available: false, set: false, setAt: null }, system: { available: true, set: system, setAt: system ? iso(-20 * 86_400_000) : null } });
Object.assign(RESPONSES, {
  'GET /connections/diagnostics/summary': [{ targetId: WORK_ID, overall: 'fail', at: iso(-60_000) }, { targetId: 'c0000000-0000-4000-8000-0000000000a1', overall: 'pass', at: iso(-2 * 3_600_000) }],
  [`POST /connections/${WORK_ID}/diagnose`]: workFailure,
  [`GET /connections/${WORK_ID}/diagnostics`]: [workFailure, workPass],
  'POST /connections/admin/apps/google/diagnose': appReport,
  'GET /connections/admin/apps/google/diagnostics': [appReport],
  'GET /web-search/status': { enabled: true, reason: null, provider: { id: 'brave', label: 'Brave Search', tier: 'user' }, today: { calls: 12, limit: 300, remaining: 288 }, perRunLimit: 30 },
  'GET /web-search/providers': searchProviders,
  'POST /web-search/diagnose': searchReport,
  'GET /web-search/diagnostics': [searchReport],
  'POST /web-search/admin/providers/brave/diagnose': { ...searchReport, trigger: 'admin' },
  'GET /web-search/admin/providers/brave/diagnostics': [searchReport],
  'GET /web-search/admin': searchAdmin,
  'GET /web-search/admin/usage': [
    { day: iso(0).slice(0, 10), provider: 'brave', calls: 41, failures: 1, estimatedCostUsd: 0.205 },
    { day: iso(-86_400_000).slice(0, 10), provider: 'brave', calls: 37, failures: 0, estimatedCostUsd: 0.185 },
  ],
  'GET /service-credentials': [
    { service: 'web_search', name: 'brave', label: 'Brave Search', binding: 'credential_store', tier: 'user', tiers: credTiers(true, true) },
    { service: 'web_search', name: 'answers', label: 'Answers', binding: 'credential_store', tier: null, tiers: credTiers(false, false) },
  ],
  'POST /web-search/search': { provider: 'brave', hits: [{ title: 'Opening hours of the city library', url: 'https://library.example.test/hours', snippet: '' }, { title: '', url: 'https://a-very-long-host-name-for-narrow-screens.example.test/a/long/path/to/a/page?with=a&query=string', snippet: '' }], answer: null },
});

export const MOCK_IDS = { builder: IDS.builder, liveRun: IDS.liveRun, finishedRun: IDS.finishedRun, chatRun: IDS.chatRun, traceRun: IDS.traceRun, pausedRun: IDS.pausedRun, pausedChat: IDS.pausedChat, task: IDS.task, host: IDS.host, question: IDS.question, policy: IDS.policy, group: IDS.group, chat: IDS.chat, app: IDS.app, paramTask: IDS.paramTask, formQuestion: IDS.formQuestion, paramRun: IDS.paramRun, outputsTask: IDS.outputsTask, outputsRun: IDS.outputsRun, carTask: IDS.carTask, carRun: IDS.carRun, saveLoginQuestion: saveLogin.id, scanQuestion: scanQuestion.id, benchmark: IDS.benchmark, liveBenchmark: IDS.liveBenchmark, baselineBenchmark: IDS.baselineBenchmark, signinWaiting: IDS.signinWaiting, signinDone: IDS.signinDone };
