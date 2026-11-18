// MCP Apps (#466), the pure rules: Claude's domain formula (checked against
// the example on Claude's page), the tool and resource `_meta`, which tools a
// caller is offered, and the supersession key.
import { MCP_APP_MIME, MCP_APPS_EXTENSION_ID, MCP_UI_RESOURCES, QUESTION_CARD_URI, RUN_CARD_URI, TASKS_CARD_URI, cardKey, claudeUiDomain, clientSupportsApps, mcpServerUrl, stampHtml, toolUiMeta, uiDomainFor, uiResourceMeta } from '../src/mcp/mcp.apps';
import { offeredTools, toolCredential, withCardKey } from '../src/mcp/mcp.dispatcher';
import { MCP_SCOPE_IDS, grantedScopes } from '../src/mcp/mcp.scopes';
import { MCP_TOOLS } from '../src/mcp/mcp.tools';

describe('Claude ui.domain', () => {
  it('is the first 32 hex of SHA-256 of the server URL + .claudemcpcontent.com (the documented example)', () => {
    // claude.com/docs/connectors/building/mcp-apps/getting-started, "Set ui.domain for Claude".
    expect(claudeUiDomain('https://example.com/mcp')).toBe('c3d80a4ed901ee05b21755a88273b4a4.claudemcpcontent.com');
  });

  it('hashes APP_URL + /api/mcp, only for Claude', () => {
    expect(mcpServerUrl('https://console.example.test/')).toBe('https://console.example.test/api/mcp');
    expect(uiDomainFor('claude', 'https://console.example.test')).toBeUndefined(); // not sent until #468 verifies it
    expect(uiDomainFor('chatgpt', 'https://console.example.test')).toBeUndefined();
    expect(uiDomainFor('claude-code', 'https://console.example.test')).toBeUndefined();
    expect(uiDomainFor('claude', undefined)).toBeUndefined();
  });
});

describe('metadata', () => {
  it('a tool links its resource as _meta.ui.resourceUri, the legacy key and the ChatGPT alias; visibility when set', () => {
    expect(toolUiMeta(RUN_CARD_URI, undefined)).toEqual({ ui: { resourceUri: RUN_CARD_URI }, 'ui/resourceUri': RUN_CARD_URI, 'openai/outputTemplate': RUN_CARD_URI });
    expect(toolUiMeta(undefined, ['app'])).toEqual({ ui: { visibility: ['app'] } });
    expect(toolUiMeta(undefined, undefined)).toBeUndefined();
  });

  it('every card (run, question, tasks) declares no origin at all and asks for a border', () => {
    expect(MCP_UI_RESOURCES.map((r) => [r.uri, r.file])).toEqual([
      [RUN_CARD_URI, 'run-card.html'],
      [QUESTION_CARD_URI, 'question-card.html'],
      [TASKS_CARD_URI, 'tasks-card.html'],
    ]);
    for (const r of MCP_UI_RESOURCES) expect(uiResourceMeta(r, undefined)).toEqual({ ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } });
    const card = MCP_UI_RESOURCES.find((r) => r.uri === RUN_CARD_URI)!;
    expect(uiResourceMeta(card, 'x.claudemcpcontent.com').ui.domain).toBe('x.claudemcpcontent.com');
  });

  it('stamps the build hash right after the doctype', () => {
    expect(stampHtml('<!doctype html><html></html>', 'note -- x')).toBe('<!doctype html>\n<!-- note  x --><html></html>');
    expect(stampHtml('<html></html>', 'n')).toBe('<!-- n -->\n<html></html>');
  });

  it('reads the MCP Apps extension from client capabilities', () => {
    expect(clientSupportsApps({ extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME] } } })).toBe(true);
    expect(clientSupportsApps({ extensions: { [MCP_APPS_EXTENSION_ID]: {} } })).toBe(true);
    expect(clientSupportsApps({ extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: ['text/html+skybridge'] } } })).toBe(false);
    expect(clientSupportsApps({})).toBe(false);
    expect(clientSupportsApps(undefined)).toBe(false);
  });
});

describe('tools', () => {
  it('run_goal, task_run, run_status and run_wait link the run card; the question and tasks tools their cards; run_card_poll and question_card_answer are app-only', () => {
    const linked = (uri: string) => MCP_TOOLS.filter((t) => t.ui?.resourceUri === uri).map((t) => t.name).sort();
    expect(linked(RUN_CARD_URI)).toEqual(['run_goal', 'run_status', 'run_wait', 'task_run']);
    expect(linked(QUESTION_CARD_URI)).toEqual(['ask_human', 'inbox_list', 'question_status']);
    expect(linked(TASKS_CARD_URI)).toEqual(['schedules_list', 'tasks_list']);
    expect(MCP_TOOLS.filter((t) => t.visibility).map((t) => [t.name, t.visibility])).toEqual([
      ['run_card_poll', ['app']],
      ['question_card_answer', ['app']],
    ]);
  });

  it('offers app-only tools to OAuth apps and to clients that declare MCP Apps, never to the rest', () => {
    const names = (rctx: Parameters<typeof offeredTools>[0]) => offeredTools(rctx).map((t) => t.name);
    expect(names({ credential: { kind: 'pat' } as never })).not.toContain('run_card_poll');
    expect(names({ credential: { kind: 'oauth' } as never })).toContain('run_card_poll');
    expect(names({ credential: { kind: 'pat' } as never, clientCapabilities: { extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME] } } } })).toContain('run_card_poll');
    expect(names({ credential: { kind: 'oauth' } as never })).toContain('question_card_answer');
    expect(names({ credential: { kind: 'pat' } as never })).not.toContain('question_card_answer');
    expect(names({ credential: { kind: 'pat' } as never })).toHaveLength(MCP_TOOLS.length - 2);
  });

  it('stamps a younger card key on a result that opens the card, never on an error or another tool', () => {
    const goal = MCP_TOOLS.find((t) => t.name === 'run_goal')!;
    const list = MCP_TOOLS.find((t) => t.name === 'runs_list')!;
    const a = withCardKey(goal, { content: [], structuredContent: { id: 'r' } }).structuredContent!.card_key as { created_at: number; seq: number };
    const b = withCardKey(goal, { content: [], structuredContent: { id: 'r' } }).structuredContent!.card_key as { created_at: number; seq: number };
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(withCardKey(goal, { content: [], isError: true, structuredContent: { code: 'X' } }).structuredContent).toEqual({ code: 'X' });
    expect(withCardKey(list, { content: [], structuredContent: { items: [] } }).structuredContent).toEqual({ items: [] });
    expect(cardKey(5).created_at).toBe(5);
  });
});

describe('granted scopes (what a card may show, #467)', () => {
  it('every scope for a personal access token or a session; the token\'s own scopes, in consent order, when it carries them', () => {
    expect(grantedScopes(undefined)).toEqual([...MCP_SCOPE_IDS]);
    expect(grantedScopes({})).toEqual([...MCP_SCOPE_IDS]);
    expect(grantedScopes({ scopes: ['inbox:write', 'runs:read', 'unknown:scope'] })).toEqual(['runs:read', 'inbox:write']);
  });
});

describe('the credential the tools see (#459)', () => {
  it('carries an OAuth token\'s scopes, client and grant (never the token), and only the kind otherwise', () => {
    const oauth = { kind: 'oauth' as const, tokenId: 't1', grantId: 'g1', clientId: 'c1', resourceId: 'mcp', scopes: ['runs:read', 'runs:write'] };
    expect(toolCredential({ credential: oauth })).toEqual({ kind: 'oauth', scopes: ['runs:read', 'runs:write'], clientId: 'c1', grantId: 'g1' });
    expect(grantedScopes(toolCredential({ credential: oauth }))).toEqual(['runs:read', 'runs:write']);
    expect(toolCredential({ credential: { kind: 'pat', tokenId: 'p1' } })).toEqual({ kind: 'pat' });
    expect(toolCredential({ credential: { kind: 'jwt' } })).toEqual({ kind: 'jwt' });
    expect(toolCredential({ credential: null })).toBeUndefined();
  });
});
