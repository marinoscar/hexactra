// `toolFamilyOf` (E41.1, #698): the family the scenario kit, the trace and the metrics name for a tool, and the bounded label of one.
import { z } from 'zod';

import { defineRunnerTool, familyLabel, GatePipeline, toolFamilyOf, type HarnessMemory, type RunContext } from '../src';
import { executeTool } from '../src/engine';
import { fakeRun, FakeTelemetry } from '../src/testing';

describe('toolFamilyOf', () => {
  it('maps the connection groups to their families and keeps every other group', () => {
    expect(toolFamilyOf({ group: 'connection' })).toBe('accounts');
    expect(toolFamilyOf({ group: 'connection:abc-123' })).toBe('mcp:abc-123');
    expect(toolFamilyOf({ group: 'browser' })).toBe('browser');
    expect(toolFamilyOf({ group: 'desktop' })).toBe('desktop');
    expect(toolFamilyOf({ group: 'human' })).toBe('human');
    expect(toolFamilyOf({ group: 'control' })).toBe('control');
  });

  it('prefers an explicit family over the group', () => {
    expect(toolFamilyOf({ group: 'connection', family: 'files' })).toBe('files');
  });

  it('gives every MCP server the one bounded label', () => {
    expect(familyLabel('mcp:abc-123')).toBe('mcp');
    expect(familyLabel('accounts')).toBe('accounts');
  });
});

describe('executeTool tells the telemetry the family and a refusal', () => {
  type Ctx = RunContext<HarnessMemory, Record<string, never>>;
  const tool = defineRunnerTool({
    name: 'note_it',
    group: 'connection:c-9',
    description: 'A test tool.',
    parameters: z.object({}),
    gated: { block: () => ({}) },
    execute: async () => 'done',
  });

  it('records the family, and `refused` when a gate refuses', async () => {
    const { ctx } = fakeRun();
    const telemetry = ctx.ports.telemetry as FakeTelemetry;
    const refuse = new GatePipeline<Ctx>([{ name: 'block', check: async () => ({ kind: 'refuse', text: 'no' }) }]);
    const allow = new GatePipeline<Ctx>([{ name: 'block', check: async () => ({ kind: 'allow' }) }]);
    await executeTool(ctx as Ctx, tool as never, {}, refuse);
    await executeTool(ctx as Ctx, tool as never, {}, allow);
    expect(telemetry.families).toEqual([
      { tool: 'note_it', family: 'mcp:c-9', outcome: 'refused' },
      { tool: 'note_it', family: 'mcp:c-9', outcome: 'ran' },
    ]);
  });
});
