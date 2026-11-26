// The guard of one rule (E50.17, #987): a tool that is set up and switched on is always available. For one owner with a Google account (mail
// on, calendar off), a paused Microsoft account and an MCP server with one `read`, one `write` and one `off` tool, every kind of run (a task
// run, a one-off run, a chat's run) and the chat's own model are offered exactly what is switched on: no task or chat list decides it, and
// flipping a switch changes exactly that tool in the next run. Availability is not approval: a write still asks with a card. Named in both
// AGENTS.md files as the test that proves the rule; `runConnections` (and, with E50.7, `web-availability.ts`) implement it.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { chatConnectionTools } from '../src/chat/chat-connection-tools';
import { ChatService } from '../src/chat/chat.service';
import { ConnectionApps } from '../src/connections/connection-apps.service';
import { ConnectionCapabilities } from '../src/connections/connection-capabilities.service';
import { McpCatalogService } from '../src/connections/mcp/mcp-catalog.service';
import { McpConnectionsService } from '../src/connections/mcp/mcp-connections.service';
import { createApp } from '../src/main';
import { RunStopSignal } from '../src/runner/stop-signal';
import { connectionKit, fakeFabric, login, scriptedModel, type Call, type Kit } from './support/connection-run-kit';
import { FakeMcpServer } from './support/fake-mcp-server';

const savedKey = process.env.SECRETS_ENCRYPTION_KEY;
process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
let app: NestFastifyApplication;
let kit: Kit;
let adminId: string;
const stamp = `${Date.now()}`;
const stopSignals: RunStopSignal[] = [];
const servers: FakeMcpServer[] = [];
const extra: string[] = [];

beforeAll(async () => {
  const start = RunStopSignal.start.bind(RunStopSignal);
  jest.spyOn(RunStopSignal, 'start').mockImplementation((source) => {
    const signal = start(source);
    stopSignals.push(signal);
    return signal;
  });
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  kit = connectionKit(app);
  adminId = await login(app, `taa-admin-${stamp}@example.test`);
  await app.get(ConnectionApps, { strict: false }).saveMcp(adminId, { enabled: true, allowedHosts: [], blockedHosts: [] });
});
afterAll(async () => {
  await app.get(ConnectionApps, { strict: false }).saveMcp(adminId, { enabled: false, allowedHosts: [], blockedHosts: [] });
  await kit?.prisma.connection.deleteMany({ where: { id: { in: extra } } });
  await kit?.cleanup();
  await Promise.all(servers.map((s) => s.stop()));
  await Promise.all(stopSignals.map((x) => x.dispose()));
  await app?.close();
  if (savedKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = savedKey;
});

const MAIL_READ_TOOLS = ['mail_search', 'mail_read'];
const CALENDAR_TOOLS = ['calendar_list', 'calendar_free_busy', 'calendar_create_event', 'calendar_update_event', 'calendar_delete_event'];
const MCP_READ = 'notes__search_notes';
const MCP_WRITE = 'notes__add_note';
const MCP_OFF = 'notes__wipe_notes';
const FINISH: Call = ['finish', { success: true, result: 'Done.' }];

/** The owner: Google (mail read and send on, calendar off), a paused Microsoft account with everything on, an MCP server read / write / off. */
async function owner(name: string) {
  const userId = await login(app, `taa-${name}-${stamp}@example.test`);
  const google = await kit.connect(userId, 'Work', ['mail_read', 'mail_send']);
  const microsoft = await kit.prisma.connection.create({
    data: { userId, provider: 'microsoft', accountId: `ms-${name}-${stamp}`, accountEmail: `ms-${name}@example.test`, label: 'Office', capabilities: ['mail_read', 'mail_send', 'calendar_read', 'calendar_write', 'docs_read'], grantedScopes: [], status: 'paused' },
  });
  extra.push(microsoft.id);
  const server = await new FakeMcpServer({
    tools: [
      { name: 'search_notes', description: 'Search the notes.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: true } },
      { name: 'add_note', description: 'Adds a note.', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
      { name: 'wipe_notes', description: 'Deletes every note.', inputSchema: { type: 'object', properties: {} } },
    ],
  }).start();
  servers.push(server);
  const added = await app.get(McpConnectionsService).add(userId, { url: server.url, label: 'Notes', auth: { kind: 'none' } });
  const mcpId = added.connection!.id;
  extra.push(mcpId);
  const catalog = app.get(McpCatalogService);
  const toolIds = new Map((await catalog.list(userId, mcpId)).tools.map((t) => [t.name, t.id]));
  const setMode = (tool: string, mode: 'off' | 'read' | 'write') => catalog.setMode(userId, mcpId, toolIds.get(tool)!, mode);
  await setMode('search_notes', 'read');
  await setMode('add_note', 'write');
  // A task with no connection list and no web search field: there is nothing to tick.
  const db = kit.prisma.forUser({ userId });
  const task = await db.task.create({ data: { userId, name: `Task ${name}`, goal: 'Do the errand', confirmRiskyActions: false } });
  const chat = await app.get(ChatService, { strict: false }).create(userId, {} as never);
  return { userId, db, google, microsoft, mcpId, server, setMode, task, chat };
}
type Owner = Awaited<ReturnType<typeof owner>>;

type Kind = 'task run' | 'one-off run' | "chat's run";
/** One run of the given kind, advanced once with a model that finishes: the names it was offered in its first round. */
async function offered(o: Owner, kind: Kind, calls: Call[][] = [[FINISH]]) {
  const data = kind === 'task run' ? { taskId: o.task.id, trigger: 'manual' as const } : kind === 'one-off run' ? { trigger: 'manual' as const } : { conversationId: o.chat.id, trigger: 'chat' as const };
  const run = await o.db.run.create({ data: { userId: o.userId, goal: 'Do the errand', ...data } });
  const model = scriptedModel(calls);
  const outcome = await kit.runner(model, fakeFabric()).advance(run.id, o.userId, null);
  return { names: model.offered[0]!, run, outcome, model };
}

/** The read tools the chat's own model is offered (it never has a write tool or an MCP tool). */
async function chatModelTools(o: Owner): Promise<string[]> {
  const got = await chatConnectionTools({ prisma: kit.prisma, connections: app.get(ConnectionCapabilities) }, { userId: o.userId, orgId: null, conversationId: o.chat.id }, () => undefined);
  return got.tools.map((t) => (t as unknown as { tool?: { name: string }; name?: string }).tool?.name ?? (t as unknown as { name: string }).name);
}

describe('a tool that is set up and switched on is always available (E50.17)', () => {
  let o: Owner;
  beforeAll(async () => {
    o = await owner('main');
  });

  it.each<Kind>(['task run', 'one-off run', "chat's run"])('a %s is offered exactly what is switched on', async (kind) => {
    const { names, run } = await offered(o, kind);
    expect(names).toEqual(expect.arrayContaining([...MAIL_READ_TOOLS, 'mail_send', MCP_READ, MCP_WRITE]));
    for (const n of [...CALENDAR_TOOLS, MCP_OFF]) expect(names).not.toContain(n);
    // Nothing of the paused Microsoft account: not in the run's connections at all.
    const snapshot = JSON.stringify((await kit.prisma.run.findFirstOrThrow({ where: { id: run.id } })).policySnapshot);
    expect(snapshot).toContain('"Work"');
    expect(snapshot).toContain('"Notes"');
    expect(snapshot).not.toContain('"Office"');
  });

  it("the chat's own model reads with exactly the read tools switched on", async () => {
    const names = await chatModelTools(o);
    expect(names).toEqual(MAIL_READ_TOOLS);
  });

  it('the task has no connection list and no field to tick, and the result is the same', async () => {
    expect(await kit.prisma.taskConnection.count({ where: { taskId: o.task.id } })).toBe(0);
    expect(await kit.prisma.conversationConnection.count({ where: { conversationId: o.chat.id } })).toBe(0);
    const res = await app.get(ChatService, { strict: false }).get(o.userId, o.chat.id);
    expect(res.connections).toEqual([]);
  });

  it('flipping each switch off removes exactly that tool from the next run, and on brings it back', async () => {
    const base = (await offered(o, 'task run')).names;
    const diff = (next: string[]) => ({ gone: base.filter((n) => !next.includes(n)), added: next.filter((n) => !base.includes(n)) });

    // The MCP read tool off, then back on.
    await o.setMode('search_notes', 'off');
    expect(diff((await offered(o, 'task run')).names)).toEqual({ gone: [MCP_READ], added: [] });
    await o.setMode('search_notes', 'read');
    expect(diff((await offered(o, 'task run')).names)).toEqual({ gone: [], added: [] });

    // The MCP off tool switched on, then off again.
    await o.setMode('wipe_notes', 'read');
    expect(diff((await offered(o, 'task run')).names)).toEqual({ gone: [], added: [MCP_OFF] });
    await o.setMode('wipe_notes', 'off');

    // Google's send off: only the send goes.
    await kit.prisma.connection.update({ where: { id: o.google.id }, data: { capabilities: ['mail_read'] } });
    expect(diff((await offered(o, 'task run')).names).gone).toEqual(['mail_send']);
    await kit.prisma.connection.update({ where: { id: o.google.id }, data: { capabilities: ['mail_read', 'mail_send'] } });
    expect(diff((await offered(o, 'task run')).names)).toEqual({ gone: [], added: [] });

    // The Microsoft account resumed: its calendar is offered; paused again: gone.
    await kit.prisma.connection.update({ where: { id: o.microsoft.id }, data: { status: 'active' } });
    const resumed = await offered(o, 'one-off run');
    expect(resumed.names).toEqual(expect.arrayContaining(['calendar_list', 'calendar_create_event']));
    await kit.prisma.connection.update({ where: { id: o.microsoft.id }, data: { status: 'paused' } });
    for (const n of CALENDAR_TOOLS) expect((await offered(o, 'one-off run')).names).not.toContain(n);

    // Google paused: none of its tools, the MCP server's stay.
    await kit.prisma.connection.update({ where: { id: o.google.id }, data: { status: 'paused' } });
    const paused = (await offered(o, 'task run')).names;
    for (const n of [...MAIL_READ_TOOLS, 'mail_send']) expect(paused).not.toContain(n);
    expect(paused).toEqual(expect.arrayContaining([MCP_READ, MCP_WRITE]));
    await kit.prisma.connection.update({ where: { id: o.google.id }, data: { status: 'active' } });
    expect(await chatModelTools(o)).toEqual(MAIL_READ_TOOLS);
  });

  it('availability is not approval: a write still produces an approval card and sends nothing', async () => {
    const mcpWrite = await offered(o, 'task run', [[[MCP_WRITE, { title: 'A note' }]]]);
    expect(mcpWrite.outcome).toBe('waiting_human');
    expect(mcpWrite.model.outputs[0]).toMatch(/^Asked the owner to approve this/);
    expect(await kit.prisma.question.count({ where: { runId: mcpWrite.run.id, status: 'pending' } })).toBe(1);
    expect(o.server.calls()).toHaveLength(0);

    const send = await offered(o, "chat's run", [[['mail_send', { connection: 'Work', draft_id: null, to: ['person-b@example.test'], cc: null, bcc: null, subject: 'Hi', body: 'Hello', reply_to_message_id: null, attachments: null }]]]);
    expect(send.outcome).toBe('waiting_human');
    expect(await kit.prisma.question.count({ where: { runId: send.run.id, status: 'pending' } })).toBe(1);
    expect(kit.fake.account(o.google.id).sent).toHaveLength(0);
  });

  it("never offers another user's connection", async () => {
    const stranger = await login(app, `taa-stranger-${stamp}@example.test`);
    await kit.connect(stranger, 'Theirs', ['mail_read', 'calendar_read', 'calendar_write']);
    const { names, run } = await offered(o, 'task run');
    for (const n of CALENDAR_TOOLS) expect(names).not.toContain(n);
    expect(JSON.stringify((await kit.prisma.run.findFirstOrThrow({ where: { id: run.id } })).policySnapshot)).not.toContain('"Theirs"');
  });

  // E50.7 (#977) fills these in when web search exists (`host/web-availability.ts`): set up and switched on means offered, the same rule.
  it.todo('web search (E50.7): a task run, a one-off run, a chat run and the chat model are offered web_search and web_fetch when a provider is set up and both switches are on, with no task field');
  it.todo('web search (E50.7): the deployment or the user switch off removes web_search from the next run, and on brings it back');
});
