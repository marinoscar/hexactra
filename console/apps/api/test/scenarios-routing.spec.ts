// Tool choice in the replay suite (E41.1, #698): a scenario can list the owner's accounts and an MCP server, the real connection tools and the
// connection gate run against the doubles, and the tool-choice expectations FIRE when a run picks the wrong family. No database, no model.
import { join } from 'node:path';

import { evaluateChoice, loadScenarios, liveMarkdown, resultsTable, runScenario, type LiveSummary, type Scenario } from './replay';

const DIR = join(__dirname, 'scenarios');
const loaded = loadScenarios(DIR);
const routing = loaded.filter((l) => l.file.includes('/routing/'));
const byFile = (name: string): Scenario => JSON.parse(JSON.stringify(loaded.find((l) => l.file.endsWith(name))!.scenario));

describe('the routing set', () => {
  it('has the nine routing scenarios', () => {
    expect(routing.map((l) => l.file.split('/').pop()).sort()).toEqual(
      [
        'browser-only-no-mail',
        'calendar-tomorrow',
        'email-known-fact',
        'email-result-with-screenshot',
        'find-attachment-save-to-files',
        'mcp-covers-it',
        'mixed-lookup-then-email',
        'sheet-append-row',
        'two-accounts-ask',
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
    const r = await runScenario(byFile('email-result-with-screenshot.scenario.json'));
    expect(r.pass).toBe(true);
    expect(r.pendingFailures).toEqual(expect.arrayContaining(['[pending E41.4] mustNotUseFamily: the browser family was used (navigate, read_text)']));
    expect(resultsTable([r])).toContain('PENDING: routing: email a found result with a screenshot');
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
