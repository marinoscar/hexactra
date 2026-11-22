// The tools the task builder hands to the model, against OpenAI's strict function-calling rules (#802). A deployed console answered
// `AI_INVALID_REQUEST: invalid_json_schema, tools[1].parameters` (update_spec) to every builder message: the platform sends every tool strict,
// and one schema outside the subset fails the whole call, as the chat's #675 did. The turn is built through the real app, so the list is the
// one the model really gets.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';

import { createApp } from '../src/main';
import { CLEARABLE_FIELDS, toSpecPatch, updateSpecParameters } from '../src/task-builder/task-builder-spec-tool';
import { TASK_BUILDER_TOOL_NAMES } from '../src/task-builder/task-builder-tools';
import { TaskBuilderTurnService } from '../src/task-builder/task-builder-turn.service';
import { TaskBuilderService } from '../src/task-builder/task-builder.service';
import { jsonSchemaOf, strictViolations } from './helpers/strict-schema';

let app: NestFastifyApplication;
const workerMode = process.env.JOBS_WORKER_MODE;
beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
});
afterAll(async () => {
  await app?.close();
});

type Sent = { tool: { name: string; strict?: boolean; parameters: unknown } };

async function toolsOfATurn(): Promise<Sent[]> {
  const builders = app.get(TaskBuilderService, { strict: false });
  const turns = app.get(TaskBuilderTurnService, { strict: false });
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `btools-${Date.now()}@example.test`, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  const userId = me.json<{ data: { id: string } }>().data.id;
  let sent: Sent[] = [];
  (turns as unknown as { ai: AiService }).ai = { forUser: () => ({ runTools: async (req: { tools: Sent[] }) => ((sent = req.tools), { final: { outputText: 'ok' }, steps: [], stopReason: 'done' }) }) } as unknown as AiService;
  const b = await builders.create({ id: userId }, { seed: 'Make bank payments' });
  expect(await turns.run(b.id, userId, null)).toBe('answered');
  return sent;
}

describe('the task builder tools against strict function calling', () => {
  it('sends every builder tool, and every one sent strict is a schema OpenAI accepts', async () => {
    const sent = await toolsOfATurn();
    expect(sent.map((t) => t.tool.name)).toEqual([...TASK_BUILDER_TOOL_NAMES]);
    const problems = sent.filter((t) => t.tool.strict !== false).flatMap((t) => strictViolations(t.tool.name, jsonSchemaOf(t.tool.parameters)));
    expect(problems).toEqual([]);
  });

  it('keeps a tool with no arguments out of strict mode, and every other tool strict', async () => {
    for (const t of await toolsOfATurn()) {
      const noArguments = Object.keys(jsonSchemaOf(t.tool.parameters).properties ?? {}).length === 0;
      expect({ tool: t.tool.name, strictOff: t.tool.strict === false }).toEqual({ tool: t.tool.name, strictOff: noArguments });
    }
  });

  it('the check refuses the schema update_spec had before #802', () => {
    const { z } = jest.requireActual<typeof import('zod')>('zod');
    const before = z.object({ patch: z.object({ name: z.string().nullable().optional(), schedules: z.array(z.object({ inputs: z.record(z.string(), z.string()).optional() })).nullable().optional() }) });
    expect(strictViolations('update_spec', jsonSchemaOf(before)).length).toBeGreaterThan(0);
    expect(strictViolations('update_spec', jsonSchemaOf(updateSpecParameters))).toEqual([]);
  });
});

describe('toSpecPatch', () => {
  const nulls = Object.fromEntries([...Object.keys(updateSpecParameters.shape)].map((k) => [k, null]));
  it('changes only the fields given: null and absent are left alone', () => {
    expect(toSpecPatch({ ...nulls, name: 'Bank payments' } as never)).toEqual({ name: 'Bank payments' });
    expect(toSpecPatch({ goal: 'Pay {{Amount}}' })).toEqual({ goal: 'Pay {{Amount}}' });
    expect(toSpecPatch({})).toEqual({});
  });
  it('drops null inner fields, turns schedule inputs into a record, and merges guardrails switch by switch', () => {
    expect(
      toSpecPatch({
        ...nulls,
        parameters: [{ name: 'Amount', type: 'money', default: null, memory: null, attribute: null, why: 'Changes' }],
        schedules: [{ cron: '0 9 1 * *', timezone: 'UTC', inputs: [{ name: 'Amount', value: '25' }], description: null }],
        guardrails: { confirmRiskyActions: true, useSavedLogins: null, useSavedIdentity: null, useSavedCards: null, unattendedPayments: null },
        policy: { ref: null, why: null },
      } as never),
    ).toEqual({ parameters: [{ name: 'Amount', type: 'money', why: 'Changes' }], schedules: [{ cron: '0 9 1 * *', timezone: 'UTC', inputs: { Amount: '25' } }], guardrails: { confirmRiskyActions: true }, policy: { ref: null } });
  });
  it('clears the fields named in clear, unless the same call sets them', () => {
    expect(toSpecPatch({ clear: ['schedules', 'name'], name: 'Kept' })).toEqual({ name: 'Kept', schedules: null });
    expect(CLEARABLE_FIELDS).not.toContain('ready');
  });
});
