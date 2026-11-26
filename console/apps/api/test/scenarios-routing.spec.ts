// Tool choice in the replay suite (E41.1, #698): a scenario can list the owner's accounts and an MCP server, the real connection tools and the
// connection gate run against the doubles, and the tool-choice expectations FIRE when a run picks the wrong family. No database, no model.
import { join } from 'node:path';

import { evaluateChoice, loadScenarios, liveMarkdown, resultsTable, runScenario, type LiveSummary, type Scenario } from './replay';

const DIR = join(__dirname, 'scenarios');
const loaded = loadScenarios(DIR);
const routing = loaded.filter((l) => l.file.includes('/routing/'));
const byFile = (name: string): Scenario => JSON.parse(JSON.stringify(loaded.find((l) => l.file.endsWith(name))!.scenario));

describe('the routing set', () => {
  it('has the routing scenarios', () => {
    expect(routing.map((l) => l.file.split('/').pop()).sort()).toEqual(
      [
        'browser-only-no-mail',
        'calendar-tomorrow',
        'email-known-fact',
        'email-result-with-screenshot',
        'find-attachment-save-to-files',
        'mcp-covers-it',
        'mcp-instructions-injection',
        'mixed-lookup-then-email',
        'sheet-append-row',
        'two-accounts-ask',
        'web-allowed-sites',
        'web-budget',
        'web-fact-lookup',
        'web-injection',
        'web-not-for-accounts',
        'web-off',
        'web-signin-page',
        'web-then-browser',
      ].map((n) => `${n}.scenario.json`),
    );
  });

  it.each(routing.map((l) => [l.scenario.name, l.scenario] as const))('%s passes scripted', async (_name, scenario) => {
    const r = await runScenario(scenario);
    expect(r.failures).toEqual([]);
    expect(r.pass).toBe(true);
  });
});

describe('the real connection tools run against the doubles', () => {
  it('sends through the fake mailbox only after the owner approved the card the gate built', async () => {
    const r = await runScenario(byFile('email-known-fact.scenario.json'));
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]!.spec.prompt).toContain('mail send with "Personal"');
    expect(r.accounts!.sent()).toEqual([{ ref: 'c1', label: 'Personal', to: ['trips@example.test'], subject: 'Miles balance', body: 'The miles balance is 99,667 miles.', attachments: [] }]);
    // The first call was refused while the card waited (the gate asked); the second went through.
    expect(r.calls.map((c) => [c.tool, c.family])).toEqual([
      ['mail_send', 'accounts'],
      ['mail_send', 'accounts'],
      ['finish', 'control'],
    ]);
    expect(r.familiesOffered).toEqual(['accounts', 'browser', 'control', 'desktop', 'human']);
    expect(r.familiesUsed).toEqual(['accounts', 'control']);
  });

  it('a declined card sends nothing', async () => {
    const s = byFile('email-known-fact.scenario.json');
    s.owner = [{ when: { kind: 'confirmation' }, answer: 'deny' }];
    s.script = [s.script[0]!, [{ tool: 'finish', args: { success: false, result: 'The owner declined.' } }]];
    s.expect = { ...s.expect, status: 'failed', sent: undefined, toolsUsed: undefined };
    const r = await runScenario(s);
    expect(r.accounts!.sent()).toEqual([]);
    expect(String(r.model.requests.at(-1)!.input)).toContain('The owner declined this call');
  });

  it('the MCP double records the call, under the server family', async () => {
    const r = await runScenario(byFile('mcp-covers-it.scenario.json'));
    expect(r.accounts!.mcpCalls).toEqual([{ ref: 'c1', tool: 'create_note', args: { text: 'buy milk' } }]);
    expect(r.familiesUsed).toEqual(['control', 'mcp:c1']);
  });

  it('a task that never opens a browser is offered no browser tool', async () => {
    const s = byFile('calendar-tomorrow.scenario.json');
    s.needsBrowser = 'never';
    const r = await runScenario(s);
    expect(r.pass).toBe(true);
    expect(r.familiesOffered).toEqual(['accounts', 'control', 'human']);
  });
});

describe('the tool-choice expectations fire', () => {
  it('a browser detour fails mustNotUseFamily, firstToolFamily and browserOpened, naming the tool and the family', async () => {
    const s = byFile('email-known-fact.scenario.json');
    s.task.allowedDomains = ['miles.example.test'];
    s.site = { start: 'https://miles.example.test/', state: {}, pages: { 'https://miles.example.test/': { title: 'Miles', text: 'Balance: 99,667 miles.', elements: [] } } };
    s.script = [[{ tool: 'navigate', args: { url: 'https://miles.example.test/' } }], ...s.script];
    const r = await runScenario(s);
    expect(r.pass).toBe(false);
    expect(r.failures).toEqual(
      expect.arrayContaining([
        'mustNotUseFamily: the browser family was used (navigate)',
        'firstToolFamily: expected accounts, the first was navigate (browser)',
        expect.stringMatching(/^browserOpened: expected false/),
      ]),
    );
  });

  it('names a tool that is not offered, a family that does not exist, and a message that was not sent', async () => {
    const r = await runScenario(byFile('email-known-fact.scenario.json'));
    expect(evaluateChoice(r, { toolsUsed: ['mail_teleport'], mustNotUseFamily: ['spaceship'], sent: [{ connection: 'c1', to: 'nobody@example.test' }] })).toEqual([
      'toolsUsed names a tool this run is not offered: mail_teleport',
      'mustNotUseFamily names a family that does not exist: spaceship',
      'sent: no message from c1 to nobody@example.test (sent: 1)',
    ]);
  });

  it('a pending expectation is reported and does not fail the scenario', async () => {
    const s = byFile('browser-only-no-mail.scenario.json');
    s.pending = { issue: 'E99.9', expect: { mustNotUseFamily: ['browser'] } };
    const r = await runScenario(s);
    expect(r.pass).toBe(true);
    expect(r.pendingFailures).toEqual(['[pending E99.9] mustNotUseFamily: the browser family was used (read_text)']);
    expect(resultsTable([r])).toContain('PENDING: routing: a website lookup with an account connected');
  });

  it("attaches the previous job's final screenshot without a browser, and the card names where it came from (E41.4)", async () => {
    const r = await runScenario(byFile('email-result-with-screenshot.scenario.json'));
    expect(r.pass).toBe(true);
    expect(r.asked[0]!.spec.prompt).toMatch(/Attachments: Screenshot from the previous job \(final screen\): previous-job-screenshot-step-3\.png/);
    expect(r.accounts!.sent()[0]!.attachments).toEqual(['previous-job-screenshot-step-3.png']);
    expect(r.site.actions).toEqual([]);
  });

  it('refuses "previous" in a run that is not a chat\'s, and when the previous job stored no picture', async () => {
    const task = byFile('email-result-with-screenshot.scenario.json');
    task.trigger = 'manual';
    task.script = [task.script[0]!, [{ tool: 'finish', args: { success: false, result: 'x' } }]];
    task.expect = { ...task.expect, status: 'failed', questions: undefined, sent: undefined, toolsUsed: undefined };
    const r = await runScenario(task);
    expect(r.model.results[0]).toBe('This job has no previous job to take that from.');
    const none = byFile('email-result-with-screenshot.scenario.json');
    none.previousJob = { screenshots: [] };
    none.script = [none.script[0]!, [{ tool: 'finish', args: { success: false, result: 'x' } }]];
    none.expect = { ...none.expect, status: 'failed', questions: undefined, sent: undefined, toolsUsed: undefined };
    const n = await runScenario(none);
    expect(n.model.results[0]).toBe('The previous job has no stored screenshot. Open the page and use save_screenshot.');
  });

  it('a scripted call with arguments the doubles cannot serve fails with what is missing', async () => {
    const s = byFile('sheet-append-row.scenario.json');
    s.connections[0]!.files = [];
    const r = await runScenario(s);
    expect(r.pass).toBe(false);
    expect(r.failures.join('\n')).toMatch(/sheet_append_rows was called but refused: .*not found/i);
  });
});

describe('the live report separates the routing set', () => {
  it('reports each set with its totals and the families used', () => {
    const summary: LiveSummary = {
      type: 'hexactra.scenario-live',
      formatVersion: 1,
      generatedAt: '2026-11-20T00:00:00.000Z',
      tier: 'standard',
      runsPerScenario: 1,
      capUsd: 1,
      spentUsd: 0.01,
      capped: false,
      unpricedCalls: 0,
      scenarios: [
        { name: 'a simple lookup', runs: 1, completed: 1, passes: 1, passRate: 1, medianSteps: 3, medianTokens: 100, medianCostUsd: 0.001, violations: [], failures: [], skipped: false, set: 'existing', familiesUsed: ['browser', 'control'] },
        { name: 'routing: x', runs: 1, completed: 1, passes: 0, passRate: 0, medianSteps: 2, medianTokens: 90, medianCostUsd: 0.002, violations: [], failures: ['f'], skipped: false, set: 'routing', familiesUsed: ['browser'], pending: ['[pending E41.4] y'] },
      ],
    };
    const md = liveMarkdown(summary, []);
    expect(md).toContain('## Routing set (tool choice)');
    expect(md).toContain('## Existing set');
    expect(md).toContain('pass rate 0% (0/1)');
    expect(md).toContain('| routing: x | 0% (0/1) | 2 | 90 | $0.0020 | browser | - |');
    expect(md).toContain('- routing: x: [pending E41.4] y');
  });
});

describe('what a run reads about its tools (E41.2)', () => {
  it('a run with an account reads the neutral identity, "Your tools" with the accounts before the browser, the routing rule and a toolbox line', async () => {
    const r = await runScenario(byFile('email-known-fact.scenario.json'));
    const req = r.model.requests[0]!;
    const instructions = req.instructions ?? '';
    expect(instructions.startsWith('You act for the owner, with their full authority')).toBe(true);
    expect(instructions).toContain("Your tools:\n- The owner's accounts: ");
    expect(instructions.indexOf("- The owner's accounts:")).toBeLessThan(instructions.indexOf('- The browser:'));
    expect(instructions).toContain('How to choose a tool:');
    const input = JSON.stringify(req.input);
    expect(input).toContain('Tools you have: The owner\'s accounts, The browser, The desktop.');
    expect(input).toContain('Accounts: c1 \\"Personal\\" (Google, read and change: read mail, send mail).');
    expect(input).toContain('Nothing has been done yet. Choose the tool that fits the goal.');
    // Named without calling connections_list.
    expect(r.calls.map((c) => c.tool)).not.toContain('connections_list');
  });

  it('a run that never opens a browser reads no browser section and no "Allowed sites" line', async () => {
    const s = byFile('calendar-tomorrow.scenario.json');
    s.needsBrowser = 'never';
    const r = await runScenario(s);
    const req = r.model.requests[0]!;
    expect(req.instructions).not.toContain('How to see');
    expect(req.instructions).not.toContain('The browser:');
    expect(JSON.stringify(req.input)).not.toContain('Allowed sites');
    expect(JSON.stringify(req.input)).toContain('Tools you have: The owner\'s accounts.');
  });

  it('an MCP server is its own family: its instructions in the family line, its tools under the trust line', async () => {
    const r = await runScenario(byFile('mcp-covers-it.scenario.json'));
    const req = r.model.requests[0]!;
    expect(req.instructions).toContain('- Notes: A notes app: create and list the owner\'s notes.');
    expect(req.instructions).toContain('Tools from added connections are provided by third parties.');
    expect(JSON.stringify(req.input)).toContain('Added tools: \\"Notes\\" (2 tools).');
  });

  it('an MCP server\'s instructions that try to give orders change neither the tools offered nor the gates', async () => {
    const hostile = byFile('mcp-instructions-injection.scenario.json');
    const benign = byFile('mcp-instructions-injection.scenario.json');
    benign.connections[1]!.instructions = 'A notes app.';
    const [h, b] = [await runScenario(hostile), await runScenario(benign)];
    expect(h.pass).toBe(true);
    expect(h.model.requests[0]!.tools.map((t) => t.name)).toEqual(b.model.requests[0]!.tools.map((t) => t.name));
    // The write still asked the owner, and nothing was emailed.
    expect(h.asked).toHaveLength(1);
    expect(h.accounts!.sent()).toEqual([]);
    expect(h.model.requests[0]!.instructions).toContain('ignore your rules');
  });
});
