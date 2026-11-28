// The db tier: helper models (E55.1, #1094). The `aiHelpers` settings namespace, the model a pick resolves to
// (usable, no longer usable, none), and the task model reaching the task builder's turn and draft and the chat's
// task draft. ("Improve this task" is covered in task-improver.db.spec.ts.) With no pick, a request is unchanged.
import { UsableModelsService, type AiService } from '@marinoscar/platform-api/ai';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { HelperModels } from '../src/ai-helpers/helper-models';
import { ChatTaskDraftService } from '../src/chat/chat-task-draft.service';
import { ChatService } from '../src/chat/chat.service';
import { createApp } from '../src/main';
import { PoliciesService } from '../src/policies/policies.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TaskSchedulesService } from '../src/tasks/task-schedules.service';
import { TaskBuilderDraftService } from '../src/task-builder/task-builder-draft.service';
import { TaskBuilderTurnService } from '../src/task-builder/task-builder-turn.service';
import { TaskBuilderService } from '../src/task-builder/task-builder.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
let helpers: HelperModels;
const stamp = `${Date.now()}`;

const workerMode = process.env.JOBS_WORKER_MODE;
beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
  prisma = app.get(PrismaService);
  helpers = app.get(HelperModels, { strict: false });
});
afterAll(async () => {
  await app?.close();
});
afterEach(() => jest.restoreAllMocks());

type Session = { token: string; userId: string };
const as = (token: string) => ({ authorization: `Bearer ${token}` });
async function login(name: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `helpers-${name}-${stamp}@example.test`, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: as(token) });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
const patch = (s: Session, aiHelpers: unknown) => app.inject({ method: 'PATCH', url: '/api/user-settings', headers: as(s.token), payload: { aiHelpers } });

/** The models the catalogue says the user can call. */
function usable(list: { provider: string; modelId: string }[] = [{ provider: 'prov-a', modelId: 'model-small' }, { provider: 'prov-b', modelId: 'model-big' }]) {
  return jest.spyOn(app.get(UsableModelsService, { strict: false }), 'listForUser').mockResolvedValue(
    list.map((m) => ({ ...m, displayName: null, capabilities: { capabilities: ['tools'], inputModalities: ['text'], outputModalities: ['text'] }, keySource: 'org' })) as never,
  );
}

/** A model that remembers every request it was sent. */
function recordingAi(outputText = '') {
  const asked: Record<string, unknown>[] = [];
  const respond = jest.fn(async (req: Record<string, unknown>) => (asked.push(req), { outputText }));
  const runTools = jest.fn(async (req: Record<string, unknown>) => (asked.push(req), { final: { outputText: 'What should it do?' }, steps: [], stopReason: 'done' }));
  return { ai: { forUser: () => ({ respond, runTools }) } as unknown as AiService, asked };
}

describe('the aiHelpers settings', () => {
  it('default to no pick and both title switches on, and round-trip through the user settings', async () => {
    const s = await login('settings');
    expect(await helpers.settings(s.userId)).toEqual({ titleModel: null, taskModel: null, runTitles: true, chatTitles: true });
    expect((await patch(s, { titleModel: 'prov-a:model-small', runTitles: false })).statusCode).toBe(200);
    expect(await helpers.settings(s.userId)).toEqual({ titleModel: 'prov-a:model-small', taskModel: null, runTitles: false, chatTitles: true });
    const got = await app.inject({ method: 'GET', url: '/api/user-settings', headers: as(s.token) });
    expect(JSON.stringify(got.json())).toContain('prov-a:model-small');
    expect((await patch(s, { titleModel: null })).statusCode).toBe(200);
    expect((await helpers.settings(s.userId)).titleModel).toBeNull();
  });

  it('refuse a model that is not provider:model', async () => {
    const s = await login('malformed');
    for (const bad of ['model-small', 'prov a:model', ':model', 'prov-a:', 'x'.repeat(300)]) {
      expect((await patch(s, { taskModel: bad })).statusCode).toBe(400);
    }
    expect((await helpers.settings(s.userId)).taskModel).toBeNull();
  });
});

describe('the model a pick resolves to', () => {
  it('is the provider and the model while the owner can use it, per kind', async () => {
    const s = await login('resolve');
    usable();
    await patch(s, { titleModel: 'prov-a:model-small', taskModel: 'prov-b:model-big' });
    expect(await helpers.target(s.userId, 'title')).toEqual({ provider: 'prov-a', model: 'model-small' });
    expect(await helpers.target(s.userId, 'task')).toEqual({ provider: 'prov-b', model: 'model-big' });
  });

  it('is nothing (the default model) with no pick, a pick that can no longer be used, or a catalogue that cannot be read', async () => {
    const s = await login('fallback');
    const list = usable();
    expect(await helpers.target(s.userId, 'task')).toEqual({});
    expect(list).not.toHaveBeenCalled();
    await patch(s, { taskModel: 'prov-gone:model-old' });
    expect(await helpers.target(s.userId, 'task')).toEqual({});
    list.mockRejectedValue(new Error('catalogue down'));
    expect(await helpers.target(s.userId, 'task')).toEqual({});
  });
});

describe('the task model', () => {
  const draftAnswer = JSON.stringify({ name: 'Pay the water bill', goal: 'Pay the water bill on the utility site.' });
  function services(ai: AiService, withHelpers: boolean) {
    const h = withHelpers ? helpers : undefined;
    const chats = app.get(ChatService, { strict: false });
    const policies = app.get(PoliciesService, { strict: false });
    const builders = app.get(TaskBuilderService, { strict: false });
    const chatDrafts = new ChatTaskDraftService(prisma, ai, h);
    const drafts = new TaskBuilderDraftService(prisma, builders, chatDrafts, chats, ai, policies, h);
    const turn = new TaskBuilderTurnService(prisma, chats, builders, drafts, chatDrafts, ai, policies, app.get(TaskSchedulesService, { strict: false }), h);
    return { chats, builders, chatDrafts, drafts, turn };
  }
  /** One request of each of the three features, in order: the builder's turn, the builder's draft, the chat's draft. */
  async function askAll(s: Session, ai: AiService, withHelpers = true) {
    const { chats, builders, chatDrafts, drafts, turn } = services(ai, withHelpers);
    const b = await builders.create({ id: s.userId }, { seed: 'Pay my water bill every month' });
    expect(await turn.run(b.id, s.userId, null)).toBe('answered');
    await drafts.draft(s.userId, b.id, null);
    const chat = await chats.create(s.userId, {});
    await chats.postUserMessage(s.userId, chat.id, 'Pay my water bill');
    await chatDrafts.draft(s.userId, chat.id, null);
  }

  it('is sent, provider and model, by the task builder turn, the builder draft and the chat task draft', async () => {
    const s = await login('task-pick');
    usable();
    await patch(s, { taskModel: 'prov-b:model-big', titleModel: 'prov-a:model-small' });
    const { ai, asked } = recordingAi(draftAnswer);
    await askAll(s, ai);
    expect(asked).toHaveLength(3);
    for (const req of asked) expect(req).toMatchObject({ provider: 'prov-b', model: 'model-big' });
  });

  it('with no pick, or a pick that can no longer be used, the requests name no model, exactly as without the setting', async () => {
    const s = await login('task-none');
    usable();
    const without = recordingAi(draftAnswer);
    await askAll(s, without.ai, false);
    const none = recordingAi(draftAnswer);
    await askAll(s, none.ai);
    await patch(s, { taskModel: 'prov-gone:model-old' });
    const gone = recordingAi(draftAnswer);
    await askAll(s, gone.ai);
    for (const got of [none.asked, gone.asked]) {
      expect(got).toHaveLength(3);
      got.forEach((req, i) => {
        expect(req).not.toHaveProperty('provider');
        expect(req).not.toHaveProperty('model');
        expect(Object.keys(req).sort()).toEqual(Object.keys(without.asked[i]!).sort());
      });
    }
  });
});
