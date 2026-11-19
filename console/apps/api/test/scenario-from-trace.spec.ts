// `scenario-from-trace` (E38.6, #587): an exported run trace becomes a scripted scenario skeleton that is valid against the scenario
// schema, keeps masked values masked, invents every host, and leaves a TODO wherever the trace cannot say. The trace fixture is a valid
// `hexactra.run-trace` file (checked against the export schema here, so it cannot drift from what `runs export` writes).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { scenarioFromTrace } from '@app/shared/scenario-from-trace';

import { runTraceSchema } from '../src/tasks/run-trace.schemas';
import { parseScenario, runScenario } from '../src/runner/testing';

const trace = JSON.parse(readFileSync(join(__dirname, 'fixtures/run-trace-transfer.json'), 'utf8')) as Record<string, any>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('scenarioFromTrace', () => {
  it('reads a fixture that is a valid run trace', () => {
    expect(runTraceSchema.safeParse(trace).success).toBe(true);
  });

  it('produces a skeleton that is valid against the scenario schema', () => {
    const { scenario, todo } = scenarioFromTrace(trace);
    const parsed = parseScenario(scenario);
    expect(parsed.goal).toBe('Send 25.00 to Person A from the Checking account');
    expect(parsed.policy).toBe('builtin:balanced');
    expect(parsed.task).toEqual({ confirmRiskyActions: true, allowedDomains: ['site-1.example.test'] });
    expect(parsed.expect).toMatchObject({ status: 'succeeded', mustAsk: [{ kind: 'confirmation' }] });
    expect(todo.length).toBeGreaterThan(0);
    expect(parsed.name).toMatch(/^TODO name/);
  });

  it("takes the owner's answers and the action sequence as the script, with the page's label from the stopped click", () => {
    const { scenario } = scenarioFromTrace(trace);
    const s = parseScenario(scenario);
    expect(s.owner).toEqual([{ when: { kind: 'confirmation', input: 'confirm' }, answer: 'approve' }]);
    expect(s.script.flat().map((c) => c.tool)).toEqual(['navigate', 'observe_elements', 'type_text', 'type_handoff_secret', 'click', 'request_human', 'click', 'read_text', 'finish']);
    const page = Object.values(s.site.pages)[0]!;
    const send = page.elements.find((e) => e.selector === '#send')!;
    expect(send).toMatchObject({ label: 'Send payment', commit: 'payment' });
    expect(page.elements.find((e) => e.selector === '#card-note')).toMatchObject({ type: 'password', secret: true });
  });

  it('invents every host and path: a real address of the trace is in no output', () => {
    const t = clone(trace);
    t.steps[0].args.url = 'https://realbank.invalid/accounts/transfer/42';
    t.steps[0].summary = 'at https://realbank.invalid/accounts/transfer/42 — Send money';
    const text = JSON.stringify(scenarioFromTrace(t));
    expect(text).not.toContain('realbank');
    expect(text).not.toContain('/accounts/transfer/42');
    expect(text).toContain('site-1.example.test');
  });

  it('never unmasks a value: masked text stays masked, a typed value is a TODO, a secret is a placeholder, no picture is copied', () => {
    const { scenario } = scenarioFromTrace(trace);
    const text = JSON.stringify(scenario);
    expect(text).toContain('card ending ••••4242');
    expect(text).toContain('TODO value (5 characters)');
    expect(text).not.toContain('QUJD');
    // A withheld answer has no value in the trace and none in the skeleton but a placeholder.
    const t = clone(trace);
    t.steps[5].question.input = 'secret';
    t.steps[5].question.answer = { outcome: 'completed', valueWithheld: true, channel: 'web', answeredAt: null };
    const s = parseScenario(scenarioFromTrace(t).scenario);
    expect(s.owner[0]).toEqual({ when: { kind: 'confirmation', input: 'secret' }, answer: 'secret', value: 'TODO-secret-value' });
    expect(s.secrets).toEqual(['TODO-secret-value']);
  });

  it('runs: the skeleton is a scripted scenario the kit can execute as it is, and the owner\'s approval is replayed', async () => {
    const s = parseScenario(scenarioFromTrace(trace).scenario);
    const result = await runScenario(s);
    expect(result.error).toBeNull();
    expect(result.asked.map((q) => q.spec.kind)).toEqual(['confirmation']);
    expect(result.violations).toEqual([]);
  });

  it('leaves out a failed step the fake site cannot reproduce, and says so', () => {
    const t = clone(trace);
    t.steps[1].ok = false;
    t.steps[1].summary = 'timed out';
    const { scenario, todo } = scenarioFromTrace(t);
    expect(parseScenario(scenario).script.flat().map((c) => c.tool)).not.toContain('observe_elements');
    expect(todo.join('\n')).toMatch(/1 failed step\(s\) were left out/);
  });

  it('marks an action with no tool, and a run that was still live, instead of guessing', () => {
    const t = clone(trace);
    t.steps[1].action = 'teleport';
    t.run.status = 'running';
    const { scenario, todo } = scenarioFromTrace(t);
    expect(parseScenario(scenario).script.flat().map((c) => c.tool)).toContain('TODO:teleport');
    expect(todo.join('\n')).toMatch(/the action "teleport" has no tool/);
    expect(todo.join('\n')).toMatch(/was running when exported/);
  });

  it('refuses anything that is not a run trace', () => {
    expect(() => scenarioFromTrace({ type: 'hexactra.agent-policies' })).toThrow(/not a run trace/);
    expect(() => scenarioFromTrace(null)).toThrow(/not a run trace/);
    expect(() => scenarioFromTrace({ type: 'hexactra.run-trace', run: {} })).toThrow(/no "run" or no "steps"/);
  });
});
