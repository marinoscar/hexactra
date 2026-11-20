// E40.5 (#689): the host binding of the fresh browser start, against an in-memory fabric: a new task restarts the
// profile's browser and closes the restored tabs; a chat follow-up and a resumed run do not; a shared profile is
// left alone; a failed restart never fails the run.
import { freshStart } from '../src/runner/host/fresh-start';
import type { HostDeps } from '../src/runner/host/deps';
import type { FabricSession } from '../src/runner/fabric-session';

function harness(opts: { sessions?: { id: string; host_id: string; profile?: string; status: string }[]; restart?: string; earlierChatRuns?: number } = {}) {
  const requests: string[] = [];
  const actions: Record<string, unknown>[] = [];
  const steps: { kind: string; summary: string }[] = [];
  const d = {
    log: { log: jest.fn(), warn: jest.fn() },
    prisma: {
      run: { count: jest.fn(async () => opts.earlierChatRuns ?? 0) },
      runStep: { aggregate: jest.fn(async () => ({ _max: { seq: 3 } })), create: jest.fn(async ({ data }: { data: { kind: string; summary: string } }) => void steps.push(data)) },
    },
    fabric: {
      request: jest.fn(async (method: string, path: string) => {
        requests.push(`${method} ${path}`);
        if (path === '/v1/sessions') return { sessions: opts.sessions ?? [{ id: 's1', host_id: 'h1', profile: 'default', status: 'active' }] };
        if (path.endsWith('/commands')) return { state: opts.restart ?? 'succeeded' };
        throw new Error(`unexpected ${path}`);
      }),
    },
  } as unknown as HostDeps;
  const session = {
    act: jest.fn(async (_id: string, action: Record<string, unknown>) => {
      actions.push(action);
      if (action.type === 'new_tab') return { id: 'o', state: 'succeeded', result: { tab_id: 9 } };
      if (action.type === 'tabs') return { id: 'o', state: 'succeeded', result: { tabs: [{ id: 3 }, { id: 4 }, { id: 9 }] } };
      return { id: 'o', state: 'succeeded', result: {} };
    }),
  } as unknown as FabricSession;
  return { d, session, requests, actions, steps };
}
const run = (over: Record<string, unknown> = {}) => ({ id: 'r1', profile: 'default', trigger: 'manual', conversationId: null, ...over });

it('restarts the browser for a new task and closes the restored tabs', async () => {
  const h = harness();
  expect(await freshStart(h.d, h.session, run(), 's1', { resumed: false })).toMatch(/restarted/);
  expect(h.requests).toEqual(['GET /v1/sessions', 'POST /v1/hosts/h1/commands']);
  expect(h.actions).toEqual([{ type: 'new_tab' }, { type: 'tabs' }, { type: 'close_tab', tab_id: 3 }, { type: 'close_tab', tab_id: 4 }]);
  expect(h.steps).toEqual([expect.objectContaining({ kind: 'browser', summary: 'Started with a fresh browser (restarted it and closed 2 old tabs)' })]);
});

it('restarts for the first run of a chat, not for a follow-up or a resumed run', async () => {
  const first = harness({ earlierChatRuns: 0 });
  expect(await freshStart(first.d, first.session, run({ trigger: 'chat', conversationId: 'c1' }), 's1', { resumed: false })).not.toBeNull();
  const followUp = harness({ earlierChatRuns: 1 });
  expect(await freshStart(followUp.d, followUp.session, run({ trigger: 'chat', conversationId: 'c1' }), 's1', { resumed: false })).toBeNull();
  expect(followUp.requests).toEqual([]);
  const resumed = harness();
  expect(await freshStart(resumed.d, resumed.session, run(), 's1', { resumed: true })).toBeNull();
  expect(resumed.requests).toEqual([]);
});

it('leaves a profile another session uses alone, and says so', async () => {
  const h = harness({ sessions: [{ id: 's1', host_id: 'h1', profile: 'default', status: 'active' }, { id: 's2', host_id: 'h1', profile: 'default', status: 'active' }] });
  expect(await freshStart(h.d, h.session, run(), 's1', { resumed: false })).toBeNull();
  expect(h.requests).toEqual(['GET /v1/sessions']);
  expect(h.steps[0]!.summary).toMatch(/another session/);
});

it('never fails the run when the restart fails', async () => {
  const h = harness({ restart: 'failed' });
  await expect(freshStart(h.d, h.session, run(), 's1', { resumed: false })).resolves.toBeNull();
  expect(h.actions).toEqual([]);
  expect((h.d.log.warn as jest.Mock).mock.calls[0]![0]).toMatch(/fresh browser start skipped/);
});
