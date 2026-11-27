// The tools the chat hands to the model, against OpenAI's strict function-calling rules (#675). OpenAI answered 400 `invalid_function_parameters`
// on `tools[3].parameters` (propose_memory's free-form `attributes` record) to EVERY chat message, even "hello", because every tool is sent
// strict and one bad schema fails the whole call. The chat is built through the real app, so the list is the one the model really gets.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';

import { CHAT_CONNECTION_TOOLS } from '../src/chat/chat-connection-tools';
import { ChatTurnService } from '../src/chat/chat-turn.service';
import { ChatService } from '../src/chat/chat.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { attributesFromPairs } from '../src/memories/memory-attribute-pairs';
import { createApp } from '../src/main';
import { finishParameters } from '../src/runner/outputs';
import { proposeMemory } from '../src/runner/host/tools/propose';
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

/** The tools one chat turn sends to the model, as the app wires them (every optional collaborator present). */
async function toolsOfATurn(savedTasks = 0): Promise<Sent[]> {
  const chats = app.get(ChatService, { strict: false });
  const turns = app.get(ChatTurnService, { strict: false });
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `tools-${Date.now()}@example.test`, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  const userId = me.json<{ data: { id: string } }>().data.id;
  // More saved tasks than the chat's task block holds (#1007): list_tasks is offered too.
  for (let i = 0; i < savedTasks; i += 1) await app.get(PrismaService).task.create({ data: { userId, name: `Task ${i}`, goal: `Do task ${i}` } });
  let sent: Sent[] = [];
  const ai = { forUser: () => ({ runTools: async (req: { tools: Sent[] }) => ((sent = req.tools), { final: { outputText: 'ok' }, steps: [], stopReason: 'done' }) }) } as unknown as AiService;
  (turns as unknown as { ai: AiService }).ai = ai;
  const chat = await chats.create(userId, {});
  await chats.postUserMessage(userId, chat.id, 'hello');
  expect(await turns.run(chat.id, userId, null)).toBe('answered');
  return sent;
}

describe('the chat tools against strict function calling', () => {
  it('offers the tools the chat is meant to have, and every one sent strict is a schema OpenAI accepts', async () => {
    const sent = await toolsOfATurn();
    const names = sent.map((t) => t.tool.name);
    expect(names).toEqual(expect.arrayContaining(['ask_user', 'start_run', 'stop_run', 'propose_memory', 'draft_task']));

    const problems = sent.filter((t) => t.tool.strict !== false).flatMap((t) => strictViolations(t.tool.name, jsonSchemaOf(t.tool.parameters)));
    expect(problems).toEqual([]);
  });

  it('offers list_tasks to an owner with more tasks than the block holds, as a schema OpenAI accepts (#1007)', async () => {
    const sent = await toolsOfATurn(16);
    const listTasks = sent.find((t) => t.tool.name === 'list_tasks');
    expect(listTasks).toBeDefined();
    expect(listTasks!.tool.strict).not.toBe(false);
    expect(sent.filter((t) => t.tool.strict !== false).flatMap((t) => strictViolations(t.tool.name, jsonSchemaOf(t.tool.parameters)))).toEqual([]);
    expect((await toolsOfATurn()).map((t) => t.tool.name)).not.toContain('list_tasks');
  });

  it('keeps a tool with no arguments out of strict mode, and every other tool strict', async () => {
    const sent = await toolsOfATurn(16);
    for (const t of sent) {
      const noArguments = Object.keys((jsonSchemaOf(t.tool.parameters).properties ?? {})).length === 0;
      expect({ tool: t.tool.name, strictOff: t.tool.strict === false }).toEqual({ tool: t.tool.name, strictOff: noArguments });
    }
  });

  it('the connection read tools and the runner memory tool are strict-valid too', () => {
    const problems = [
      ...CHAT_CONNECTION_TOOLS.flatMap((t) => strictViolations(t.name, jsonSchemaOf(t.parameters))),
      ...strictViolations(proposeMemory.name, jsonSchemaOf(proposeMemory.parameters)),
    ];
    expect(problems).toEqual([]);
  });

  it('the check itself refuses what OpenAI refused: a free-form record', () => {
    const { z } = jest.requireActual<typeof import('zod')>('zod');
    const record = z.object({ attributes: z.record(z.string().min(1), z.string()) });
    expect(strictViolations('t', jsonSchemaOf(record)).join('\n')).toMatch(/additionalProperties: false|propertyNames/);
  });
});

describe('the runner finish tool with task outputs', () => {
  it('is strict-valid for every output type, so a task with outputs cannot make the model call fail', () => {
    const types = ['text', 'number', 'money', 'date', 'datetime', 'boolean', 'url', 'choice'] as const;
    const spec = types.map((type, i) => ({ key: `field_${i}`, label: `Field ${i}`, type, required: i % 2 === 0, sensitive: false, ...(type === 'choice' ? { options: ['a', 'b'] } : {}) }));
    expect(strictViolations('finish', jsonSchemaOf(finishParameters(spec as never)))).toEqual([]);
    expect(strictViolations('finish', jsonSchemaOf(finishParameters([])))).toEqual([]);
  });
});

describe('memory attributes as pairs (#675)', () => {
  it('become the record the memory service takes: trimmed, a blank one dropped, a repeated name keeps its last value', () => {
    expect(attributesFromPairs([{ name: ' phone ', value: ' 555-0199 ' }, { name: 'bank', value: 'Example Bank' }, { name: 'phone', value: '555-0100' }, { name: '  ', value: 'x' }, { name: 'empty', value: '   ' }])).toEqual({ phone: '555-0100', bank: 'Example Bank' });
    expect(attributesFromPairs([])).toEqual({});
  });
});
