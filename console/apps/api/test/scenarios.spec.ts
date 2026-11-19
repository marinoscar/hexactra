// The replay suite in scripted mode (E38.6, #587): the scenario schema, every scenario run against the real runner loop, the invariants
// each broken on purpose and reported by name, the reports, and the rules for what a scenario may contain. No database, no model.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  INVARIANT_RULES,
  isViolationOf,
  junitXml,
  loadScenarios,
  parseScenario,
  resultsTable,
  runScenario,
  ScenarioInvalid,
  scenarioJsonSchema,
  type Scenario,
} from './replay';

const DIR = join(__dirname, 'scenarios');
const loaded = loadScenarios(DIR);
const violating = loaded.filter((l) => l.scenario.expect.violations.length > 0);
const starter = loaded.filter((l) => l.scenario.expect.violations.length === 0);
const byFile = (name: string): Scenario => loaded.find((l) => l.file.endsWith(name))!.scenario;
const clone = (s: Scenario): Scenario => JSON.parse(JSON.stringify(s));

describe('the scenario format', () => {
  it('has a JSON Schema beside it that is the one the zod schema generates', () => {
    expect(JSON.parse(readFileSync(join(DIR, 'scenario.schema.json'), 'utf8'))).toEqual(JSON.parse(JSON.stringify(scenarioJsonSchema())));
  });

  it('validates every scenario file, and names the field of an invalid one', () => {
    expect(loaded.length).toBeGreaterThan(0);
    const bad = { ...JSON.parse(readFileSync(join(DIR, 'lookup.scenario.json'), 'utf8')) } as Record<string, unknown>;
    delete bad.goal;
    (bad.site as { pages: Record<string, { elements: Record<string, unknown>[] }> }).pages['https://shop.example.test/'] = { title: 'x', text: 'y', elements: [{ selector: '#a', label: 'A' }] } as never;
    let error: ScenarioInvalid | null = null;
    try {
      parseScenario(bad, 'bad.scenario.json');
    } catch (e) {
      error = e as ScenarioInvalid;
    }
    expect(error).toBeInstanceOf(ScenarioInvalid);
    expect(error!.message).toContain('bad.scenario.json');
    expect(error!.problems).toEqual(expect.arrayContaining([expect.stringMatching(/^goal:/), expect.stringMatching(/^site\.pages\.https:\/\/shop\.example\.test\/\.elements\.0\.id:/)]));
  });

  it('refuses an unknown field, so a typo is not silently ignored', () => {
    const bad = JSON.parse(readFileSync(join(DIR, 'lookup.scenario.json'), 'utf8')) as Record<string, unknown>;
    (bad.expect as Record<string, unknown>).statuss = 'succeeded';
    expect(() => parseScenario(bad)).toThrow(/expect.*statuss|Unrecognized key/);
  });

  it('fails loading with the file named when a file is not JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hx-scn-'));
    writeFileSync(join(dir, 'broken.scenario.json'), '{ nope');
    expect(() => loadScenarios(dir)).toThrow(/broken\.scenario\.json: not JSON/);
  });
});

describe('the starter set', () => {
  it('has at least twelve scenarios, covering what the issue lists', () => {
    expect(starter.length).toBeGreaterThanOrEqual(12);
    const names = starter.map((l) => l.scenario.name).join('\n');
    for (const topic of [/lookup/, /multi-page form/, /login/, /code prompt/, /confirmed payment/, /denied confirmation/, /date picker/, /stall/, /unattended/, /chat run/, /injection/, /crash before/, /crash after/, /Stop/]) expect(names).toMatch(topic);
  });

  it.each(starter.map((l) => [l.scenario.name, l.scenario] as const))('passes in scripted mode: %s', async (_name, scenario) => {
    const result = await runScenario(scenario);
    expect(result.failures).toEqual([]);
    expect(result.violations).toEqual([]);
    expect(result.pass).toBe(true);
  });
});

describe('the invariants', () => {
  it('has a scenario that violates each rule on purpose, and the suite reports it by name', () => {
    for (const rule of INVARIANT_RULES) expect(violating.some((l) => l.scenario.expect.violations.some((v) => isViolationOf(v, rule) || v.startsWith(rule.split(':')[0]! + ':')))).toBe(true);
  });

  it.each(violating.map((l) => [l.scenario.name, l.scenario] as const))('reports the violation of: %s', async (_name, scenario) => {
    const result = await runScenario(scenario);
    expect(result.failures).toEqual([]);
    for (const expected of scenario.expect.violations) expect(result.violations.some((v) => isViolationOf(v, expected))).toBe(true);
  });

  it('names the click that was not confirmed, the host left, the repeated commit and where a secret showed up', async () => {
    expect((await runScenario(byFile('violations/pay-without-asking.scenario.json'))).violations).toEqual(['click:Pay:without_confirmation']);
    expect((await runScenario(byFile('violations/leaves-allowed-sites.scenario.json'))).violations).toEqual(['navigate:outside_allowed_sites:elsewhere.example.test']);
    expect((await runScenario(byFile('violations/repeats-a-commit.scenario.json'))).violations).toContain('repeat_commit:Pay');
    expect((await runScenario(byFile('violations/secret-in-model-input.scenario.json'))).violations).toEqual(['secret_leak:model_input']);
  });

  it('fails a scenario that does not expect a violation when one happens', async () => {
    const s = clone(byFile('violations/pay-without-asking.scenario.json'));
    s.expect.violations = [];
    const result = await runScenario(s);
    expect(result.pass).toBe(false);
    expect(result.failures).toContain('violation: click:Pay:without_confirmation');
  });

  it('fails a scenario that expects a violation the run did not have', async () => {
    const s = clone(byFile('payment-confirmed.scenario.json'));
    s.expect.violations = ['repeat_commit'];
    const result = await runScenario(s);
    expect(result.pass).toBe(false);
    expect(result.failures).toContain('expected the suite to report repeat_commit, and it did not');
  });

  it('does not let the gates off make an honest scenario pass: the confirmed payment with the gates off is a violation', async () => {
    const s = clone(byFile('payment-confirmed.scenario.json'));
    s.harness.sabotage = ['gates_off'];
    const result = await runScenario(s);
    expect(result.violations).toContain('click:Pay:without_confirmation');
    expect(result.pass).toBe(false);
  });

  it('keeps a typed secret out of every step, the memory, the model input and the spans (the login scenario)', async () => {
    const result = await runScenario(byFile('login-from-owner.scenario.json'));
    const everything = JSON.stringify([result.steps, result.memory, result.model.requests.map((r) => [r.instructions, r.input]), result.model.results]);
    expect(everything).not.toContain('pw-invented-8271-qz');
    expect(result.site.state.pass).toBe('pw-invented-8271-qz');
  });

  it('names a script that asks for a tool that is not offered, or that runs out, instead of passing', async () => {
    const wrongTool = clone(byFile('lookup.scenario.json'));
    wrongTool.script = [[{ tool: 'not_a_tool' }]];
    expect((await runScenario(wrongTool)).failures.join('\n')).toMatch(/"not_a_tool", which is not offered/);
    const runsOut = clone(byFile('lookup.scenario.json'));
    runsOut.script = [[{ tool: 'observe_elements' }]];
    const result = await runScenario(runsOut);
    expect(result.status).toBe('error');
    expect(result.failures.join('\n')).toMatch(/the script has no more model calls/);
  });

  it('refuses a script whose arguments the tool does not accept, with the field named', async () => {
    const s = clone(byFile('lookup.scenario.json'));
    s.script = [[{ tool: 'navigate', args: { url: 42 } }]];
    expect((await runScenario(s)).failures.join('\n')).toMatch(/arguments for "navigate" are refused: url/);
  });
});

describe('what the harness does in a scenario', () => {
  it('asks before the Pay click, and the click reaches the browser once, after the answer', async () => {
    const r = await runScenario(byFile('payment-confirmed.scenario.json'));
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]!.activationsAtAsk).toBe(0);
    expect(r.site.activations.map((a) => a.label)).toEqual(['Pay']);
  });

  it('moves a stalled run to the next tier', async () => {
    const r = await runScenario(byFile('stall-escalates.scenario.json'));
    expect(r.tier).toBe('frontier');
    expect(r.model.requests.map((q) => q.route.label)).toEqual(['standard', 'standard', 'frontier', 'frontier']);
  });

  it('marks the click unknown after a crash and asks again before it clicks', async () => {
    const r = await runScenario(byFile('crash-before-confirmed-click.scenario.json'));
    expect(r.steps.some((s) => s.phase === 'unknown')).toBe(true);
    expect(r.asked.map((q) => q.spec.kind)).toEqual(['confirmation', 'confirmation']);
    expect(r.site.activations).toHaveLength(1);
  });

  it('never repeats a payment that happened before the crash', async () => {
    const r = await runScenario(byFile('crash-after-confirmed-click.scenario.json'));
    expect(r.steps.some((s) => s.phase === 'unknown')).toBe(true);
    expect(r.site.activations).toHaveLength(1);
  });

  it('keeps a chat run going past a budget a scheduled run stops at', async () => {
    const stopped = await runScenario(byFile('budget-stop-unattended.scenario.json'));
    const chat = await runScenario(byFile('budget-no-stop-chat.scenario.json'));
    expect((stopped.finished!.patch as { stopReason: string }).stopReason).toBe('budget_actions');
    expect((chat.finished!.patch as { stopReason: string }).stopReason).toBe('finished');
  });

  it('is deterministic: the same scenario gives the same steps and tokens twice', async () => {
    const a = await runScenario(byFile('payment-confirmed.scenario.json'));
    const b = await runScenario(byFile('payment-confirmed.scenario.json'));
    expect(b.steps.map((s) => [s.seq, s.kind, s.action, s.summary])).toEqual(a.steps.map((s) => [s.seq, s.kind, s.action, s.summary]));
    expect(b.usage).toEqual(a.usage);
  });
});

describe('the reports', () => {
  it('prints a table with a line per scenario and the reason a scenario failed', async () => {
    const bad = clone(byFile('lookup.scenario.json'));
    bad.expect.status = 'failed';
    const results = [await runScenario(byFile('lookup.scenario.json')), await runScenario(bad)];
    const table = resultsTable(results);
    expect(table).toMatch(/PASS\s+a simple lookup/);
    expect(table).toMatch(/FAIL\s+a simple lookup/);
    expect(table).toContain('1 of 2 scenarios passed');
    expect(table).toContain('status: expected failed, got succeeded');
  });

  it('writes JUnit XML with a failure per failed scenario, escaped', async () => {
    const bad = clone(byFile('lookup.scenario.json'));
    bad.name = 'a <lookup> & "more"';
    bad.expect.finishIncludes = '<nothing>';
    const xml = junitXml([await runScenario(byFile('lookup.scenario.json')), await runScenario(bad)], new Map([['a simple lookup', 'test/scenarios/lookup.scenario.json']]));
    expect(xml).toContain('<testsuite name="hexactra scenarios (scripted)" tests="2" failures="1"');
    expect(xml).toContain('classname="test/scenarios/lookup.scenario.json" name="a simple lookup" time="0"></testcase>');
    expect(xml).toContain('name="a &lt;lookup&gt; &amp; &quot;more&quot;"');
    expect(xml).toContain('<failure message="finish: the result does not mention &quot;&lt;nothing&gt;&quot;"');
  });
});

describe('what a scenario may contain', () => {
  const files = (function walk(d: string): string[] {
    return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.scenario.json') ? [join(d, e.name)] : []));
  })(DIR);

  // Real companies, banks, payment services and mail providers, and the words that would name a real person's account.
  const DENY = /\b(google|gmail|amazon|paypal|stripe|venmo|zelle|chase|wells ?fargo|citibank|bank of america|barclays|hsbc|santander|revolut|facebook|meta\.com|instagram|twitter|linkedin|microsoft|outlook|apple\.com|icloud|ebay|netflix|spotify|uber|airbnb|booking\.com|walmart|target\.com|ikea)\b/i;

  it('finds the scenario files it reads', () => {
    expect(files.length).toBe(loaded.length);
  });

  it('uses only invented hosts: every address ends in .example.test', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const hosts = [...text.matchAll(/https?:\/\/([^/\s"'?#:]+)/g)].map((m) => m[1]!.toLowerCase());
      const domains = JSON.parse(text) as Scenario;
      hosts.push(...(domains.task?.allowedDomains ?? []), ...(domains.approvals ?? []).map((a) => a.host));
      for (const host of hosts) expect({ file, host }).toEqual({ file, host: expect.stringMatching(/\.example\.test$/) });
    }
  });

  it('names no real company, service or person, and holds no email, phone number or card number', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect({ file, hit: DENY.exec(text)?.[0] ?? null }).toEqual({ file, hit: null });
      expect({ file, email: [...text.matchAll(/[\w.+-]+@([\w-]+\.)+\w+/g)].map((m) => m[0]).filter((e) => !/@[\w.-]*example\.test$/.test(e)) }).toEqual({ file, email: [] });
      expect({ file, long: text.match(/\b\d{12,19}\b/g) }).toEqual({ file, long: null });
    }
  });

  it('uses invented people: Person A or Person B, never a first and last name', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const name of text.match(/Person [A-Z]\b/g) ?? []) expect(['Person A', 'Person B']).toContain(name);
    }
  });
});

describe('the scenarios script', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', 'scripts/scenarios.ts', ...args], { cwd: resolve(__dirname, '..'), encoding: 'utf8', timeout: 120_000 });

  it('exits 1 and says why when no scenario is found: a step never reports success for a suite that did not run', () => {
    const empty = mkdtempSync(join(tmpdir(), 'hx-scn-empty-'));
    const r = run('--dir', empty, '--junit', join(empty, 'out.xml'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no scenario found.*refusing to report success/);
  });

  it('exits 1 naming the file and the field of an invalid scenario', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hx-scn-bad-'));
    writeFileSync(join(dir, 'x.scenario.json'), JSON.stringify({ name: 'x' }));
    const r = run('--dir', dir, '--junit', join(dir, 'out.xml'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/x\.scenario\.json: goal:/);
  });

  it('runs the suite, prints the table and writes the JUnit file', () => {
    const out = mkdtempSync(join(tmpdir(), 'hx-scn-out-'));
    const r = run('--junit', join(out, 'scenarios.xml'));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\d+ of \d+ scenarios passed/);
    expect(readFileSync(join(out, 'scenarios.xml'), 'utf8')).toContain(`tests="${loaded.length}" failures="0"`);
  });
});
