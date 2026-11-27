// The run trace file (#542), pure parts: its JSON Schema shipped in
// packages/sdk (regenerate with UPDATE_RUN_TRACE_SCHEMA=1), the file name,
// the tiers a run used, and how `run_export` fits a large trace into the MCP
// result size limit.
import { readFileSync, writeFileSync } from 'node:fs';

import { MAX_RESULT_CHARS_OAUTH, finalizeResult, limitsFor } from '../src/mcp/mcp.results';
import { MCP_TOOLS } from '../src/mcp/mcp.tools';
import { fitRunTrace } from '../src/mcp/run-export';
import { RUN_TRACE_FORMAT_VERSION, type RunTrace } from '../src/tasks/run-trace.schemas';
import { runExportFilename, tiersUsed } from '../src/tasks/run-trace.service';
import { RUN_TRACE_JSON_SCHEMA, runTraceJsonSchema, runTraceValidator } from './helpers/run-trace-schema';

const RUN = '3f1c2b7a-1234-4abc-8def-0123456789ab';
function trace(steps: number, reasoningChars = 200): RunTrace {
  return {
    type: 'hexactra.run-trace',
    formatVersion: 1,
    exportedAt: '2026-11-18T18:05:00.000Z',
    partial: false,
    console: { version: '1.59.0' },
    masking: { applied: true, patternsVersion: 1, hits: { card: 1 } },
    run: {
      id: RUN,
      goal: 'Find a fare',
      status: 'failed',
      stopReason: 'budget_actions',
      result: null,
      error: 'Out of actions',
      trigger: 'chat',
      origin: 'web',
      client: null,
      taskId: null,
      taskName: null,
      conversationId: null,
      profile: 'default',
      traceIds: [],
      host: null,
      createdAt: '2026-11-18T18:00:00.000Z',
      startedAt: '2026-11-18T18:00:01.000Z',
      finishedAt: '2026-11-18T18:04:00.000Z',
      confirmedActions: [],
      usage: { stepCount: steps, modelCalls: 3, inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, costUsd: 0.01, costKnown: true, activeMs: 1000 },
    },
    policy: null,
    budget: null,
    models: [{ tier: 'standard', model: 'openai:gpt-test', calls: 3 }],
    steps: Array.from({ length: steps }, (_, i) => ({
      seq: i + 1,
      at: '2026-11-18T18:01:00.000Z',
      kind: 'action',
      action: 'click',
      args: { selector: `#b${i}` },
      ok: true,
      summary: `Clicked button ${i}`,
      reasoning: 'r'.repeat(reasoningChars),
      durationMs: 120,
      question: null,
      screenshot: i === 0 ? { moment: 'final', masked: 0, note: null, contentType: 'image/jpeg', bytes: 4, data: 'AAAA' } : null,
    })),
    chat: [],
  };
}

describe('the JSON Schema of the file', () => {
  it('is the one packages/sdk ships, generated from the zod schema', () => {
    const generated = `${JSON.stringify(runTraceJsonSchema(), null, 2)}\n`;
    if (process.env.UPDATE_RUN_TRACE_SCHEMA === '1') writeFileSync(RUN_TRACE_JSON_SCHEMA, generated);
    expect(readFileSync(RUN_TRACE_JSON_SCHEMA, 'utf8')).toBe(generated);
  });

  it('writes version 2 (findings), still reads a version 1 file, and refuses another type or version', () => {
    const validate = runTraceValidator();
    expect(RUN_TRACE_FORMAT_VERSION).toBe(2);
    // A version 1 file: no findings.
    expect(validate(trace(3))).toBe(true);
    const finding = { code: 'loop', severity: 'warn', title: 'The run went round in a loop', detail: 'Steps 3 to 9 repeated', seqFrom: 3, seqTo: 9, stepsSpent: 6, evidence: { cycle: 2 } };
    expect(validate({ ...trace(3), formatVersion: 2, findings: [finding] })).toBe(true);
    expect(validate({ ...trace(3), formatVersion: 2, findings: [] })).toBe(true);
    expect(validate({ ...trace(3), formatVersion: 2, findings: [{ ...finding, code: 'made_up' }] })).toBe(false);
    expect(validate({ ...trace(1), formatVersion: 3 })).toBe(false);
    expect(validate({ ...trace(1), type: 'hexactra.agent-policies' })).toBe(false);
  });
});

describe('the file name and the models', () => {
  it('is hexactra-run-<first 8 of id>-<yyyymmdd>.json in UTC', () => {
    expect(runExportFilename(RUN, new Date('2026-11-18T23:59:00Z'))).toBe('hexactra-run-3f1c2b7a-20261118.json');
  });

  it('lists the start tier, then each tier a routing step moved to, once', () => {
    const steps = [
      { kind: 'action', args: { to: 'frontier' } },
      { kind: 'routing', args: { from: 'standard', to: 'frontier', reason: 'stalled' } },
      { kind: 'routing', args: { from: 'frontier', to: 'standard' } },
      { kind: 'routing', args: { from: 'standard', to: 'nonsense' } },
    ];
    expect(tiersUsed('standard', steps)).toEqual(['standard', 'frontier']);
    expect(tiersUsed(null, [])).toEqual([]);
  });
});

describe('run_export: fitting the trace into a tool result', () => {
  it('never carries an image, and leaves a trace that fits as it is', () => {
    const out = fitRunTrace(trace(3), 100_000);
    expect(out.truncated).toBe(false);
    expect(out.truncation).toEqual({ reasoningDropped: false, stepsOmitted: 0, chatOmitted: 0 });
    expect(JSON.stringify(out)).not.toContain('AAAA');
    expect(out.steps[0]!.screenshot).toEqual({ moment: 'final', masked: 0, note: null, contentType: 'image/jpeg', bytes: 4 });
  });

  it('drops the reasoning first, then the oldest steps, says so, and holds the size limit', () => {
    const reasoningOnly = fitRunTrace(trace(40, 3_000), 100_000);
    expect(reasoningOnly).toMatchObject({ truncated: true, truncation: { reasoningDropped: true, stepsOmitted: 0, chatOmitted: 0 } });
    expect(reasoningOnly.steps).toHaveLength(40);

    const big = fitRunTrace(trace(3_000), MAX_RESULT_CHARS_OAUTH);
    expect(big.truncated).toBe(true);
    expect(big.truncation.reasoningDropped).toBe(true);
    expect(big.truncation.stepsOmitted).toBeGreaterThan(0);
    expect(big.steps[big.steps.length - 1]!.seq).toBe(3_000);
    expect(big.steps[0]!.seq).toBe(big.truncation.stepsOmitted + 1);
    expect(big.steps.every((s) => s.reasoning === null)).toBe(true);
    // The finished result (notice, summary, pretty JSON) stays within the OAuth limit without the generic cut.
    const tool = MCP_TOOLS.find((t) => t.name === 'run_export')!;
    expect(tool).toBeDefined();
    const text = JSON.stringify(big, null, 2);
    const final = finalizeResult({ content: [{ type: 'text', text }], structuredContent: big as never, summary: 'Run 3f1c2b7a: failed.', untrusted: true }, { structured: true, limits: limitsFor('oauth') });
    const sent = (final.content[0] as { text: string }).text;
    expect(sent.length).toBeLessThanOrEqual(MAX_RESULT_CHARS_OAUTH);
    expect(sent).not.toContain('[Truncated:');
  });

  it('drops the oldest chat messages only once every step is gone', () => {
    const chatty = { ...trace(5), chat: Array.from({ length: 300 }, (_, i) => ({ seq: i + 1, role: 'user' as const, kind: 'text', text: 'c'.repeat(1_000), at: '2026-11-18T18:00:00.000Z' })) };
    const out = fitRunTrace(chatty, 100_000);
    expect(out.steps).toEqual([]);
    expect(out.truncation.stepsOmitted).toBe(5);
    expect(out.truncation.chatOmitted).toBeGreaterThan(0);
    expect(out.chat[out.chat.length - 1]!.seq).toBe(300);
    expect(JSON.stringify(out, null, 2).length).toBeLessThanOrEqual(100_000);
  });
});

describe('the run_export tool', () => {
  it('reads the file without images through the export route and marks the result untrusted', async () => {
    const tool = MCP_TOOLS.find((t) => t.name === 'run_export')!;
    expect([tool.title, tool.scope, tool.effect, tool.openWorld]).toEqual(["Export a run's trace", 'runs:read', 'read', false]);
    const paths: string[] = [];
    const result = await tool.call({ run_id: RUN }, {
      api: async <T>(_m: string, path: string) => {
        paths.push(path);
        return trace(2) as T;
      },
      bytes: async () => ({ mime: 'image/jpeg', data: Buffer.alloc(0) }),
    });
    expect(paths).toEqual([`/runs/${RUN}/export?format=json&screenshots=none`]);
    expect(result.untrusted).toBe(true);
    expect(result.structuredContent).toMatchObject({ truncated: false, run: { id: RUN } });
    expect(JSON.stringify(result)).not.toContain('AAAA');
  });
});
