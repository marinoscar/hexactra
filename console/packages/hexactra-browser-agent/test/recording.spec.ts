// The fabric calls of a run recording (epic #755): the actions sent, the chunks read back (inline or by artifact), and failures as codes.
import type { ActionOp } from '../src/browser-port';
import { RecordingCallError, recordPause, recordPull, recordStart, recordStop } from '../src/recording';

function fakeSession(answer: (action: Record<string, unknown>) => Partial<ActionOp> | Error | 'hang') {
  const sent: { action: Record<string, unknown>; opts?: { waitForTakeover?: boolean } }[] = [];
  return {
    sent,
    act: async (_id: string, action: Record<string, unknown>, _t?: number, opts?: { waitForTakeover?: boolean }) => {
      sent.push({ action, opts });
      const a = answer(action);
      if (a === 'hang') return new Promise<ActionOp>(() => undefined);
      if (a instanceof Error) throw a;
      return { id: 'op', state: 'succeeded', ...a } as ActionOp;
    },
  };
}
const noFetch = { raw: async () => { throw new Error('not fetched'); } };

describe('run recording calls (#755)', () => {
  it('starts with the options and never waits for a takeover', async () => {
    const s = fakeSession(() => ({ result: { recording_id: 'rec-1' } }));
    expect(await recordStart(s, 'sess', { maxWidth: 1280 })).toBe('rec-1');
    expect(s.sent[0]).toEqual({ action: { type: 'record_start', max_width: 1280 }, opts: { waitForTakeover: false } });
  });

  it('reads an inline chunk, and one stored as an artifact', async () => {
    const inline = fakeSession(() => ({ result: { data: Buffer.from('abc').toString('base64'), seq: 2, frames: 5, dropped: 1, duration_ms: 900 } }));
    const c = await recordPull(inline, noFetch, 'sess', 'rec-1');
    expect(c).toMatchObject({ seq: 2, frames: 5, dropped: 1, durationMs: 900, done: false, ended: null });
    expect(c.bytes.toString()).toBe('abc');

    const byHandle = fakeSession(() => ({ result: { artifact_id: 'a1', size: 3, seq: 0, done: true, ended: 'stopped' } }));
    const paths: string[] = [];
    const fetcher = { raw: async (_m: 'GET', path: string) => { paths.push(path); return new Response(Buffer.from('xyz')); } };
    const last = await recordStop(byHandle, fetcher, 'sess', 'rec-1');
    expect(paths).toEqual(['/v1/artifacts/a1']);
    expect(last).toMatchObject({ done: true, ended: 'stopped' });
    expect(last.bytes.toString()).toBe('xyz');
  });

  it('reads an empty pull as no bytes, without a fetch', async () => {
    const s = fakeSession(() => ({ result: { mime: 'application/x-hexactra-recording', size: 0, seq: 3 } }));
    expect((await recordPull(s, noFetch, 'sess', 'rec-1')).bytes.length).toBe(0);
  });

  it('pauses and resumes', async () => {
    const s = fakeSession(() => ({ result: { paused: true } }));
    await recordPause(s, 'sess', 'rec-1', true);
    expect(s.sent[0]!.action).toEqual({ type: 'record_pause', recording_id: 'rec-1', paused: true });
  });

  it('turns failures into codes, and a call that hangs into unavailable', async () => {
    const failed = fakeSession(() => ({ state: 'failed', error: 'recording_not_found: no recording rec-1' }));
    await expect(recordPull(failed, noFetch, 'sess', 'rec-1')).rejects.toMatchObject({ code: 'recording_not_found' });
    const thrown = fakeSession(() => new Error('encoder_unavailable: this Chrome has no offscreen documents'));
    await expect(recordStart(thrown, 'sess')).rejects.toMatchObject({ code: 'encoder_unavailable' });
    const oldExtension = fakeSession(() => ({ state: 'failed', error: 'unsupported action record_start' }));
    await expect(recordStart(oldExtension, 'sess')).rejects.toMatchObject({ code: 'unsupported' });
    const oldAgent = fakeSession(() => new Error('invalid action: unknown variant `record_start`, expected one of `navigate`'));
    await expect(recordStart(oldAgent, 'sess')).rejects.toMatchObject({ code: 'unsupported' });
    const hangs = fakeSession(() => 'hang');
    await expect(recordStart(hangs, 'sess', {}, 20)).rejects.toBeInstanceOf(RecordingCallError);
    await expect(recordStart(hangs, 'sess', {}, 20)).rejects.toMatchObject({ code: 'unavailable' });
  });
});
