// The Activity list's building blocks (E37.4, #593), without a database: what the sanitizer keeps of a fabric event
// (a whitelist, each field in a closed set or a strict pattern), the bounded SSE reader, and the fabric client's
// read of the `secrets.*` replay.
import { FabricClient, FabricError } from '../src/fabric/fabric.client';
import { parseFrame, readSseEvents, splitFrames } from '../src/fabric/sse';
import { ACTIVITY_OUTCOMES, isRefusal, sanitizeSecretsEvent, siteOf } from '../src/secrets/secrets-activity';

const USER = '11111111-1111-4111-8111-111111111111';
const OP = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';
const MARKER = 'MARKER-should-never-be-stored';

const release = (data: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  seq: 7,
  type: 'secrets.release',
  at: '2026-11-19T10:00:00.000Z',
  data: { owner_id: USER, session_id: OP, op_id: OP, run_id: RUN, client_label: 'run', provider: 'vault', item_id: '7f1c2e9a-0000-4000-8000-000000000001', field: 'password', origin: 'https://app.example.test', purpose: 'login', kind: null, count: null, released: true, outcome: 'typed', ...data },
  ...over,
});

describe('sanitizeSecretsEvent', () => {
  it('keeps the whitelisted columns of a release', () => {
    expect(sanitizeSecretsEvent(release())).toEqual({
      userId: USER,
      occurredAt: new Date('2026-11-19T10:00:00.000Z'),
      event: 'release',
      opId: OP,
      runId: RUN,
      provider: 'vault',
      itemId: '7f1c2e9a-0000-4000-8000-000000000001',
      field: 'password',
      site: 'app.example.test',
      purpose: 'login',
      outcome: 'typed',
      matches: null,
      released: true,
      amount: null,
      currency: null,
      frameSite: null,
    });
  });

  it('keeps the count of a lookup and no item or field', () => {
    const row = sanitizeSecretsEvent({ ...release({ count: 2, field: 'password', item_id: 'abc', outcome: 'ok', released: false }), type: 'secrets.lookup' });
    expect(row).toMatchObject({ event: 'lookup', matches: 2, itemId: null, field: null, purpose: null, outcome: 'ok', released: false });
  });

  it('drops everything it does not know: extra keys never reach a column', () => {
    const row = sanitizeSecretsEvent(release({ value: MARKER, password: MARKER, username: MARKER, code: MARKER, message: MARKER, note: MARKER }));
    expect(JSON.stringify(row)).not.toContain(MARKER);
  });

  it('turns text in a closed column into its safe value, never a copy of the text', () => {
    const row = sanitizeSecretsEvent(release({ outcome: MARKER, field: MARKER, purpose: MARKER, provider: MARKER, item_id: `${MARKER} with spaces`, run_id: MARKER }));
    expect(row).toMatchObject({ outcome: 'other', field: null, purpose: null, provider: 'unknown', itemId: null, runId: null });
    expect(JSON.stringify(row)).not.toContain(MARKER);
  });

  it('keeps only the host of an origin: no path, query or user info', () => {
    expect(siteOf('https://person:' + MARKER + '@shop.example.test:8443/a/b?token=' + MARKER)).toBe('shop.example.test:8443');
    expect(siteOf('https://shop.example.test/')).toBe('shop.example.test');
    expect(siteOf('not a url')).toBeNull();
    expect(siteOf(MARKER)).toBeNull();
    expect(siteOf(42)).toBeNull();
    expect(JSON.stringify(sanitizeSecretsEvent(release({ origin: `https://x:${MARKER}@evil.example.test/p?q=${MARKER}#${MARKER}` })))).not.toContain(MARKER);
  });

  it('refuses an event without a real owner, operation or time, or of another type', () => {
    expect(sanitizeSecretsEvent(release({ owner_id: 'person-a' }))).toBeNull();
    expect(sanitizeSecretsEvent(release({ owner_id: null }))).toBeNull();
    expect(sanitizeSecretsEvent(release({ op_id: 'x' }))).toBeNull();
    expect(sanitizeSecretsEvent(release({}, { at: 'yesterday' }))).toBeNull();
    expect(sanitizeSecretsEvent(release({}, { type: 'secrets.provider_registered' }))).toBeNull();
    expect(sanitizeSecretsEvent(null)).toBeNull();
    expect(sanitizeSecretsEvent('x')).toBeNull();
    expect(sanitizeSecretsEvent({ type: 'secrets.release', at: '2026-11-19T10:00:00Z', data: 'x' })).toBeNull();
  });

  it('knows a success from a refusal', () => {
    expect(['typed', 'ok'].some(isRefusal)).toBe(false);
    expect(ACTIVITY_OUTCOMES.filter(isRefusal)).toContain('origin_mismatch');
    expect(isRefusal('other')).toBe(true);
  });
});

describe('the SSE reader', () => {
  const stream = (chunks: string[], hangAfter = false) => {
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[i++]));
        else if (!hangAfter) controller.close();
        else return new Promise(() => undefined);
      },
    });
  };
  const frame = (type: string, data: unknown) => `id: 1\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

  it('splits frames across chunk boundaries and skips comments', async () => {
    const text = `: keep-alive\n\n${frame('secrets.release', { a: 1 })}${frame('reset', { last_seq: 3 })}`;
    const events = await readSseEvents(stream([text.slice(0, 20), text.slice(20)]), { idleMs: 200, maxMs: 1000, maxEvents: 10 });
    expect(events).toEqual([
      { event: 'secrets.release', data: { a: 1 } },
      { event: 'reset', data: { last_seq: 3 } },
    ]);
  });

  it('stops when the stream goes quiet, and cancels it', async () => {
    const t0 = Date.now();
    const events = await readSseEvents(stream([frame('x', { n: 1 })], true), { idleMs: 80, maxMs: 5000, maxEvents: 10 });
    expect(events).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('stops at the event limit', async () => {
    const events = await readSseEvents(stream([frame('x', 1) + frame('x', 2) + frame('x', 3)]), { idleMs: 100, maxMs: 1000, maxEvents: 2 });
    expect(events.map((e) => e.data)).toEqual([1, 2]);
  });

  it('survives a null body and malformed frames', async () => {
    expect(await readSseEvents(null, { idleMs: 10, maxMs: 10, maxEvents: 1 })).toEqual([]);
    expect(parseFrame('event: x\ndata: {not json')).toBeNull();
    expect(parseFrame('event: x')).toBeNull();
    expect(splitFrames('a\n\nb\n\nrest')).toEqual({ frames: ['a', 'b'], rest: 'rest' });
  });
});

describe('FabricClient.secretsEvents', () => {
  const credentials = { getSecret: jest.fn(async (_p: string, name: string) => (name.includes('url') || name === 'url' ? 'https://fabric.example.test' : 'token')) };
  const body = (text: string) => new Response(new ReadableStream({ start: (c) => { c.enqueue(new TextEncoder().encode(text)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

  afterEach(() => jest.restoreAllMocks());

  it('asks for the secrets replay from the start and returns the events without the reset', async () => {
    const client = new FabricClient(credentials as never);
    jest.spyOn(client, 'config').mockResolvedValue({ url: 'https://fabric.example.test', token: 't' });
    const seen: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      seen.push(String(input));
      return body(`event: reset\ndata: {"last_seq":5}\n\nid: 6\nevent: secrets.lookup\ndata: ${JSON.stringify({ seq: 6, type: 'secrets.lookup', at: '2026-11-19T10:00:00Z', data: {} })}\n\n`);
    });
    const events = await client.secretsEvents({ idleMs: 100, maxMs: 1000 });
    expect(seen[0]).toBe('https://fabric.example.test/v1/events?after=0&types=secrets.*');
    expect(events).toEqual([{ seq: 6, type: 'secrets.lookup', at: '2026-11-19T10:00:00Z', data: {} }]);
  });

  it('is a FabricError when the fabric is not configured', async () => {
    const client = new FabricClient(credentials as never);
    jest.spyOn(client, 'config').mockResolvedValue(null);
    await expect(client.secretsEvents()).rejects.toBeInstanceOf(FabricError);
  });
});
