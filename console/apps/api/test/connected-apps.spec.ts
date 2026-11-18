// Connected AI apps (#464), pure parts: the origin of a request, client names,
// the limit sentences and their MCP mapping, the day boundary of the limits.
import { appLimitSentence } from '../src/connected-apps/connected-apps.errors';
import { appConnectedTemplate, appFirstRunTemplate, appScopeAddedTemplate } from '../src/connected-apps/connected-apps.notifications';
import { clampLimits, limitsOf, scopesInWords, startOfDayIn } from '../src/connected-apps/connected-apps.service';
import { MCP_CLIENT_HEADER, RequestClientService, cleanClientName, clientLabel, friendlyAppName, mcpClientHeaderValue, originOf } from '../src/connected-apps/request-client';
import { McpApiError, mapApiError } from '../src/mcp/mcp.errors';

describe('the origin of a request (#464)', () => {
  it('reads the credential kind and the User-Agent family, never a body', () => {
    expect(originOf('jwt', 'Mozilla/5.0')).toBe('web');
    expect(originOf('pat', 'hexactra/1.43.0 (node v24.1.0)')).toBe('cli');
    expect(originOf('jwt', 'hexactra/1.43.0 (node v24.1.0)')).toBe('cli');
    expect(originOf('pat', 'python-httpx/0.27')).toBe('api');
    expect(originOf('pat', undefined)).toBe('api');
    expect(originOf('node', 'anything')).toBe('system');
    expect(originOf('jwt', 'Mozilla/5.0 (Linux; Android 14) HexactraAndroid/2')).toBe('android');
  });

  it('an OAuth credential is an app over MCP, with its client, name and grant', async () => {
    const prisma = { oAuthClient: { findUnique: jest.fn().mockResolvedValue({ host: 'chatgpt.com', name: 'ChatGPT' }) } };
    const svc = new RequestClientService(prisma as never, undefined);
    const req = { authCredential: { kind: 'oauth', tokenId: 't', grantId: 'g', clientId: 'c', resourceId: 'mcp', scopes: [] } };
    expect(await svc.resolve(req)).toEqual({ origin: 'mcp', clientId: 'c', clientName: 'chatgpt.com', grantId: 'g', verified: true });
    // Cached for a minute: one read for many calls.
    await svc.resolve(req);
    expect(prisma.oAuthClient.findUnique).toHaveBeenCalledTimes(1);
    svc.clock = () => Date.now() + 61_000;
    await svc.resolve(req);
    expect(prisma.oAuthClient.findUnique).toHaveBeenCalledTimes(2);
  });

  it('the MCP marker header counts only on an in-process request', async () => {
    const delegation = { isInProcess: jest.fn().mockReturnValue(false) };
    const svc = new RequestClientService({} as never, delegation as never);
    const req = { authCredential: { kind: 'pat', tokenId: 'p' }, headers: { [MCP_CLIENT_HEADER]: mcpClientHeaderValue('Hermes Agent'), 'user-agent': 'x' } };
    expect(await svc.resolve(req)).toMatchObject({ origin: 'api', clientName: null });
    delegation.isInProcess.mockReturnValue(true);
    expect(await svc.resolve(req)).toEqual({ origin: 'mcp', clientId: null, clientName: 'Hermes Agent', grantId: null, verified: false });
  });

  it('cleans names: no control characters, at most 64 characters; a loopback client uses its own name', () => {
    expect(cleanClientName('  Bad\u0000Name\n ')).toBe('BadName');
    expect(cleanClientName('x'.repeat(100))).toHaveLength(64);
    expect(cleanClientName('')).toBeNull();
    expect(clientLabel({ host: 'Claude.ai', name: 'Claude' })).toBe('claude.ai');
    expect(clientLabel({ host: 'loopback', name: 'Claude Code' })).toBe('Claude Code');
    expect(friendlyAppName('chatgpt.com')).toBe('ChatGPT');
    expect(friendlyAppName('claude.ai')).toBe('Claude');
    expect(friendlyAppName('tools.example.test')).toBe('tools.example.test');
  });
});

describe('limits (#464)', () => {
  it('defaults, and the deployment ceilings clamp what a user set', () => {
    expect(limitsOf(null)).toMatchObject({ maxConcurrentRuns: 2, dailyRunLimit: 50, dailyCostLimitUsd: null, confirmPurchases: true, paused: false });
    expect(clampLimits({ ...limitsOf(null), maxConcurrentRuns: 10, dailyRunLimit: 500 }, { maxConcurrentRunsPerApp: 3, maxDailyRunsPerApp: 100 })).toMatchObject({ maxConcurrentRuns: 3, dailyRunLimit: 100 });
  });

  it('the day starts at midnight in the profile time zone', () => {
    const now = new Date('2026-11-18T03:30:00Z');
    expect(startOfDayIn('UTC', now).toISOString()).toBe('2026-11-18T00:00:00.000Z');
    expect(startOfDayIn('America/New_York', now).toISOString()).toBe('2026-11-17T05:00:00.000Z');
    expect(startOfDayIn('Not/AZone', now).toISOString()).toBe('2026-11-18T00:00:00.000Z');
  });

  it('every refusal is a sentence that names where the user changes it, and the MCP error table keeps it', () => {
    expect(appLimitSentence('APP_RUN_LIMIT', { kind: 'daily', limit: 50 })).toBe('This app reached its daily limit of 50 runs. The user can raise it in Settings → AI apps.');
    for (const code of ['APP_PAUSED', 'APP_RUN_LIMIT', 'APP_COST_LIMIT', 'APP_POLICY_NOT_ALLOWED', 'APP_DOMAIN_NOT_ALLOWED'] as const) {
      const sentence = appLimitSentence(code, { limit: 2 });
      expect(sentence).toMatch(/Settings → AI apps/);
      const r = mapApiError(new McpApiError(403, code, sentence), 'run_goal');
      expect(r).toMatchObject({ isError: true, structuredContent: { code, message: sentence } });
      // A REST answer without a message still gets the sentence, never "not allowed".
      expect(mapApiError(new McpApiError(403, code, ''), 'run_goal').content[0]).toMatchObject({ text: expect.stringMatching(/Settings → AI apps/) });
    }
  });
});

describe('notification payloads (#464)', () => {
  it('app.connected names the app and its scopes in words, and links to Disconnect', () => {
    expect(scopesInWords(['runs:read', 'runs:write', 'inbox:read', 'inbox:write', 'browser:drive', 'offline_access'])).toBe('See runs, Delegate, Inbox and Drive browser');
    expect(appConnectedTemplate({ appName: 'ChatGPT', scopes: 'Delegate and Inbox', clientId: 'abc' } as never)).toEqual({
      title: 'ChatGPT was connected to your Hexactra account',
      body: 'It may: Delegate and Inbox. Not you? Disconnect it.',
      link: '/settings/ai-apps/abc',
    });
    expect(appScopeAddedTemplate({ appName: 'Claude', added: 'JavaScript', clientId: 'x' } as never).title).toBe('Claude can now do more');
    expect(appFirstRunTemplate({ appName: 'Claude', goal: 'Book a table', runId: 'r1' } as never)).toEqual({ title: 'Claude started a run', body: 'Book a table', link: '/runs/r1' });
  });
});
