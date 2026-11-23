// E46.39 (#895), phase 6 acceptance: automated facts. An everyday chat (the owner's `kgraph.everyday` on) is followed by the derive step,
// which proposes facts from the run's server records only. With the owner's auto-approve on, ONLY the derived navigation, timing and quirk
// facts become active (`approvedBy: auto`): the derived sign-in fact, the run tool's proposal, an MCP client's proposal and an imported fact
// (even one whose file claims it was derived) all stay `proposed` until the owner approves them, signed in. With auto-approve off, every
// derived fact stays proposed.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { approvedByOf, KgraphSiteFactsService } from '../../../src/kgraph/site-facts.service';
import { MCP_SCOPES } from '../../../src/mcp/mcp.scopes';
import type { PrismaService } from '../../../src/prisma/prisma.service';
import { api, autoApprove, deriveFacts, derivingChat, hostedClient, login, startApp, switches, type Session } from './kit';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;
const DEFAULTS = MCP_SCOPES.filter((s) => s.default).map((s) => s.id);

beforeAll(async () => {
  ({ app, prisma } = await startApp());
});
afterAll(async () => {
  await app?.close();
});

describe('phase 6 acceptance: automated facts (E46.39)', () => {
  let admin: Session;
  let owner: Session;
  let mcp: Awaited<ReturnType<typeof hostedClient>>;
  beforeAll(async () => {
    admin = await login(app, `kgp6-auto-admin-${stamp}@example.test`, 'admin');
    owner = await login(app, `kgp6-auto-owner-${stamp}@example.test`);
    await switches(app, admin, owner, true, true, true);
    mcp = await hostedClient(app, admin);
  });
  afterAll(async () => {
    await mcp?.close();
    await switches(app, admin, owner, false, false, false);
  });
  const facts = () => prisma.kgSiteFact.findMany({ where: { userId: owner.userId }, orderBy: { createdAt: 'asc' } });

  it('auto-approve on: only derived navigation, timing and quirk facts are active; sign-in, run-tool, MCP and imported facts stay proposed', async () => {
    await autoApprove(app, owner, true, true);
    const { runId, outcomes, outputs } = await derivingChat(app, owner, undefined, [['propose_site_fact', { kind: 'navigation', text: 'Statements are under Billing, then Archive' }]]);
    expect(outcomes).toEqual(['waiting_human', 'succeeded']);
    expect(outputs[1]).toMatch(/^Proposed/);
    await deriveFacts(app, owner, runId);

    // An MCP client's proposal and an imported fact, of the auto-approvable kinds.
    const token = await mcp.token(owner.userId, [...DEFAULTS, 'site_facts:write']);
    expect((await mcp.call(token, 'site_fact_propose', { site: 'example.test', kind: 'timing', text: 'The export takes about a minute' })).result.structuredContent).toMatchObject({ outcome: 'proposed', status: 'proposed' });
    expect(await app.get(KgraphSiteFactsService).importFacts(owner.userId, [{ site: 'example.test', kind: 'quirk', text: 'A survey pop-up appears after checkout', source: 'derived' }])).toEqual({ proposed: 1, skipped: 0 });

    const rows = (await facts()).map((f) => ({ kind: f.kind, text: f.text, source: f.source, status: f.status, approvedBy: approvedByOf(f) }));
    expect(rows).toEqual(
      expect.arrayContaining([
        { kind: 'navigation', text: 'Invoices: Billing → History', source: 'derived', status: 'active', approvedBy: 'auto' },
        { kind: 'timing', text: 'Pages on this site load slowly (about 9 s)', source: 'derived', status: 'active', approvedBy: 'auto' },
        { kind: 'sign_in', text: 'Sign-in asks for a one-time code', source: 'derived', status: 'proposed', approvedBy: null },
        { kind: 'navigation', text: 'Statements are under Billing, then Archive', source: 'agent_proposed', status: 'proposed', approvedBy: null },
        { kind: 'timing', text: 'The export takes about a minute', source: 'agent_proposed', status: 'proposed', approvedBy: null },
        { kind: 'quirk', text: 'A survey pop-up appears after checkout', source: 'derived', status: 'proposed', approvedBy: null },
      ]),
    );
    expect(rows).toHaveLength(6);
    // Everything active came from the derive step, of an auto-approvable kind.
    for (const r of rows.filter((x) => x.status === 'active')) {
      expect(r.source).toBe('derived');
      expect(['navigation', 'timing', 'quirk']).toContain(r.kind);
    }
    expect(await prisma.auditEvent.count({ where: { actorUserId: owner.userId, action: 'kgraph.site_fact.auto_approved' } })).toBe(2);
    // Reviews lists the four that wait, and (on request) the two approved automatically.
    const pending = (await api(app)(owner.token, 'GET', '/kgraph/reviews/site-facts')).json<{ data: { text: string }[] }>().data.map((f) => f.text);
    expect(pending.sort()).toEqual(['A survey pop-up appears after checkout', 'Sign-in asks for a one-time code', 'Statements are under Billing, then Archive', 'The export takes about a minute'].sort());
  });

  it('auto-approve off: every derived fact stays proposed', async () => {
    await autoApprove(app, owner, true, false);
    await prisma.kgSiteFact.deleteMany({ where: { userId: owner.userId } });
    const { runId } = await derivingChat(app, owner);
    await deriveFacts(app, owner, runId);
    const all = await facts();
    expect(all.map((f) => f.kind).sort()).toEqual(['navigation', 'sign_in', 'timing']);
    expect(all.every((f) => f.status === 'proposed' && approvedByOf(f) === null)).toBe(true);
  });
});
