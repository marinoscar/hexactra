// The policy editor's helper texts and bounds are the API's own `.describe()`
// strings and zod limits (apps/api/src/policies/agent-policy.schema.ts), read
// here from the OpenAPI document the SDK is generated from. When the API
// changes a text or a bound, this test names the entry of src/policies/help.ts
// to update, so the editor never drifts from the API.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ACTION_RESULTS_HELP, BUDGET_HELP, SCREENSHOT_WHEN_HELP, CONTEXT_HELP, MODELS_HELP, SECTION_HELP, STALL_HELP, budgetHelp, plain } from '../policies/help';
import { BUDGET_LIMIT_KEYS, CONFLICT_MODES, STALL_ACTIONS, TIERS } from '../policies/types';

interface JsonSchema {
  description?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  enum?: string[];
  properties?: Record<string, JsonSchema>;
  anyOf?: JsonSchema[];
}

const doc = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', 'packages', 'sdk', 'openapi.json'), 'utf8')) as {
  components: { schemas: Record<string, JsonSchema> };
};
const spec = doc.components.schemas.AgentPolicyResponseDto!.properties!.spec!;
const section = (name: string) => spec.properties![name]!;
const field = (sec: string, name: string) => section(sec).properties![name]!;
/** The numeric branch of a nullable number (`anyOf: [number, null]`), or the field itself. */
const numeric = (s: JsonSchema) => s.anyOf?.find((x) => x.minimum !== undefined || x.maximum !== undefined || x.exclusiveMinimum !== undefined) ?? s;

describe('policy helper texts match the API', () => {
  it.each(Object.entries(SECTION_HELP))('section %s', (name, text) => {
    expect(section(name).description).toBe(text);
  });

  it.each(Object.entries(MODELS_HELP))('models.%s', (name, text) => {
    expect(field('models', name).description).toBe(text);
  });

  it.each(Object.entries(BUDGET_HELP))('budget.%s', (name, help) => {
    const f = field('budget', name);
    expect(f.description).toBe(help.text);
    const n = numeric(f);
    expect(n.maximum).toBe(help.max);
    // Cost is `positive()` (exclusive minimum 0): the editor's smallest step is a cent.
    if (name === 'maxCostUsd') expect(n.exclusiveMinimum).toBe(0);
    else expect(n.minimum).toBe(help.min);
  });

  it.each(Object.entries(STALL_HELP))('stall.%s', (name, help) => {
    const f = field('stall', name);
    if (typeof help === 'string') {
      expect(f.description).toBe(help);
      return;
    }
    expect(f.description).toBe(help.text);
    expect([f.minimum, f.maximum]).toEqual([help.min, help.max]);
  });

  it.each(Object.entries(CONTEXT_HELP))('context.%s', (name, help) => {
    const f = field('context', name);
    expect(f.description).toBe(help.text);
    expect([f.minimum, f.maximum]).toEqual([help.min, help.max]);
  });

  it('context.actionResults (E54.2)', () => {
    expect(field('context', 'actionResults').description).toBe(ACTION_RESULTS_HELP);
    expect(field('context', 'actionResults').enum).toEqual(['plain', 'delta']);
  });

  it('context.screenshotWhen (E54.3)', () => {
    expect(field('context', 'screenshotWhen').description).toBe(SCREENSHOT_WHEN_HELP);
    expect(field('context', 'screenshotWhen').enum).toEqual(['every_round', 'on_change']);
  });

  it('covers every budget, and the enums the editor offers are the API\'s', () => {
    expect(Object.keys(section('budget').properties!).sort()).toEqual([...BUDGET_LIMIT_KEYS, 'maxWebCalls', 'warnAtPercent'].sort());
    expect(field('models', 'startTier').enum).toEqual([...TIERS]);
    expect(field('stall', 'onStall').enum).toEqual([...STALL_ACTIONS]);
  });

  it('turns code spans into plain words and leaves the "No limit" sentence to the switch', () => {
    expect(plain('Never below `startTier`.')).toBe('Never below startTier.');
    expect(budgetHelp('maxActions')).toBe('Most browser actions a run may take.');
    expect(CONFLICT_MODES).toEqual(['rename', 'skip', 'replace']);
  });
});
