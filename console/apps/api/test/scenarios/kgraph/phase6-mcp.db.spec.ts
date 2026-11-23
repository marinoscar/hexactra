// E46.39 (#895), phase 6 acceptance: site facts over MCP. A hosted client (an OAuth app the owner granted `site_facts:read` and
// `site_facts:write`) lists the owner's facts, marked untrusted, and proposes one. The proposal stays `proposed` even with the owner's
// auto-approve ON (that setting covers only facts derived from server records), never reaches a run's input, and the client cannot approve
// it: no MCP tool approves, edits or deletes a fact, and the review route refuses the client's token. Only the owner, signed in, approves.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { approvedByOf } from '../../../src/kgraph/site-facts.service';
import { MCP_SCOPES } from '../../../src/mcp/mcp.scopes';
import { MCP_TOOLS } from '../../../src/mcp/mcp.tools';
import { UNTRUSTED_NOTICE } from '../../../src/mcp/mcp.results';
import type { PrismaService } from '../../../src/prisma/prisma.service';
import { api, autoApprove, chatRun, fabricAt, hostedClient, login, ownerFact, runnerOf, scriptedAi, SITE_FACTS_BLOCK, startApp, switches, type Session } from './kit';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;
const DEFAULTS = MCP_SCOPES.filter((s) => s.default).map((s) => s.id);
const PROPOSAL = { site: 'example.test', kind: 'navigation', text: 'Order history is under Account, then Orders' };

beforeAll(async () => {
  ({ app, prisma } = await startApp());
});
afterAll(async () => {
  await app?.close();
});

describe('phase 6 acceptance: a hosted client and site facts (E46.39)', () => {
  let admin: Session;
  let owner: Session;
  let mcp: Awaited<ReturnType<typeof hostedClient>>;
  let token: string;
  beforeAll(async () => {
    admin = await login(app, `kgp6-mcp-admin-${stamp}@example.test`, 'admin');
    owner = await login(app, `kgp6-mcp-owner-${stamp}@example.test`);
    await switches(app, admin, owner, true, true, true);
    await autoApprove(app, owner, true, true);
    mcp = await hostedClient(app, admin);
    token = await mcp.token(owner.userId, [...DEFAULTS, 'site_facts:read', 'site_facts:write']);
    await ownerFact(app, owner, 'example.test', 'navigation', 'The search box is at the top of every page');
  });
  afterAll(async () => {
    await mcp?.close();
    await switches(app, admin, owner, false, false, false);
  });

  it('lists the owner\'s facts, starting with the untrusted notice', async () => {
    expect(await mcp.names(token)).toEqual(expect.arrayContaining(['site_facts_list', 'site_fact_propose']));
    const { status, result } = await mcp.call(token, 'site_facts_list', { site: 'example.test' });
    expect(status).toBe(200);
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text!.startsWith(UNTRUSTED_NOTICE)).toBe(true);
    expect(result.structuredContent).toMatchObject({ untrusted: true, facts: [{ site: 'example.test', text: 'The search box is at the top of every page', status: 'active', source: 'owner' }] });
  });

  it('proposes a fact that stays proposed with auto-approve on, and reaches no run until the owner approves it, signed in', async () => {
    expect((await api(app)(owner.token, 'GET', '/kgraph/status')).json<{ data: { autoApproveFacts: boolean } }>().data.autoApproveFacts).toBe(true);
    const { result } = await mcp.call(token, 'site_fact_propose', PROPOSAL);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ outcome: 'proposed', status: 'proposed', review_url: `${mcp.appUrl}/kgraph?tab=reviews` });
    const id = String(result.structuredContent!.fact_id);
    expect(await prisma.kgSiteFact.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'proposed', source: 'agent_proposed' });
    expect(approvedByOf(await prisma.kgSiteFact.findUniqueOrThrow({ where: { id } }))).toBeNull();
    expect(await prisma.auditEvent.count({ where: { actorUserId: owner.userId, action: 'kgraph.site_fact.auto_approved', targetId: id } })).toBe(0);

    // An everyday chat on the site reads the owner's own fact, not the client's proposal.
    const { runId } = await chatRun(prisma, owner, 'Find blue pens on shop.example.test', ['shop.example.test']);
    const model = scriptedAi([[['finish', { success: true, result: 'Done.' }]]]);
    await runnerOf(app, fabricAt(), model.ai).advance(runId, owner.userId, null);
    expect(model.rounds[0]!.input).toContain(SITE_FACTS_BLOCK);
    expect(model.rounds[0]!.input).not.toContain(PROPOSAL.text);

    // The client cannot approve: no tool does, and the review route refuses its token.
    expect(MCP_TOOLS.map((t) => t.name).filter((n) => /site_?facts?/.test(n))).toEqual(['site_facts_list', 'site_fact_propose']);
    expect(MCP_TOOLS.filter((t) => /site_?facts?/.test(t.name)).map((t) => t.effect)).toEqual(['read', 'write']);
    const viaClient = await app.inject({ method: 'POST', url: `/api/kgraph/reviews/site-facts/${id}/answer`, headers: { authorization: `Bearer ${token}` }, payload: { approve: true } });
    expect(viaClient.statusCode).toBeGreaterThanOrEqual(400);
    const viaPat = await api(app)(await mcp.pat(owner.userId), 'POST', `/kgraph/reviews/site-facts/${id}/answer`, { approve: true });
    expect(viaPat.statusCode).toBe(403);
    expect((await prisma.kgSiteFact.findUniqueOrThrow({ where: { id } })).status).toBe('proposed');

    // The owner, signed in, approves it; the next run reads it.
    const answered = await api(app)(owner.token, 'POST', `/kgraph/reviews/site-facts/${id}/answer`, { approve: true });
    expect(answered.statusCode).toBe(200);
    expect(answered.json<{ data: { status: string; approvedBy: string } }>().data).toMatchObject({ status: 'active', approvedBy: 'owner' });
    const next = await chatRun(prisma, owner, 'Find blue pens on shop.example.test', ['shop.example.test']);
    const again = scriptedAi([[['finish', { success: true, result: 'Done.' }]]]);
    await runnerOf(app, fabricAt(), again.ai).advance(next.runId, owner.userId, null);
    expect(again.rounds[0]!.input).toContain(PROPOSAL.text);
  });
});
