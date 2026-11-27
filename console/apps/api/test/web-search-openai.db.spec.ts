// OpenAI web search against a real database (E50.9, #979): the providers API lists it with no key field ("Uses your OpenAI key from
// AI settings": `credential: 'ai_service'`, `needsKey: false`); the administrator's model setting; a search through the real route
// and service, the adapter calling the AI service's test double (the platform's real `AiService` over a scripted fake provider, in
// memory); and the cost in two parts, never counted twice: the search fee in `web_search_usage` (one row, each search the answer
// reported counted, the fee per search), the tokens only in the AI usage ledger under the "Web search" feature. Invented data; no
// provider is called.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { OpenAiSearchProvider } from '../src/web-search/providers/openai.provider';
import { WEB_SEARCH_AI_FEATURE_ID } from '../src/web-search/web-search.feature';
import { answerResponse, fakeAiSearch, SEARCH_MODEL, type FakeAiSearch } from './support/fake-ai-search';

const stamp = randomUUID().slice(0, 8);
const AI_KEY = `sk-invented-${randomUUID().replace(/-/g, '')}`;

let app: NestFastifyApplication;
let prisma: PrismaService;
let fake: FakeAiSearch;
const responses: string[] = [];
const userIds: string[] = [];

interface Session {
  token: string;
  userId: string;
}

async function login(name: string, role: 'contributor' | 'admin' = 'contributor'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  const id = me.json<{ data: { id: string } }>().data.id;
  userIds.push(id);
  return { token, userId: id };
}

type Body = { data?: unknown; error?: { code?: string } };
async function call(s: Session, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${s.token}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
  responses.push(`${res.statusCode} ${res.body}`);
  return { status: res.statusCode, body: (res.body ? res.json() : null) as Body | null };
}
const data = <T>(r: Awaited<ReturnType<typeof call>>) => r.body!.data as T;

const RESET = { enabled: true, order: ['brave'], providers: { openai: { model: null, costPerCallUsd: null } } };
let admin: Session;

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  // The real adapter, with the AI service's test double in place of the AI slice's services.
  fake = fakeAiSearch();
  const provider = app.get(OpenAiSearchProvider, { strict: false });
  provider.aiDeps = { ai: fake.harness.ai, usableModels: fake.harness.usableModels, config: fake.harness.aiConfig };
  admin = await login('wso-admin', 'admin');
}, 120_000);

afterAll(async () => {
  try {
    await call(admin, 'PUT', '/api/web-search/admin', RESET);
    await prisma?.webSearchUsage.deleteMany({ where: { userId: { in: userIds } } });
  } finally {
    await app?.close();
  }
});

describe('OpenAI web search', () => {
  it('is listed with no key field and is not usable until the administrator chooses a model', async () => {
    const s = await login('wso-list');
    fake.harness.addUserKey(s.userId, AI_KEY, [SEARCH_MODEL]);
    const list = data<{ id: string; kind: string; credential: string; needsKey: boolean; keys: Record<string, boolean>; estimatedCostPerCallUsd: number }[]>(await call(s, 'GET', '/api/web-search/providers'));
    expect(list.find((p) => p.id === 'openai')).toMatchObject({ kind: 'answer', credential: 'ai_service', needsKey: false, keys: { user: false, organization: false, system: false }, estimatedCostPerCallUsd: 0.01 });
    const installed = data<{ installed: { id: string; credential: string; hosts: string[] }[] }>(await call(admin, 'GET', '/api/web-search/admin')).installed;
    expect(installed.find((p) => p.id === 'openai')).toEqual({ id: 'openai', label: 'OpenAI web search', credential: 'ai_service', hosts: ['api.openai.com'], defaultEstimatedCostPerCallUsd: 0.01 });

    expect((await call(admin, 'PUT', '/api/web-search/admin', { order: ['openai'], providers: { openai: { model: null } } })).status).toBe(200);
    expect(data(await call(s, 'GET', '/api/web-search/status'))).toMatchObject({ enabled: false, reason: 'no_key' });
    const saved = await call(admin, 'PUT', '/api/web-search/admin', { providers: { openai: { model: SEARCH_MODEL } } });
    expect(data<{ providers: Record<string, unknown> }>(saved).providers.openai).toMatchObject({ model: SEARCH_MODEL });
    expect(data(await call(s, 'GET', '/api/web-search/status'))).toMatchObject({ enabled: true, provider: { id: 'openai', label: 'OpenAI web search', tier: null } });
  });

  it('the fee is counted in web_search_usage (each search, per search), the tokens only under "Web search" in the AI ledger', async () => {
    const s = await login('wso-usage');
    fake.harness.addUserKey(s.userId, AI_KEY, [SEARCH_MODEL]);
    expect((await call(admin, 'PUT', '/api/web-search/admin', { order: ['openai'], providers: { openai: { model: SEARCH_MODEL, costPerCallUsd: 0.01 } } })).status).toBe(200);
    const ledgerBefore = fake.harness.usageEvents.length;
    const hits = [
      { title: 'Rivertown facts', url: 'https://facts.example.test/rivertown', snippet: 'Rivertown has 48,200 inhabitants.', publishedAt: null },
      { title: 'Rivertown census', url: 'https://census.example.test/rivertown', snippet: 'The census counted 48,200.', publishedAt: null },
    ];
    fake.script({ kind: 'answer', output: answerResponse(hits, 'About 48,200 people live in Rivertown.', 2).output });

    const r = await call(s, 'POST', '/api/web-search/search', { query: 'Rivertown population' });
    expect(r.status).toBe(200);
    expect(data(r)).toEqual({
      provider: 'openai',
      answer: { text: 'About 48,200 people live in Rivertown. Rivertown has 48,200 inhabitants. The census counted 48,200.', citations: ['https://facts.example.test/rivertown', 'https://census.example.test/rivertown'] },
      hits: [
        { title: 'Rivertown facts', url: 'https://facts.example.test/rivertown', snippet: 'Rivertown has 48,200 inhabitants.', publishedAt: null },
        { title: 'Rivertown census', url: 'https://census.example.test/rivertown', snippet: 'The census counted 48,200.', publishedAt: null },
      ],
    });

    // The fee: one row, two searches, USD 0.01 each. No token cost in it.
    const rows = await prisma.webSearchUsage.findMany({ where: { userId: s.userId } });
    expect(rows.map((u) => [u.provider, u.calls, u.failures, Number(u.estimatedCostUsd)])).toEqual([['openai', 2, 0, 0.02]]);
    // The tokens: one AI usage row for the call, under the "Web search" feature, paid with the user's own key.
    const ledger = fake.harness.usageEvents.slice(ledgerBefore);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ userId: s.userId, feature: WEB_SEARCH_AI_FEATURE_ID, provider: 'openai', modelId: SEARCH_MODEL });
    expect((ledger[0]!.inputTokens ?? 0) + (ledger[0]!.outputTokens ?? 0)).toBeGreaterThan(0);
    expect(fake.harness.fake.calls.at(-1)!.apiKey).toBe(AI_KEY);
    // The status counts the two searches against today's limit.
    expect(data(await call(s, 'GET', '/api/web-search/status'))).toMatchObject({ today: { calls: 2 } });
  });

  it('the diagnostic report: credential through the AI service, network skipped (the AI service holds it), one live answer', async () => {
    const s = await login('wso-diag');
    fake.harness.addUserKey(s.userId, AI_KEY, [SEARCH_MODEL]);
    expect((await call(admin, 'PUT', '/api/web-search/admin', { order: ['openai'], providers: { openai: { model: SEARCH_MODEL } } })).status).toBe(200);
    fake.script({ kind: 'results', hits: [{ title: 'Weather', url: 'https://weather.example.test/', snippet: 'Sunny.', publishedAt: null }] });
    const r = await call(s, 'POST', '/api/web-search/diagnose?provider=openai');
    expect(r.status).toBeLessThan(300);
    const stages = data<{ stages: { id: string; status: string; code: string | null }[] }>(r).stages;
    expect(stages.find((st) => st.id === 'credential')).toMatchObject({ status: 'pass' });
    expect(stages.find((st) => st.id === 'network')).toMatchObject({ status: 'skipped' });
    expect(stages.find((st) => st.id === 'live_query')).toMatchObject({ status: 'pass' });
  });

  it('never answers with the AI key', () => {
    expect(responses.join('\n')).not.toContain(AI_KEY);
  });
});
