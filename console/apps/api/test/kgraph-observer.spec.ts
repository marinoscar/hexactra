// E46.5 (#779): the console's observer binding, without a database.
import { consoleIsSensitive, KgraphObserver, postStateOf } from '../src/runner/host/kgraph/observer-port';

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
    expect(rows).toHaveLength(2);
    expect((rows[0] as { bindings: unknown }).bindings).toEqual({ q: { kind: 'parameter', parameter: 'color' } });
    expect((rows[1] as { bindings: unknown }).bindings).toEqual({ url: { kind: 'output', seq: 1, path: 'items.0.link' } });
    fail = true;
    await expect(o.toolCall(obs({ seq: 3 }))).resolves.toBeUndefined();
    expect(o.failures).toBe(1);
  });
});
