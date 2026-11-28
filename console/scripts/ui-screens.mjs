#!/usr/bin/env node
// =============================================================================
// ui-screens: the route-by-width audit of the console web app (#431)
// =============================================================================
//
// Opens every route of the table below at 360, 390, 768, 1024 and 1440 px, in
// light and dark, saves a full-page PNG of each under `.ui-screens/` (ignored
// by git) and checks that the page does not scroll sideways:
//
//     document.documentElement.scrollWidth <= window.innerWidth
//
// It exits non-zero when any page overflows, printing the route and the width,
// and also when it could not check a single page.
//
// THIS IS A LOCAL, MANUAL CHECK. IT IS NOT A CI STEP: CI has no running stack
// with data to look at. Do not wire it into a workflow as a passing step.
//
// Two ways to run it:
//
//   1. Against the dev stack (README, "Run it"), signed in:
//        npm run ui:screens -- --login      # once: sign in by hand in the window that opens;
//                                           # the session is saved to .ui-screens/state.json
//        npm run ui:screens                 # http://localhost:3535 by default (--base to change)
//      The saved state holds your refresh cookie: it stays in the ignored
//      folder, is never committed, and `--login` replaces it when it expires.
//      Routes with an id (a run, a task, a host, a question, a policy) take the
//      first one your account has; a route with nothing to open is reported as
//      SKIPPED, never as passed. Dark needs your theme set to "System".
//
//   2. Without a stack, against a build of the web app with a mocked API:
//        npm run build --workspace=web
//        npm run preview --workspace=web -- --port 4173 &
//        npm run ui:screens -- --mock --base http://localhost:4173
//      The answers come from scripts/ui-screens.fixtures.mjs. Packaged pages
//      whose endpoints are not mocked render their error or empty state; the
//      run lists those endpoints.
//
// Options: --base <url>  --state <file>  --out <dir>  --widths 360,390
//          --schemes light,dark  --only <name,name>  --strict (a skipped or
//          redirected route fails the run)  --list (print the routes and exit)
//
// A route's options: `signedOut` (open it without a session), `click` (the
// accessible name of a button to press before the screenshot: a dialog).
//
// TO ADD A PAGE: append one line to ROUTES. `{task}`, `{liveRun}`,
// `{finishedRun}`, `{chatRun}`, `{traceRun}`, `{pausedRun}`, `{pausedChat}`, `{host}`, `{question}`, `{policy}`, `{group}`, `{chat}`, `{app}`,
// `{paramTask}`, `{formQuestion}` and `{paramRun}` (mock only, #556), `{outputsTask}` and `{outputsRun}` (mock only, E39.5), `{carTask}` and `{carRun}` (mock only, E39.10), `{builder}` (mock only, E42.4), `{saveLoginQuestion}` (mock only, E37.4b), `{scanQuestion}` (mock only, #924) and `{benchmark}`, `{liveBenchmark}`, `{baselineBenchmark}` (E44.5), `{signinWaiting}` and `{signinDone}` (mock only, E48.4; also the queue summary of E48.6), `{improvement}` (mock only, E52.9) are filled
// in from the account (or the fixtures). The enabled slices' routes are read
// from apps/web/src/slices/<id>.tsx, so a new slice page needs nothing here.
// A route's options may carry `action: async (page) => …`, run once the page
// has settled and before the check, to open what needs a press (a dialog, a
// menu): the screenshot and the overflow check then include it. `viewport: true`
// saves the window as it is seen (an open dialog) instead of the full page.
//
// Playwright is the one already on the machine (`require('playwright')`); this
// script never installs a browser.
// =============================================================================

import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSOLE = resolve(HERE, '..');

/** A route action (#556): press the first button of that accessible name, then let the page settle. */
function pressButton(name) {
  return async (page) => {
    await page.getByRole('button', { name, exact: true }).first().click({ timeout: 5_000 });
    await page.waitForTimeout(500);
  };
}

/** Every route the audit opens: `[name, path, options?]`. Append to add a page. */
export const ROUTES = [
  // Chat is the home (#713); the dashboard of runs is the overview.
  ['home', '/'],
  ['home-options', '/', { action: pressButton('Chat options'), viewport: true }],
  ['overview', '/overview'],
  ['chat', '/chat'],
  ['chat-new', '/chat/new'],
  ['chat-thread', '/chat/{chat}'],
  ['chat-thread-options', '/chat/{chat}', { action: pressButton('Chat options'), viewport: true }],
  ['inbox', '/inbox'],
  ['question', '/inbox/q/{question}'],
  ['tasks', '/tasks'],
  ['task-new', '/tasks/new'],
  ['task-builder', '/tasks/builder/{builder}'],
  ['task-detail', '/tasks/{task}'],
  ['task-edit', '/tasks/{task}/edit'],
  ['task-improvement', '/tasks/{task}/improvements/{improvement}'],
  ['task-edit-improvement', '/tasks/{task}/edit?improvement={improvement}&facts=0'],
  ['runs', '/runs'],
  ['run-live', '/runs/{liveRun}'],
  ['run-finished', '/runs/{finishedRun}'],
  // A paused run (E38.2): the banner with Resume and Stop, the live browser view; in the chat, the card and the pane.
  ['run-paused', '/runs/{pausedRun}'],
  ['chat-thread-paused', '/chat/{pausedChat}'],
  ['chat-browser-paused', '/chat/{pausedChat}', { action: pressButton('Open browser'), viewport: true }],
  // A chat run started from a saved task (#1007): its Browser card starts with "Using your task …", a link to the task.
  ['chat-task-run', '/chat/{chat}', {
    action: async (page) => {
      await page.getByTestId('using-task').first().scrollIntoViewIfNeeded({ timeout: 5_000 });
      await page.waitForTimeout(300);
    },
    viewport: true,
  }],
  // Chat settings (#1007): "Use my saved tasks when one fits" under "Suggest memories", at the end of the dialog.
  ['chat-settings-saved-tasks', '/chat/{chat}', {
    action: async (page) => {
      await page.getByRole('button', { name: 'Chat options' }).first().click({ timeout: 5_000 });
      await page.getByRole('menuitem', { name: /All chat settings/ }).or(page.getByRole('button', { name: /All chat settings/ })).first().click({ timeout: 5_000 });
      await page.getByRole('switch', { name: 'Use my saved tasks when one fits' }).scrollIntoViewIfNeeded({ timeout: 5_000 });
      await page.waitForTimeout(300);
    },
    viewport: true,
  }],
  // A chat run that went over its (soft) usual limit and finished (#537).
  ['run-chat-over-limit', '/runs/{chatRun}'],
  // A run's trace (#544): questions with their answers, guidance, a confirmed step and five pictures;
  // then its lightbox and its Export menu (on a phone, in the sticky bar).
  ['run-trace', '/runs/{traceRun}', { action: loadPictures }],
  ['run-trace-lightbox', '/runs/{traceRun}', { action: openLightbox, viewport: true }],
  ['run-trace-export', '/runs/{traceRun}', { action: openExportMenu, viewport: true }],
  ['fleet', '/fleet'],
  ['desktop', '/fleet/hosts/{host}/desktop'],
  // The desktop page in sign-in mode (E48.4): the banner while the person signs in, then "Signed in as" with the next steps.
  ['desktop-signin', '/fleet/hosts/{host}/desktop?signin={signinWaiting}'],
  ['desktop-signin-done', '/fleet/hosts/{host}/desktop?signin={signinDone}'],
  // "Fix sign-ins" (E48.6): the queue grouped by host, then its summary after a run (mock only: the queue is seeded in the tab).
  ['fleet-signin-queue', '/fleet/signin-queue'],
  ['fleet-signin-queue-summary', '/fleet/signin-queue', { action: signinQueueSummary }],
  ['notes', '/notes'],
  // Settings (the user's hub and its pages).
  ['settings', '/settings'],
  ['settings-run-history', '/settings/run-history'],
  ['settings-usage', '/settings/usage'],
  // Runs Analytics (E53.5, #1073).
  ['runs-analytics', '/runs/analytics'],
  ['settings-model-prices', '/settings/model-prices'],
  ['settings-tokens', '/settings/tokens'],
  ['settings-agent-policies', '/settings/agent-policies'],
  ['settings-agent-policy-new', '/settings/agent-policies/new'],
  ['settings-agent-policy-edit', '/settings/agent-policies/{policy}'],
  ['settings-agent-model-tiers', '/settings/agent-model-tiers'],
  ['settings-webhooks', '/settings/webhooks'],
  ['settings-connected-apps', '/settings/connected-apps'],
  // Connected AI apps (#464).
  ['settings-ai-apps', '/settings/ai-apps'],
  ['settings-ai-app', '/settings/ai-apps/{app}'],
  ['settings-ai-apps-connect', '/settings/ai-apps/connect'],
  // Memories (#551): the page, and its add dialog (opened by clicking "Add").
  ['settings-memories', '/settings/memories'],
  ['settings-memories-dialog', '/settings/memories', { click: 'Add' }],
  // Skills (#1008): the list, the form, and the deployment switch.
  ['settings-skills', '/settings/skills'],
  ['settings-skills-dialog', '/settings/skills', { click: 'Add' }],
  ['admin-skills', '/admin/settings/skills'],
  // "Don't ask again" (#555): the approval card with the box ticked and the limits open.
  ['inbox-dont-ask-again', '/inbox', {
    action: async (page) => {
      await page.getByRole('checkbox', { name: /^Don't ask again/ }).first().click({ timeout: 5_000 });
      await page.getByRole('button', { name: 'Limit it' }).first().click({ timeout: 5_000 });
      await page.waitForTimeout(400);
    },
  }],
  // Paying with a saved card (E37.7): the approval card with the box ticked, so the required limit shows under it.
  ['inbox-card-approval', '/inbox', {
    action: async (page) => {
      await page.getByRole('checkbox', { name: /^Don't ask again: Pay with Visa/ }).first().click({ timeout: 5_000 });
      await page.waitForTimeout(400);
    },
  }],
  // Saved approvals (#554): the page, and its "Add a limit" dialog.
  ['settings-approvals', '/settings/approvals'],
  ['settings-approvals-limit', '/settings/approvals', {
    action: async (page) => {
      await page.getByRole('button', { name: /^More for Press 'Pay'/ }).first().click({ timeout: 5_000 });
      await page.getByRole('menuitem', { name: 'Add a limit' }).click({ timeout: 5_000 });
      await page.waitForTimeout(400);
    },
  }],
  // Secrets (#593): the page in each state of the provider card (the mock reads `?state=` from the page's own address), the administrator's page.
  ['settings-secrets', '/settings/secrets'],
  ['settings-secrets-not-connected', '/settings/secrets?state=not_connected'],
  ['settings-secrets-reconnect', '/settings/secrets?state=needs_reconnect'],
  ['settings-secrets-deployment-off', '/settings/secrets?state=deployment_off'],
  ['settings-secrets-empty', '/settings/secrets?state=empty'],
  // The Payment cards section (E37.7): a shop checked, listing the cards granted for it (the mock lists them for any shop but one with "nowhere" in its name).
  ['settings-secrets-cards', '/settings/secrets', {
    action: async (page) => {
      await page.getByLabel('Shop to check').fill('shop.example.com');
      await page.getByRole('button', { name: 'Check', exact: true }).click({ timeout: 5_000 });
      await page.getByTestId('cards-result').waitFor({ timeout: 5_000 });
      await page.waitForTimeout(300);
    },
  }],
  ['admin-secrets', '/admin/settings/secrets'],
  // Connections (E39.2): two Google accounts and a Microsoft account in different states; the empty list; the Connect dialog; one account's menu; the administrator's apps.
  ['settings-connections', '/settings/connections'],
  ['settings-connections-empty', '/settings/connections?state=empty'],
  ['settings-connections-connect', '/settings/connections', { viewport: true, action: pressButton('Connect an account') }],
  ['settings-connections-result', '/settings/connections?connect=connected&connection=c0000000-0000-4000-8000-000000000001&missing=calendar_write'],
  ['admin-connections', '/admin/settings/connections'],
  // MCP servers (E39.9): the add dialog with the bearer token field, and the tool review (a changed tool, a new one, a switched-on one).
  ['settings-connections-mcp-add', '/settings/connections', {
    viewport: true,
    action: async (page) => {
      // E50.14: the Added tools section's own button.
      await page.getByRole('button', { name: 'Add a tool', exact: true }).first().click({ timeout: 5_000 });
      await page.getByRole('radio', { name: 'Bearer token' }).click({ timeout: 5_000 });
      await page.waitForTimeout(300);
    },
  }],
  ['settings-connections-mcp-tools', '/settings/connections', {
    viewport: true,
    action: async (page) => {
      await page.getByRole('button', { name: 'Actions for Work notes' }).click({ timeout: 5_000 });
      await page.getByRole('menuitem', { name: 'Tools' }).click({ timeout: 5_000 });
      await page.getByRole('dialog', { name: 'Tools of Work notes' }).waitFor({ timeout: 5_000 });
      await page.waitForTimeout(300);
    },
  }],
  // Connections and tools (E50.14): the panel with a failing test (the Google Drive API off), the Web search section, the provider app's
  // test, and the administrator's Web search card. The panel opens from the visible Test button of the Work account.
  ['settings-connections-test', '/settings/connections', {
    viewport: true,
    action: async (page) => {
      await page.getByRole('button', { name: 'Test Work', exact: true }).click({ timeout: 5_000 });
      await page.getByTestId('diagnostics-summary').waitFor({ timeout: 8_000 });
      await page.waitForTimeout(300);
    },
  }],
  ['settings-connections-web-search', '/settings/connections#web-search', { viewport: true }],
  ['settings-connections-search-try', '/settings/connections#web-search', {
    action: async (page) => {
      await page.getByLabel('Search for').fill('library opening hours');
      await page.getByRole('button', { name: 'Search', exact: true }).click({ timeout: 5_000 });
      await page.getByRole('list', { name: 'Results' }).waitFor({ timeout: 5_000 });
      await page.waitForTimeout(300);
    },
  }],
  ['admin-connections-test', '/admin/settings/connections', { viewport: true, action: async (page) => {
    await page.getByRole('button', { name: 'Test app setup' }).first().click({ timeout: 5_000 });
    await page.getByTestId('diagnostics-summary').waitFor({ timeout: 8_000 });
    await page.waitForTimeout(300);
  } }],
  ['admin-web-search', '/admin/settings/web-search'],
  ['admin-web-search-test', '/admin/settings/web-search', { viewport: true, action: async (page) => {
    await page.getByRole('button', { name: 'Test Brave Search' }).click({ timeout: 5_000 });
    await page.getByTestId('diagnostics-summary').waitFor({ timeout: 8_000 });
    await page.waitForTimeout(300);
  } }],
  // The task form's "Saved logins" section while no provider is connected (the switch disabled with its reason; `task-new` shows it available).
  ['task-new-saved-logins-unavailable', '/tasks/new?state=not_connected'],
  ['settings-danger-zone', '/settings/danger-zone'],
  // Administration (the admin hub and its pages).
  ['admin', '/admin/settings'],
  ['admin-fabric', '/admin/settings/fabric'],
  ['admin-users', '/admin/settings/users'],
  ['admin-organization', '/admin/settings/organization'],
  ['admin-organizations', '/admin/settings/organizations'],
  ['admin-jobs', '/admin/settings/jobs'],
  ['admin-job-insights', '/admin/settings/jobs/insights'],
  ['admin-doctor', '/admin/settings/doctor'],
  ['admin-about', '/admin/settings/about'],
  ['admin-webhooks', '/admin/settings/webhooks'],
  ['admin-alerts', '/admin/settings/alerts'],
  ['admin-agent-model-tiers', '/admin/settings/agent-model-tiers'],
  ['admin-agent-ceilings', '/admin/settings/agent-ceilings'],
  ['admin-agent-pricing', '/admin/settings/agent-pricing'],
  ['admin-usage', '/admin/settings/usage'],
  ['admin-runs-analytics', '/admin/runs/analytics'],
  // Benchmarks (E44.5, #743): the list, the new form, a completed benchmark (scorecard, charts, matrix, trials), a live one, the comparison.
  ['admin-benchmarks', '/admin/settings/benchmarks'],
  ['admin-benchmark-new', '/admin/settings/benchmarks/new'],
  // Its policies chosen with one Record video tick on (#845): the per-policy ticks, Record all and the warning.
  [
    'admin-benchmark-new-recorded',
    '/admin/settings/benchmarks/new',
    {
      action: async (page) => {
        const policies = page.getByRole('group', { name: 'Recordings' }).locator('xpath=..').getByRole('checkbox', { name: /built-in|Careful/ });
        for (let i = 0; i < Math.min(2, await policies.count()); i++) await policies.nth(i).check({ timeout: 5_000 });
        await page.getByRole('checkbox', { name: /^Record video for / }).first().check({ timeout: 5_000 });
        await page.waitForTimeout(300);
      },
    },
  ],
  ['admin-benchmark', '/admin/settings/benchmarks/{benchmark}'],
  ['admin-benchmark-live', '/admin/settings/benchmarks/{liveBenchmark}'],
  // Its Export menu (E44.6, #744), open.
  ['admin-benchmark-export', '/admin/settings/benchmarks/{benchmark}', { action: pressButton('Export'), viewport: true }],
  ['admin-benchmark-compare', '/admin/settings/benchmarks/{benchmark}/compare/{baselineBenchmark}'],
  ['admin-factory-reset', '/admin/settings/factory-reset'],
  ['admin-run-history', '/admin/settings/run-history'],
  ['admin-run-recordings', '/admin/settings/run-recordings'],
  ['admin-oauth-clients', '/admin/settings/oauth-clients'],
  ['admin-ai-app-limits', '/admin/settings/ai-app-limits'],
  // Outside the shell.
  ['activate', '/activate'],
  ['oauth-error', '/oauth/error?code=client_not_allowed&host=client.example.test', { signedOut: true }],
  ['login', '/login', { signedOut: true }],
  // Task parameters (#556): the form with three, a schedule's values, the run dialog, the form card, a run's Inputs.
  ['task-edit-parameters', '/tasks/{paramTask}/edit'],
  ['task-schedule-values', '/tasks/{paramTask}/edit', { action: pressButton('Edit') }],
  ['task-run-dialog', '/tasks/{paramTask}', { action: pressButton('Run now') }],
  ['question-form', '/inbox/q/{formQuestion}'],
  // "Save this login?" (E37.4b): its own page; the same card is in the Inbox's suggestions (`inbox`) and in the chat thread (`chat-thread`).
  ['question-save-login', '/inbox/q/{saveLoginQuestion}'],
  // A scan (#924): the live picture under its warning, then "Done, I scanned it".
  ['question-scan', '/inbox/q/{scanQuestion}'],
  ['run-inputs', '/runs/{paramRun}'],
  // Task outputs (E39.5): the form's Outputs section, the task page's history table, a finished run's Outputs block.
  ['task-edit-outputs', '/tasks/{outputsTask}/edit'],
  ['task-outputs', '/tasks/{outputsTask}'],
  ['run-outputs', '/runs/{outputsRun}'],
  // Connections in the console (E39.10): the task form with the accounts and deliveries sections open, each delivery editor, the guided setup,
  // the task page, a run an email started with account steps and deliveries, the Connections page with an account's details, and the approval cards.
  ['task-edit-accounts', '/tasks/{carTask}/edit', { action: openSections }],
  ['task-edit-delivery-email', '/tasks/{carTask}/edit', { viewport: true, action: openDelivery('Email to 2 people') }],
  ['task-edit-delivery-sheet', '/tasks/{carTask}/edit', { viewport: true, action: openDelivery('Add a row to') }],
  ['task-edit-delivery-folder', '/tasks/{carTask}/edit', { viewport: true, action: openDelivery('Save the PDF report') }],
  ['task-edit-delivery-webhook', '/tasks/{carTask}/edit', { viewport: true, action: openDelivery('Send the run') }],
  ['task-edit-file-chooser', '/tasks/{carTask}/edit', { viewport: true, action: chooseFile }],
  ['task-new-guided-setup', '/tasks/new', { viewport: true, action: openGuided }],
  ['task-connections-detail', '/tasks/{carTask}'],
  ['run-connections', '/runs/{carRun}'],
  ['settings-connections-details', '/settings/connections', { action: openConnectionDetails }],
  // The Knowledge Graph (E46.20, #794): the page's tabs, a procedure, a version's diff, the settings cards' pages. The task page
  // (`task-detail`), a finished run (`run-finished`) and the Inbox (`inbox`) show its control, panel and review card in the mock.
  ['kgraph', '/kgraph'],
  ['kgraph-reviews', '/kgraph?tab=reviews'],
  ['kgraph-sites', '/kgraph?tab=sites'],
  ['kgraph-site-facts', '/kgraph?tab=sites&site=example.test'],
  ['kgraph-site-add', '/kgraph?tab=sites&site=example.test', { action: pressButton('Add a fact') }],
  // The Map (E46.21): the canvas from 768 px up, the short note and link below; then a task opened in the side panel and expanded, and
  // "what uses this site" (run these two at 768, 1024 and 1440: below 768 there is no map to press).
  ['kgraph-map', '/kgraph?tab=map', { action: settleMap }],
  ['kgraph-map-task', '/kgraph?tab=map', { action: mapPress('Task: Export the open orders', 'Show its steps') }],
  ['kgraph-map-site', '/kgraph?tab=map', { action: mapPress('Site: portal.example.test', 'What uses this site') }],
  ['kgraph-history', '/kgraph?tab=history', { action: pressButton('What changed') }],
  ['kgraph-procedure', '/kgraph/procedures/kgp-ui-1'],
  // E46.29: a chat run that used a saved procedure (the everyday switch): "Used saved procedure: <name>" in the run's Knowledge Graph panel.
  ['run-everyday', '/runs/{chatRun}'],
  ['settings-kgraph', '/settings/kgraph'],
  ['settings-kgraph-delete', '/settings/kgraph', { viewport: true, action: pressButton('Delete everything learned') }],
  ['admin-kgraph', '/admin/settings/kgraph'],
  ['inbox-account-approvals', '/inbox', {
    action: async (page) => {
      await page.getByRole('button', { name: 'Show all' }).first().click({ timeout: 5_000 });
      await page.getByRole('checkbox', { name: /^Don't ask again: Send mail with Work/ }).first().click({ timeout: 5_000 });
      await page.waitForTimeout(400);
    },
  }],
];

/** The Map (E46.21): from 768 px up, wait for the lazily loaded canvas and its fit; below, the note is the page. */
async function settleMap(page, width) {
  if (width < 768) return;
  await page.locator('.react-flow__node').first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(600);
}

/** The Map: choose a node in the keyboard list (its accessible name starts with `node`), then press `button` in the side panel. */
function mapPress(node, button) {
  return async (page, width) => {
    if (width < 768) return;
    await settleMap(page, width);
    await page.getByRole('list', { name: 'Nodes on the map' }).getByRole('button', { name: new RegExp(`^${node.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first().click({ timeout: 5_000 });
    await page.getByRole('complementary', { name: 'Details' }).getByRole('button', { name: button, exact: true }).click({ timeout: 5_000 });
    await page.waitForTimeout(800);
  };
}

/** The task form: open "Accounts the agent may use" and "Where the result goes". */
async function openSections(page) {
  await page.getByRole('button', { name: /Accounts the agent may use/ }).click({ timeout: 8_000 });
  await page.getByRole('button', { name: /Where the result goes/ }).click({ timeout: 8_000 });
  await page.waitForTimeout(600);
}

/** The task form: open the Deliveries section and the editor of the delivery whose summary starts with `text`. */
function openDelivery(text) {
  return async (page) => {
    await page.getByRole('button', { name: /Where the result goes/ }).click({ timeout: 8_000 });
    const row = page.getByTestId(/^delivery-/).filter({ hasText: text }).first();
    await row.getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 5_000 });
    await page.getByRole('dialog').waitFor({ timeout: 5_000 });
    await page.waitForTimeout(500);
  };
}

/** The spreadsheet delivery's file chooser. */
async function chooseFile(page) {
  await page.getByRole('button', { name: /Where the result goes/ }).click({ timeout: 8_000 });
  const row = page.getByTestId(/^delivery-/).filter({ hasText: 'Add a row to' }).first();
  await row.getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 5_000 });
  await page.getByRole('button', { name: 'Change', exact: true }).click({ timeout: 5_000 });
  await page.getByRole('dialog', { name: /Choose a spreadsheet/ }).waitFor({ timeout: 5_000 });
  await page.waitForTimeout(600);
}

/** The new task form: the guided setup of the deliveries section. */
async function openGuided(page) {
  await page.getByRole('button', { name: /Where the result goes/ }).click({ timeout: 8_000 });
  await page.getByRole('button', { name: 'Keep a record of each run' }).click({ timeout: 5_000 });
  await page.getByRole('dialog').waitFor({ timeout: 5_000 });
  await page.waitForTimeout(400);
}

/** The Connections page: open the first account's "What it is used for". */
async function openConnectionDetails(page) {
  await page.getByRole('button', { name: 'What it is used for' }).first().click({ timeout: 5_000 });
  await page.getByText('Recent activity').first().waitFor({ timeout: 5_000 });
  await page.waitForTimeout(500);
}

/** `run-trace`: scroll through the page so every lazy picture loads, then back to the top. */
async function loadPictures(page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += window.innerHeight / 2) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(500);
}

/**
 * `fleet-signin-queue-summary` (E48.6): seeds the tab's queue as if the person had run it (one busy, one timed out, one
 * active on the completed fixture sign-in), then opens the queue page back from that sign-in, which shows the summary.
 */
async function signinQueueSummary(page) {
  const fixtures = await import('./ui-screens.fixtures.mjs');
  const host = fixtures.MOCK_IDS.host;
  const doneId = fixtures.MOCK_IDS.signinDone;
  const item = (profile, status, reason, runUrl = null) => ({ key: `${host}/${profile}`, hostId: host, hostName: 'mini-pc', profile, state: 'signed_out', checkedAt: null, status, reason, runUrl });
  const queue = {
    items: [
      item('a-profile-with-a-very-long-name-0123', 'failed', 'Not finished within 15 minutes'),
      item('default', 'pending', null),
      item('travel', 'skipped', 'Busy with a run; sign it in when the run ends', '/runs/3333333a-3333-4333-8333-333333333333'),
    ],
    onNode: [{ key: 'cloud/default', hostName: 'cloud-box-with-a-long-host-name.example.test', profile: 'default', hint: 'No desktop: sign in with `hexactra fleet profile show`' }],
    held: null,
    active: { key: `${host}/default`, sessionId: doneId },
    ran: true,
  };
  await page.evaluate((q) => window.sessionStorage.setItem('hexactra.fleet.signinQueue', JSON.stringify(q)), queue);
  await page.goto(new URL(`/fleet/signin-queue?from=${doneId}`, page.url()).toString());
  await page.getByTestId('queue-summary').waitFor({ timeout: 5_000 });
  await page.waitForTimeout(300);
}

/** `run-trace-lightbox`: press the first picture of the run and wait for its dialog. */
async function openLightbox(page) {
  await page.getByRole('button', { name: /^Open the picture/ }).first().click();
  await page.getByRole('dialog').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(400);
}

/** `run-trace-export`: open the Export menu (the header's from md up, the sticky bar's below). */
async function openExportMenu(page) {
  await page.getByRole('button', { name: 'Export', exact: true }).first().click();
  await page.getByRole('menu').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
}

const DEFAULT_WIDTHS = [360, 390, 768, 1024, 1440];
const DEFAULT_SCHEMES = ['light', 'dark'];

function parseArgs(argv) {
  const args = { mock: false, login: false, strict: false, list: false, base: 'http://localhost:3535', out: join(CONSOLE, '.ui-screens'), state: null, widths: DEFAULT_WIDTHS, schemes: DEFAULT_SCHEMES, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--mock') args.mock = true;
    else if (a === '--login') args.login = true;
    else if (a === '--strict') args.strict = true;
    else if (a === '--list') args.list = true;
    else if (a === '--base') args.base = value().replace(/\/$/, '');
    else if (a === '--out') args.out = resolve(value());
    else if (a === '--state') args.state = resolve(value());
    else if (a === '--widths') args.widths = value().split(',').map(Number).filter((n) => n > 0);
    else if (a === '--schemes') args.schemes = value().split(',');
    else if (a === '--only') args.only = value().split(',');
    else throw new Error(`unknown option ${a}`);
  }
  args.state ??= join(args.out, 'state.json');
  return args;
}

/** The enabled slices' routes, read from their source (`{ path: 'settings/…' }` entries of `routes` and `publicRoutes`). */
export function sliceRoutes() {
  const enabled = JSON.parse(readFileSync(join(CONSOLE, 'packages', 'shared', 'slices.json'), 'utf8')).enabled;
  const routes = [];
  for (const id of enabled) {
    const file = join(CONSOLE, 'apps', 'web', 'src', 'slices', `${id}.tsx`);
    if (!existsSync(file)) continue;
    const source = readFileSync(file, 'utf8');
    const publicBlock = /publicRoutes:\s*\[([\s\S]*?)\]/.exec(source)?.[1] ?? '';
    // A route path has no leading slash; a card's path has one and is the same page.
    for (const match of source.matchAll(/\bpath:\s*'([A-Za-z][^']*)'/g)) {
      const path = match[1];
      const name = `slice-${id}-${path.replace(/[^A-Za-z0-9]+/g, '-')}`;
      if (routes.some((r) => r[0] === name)) continue;
      routes.push([name, `/${path.replace(/:id\b/, '{group}')}`, publicBlock.includes(`'${path}'`) ? { signedOut: true } : {}]);
    }
  }
  return routes;
}

const fill = (path, ids) => path.replace(/\{(\w+)\}/g, (_, key) => ids[key] ?? `{${key}}`);

/** The ids of the signed-in account's first live run, finished run, task, host, question, policy and group. */
async function discoverIds(page) {
  return page.evaluate(async () => {
    const refresh = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
    if (!refresh.ok) return { error: `POST /api/auth/refresh answered ${refresh.status}: sign in again with --login` };
    const token = (await refresh.json()).data?.accessToken;
    const get = async (path) => {
      const res = await fetch(`/api${path}`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
      if (!res?.ok) return [];
      const body = await res.json();
      const data = body.data ?? body;
      return Array.isArray(data) ? data : (data.items ?? []);
    };
    const [runs, tasks, hosts, inbox, policies, groups, chats, apps, benchmarks] = await Promise.all([get('/runs'), get('/tasks'), get('/fleet/hosts'), get('/inbox'), get('/agent-policies'), get('/groups'), get('/chats'), get('/connected-apps'), get('/benchmarks')]);
    const live = new Set(['queued', 'running', 'waiting_human', 'paused']);
    return {
      liveRun: runs.find((r) => live.has(r.status))?.id,
      finishedRun: runs.find((r) => !live.has(r.status))?.id,
      chatRun: (runs.find((r) => r.trigger === 'chat' && r.budget?.over?.length) ?? runs.find((r) => r.trigger === 'chat'))?.id,
      // The trace routes open the first finished run; whether it has pictures depends on the account.
      traceRun: runs.find((r) => !live.has(r.status))?.id,
      // A run the owner paused (E38.2) and the chat that holds it; absent unless the account has one.
      pausedRun: runs.find((r) => r.status === 'paused')?.id,
      pausedChat: chats.find((c) => c.liveRun?.status === 'paused')?.id,
      task: tasks[0]?.id,
      host: (hosts.find((h) => h.desktop && h.online) ?? hosts[0])?.id,
      question: inbox[0]?.questionId,
      policy: (policies.find((p) => !p.builtin) ?? policies[0])?.id,
      group: groups[0]?.id,
      chat: chats[0]?.id,
      app: apps[0]?.clientId,
      // Benchmarks (E44.5): the newest ended one, a live one, and an earlier one on the same suite version to compare with.
      ...(() => {
        const ended = benchmarks.filter((b) => b.status !== 'queued' && b.status !== 'running');
        const first = ended[0];
        const base = first && ended.find((b) => b.id !== first.id && b.suiteKey === first.suiteKey && b.suiteVersion === first.suiteVersion);
        return { benchmark: first?.id, liveBenchmark: benchmarks.find((b) => b.status === 'running')?.id, baselineBenchmark: base?.id };
      })(),
    };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const routes = [...ROUTES, ...sliceRoutes()].filter(([name]) => !args.only || args.only.includes(name));
  if (args.list) {
    for (const [name, path] of routes) console.log(`${name.padEnd(44)} ${path}`);
    return 0;
  }
  // The pre-installed Playwright: resolved from here, then from the machine's global modules.
  const require = createRequire(import.meta.url);
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.error('ui-screens: Playwright is not installed here (require("playwright") failed). This check needs it; it never installs a browser itself.');
    return 2;
  }
  mkdirSync(args.out, { recursive: true });

  if (args.login) {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${args.base}/login`);
    console.log(`Sign in in the window that opened (${args.base}). Waiting up to 5 minutes…`);
    await page.waitForURL((url) => !/\/(login|auth\/callback)/.test(url.pathname), { timeout: 300_000 });
    await context.storageState({ path: args.state });
    await browser.close();
    console.log(`Saved the session to ${args.state} (ignored by git; never commit it).`);
    return 0;
  }

  if (!args.mock && !existsSync(args.state)) {
    console.error(`ui-screens: no saved session at ${args.state}. Run "npm run ui:screens -- --login" first, or use --mock.`);
    return 2;
  }

  // Headful, never headless (AGENTS.md, "Never a headless browser"): without a desktop, run under `xvfb-run -a`.
  const browser = await chromium.launch({ headless: false });
  const fixtures = args.mock ? await import('./ui-screens.fixtures.mjs') : null;
  const unmocked = new Set();
  let frame = null;
  /** The trace's pictures (#544), one per step, each a different placeholder page with masked boxes. */
  const traceFrames = new Map();
  if (fixtures) {
    // 1280 x 800 placeholder frames drawn by the browser (no binary in the repository).
    const page = await browser.newPage();
    const draw = (spec) =>
      page.evaluate(({ title, header, masks }) => {
        const canvas = Object.assign(document.createElement('canvas'), { width: 1280, height: 800 });
        const g = canvas.getContext('2d');
        g.fillStyle = '#e8eaf6';
        g.fillRect(0, 0, 1280, 800);
        g.fillStyle = header;
        g.fillRect(0, 0, 1280, 64);
        g.fillStyle = '#9fa8da';
        for (let i = 0; i < 5; i++) g.fillRect(80, 120 + i * 120, 1120, 84);
        g.fillStyle = '#212121';
        for (const [x, y, w, h] of masks) g.fillRect(x, y, w, h);
        g.fillStyle = '#ffffff';
        g.font = '28px sans-serif';
        g.fillText(title, 24, 42);
        return canvas.toDataURL('image/png');
      }, spec);
    const png = (dataUrl) => Buffer.from(dataUrl.split(',')[1], 'base64');
    frame = png(await draw({ title: 'flights.example.test: a placeholder page', header: '#3949ab', masks: [] }));
    for (const [seq, spec] of Object.entries(fixtures.TRACE_FRAMES ?? {})) traceFrames.set(Number(seq), png(await draw(spec)));
    await page.close();
  }

  const mockApi = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '');
    const key = `${request.method()} ${path}`;
    if (/^GET \/runs\/[^/]+\/screenshot$/.test(key)) return route.fulfill({ contentType: 'image/png', body: frame });
    if (/^GET \/questions\/[^/]+\/scan-image$/.test(key)) return route.fulfill({ contentType: 'image/png', headers: { 'x-scan-domain': 'example.com', 'cache-control': 'no-store' }, body: frame });
    const traceShot = /^GET \/runs\/[^/]+\/steps\/(\d+)\/screenshot$/.exec(key);
    if (traceShot) return route.fulfill({ contentType: 'image/png', body: traceFrames.get(Number(traceShot[1])) ?? frame });
    if (/\/stream$/.test(path) || request.headers().accept?.includes('text/event-stream')) return route.abort();
    if (key in fixtures.RESPONSES) {
      // A function answers by the request (its query, its JSON body): a list that is an array or a page, a preview of what was sent.
      const answer = fixtures.RESPONSES[key];
      return route.fulfill({ json: { data: typeof answer === 'function' ? answer(url, request.postDataJSON?.() ?? null, request.headers().referer ?? '') : answer } });
    }
    unmocked.add(key);
    return route.fulfill({ status: 404, json: { message: 'Not mocked (ui-screens)' } });
  };

  const newContext = async (width, scheme, signedIn) => {
    const context = await browser.newContext({
      viewport: { width, height: width < 600 ? 800 : 900 },
      colorScheme: scheme,
      hasTouch: width < 600,
      ...(signedIn && !args.mock ? { storageState: args.state } : {}),
    });
    if (args.mock) {
      await context.route('**/api/**', (route) => {
        // Signed out: the refresh fails, so the app shows its sign-in page.
        if (!signedIn && /\/api\/auth\/(refresh|me)$/.test(new URL(route.request().url()).pathname)) return route.fulfill({ status: 401, json: { message: 'Unauthorized' } });
        return mockApi(route);
      });
    }
    return context;
  };

  let ids = fixtures ? fixtures.MOCK_IDS : {};
  if (!args.mock) {
    const context = await newContext(1024, 'light', true);
    const page = await context.newPage();
    await page.goto(`${args.base}/`, { waitUntil: 'domcontentloaded' });
    ids = await discoverIds(page);
    await context.close();
    if (ids.error) {
      console.error(`ui-screens: ${ids.error}`);
      await browser.close();
      return 2;
    }
  }

  /** results[name][width] = 'ok' | 'overflow' | 'skipped' | 'redirected' (the worst of the schemes). */
  const results = new Map(routes.map(([name]) => [name, new Map()]));
  const rank = { ok: 0, skipped: 1, redirected: 2, overflow: 3 };
  const note = (name, width, status) => {
    const row = results.get(name);
    if (rank[status] >= rank[row.get(width) ?? 'ok']) row.set(width, status);
  };
  const failures = [];
  let checked = 0;

  for (const scheme of args.schemes) {
    for (const width of args.widths) {
      const contexts = { true: null, false: null };
      for (const [name, template, options = {}] of routes) {
        const path = fill(template, ids);
        if (path.includes('{')) {
          note(name, width, 'skipped');
          continue;
        }
        const signedIn = !options.signedOut;
        contexts[signedIn] ??= await newContext(width, scheme, signedIn);
        const page = await contexts[signedIn].newPage();
        try {
          await page.goto(`${args.base}${path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          // A live page keeps a stream open, so "network idle" may never come: wait for it briefly, then let the page settle.
          await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => undefined);
          await page.waitForTimeout(500);
          if (options.click) {
            await page.getByRole('button', { name: options.click, exact: true }).first().click({ timeout: 5_000 });
            await page.waitForTimeout(400);
          }
          const at = new URL(page.url()).pathname;
          if (at !== path.split(/[?#]/)[0]) {
            // The app has no such route (yet), or the account may not open it: it was sent elsewhere.
            note(name, width, 'redirected');
            continue;
          }
          if (options.action) await options.action(page, width);
          const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
          await page.screenshot({ path: join(args.out, `${name}-${width}-${scheme}.png`), fullPage: !options.viewport });
          checked++;
          if (size.scroll > size.inner) {
            note(name, width, 'overflow');
            failures.push(`OVERFLOW ${path} at ${width}px (${scheme}): scrollWidth ${size.scroll} > innerWidth ${size.inner}`);
          } else note(name, width, 'ok');
        } catch (error) {
          note(name, width, 'overflow');
          failures.push(`ERROR ${path} at ${width}px (${scheme}): ${error.message.split('\n')[0]}`);
        } finally {
          await page.close();
        }
      }
      for (const context of Object.values(contexts)) await context?.close();
    }
  }
  await browser.close();

  const mark = { ok: 'ok', overflow: 'OVERFLOW', skipped: 'skipped', redirected: 'redirected' };
  console.log(`\nui-screens: ${args.mock ? 'mocked API' : 'dev stack'} at ${args.base}; schemes ${args.schemes.join(', ')}\n`);
  console.log(`${'route'.padEnd(44)}${args.widths.map((w) => String(w).padEnd(11)).join('')}`);
  const unchecked = [];
  for (const [name, template] of routes) {
    const row = results.get(name);
    console.log(`${name.padEnd(44)}${args.widths.map((w) => mark[row.get(w) ?? 'skipped'].padEnd(11)).join('')}`);
    const status = row.get(args.widths[0]);
    if (status === 'skipped') unchecked.push(`${template} (nothing to open: no ${/\{(\w+)\}/.exec(fill(template, ids))?.[1] ?? 'data'})`);
    if (status === 'redirected') unchecked.push(`${template} (redirected: no such route, or no permission)`);
  }
  if (unmocked.size) console.log(`\nNot mocked (those pages rendered their error or empty state):\n  ${[...unmocked].sort().join('\n  ')}`);
  if (unchecked.length) console.log(`\nNOT CHECKED (${unchecked.length}):\n  ${unchecked.join('\n  ')}`);
  for (const failure of failures) console.error(failure);
  console.log(`\n${checked} page loads checked, ${failures.length} failed, ${unchecked.length} routes not checked. Screenshots: ${args.out}`);
  if (checked === 0) {
    console.error('ui-screens: nothing was checked.');
    return 1;
  }
  if (failures.length) return 1;
  if (args.strict && unchecked.length) return 1;
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`ui-screens: ${error.message}`);
      process.exit(2);
    },
  );
}
