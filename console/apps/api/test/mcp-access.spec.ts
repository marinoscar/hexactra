// The scope gate of the MCP tools (E33.2, #460), without a database: which
// tools an OAuth app may call, may ask for (step-up) or may never use; what
// `tools/list` gives it; the step-up scopes of a batch; the REST layer's
// action-kind gate; and the instructions per caller (byte-identical for
// personal access tokens and sessions).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InsufficientScopeException } from '@marinoscar/platform-api/identity';

import { assertBrowserScopes, browserActionScope } from '../src/browser/browser-action-scopes';
import { challengeScopes, missingScopes, scopeUsable, toolAccess, toolScopes } from '../src/mcp/mcp.access';
import { FORBIDDEN_TOOL_TEXT, McpDispatcher, STEP_UP_NOTE, listedTools, securitySchemes, stepUpScopes, tokenRevoked, toolListEntry } from '../src/mcp/mcp.dispatcher';
import { MCP_VERSIONS, type McpRequestContext } from '../src/mcp/mcp.protocol';
import { MCP_SCOPES, MCP_SCOPE_IDS, type McpScope } from '../src/mcp/mcp.scopes';
import { MCP_INSTRUCTIONS, MCP_TOOLS, instructionsFor } from '../src/mcp/mcp.tools';

const DEFAULT_SCOPES = MCP_SCOPES.filter((s) => s.default).map((s) => s.id);
/** The permissions the console's roles give (their `defaultGrants`). */
const CONTRIBUTOR = ['runs:read', 'runs:write', 'runs:delete', 'tasks:read', 'tasks:write', 'fleet:read', 'agent_policies:read', 'agent_policies:write', 'usage:read'];
const VIEWER = ['runs:read', 'tasks:read', 'fleet:read', 'agent_policies:read', 'usage:read'];

const oauth = (scopes: readonly string[]) => ({ kind: 'oauth' as const, tokenId: 't', grantId: 'g', clientId: 'c', resourceId: 'mcp', scopes: [...scopes] });
const tool = (name: string) => MCP_TOOLS.find((t) => t.name === name)!;
const rctx = (credential: unknown): McpRequestContext => ({ version: '2025-06-18', flags: MCP_VERSIONS['2025-06-18'], credential: credential as never });
const call = (name: string, args: Record<string, unknown> = {}, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

describe('toolAccess (#460)', () => {
  it('never gates a session, a personal access token or a node', () => {
    for (const kind of ['jwt', 'pat', 'node']) {
      for (const t of MCP_TOOLS) expect(toolAccess(t, { kind }, { permissions: [] })).toBe('allowed');
    }
    expect(toolAccess(tool('browser_evaluate'), null)).toBe('allowed');
  });

  it('an OAuth token: allowed with the scope, needs_scope without it, forbidden when the user lacks the permission', () => {
    const cred = oauth(DEFAULT_SCOPES);
    const user = { permissions: CONTRIBUTOR };
    expect(toolAccess(tool('run_goal'), cred, user)).toBe('allowed');
    expect(toolAccess(tool('task_create'), cred, user)).toBe('allowed');
    expect(toolAccess(tool('browser_open'), cred, user)).toBe('needs_scope');
    expect(toolAccess(tool('policy_create'), cred, user)).toBe('needs_scope');
    expect(toolAccess(tool('task_create'), cred, { permissions: VIEWER })).toBe('forbidden');
    // Holding the scope does not help a user without the permission behind it.
    expect(toolAccess(tool('run_goal'), oauth(MCP_SCOPE_IDS), { permissions: VIEWER })).toBe('forbidden');
    expect(toolAccess(tool('runs_list'), cred, { permissions: VIEWER })).toBe('allowed');
    // Without the user's permissions, a missing scope is needs_scope (the REST route still decides).
    expect(toolAccess(tool('task_create'), oauth(['runs:read']))).toBe('needs_scope');
  });

  it('browser:evaluate and desktop:control also require browser:drive', () => {
    expect(toolScopes(tool('browser_evaluate'))).toEqual(['browser:evaluate', 'browser:drive']);
    expect(toolScopes(tool('browser_desktop_click'))).toEqual(['desktop:control', 'browser:drive']);
    expect(toolScopes(tool('browser_click'))).toEqual(['browser:drive']);
    const user = { permissions: CONTRIBUTOR };
    expect(toolAccess(tool('browser_evaluate'), oauth(['browser:drive']), user)).toBe('needs_scope');
    expect(missingScopes(tool('browser_evaluate'), oauth(['browser:drive']))).toEqual(['browser:evaluate']);
    expect(toolAccess(tool('browser_desktop_click'), oauth(['desktop:control']), user)).toBe('needs_scope');
    expect(missingScopes(tool('browser_desktop_click'), oauth(['desktop:control']))).toEqual(['browser:drive']);
    expect(toolAccess(tool('browser_desktop_click'), oauth(['desktop:control', 'browser:drive']), user)).toBe('allowed');
  });

  it('ignores scope strings it does not know, and never throws on them', () => {
    const cred = oauth(['runs:read', 'not-a-scope', '', 'offline_access']);
    expect(toolAccess(tool('runs_list'), cred, { permissions: CONTRIBUTOR })).toBe('allowed');
    expect(challengeScopes(cred, ['browser:drive'])).toEqual(['runs:read', 'offline_access', 'browser:drive']);
  });
});

describe('tools/list for an OAuth app (#460)', () => {
  const names = (list: ReturnType<typeof listedTools>, access?: string) => list.filter((t) => !access || t.access === access).map((t) => t.tool.name);

  it('default consent: the delegate, task, inbox and read tools callable; browser, JavaScript, desktop and policy writes as step-up', () => {
    const list = listedTools(rctx(oauth(DEFAULT_SCOPES)), { permissions: CONTRIBUTOR }, true);
    const callable = names(list, 'allowed');
    expect(callable).toEqual(expect.arrayContaining(['run_goal', 'run_wait', 'run_status', 'task_create', 'task_run', 'schedule_create', 'inbox_list', 'inbox_answer', 'ask_human', 'policies_list', 'hosts_list']));
    expect(callable.filter((n) => n.startsWith('browser_'))).toEqual([]);
    const stepUp = names(list, 'needs_scope');
    expect(stepUp).toEqual(expect.arrayContaining(['browser_open', 'browser_click', 'browser_evaluate', 'browser_desktop_click', 'policy_create', 'policy_update', 'policy_set_default', 'policies_import']));
    // Definition order, whatever the access.
    const order = MCP_TOOLS.map((t) => t.name);
    expect(names(list)).toEqual(order.filter((n) => names(list).includes(n)));
    expect(names(listedTools(rctx(oauth(DEFAULT_SCOPES)), { permissions: CONTRIBUTOR }, true))).toEqual(names(list));
  });

  it('advertiseStepUpTools off: only the callable tools', () => {
    const list = listedTools(rctx(oauth(DEFAULT_SCOPES)), { permissions: CONTRIBUTOR }, false);
    expect(list.every((t) => t.access === 'allowed')).toBe(true);
    expect(names(list).filter((n) => n.startsWith('browser_') || ['policy_create', 'policy_update', 'policy_set_default', 'policies_import'].includes(n))).toEqual([]);
  });

  it('a viewer: never a tool the role cannot use (no write tool, not even as step-up)', () => {
    const list = listedTools(rctx(oauth(DEFAULT_SCOPES)), { permissions: VIEWER }, true);
    const writes = MCP_TOOLS.filter((t) => t.effect !== 'read').map((t) => t.name);
    expect(names(list).filter((n) => writes.includes(n))).toEqual([]);
    expect(names(list)).toEqual(expect.arrayContaining(['runs_list', 'inbox_list', 'tasks_list']));
  });

  it('marks a step-up tool in its description; securitySchemes on every tool for every caller', () => {
    const t = tool('browser_open');
    expect(toolListEntry(t, MCP_VERSIONS['2025-06-18'], { stepUp: true }).description).toBe(`${t.description} ${STEP_UP_NOTE}`);
    expect(toolListEntry(t, MCP_VERSIONS['2025-06-18']).description).toBe(t.description);
    for (const x of MCP_TOOLS) {
      expect([x.name, toolListEntry(x, MCP_VERSIONS['2025-03-26']).securitySchemes]).toEqual([x.name, [{ type: 'oauth2', scopes: toolScopes(x) }]]);
      expect(securitySchemes(x)[0]!.scopes[0]).toBe(x.scope);
    }
  });

  it('the dispatcher lists them so, reading the setting', async () => {
    const list = async (advertise: boolean, credential: unknown, userPermissions?: string[]) => {
      const settings = { getNamespace: async () => ({ elicitation: true, advertiseStepUpTools: advertise }) };
      const d = new McpDispatcher({ httpAdapter: { getInstance: () => ({}) } } as never, undefined, undefined, undefined, settings as never);
      const out = await d.dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, rctx(credential), 'Bearer x', undefined, { userPermissions });
      return (out!.body.result as { tools: Array<{ name: string; description: string; securitySchemes: unknown }> }).tools;
    };
    const on = await list(true, oauth(DEFAULT_SCOPES), CONTRIBUTOR);
    expect(on.find((t) => t.name === 'browser_open')!.description).toContain(STEP_UP_NOTE);
    expect(on.find((t) => t.name === 'run_goal')!.description).not.toContain(STEP_UP_NOTE);
    const off = await list(false, oauth(DEFAULT_SCOPES), CONTRIBUTOR);
    expect(off.map((t) => t.name)).not.toContain('browser_open');
    // A personal access token: every model-visible tool, unmarked, whatever the setting says; without the Knowledge Graph's switches (no
    // service here: off), not the learned-procedure tools (E46.22).
    const pat = await list(false, { kind: 'pat', tokenId: 'p' });
    expect(pat.map((t) => t.name)).toEqual(MCP_TOOLS.filter((t) => !t.visibility && !t.feature).map((t) => t.name));
    expect(pat.some((t) => t.description.includes(STEP_UP_NOTE))).toBe(false);
    expect(pat.every((t) => Array.isArray(t.securitySchemes))).toBe(true);
  });
});

describe('call-time enforcement (#460)', () => {
  it('stepUpScopes: the missing scopes of every tools/call that needs one; a batch mixing allowed and step-up calls needs them', () => {
    const r = rctx(oauth(DEFAULT_SCOPES));
    const user = { permissions: CONTRIBUTOR };
    expect(stepUpScopes([call('run_goal', { goal: 'x' })], r, user)).toBeNull();
    expect(stepUpScopes([call('browser_open')], r, user)).toEqual(['browser:drive']);
    expect(stepUpScopes([call('run_goal'), call('browser_evaluate', {}, 2)], r, user)?.sort()).toEqual(['browser:drive', 'browser:evaluate']);
    // Forbidden and unknown tools are not step-ups; nor is any call of a personal access token.
    expect(stepUpScopes([call('task_create')], r, { permissions: VIEWER })).toBeNull();
    expect(stepUpScopes([call('no_such_tool')], r, user)).toBeNull();
    expect(stepUpScopes([call('browser_open')], rctx({ kind: 'pat', tokenId: 'p' }), user)).toBeNull();
  });

  it('a forbidden call is a tool error with a plain sentence and never reaches the REST route', async () => {
    const inject = jest.fn();
    const d = new McpDispatcher({ httpAdapter: { getInstance: () => ({ inject }) } } as never);
    const out = await d.dispatch(call('task_create', { name: 'n', goal: 'g' }), rctx(oauth(DEFAULT_SCOPES)), 'Bearer x', undefined, { userPermissions: VIEWER });
    expect(out!.status).toBe(200);
    const result = out!.body.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(FORBIDDEN_TOOL_TEXT);
    expect(inject).not.toHaveBeenCalled();
  });

  it('a token that stops being valid during a call answers the whole request 401', async () => {
    const caller = async () => ({ statusCode: 401, headers: {}, body: JSON.stringify({ message: 'Unauthorized' }), rawPayload: Buffer.alloc(0) });
    const d = new McpDispatcher({ httpAdapter: { getInstance: () => ({}) } } as never);
    const out = await d.dispatch(call('runs_list'), rctx(oauth(DEFAULT_SCOPES)), caller as never, undefined, { userPermissions: CONTRIBUTOR });
    expect(out!.status).toBe(401);
    expect(out!.body.error).toMatchObject({ message: expect.stringMatching(/sign in again/) });
    // A personal access token's 401 stays a tool error.
    const pat = await d.dispatch(call('runs_list'), rctx({ kind: 'pat', tokenId: 'p' }), caller as never);
    expect(pat!.status).toBe(200);
    expect(tokenRevoked(7).status).toBe(401);
  });
});

describe('per-request availability: the learned-procedure tools (E46.22)', () => {
  const PROC = ['procedures_list', 'procedure_get', 'procedure_run'];
  // And the site-fact tools (E46.35), behind the same switches.
  const KG = [...PROC, 'site_facts_list', 'site_fact_propose'];
  const KG_USER = [...CONTRIBUTOR, 'kgraph:read'];
  /** A dispatcher whose Knowledge Graph switches answer `available`, and the REST calls its tools made. */
  const dispatcher = (available: boolean | 'throws') => {
    const inject = jest.fn(async () => ({ statusCode: 200, headers: {}, body: JSON.stringify({ data: { enabled: true, procedures: [] } }), rawPayload: Buffer.alloc(0) }));
    const kgraph = { status: async () => (available === 'throws' ? Promise.reject(new Error('db down')) : { deployment: available, user: available, available }) };
    const d = new McpDispatcher({ httpAdapter: { getInstance: () => ({ inject }) } } as never, undefined, undefined, undefined, undefined, undefined, undefined, undefined, kgraph as never);
    return { d, inject };
  };
  const list = async (d: McpDispatcher, credential: unknown, userPermissions?: string[]) =>
    ((await d.dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, rctx(credential), 'Bearer x', undefined, { userId: 'u1', userPermissions }))!.body.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
  const before = MCP_TOOLS.filter((t) => !t.feature);

  it('switch off (or unreadable): tools/list is exactly the list of before for every caller, and a direct call answers "turned off"', async () => {
    for (const state of [false, 'throws'] as const) {
      const { d, inject } = dispatcher(state);
      expect(await list(d, { kind: 'pat', tokenId: 'p' })).toEqual(before.filter((t) => !t.visibility).map((t) => t.name));
      expect(await list(d, { kind: 'jwt' })).toEqual(before.filter((t) => !t.visibility).map((t) => t.name));
      const app = await list(d, oauth(MCP_SCOPE_IDS), KG_USER);
      expect(app.filter((n) => KG.includes(n))).toEqual([]);
      expect(app).toEqual(listedTools(rctx(oauth(MCP_SCOPE_IDS)), { permissions: KG_USER }, false).map((x) => x.tool.name).filter((n) => !KG.includes(n)));
      for (const name of KG) {
        const out = await d.dispatch(call(name, { procedure_id: 'kgp-1' }), rctx({ kind: 'pat', tokenId: 'p' }), 'Bearer x', undefined, { userId: 'u1' });
        const r = out!.body.result as { isError: boolean; content: Array<{ text: string }>; structuredContent?: { code: string } };
        expect([name, r.isError, r.content[0]!.text]).toEqual([name, true, expect.stringContaining('is turned off')]);
      }
      expect(inject).not.toHaveBeenCalled();
    }
  });

  it('switch on: listed and callable, at the end of the model tools of before; an OAuth app sees them only with their scopes', async () => {
    const { d, inject } = dispatcher(true);
    const pat = await list(d, { kind: 'pat', tokenId: 'p' });
    expect(pat).toEqual(MCP_TOOLS.filter((t) => !t.visibility).map((t) => t.name));
    expect(pat.slice(-5)).toEqual(KG);
    // Granted procedures:run (and :read): listed. Without them: not listed (no step-up advertised) or marked as a step-up.
    expect((await list(d, oauth([...DEFAULT_SCOPES, 'procedures:read', 'procedures:run']), KG_USER)).filter((n) => PROC.includes(n))).toEqual(PROC);
    // With procedures:run only, the read tools are advertised as step-ups (the default setting), marked so.
    const stepped = ((await d.dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, rctx(oauth(['runs:read', 'procedures:run'])), 'Bearer x', undefined, { userId: 'u1', userPermissions: KG_USER }))!.body.result as { tools: Array<{ name: string; description: string }> }).tools;
    expect(stepped.filter((t) => PROC.includes(t.name)).map((t) => [t.name, t.description.includes(STEP_UP_NOTE)])).toEqual([['procedures_list', true], ['procedure_get', true], ['procedure_run', false]]);
    const out = await d.dispatch(call('procedures_list', {}), rctx({ kind: 'pat', tokenId: 'p' }), 'Bearer x', undefined, { userId: 'u1' });
    expect((out!.body.result as { isError?: boolean }).isError).toBeFalsy();
    expect(inject).toHaveBeenCalledTimes(1);
  });

  it('scopes gate an OAuth app: procedures:read reads, procedures:run runs; neither alone does the other; a user without the permissions is forbidden', () => {
    const user = { permissions: KG_USER };
    expect(toolAccess(tool('procedures_list'), oauth(['procedures:read']), user)).toBe('allowed');
    expect(toolAccess(tool('procedure_run'), oauth(['procedures:read']), user)).toBe('needs_scope');
    expect(toolAccess(tool('procedure_run'), oauth(['procedures:run']), user)).toBe('allowed');
    expect(toolAccess(tool('procedure_get'), oauth(['procedures:run']), user)).toBe('needs_scope');
    expect(toolAccess(tool('procedure_run'), oauth(MCP_SCOPE_IDS), { permissions: [...VIEWER, 'kgraph:read'] })).toBe('forbidden');
    expect(toolAccess(tool('procedures_list'), oauth(MCP_SCOPE_IDS), { permissions: CONTRIBUTOR })).toBe('forbidden');
  });

  it('scopes gate an OAuth app for the site-fact tools (E46.35): site_facts:read lists, site_facts:write proposes; neither alone does the other; a PAT has both', () => {
    const user = { permissions: [...CONTRIBUTOR, 'kgraph:read', 'kgraph:write'] };
    expect(toolAccess(tool('site_facts_list'), oauth(['site_facts:read']), user)).toBe('allowed');
    expect(toolAccess(tool('site_facts_list'), oauth(DEFAULT_SCOPES), user)).toBe('needs_scope');
    expect(toolAccess(tool('site_facts_list'), oauth(['site_facts:write']), user)).toBe('needs_scope');
    expect(toolAccess(tool('site_fact_propose'), oauth(['site_facts:write']), user)).toBe('allowed');
    expect(toolAccess(tool('site_fact_propose'), oauth(['site_facts:read', 'procedures:read', 'procedures:run']), user)).toBe('needs_scope');
    expect(toolAccess(tool('site_fact_propose'), { kind: 'pat' }, user)).toBe('allowed');
    expect(toolAccess(tool('site_fact_propose'), oauth(MCP_SCOPE_IDS), { permissions: [...CONTRIBUTOR, 'kgraph:read'] })).toBe('forbidden');
  });

  it('a turned-off tool is never a step-up: stepUpScopes skips it', () => {
    const r = rctx(oauth(DEFAULT_SCOPES));
    const user = { permissions: KG_USER };
    expect(stepUpScopes([call('procedure_run')], r, user)).toEqual(['procedures:run']);
    expect(stepUpScopes([call('procedure_run')], r, user, new Set(['kgraph']))).toBeNull();
  });
});

describe('the REST layer: browser action kinds (#460)', () => {
  it('maps every action kind to its scope; every browser tool carries its action kind\'s scope', () => {
    expect(browserActionScope('evaluate')).toBe('browser:evaluate');
    expect(browserActionScope('desktop_click')).toBe('desktop:control');
    expect(browserActionScope('desktop_anything_new')).toBe('desktop:control');
    expect(browserActionScope('click')).toBe('browser:drive');
    expect(browserActionScope('type_handoff_secret')).toBe('browser:drive');
    for (const t of MCP_TOOLS.filter((x) => x.name.startsWith('browser_'))) expect([t.name, ['browser:drive', 'browser:evaluate', 'desktop:control'].includes(t.scope)]).toEqual([t.name, true]);
  });

  it('refuses an OAuth caller without the kind\'s scopes with insufficient_scope; passes every other credential', () => {
    const refused = (fn: () => void) => {
      try {
        fn();
        return null;
      } catch (e) {
        return e instanceof InsufficientScopeException ? [...e.requiredScopes] : 'other';
      }
    };
    expect(refused(() => assertBrowserScopes(oauth(['browser:drive']), browserActionScope('evaluate')))).toEqual(['browser:evaluate']);
    expect(refused(() => assertBrowserScopes(oauth(['desktop:control']), browserActionScope('desktop_key')))).toEqual(['browser:drive']);
    expect(refused(() => assertBrowserScopes(oauth(DEFAULT_SCOPES), 'browser:drive'))).toEqual(['browser:drive']);
    expect(refused(() => assertBrowserScopes(oauth(['browser:drive', 'browser:evaluate']), browserActionScope('evaluate')))).toBeNull();
    expect(refused(() => assertBrowserScopes({ kind: 'pat', tokenId: 'p' }, 'browser:evaluate'))).toBeNull();
    expect(refused(() => assertBrowserScopes(null, 'desktop:control'))).toBeNull();
  });
});

describe('instructions per caller (#460)', () => {
  const SNAPSHOT = readFileSync(join(__dirname, '__snapshots__', 'mcp-instructions.txt'), 'utf8');
  const forScopes = (scopes: readonly McpScope[]) => instructionsFor((s) => scopeUsable(s, oauth(scopes), { permissions: CONTRIBUTOR }));

  it('personal access tokens and sessions get the text of before, byte for byte', () => {
    expect(MCP_INSTRUCTIONS).toBe(SNAPSHOT);
    expect(instructionsFor((s) => scopeUsable(s, { kind: 'pat' }))).toBe(SNAPSHOT);
    expect(forScopes(MCP_SCOPE_IDS)).toBe(SNAPSHOT);
  });

  it('an OAuth app without browser:drive: no Drive paragraph, no browser_ tool, no "full authority"', () => {
    const text = forScopes(DEFAULT_SCOPES);
    expect(text).not.toMatch(/browser_|Drive:|full authority/);
    expect(text).toMatch(/1\. Delegate: run_goal/);
    expect(text).toMatch(/2\. Policies:/);
    expect(text).toMatch(/3\. Ask: ask_human/);
    expect(text).toMatch(/untrusted/);
  });

  it('with browser:drive: the Drive paragraph and the authority sentence, naming JavaScript and the desktop only when allowed', () => {
    const drive = forScopes([...DEFAULT_SCOPES, 'browser:drive']);
    expect(drive).toMatch(/2\. Drive: browser_open/);
    expect(drive).toMatch(/full authority/);
    expect(drive).not.toMatch(/browser_evaluate|browser_desktop_/);
    const js = forScopes([...DEFAULT_SCOPES, 'browser:drive', 'browser:evaluate']);
    expect(js).toMatch(/browser_key\), and run JavaScript \(browser_evaluate\)\./);
    expect(js).not.toMatch(/browser_desktop_/);
    // desktop:control without browser:drive is not enough.
    expect(forScopes([...DEFAULT_SCOPES, 'desktop:control'])).not.toMatch(/browser_desktop_/);
  });
});
