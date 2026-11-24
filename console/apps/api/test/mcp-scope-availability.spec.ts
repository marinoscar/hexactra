// The feature-gated MCP scopes' availability check (#916): the port the platform's `OAuthScopeDefinition.available`
// calls fails closed, and the binder reads the Knowledge Graph's switches (the user's when known, the deployment's alone otherwise).
import { bindScopeFeatureCheck, scopeFeatureAvailable } from '../src/mcp/mcp.scope-availability';
import { McpScopeAvailabilityBinder } from '../src/mcp/mcp.scope-availability.binder';
import { MCP_SCOPES } from '../src/mcp/mcp.scopes';

afterEach(() => bindScopeFeatureCheck(null));

describe('scopeFeatureAvailable', () => {
  it('is false before anything is bound', async () => {
    expect(await scopeFeatureAvailable('kgraph', { userId: 'u1' })).toBe(false);
  });

  it('is false when the check throws or rejects, and true only for a literal true', async () => {
    bindScopeFeatureCheck(async () => {
      throw new Error('settings down');
    });
    expect(await scopeFeatureAvailable('kgraph', {})).toBe(false);
    bindScopeFeatureCheck(async () => 'yes' as unknown as boolean);
    expect(await scopeFeatureAvailable('kgraph', {})).toBe(false);
    bindScopeFeatureCheck(async () => true);
    expect(await scopeFeatureAvailable('kgraph', {})).toBe(true);
  });
});

describe('McpScopeAvailabilityBinder', () => {
  const kgraph = (deployment: boolean, available: boolean) => ({
    systemSettingsOf: jest.fn(async () => ({ enabled: deployment })),
    status: jest.fn(async () => ({ deployment, user: available, available })),
  });

  it('with a user, the Knowledge Graph is available only when the deployment and the user switches are on', async () => {
    const k = kgraph(true, false);
    new McpScopeAvailabilityBinder(k as never).onModuleInit();
    expect(await scopeFeatureAvailable('kgraph', { userId: 'u1', orgId: null })).toBe(false);
    expect(k.status).toHaveBeenCalledWith('u1');
    const on = kgraph(true, true);
    new McpScopeAvailabilityBinder(on as never).onModuleInit();
    expect(await scopeFeatureAvailable('kgraph', { userId: 'u1' })).toBe(true);
  });

  it('without a user (metadata, /authorize), the deployment switch alone decides', async () => {
    const off = kgraph(false, false);
    new McpScopeAvailabilityBinder(off as never).onModuleInit();
    expect(await scopeFeatureAvailable('kgraph', {})).toBe(false);
    expect(off.status).not.toHaveBeenCalled();
    new McpScopeAvailabilityBinder(kgraph(true, false) as never).onModuleInit();
    expect(await scopeFeatureAvailable('kgraph', {})).toBe(true);
  });

  it('without the Knowledge Graph module, and after the app closes, nothing is available', async () => {
    new McpScopeAvailabilityBinder(undefined).onModuleInit();
    expect(await scopeFeatureAvailable('kgraph', {})).toBe(false);
    const b = new McpScopeAvailabilityBinder(kgraph(true, true) as never);
    b.onModuleInit();
    b.onModuleDestroy();
    expect(await scopeFeatureAvailable('kgraph', { userId: 'u1' })).toBe(false);
  });
});

describe('the scopes that carry the check', () => {
  it('are exactly the Knowledge Graph scopes, none of them a default scope', () => {
    const gated = MCP_SCOPES.filter((s) => s.feature === 'kgraph');
    expect(gated.map((s) => s.id)).toEqual(['procedures:read', 'procedures:run', 'site_facts:read', 'site_facts:write']);
    expect(gated.every((s) => !s.default)).toBe(true);
  });
});
