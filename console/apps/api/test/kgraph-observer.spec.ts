// E46.5 (#779): the console's observer binding, without a database.
import { CAPTURE_INCOMPLETE, CAPTURE_QUEUE_LIMIT, consoleIsSensitive, KgraphObserver, postStateOf } from '../src/runner/host/kgraph/observer-port';

const obs = (over: object = {}) => ({ seq: 1, tool: 'navigate', family: 'browser', commits: false, args: {}, resultText: 'ok', ok: true, outcome: 'ran' as const, steps: [], startedAt: 0, durationMs: 1, ...over });

describe('the kgraph observer binding', () => {
  it('keeps the host and path of the page and the view digest, never the query', () => {
    expect(postStateOf(obs({ steps: [{ ok: true, url: 'https://Shop.example.test/a/b?session=1#x', contentHash: 'h9' }] }))).toEqual({ host: 'shop.example.test', path: '/a/b', viewDigest: 'h9' });
  });
  it('keeps the shape of an account result, not its values', () => {
    expect(postStateOf(obs({ family: 'accounts', resultText: JSON.stringify({ messages: [{ subject: 'Private', id: 'm1' }] }) }))).toEqual({ resultShape: '{messages:[{id:string,subject:string}]}' });
  });
  it('uses the console sensitive table', () => {
    expect(consoleIsSensitive('4111 1111 1111 1111')).toBe(true);
    expect(consoleIsSensitive('blue pens')).toBe(false);
  });
  it('binds a run parameter by key, keeps earlier results in memory only, and survives a failed write', async () => {
    const rows: unknown[] = [];
    let fail = false;
    const prisma = { kgTrace: { create: async ({ data }: { data: unknown }) => { if (fail) throw new Error('down'); rows.push(data); } } };
    const o = new KgraphObserver({ prisma: prisma as never, log: { warn: () => undefined }, userId: 'u', runId: 'r', goal: 'Find pens', inputs: { values: { color: { value: 'blue', source: 'provided', label: 'Color' } }, sensitive: [] } });
    await o.toolCall(obs({ tool: 'mail_search', family: 'accounts', args: { q: 'blue' }, resultText: JSON.stringify({ items: [{ link: 'https://shop.example.test/p/42' }] }) }));
    await o.toolCall(obs({ seq: 2, args: { url: 'https://shop.example.test/p/42' } }));
    await o.flush();
    expect(rows).toHaveLength(2);
    expect((rows[0] as { bindings: unknown }).bindings).toEqual({ q: { kind: 'parameter', parameter: 'color' } });
    expect((rows[1] as { bindings: unknown }).bindings).toEqual({ url: { kind: 'output', seq: 1, path: 'items.0.link' } });
    fail = true;
    await expect(o.toolCall(obs({ seq: 3 }))).resolves.toBeUndefined();
    await o.flush();
    expect(o.failures).toBe(1);
  });
});

describe('the capture is off the run\'s path (#922)', () => {
  /** A store whose writes complete only when the test lets them. */
  function deferredStore() {
    const rows: Array<{ seq: number }> = [];
    const gates: Array<() => void> = [];
    const nodes: Array<{ type: string; key: string; label: string }> = [];
    let fail = false;
    const prisma = {
      kgTrace: {
        create: ({ data }: { data: { seq: number } }) =>
          new Promise<void>((resolve, reject) => {
            gates.push(() => (fail ? reject(new Error('down')) : (rows.push(data), resolve())));
          }),
      },
      kgNode: {
        upsert: async ({ create }: { create: { type: string; key: string; label: string } }) => {
          nodes.push({ type: create.type, key: create.key, label: create.label });
        },
      },
    };
    return {
      prisma,
      rows,
      nodes,
      fail: () => (fail = true),
      /** Lets every write that is waiting complete, one at a time in order, until none waits. */
      async release() {
        for (let i = 0; i < 10_000; i++) {
          await new Promise((r) => setImmediate(r));
          const g = gates.shift();
          if (!g) return;
          g();
        }
      },
    };
  }
  const logs: string[] = [];
  const log = { warn: (m: string) => logs.push(`warn ${m}`), log: (m: string) => logs.push(`log ${m}`) };
  const observer = (prisma: unknown, over: object = {}) => new KgraphObserver({ prisma: prisma as never, log, userId: 'u', runId: 'r1', goal: 'g', inputs: null, ...over });

  beforeEach(() => logs.splice(0));

  it('returns before its write completes, and flush waits for every write, in order', async () => {
    const s = deferredStore();
    const o = observer(s.prisma);
    // The store never completes on its own: toolCall still resolves, so the run does not wait for the database.
    await o.toolCall(obs({ seq: 1 }));
    await o.toolCall(obs({ seq: 2 }));
    await o.toolCall(obs({ seq: 3 }));
    expect(s.rows).toEqual([]);
    const flushed = o.flush();
    await s.release();
    await flushed;
    expect(s.rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^log run r1: kgraph capture: 3 writes, 0 failed, \d+ ms writing off the run's path$/);
    expect(s.nodes).toEqual([]);
  });

  it('drops and counts writes over the bound, and a run that lost a write is marked so it is never compiled', async () => {
    const s = deferredStore();
    const o = observer(s.prisma);
    for (let i = 1; i <= CAPTURE_QUEUE_LIMIT + 5; i++) await o.toolCall(obs({ seq: i }));
    expect(o.failures).toBe(5);
    const flushed = o.flush();
    await s.release();
    await flushed;
    expect(s.rows).toHaveLength(CAPTURE_QUEUE_LIMIT);
    expect(s.nodes).toEqual([{ type: 'CompileRejection', key: 'r1', label: CAPTURE_INCOMPLETE }]);
    expect(logs[0]).toMatch(/^warn run r1: kgraph capture: 1000 writes, 5 failed/);
  });

  it('a failed write marks the run as not to be compiled; a clean run is not marked', async () => {
    const s = deferredStore();
    const o = observer(s.prisma);
    await o.toolCall(obs({ seq: 1 }));
    s.fail();
    const flushed = o.flush();
    await s.release();
    await flushed;
    expect(o.failures).toBe(1);
    expect(s.nodes).toEqual([{ type: 'CompileRejection', key: 'r1', label: CAPTURE_INCOMPLETE }]);
  });

  it('a flush that times out never holds the run: the waiting writes count as lost', async () => {
    const s = deferredStore();
    const o = observer(s.prisma);
    await o.toolCall(obs({ seq: 1 }));
    await o.toolCall(obs({ seq: 2 }));
    await o.flush(20);
    expect(o.failures).toBeGreaterThanOrEqual(1);
    expect(s.nodes.map((n) => n.label)).toEqual([CAPTURE_INCOMPLETE]);
  });

  it('an everyday run (surface only) is never marked: nothing of it is compiled', async () => {
    const s = deferredStore();
    s.fail();
    const failing = { kgNode: { upsert: async () => { throw new Error('down'); } } };
    const o = observer(failing, { surfaceOnly: true });
    await o.toolCall(obs({ seq: 1, steps: [{ ok: true, url: 'https://shop.example.test/a' }] }));
    await o.flush();
    expect(o.failures).toBe(1);
    expect(s.nodes).toEqual([]);
  });
});
