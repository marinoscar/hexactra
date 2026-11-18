// The form of a step-up (#531): ChatGPT reads the challenge from a tool error
// result's `_meta["mcp/www_authenticate"]`; every other app gets the HTTP 403.
// Detection (isChatGptCaller), the setting (stepUpTransport), the tool result
// itself and the client hosts it reads (RequestClientService.clientHosts).
import { RequestClientService, hostsOf } from '../src/connected-apps/request-client';
import { WWW_AUTHENTICATE_META, stepUpText, stepUpToolResult } from '../src/mcp/mcp.controller';
import { CHATGPT_CLIENT_HOSTS, isChatGptCaller, stepUpTransport } from '../src/mcp/mcp.protocol';
import { MCP_DEFAULT_SETTINGS, mcpSettingsPatchSchema, mcpSettingsSchema, resolveMcpSettings } from '../src/mcp/mcp.settings';

describe('isChatGptCaller (#531)', () => {
  it('an OAuth client on chatgpt.com or openai.com, or a subdomain', () => {
    expect(CHATGPT_CLIENT_HOSTS).toEqual(['chatgpt.com', 'openai.com']);
    for (const host of ['chatgpt.com', 'CHATGPT.COM', 'openai.com', 'chat.openai.com', 'platform.openai.com.', 'auth.chatgpt.com']) {
      expect([host, isChatGptCaller({ clientHosts: [host] })]).toEqual([host, true]);
    }
    expect(isChatGptCaller({ clientHosts: ['assistant.example.test', 'chatgpt.com'] })).toBe(true);
  });

  it('not a look-alike host', () => {
    for (const host of ['notchatgpt.com', 'chatgpt.com.example.test', 'openai.co', 'example-openai.com', 'claude.ai', '', null, undefined]) {
      expect([host, isChatGptCaller({ clientHosts: [host] })]).toEqual([host, false]);
    }
    expect(isChatGptCaller({})).toBe(false);
  });

  it('a clientInfo.name naming OpenAI or ChatGPT, when the request carries one', () => {
    expect(isChatGptCaller({ clientInfoName: 'openai-mcp' })).toBe(true);
    expect(isChatGptCaller({ clientInfoName: 'ChatGPT' })).toBe(true);
    expect(isChatGptCaller({ clientInfoName: 'claude-ai' })).toBe(false);
    expect(isChatGptCaller({ clientHosts: ['claude.ai'], clientInfoName: null })).toBe(false);
  });
});

describe('stepUpTransport and mcp.stepUpForm (#531)', () => {
  it('auto: the tool error for ChatGPT, the 403 for every other OAuth app', () => {
    expect(stepUpTransport('auto', 'oauth', true)).toBe('tool');
    expect(stepUpTransport('auto', 'oauth', false)).toBe('http');
  });

  it('http forces the 403 for every app, ChatGPT included', () => {
    expect(stepUpTransport('http', 'oauth', true)).toBe('http');
    expect(stepUpTransport('http', 'oauth', false)).toBe('http');
  });

  it('tool forces the tool error for every OAuth app', () => {
    expect(stepUpTransport('tool', 'oauth', true)).toBe('tool');
    expect(stepUpTransport('tool', 'oauth', false)).toBe('tool');
  });

  it('a caller that is not an OAuth app never gets the tool form (it never steps up)', () => {
    for (const kind of ['pat', 'jwt', 'node', undefined]) {
      expect(stepUpTransport('tool', kind, true)).toBe('http');
      expect(stepUpTransport('auto', kind, true)).toBe('http');
    }
  });

  it('the setting: auto by default, one of three values, read as auto when stored before it existed', () => {
    expect(MCP_DEFAULT_SETTINGS.stepUpForm).toBe('auto');
    expect(resolveMcpSettings({ elicitation: false }).stepUpForm).toBe('auto');
    expect(resolveMcpSettings({ stepUpForm: 'tool' }).stepUpForm).toBe('tool');
    expect(mcpSettingsPatchSchema.safeParse({ stepUpForm: 'http' }).success).toBe(true);
    expect(mcpSettingsPatchSchema.safeParse({ stepUpForm: 'header' }).success).toBe(false);
    expect(mcpSettingsSchema.safeParse({ elicitation: true, advertiseStepUpTools: true }).success).toBe(true);
  });
});

describe('the step-up tool result (#531)', () => {
  it('a JSON-RPC result: a tool error with the 403 body\'s words and the exact challenge in _meta["mcp/www_authenticate"]', () => {
    const challenge = 'Bearer resource_metadata="https://console.example.test/.well-known/oauth-protected-resource/api/mcp", error="insufficient_scope", error_description="This tool needs more permission than the user allowed", scope="runs:read browser:drive"';
    const out = stepUpToolResult(7, challenge, ['browser:drive']);
    expect(WWW_AUTHENTICATE_META).toBe('mcp/www_authenticate');
    expect(out).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: {
        isError: true,
        content: [{ type: 'text', text: 'This tool needs permission the user has not given this app yet (browser:drive). Ask the user to allow it.' }],
        _meta: { 'mcp/www_authenticate': [challenge] },
      },
    });
    expect(stepUpText(['a:b', 'c:d'])).toBe('This tool needs permission the user has not given this app yet (a:b c:d). Ask the user to allow it.');
    expect((out.result as Record<string, unknown>).structuredContent).toBeUndefined();
  });
});

describe('the hosts of an OAuth client (#531)', () => {
  it('host, client_uri and every redirect URI host, without loopback or duplicates', () => {
    expect(hostsOf({ host: 'assistant.example.test', clientUri: 'https://www.example.test/app', redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect', 'https://assistant.example.test/cb', 'not a url'] })).toEqual([
      'assistant.example.test',
      'www.example.test',
      'chatgpt.com',
    ]);
    expect(hostsOf({ host: 'loopback', redirectUris: ['http://127.0.0.1/callback'] })).toEqual(['127.0.0.1']);
    expect(hostsOf({ host: 'chatgpt.com' })).toEqual(['chatgpt.com']);
  });

  it('read with the display name, in one cached query', async () => {
    const prisma = { oAuthClient: { findUnique: jest.fn().mockResolvedValue({ host: 'assistant.example.test', name: 'App', clientUri: null, redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'] }) } };
    const svc = new RequestClientService(prisma as never, undefined);
    expect(await svc.clientHosts('c1')).toEqual(['assistant.example.test', 'chatgpt.com']);
    expect(await svc.displayName('c1')).toBe('assistant.example.test');
    expect(prisma.oAuthClient.findUnique).toHaveBeenCalledTimes(1);
    prisma.oAuthClient.findUnique.mockResolvedValueOnce(null);
    expect(await svc.clientHosts('missing')).toEqual([]);
  });
});
