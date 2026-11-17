// What a live run is doing right now (#379): the activity the run page shows.
import { runActivity } from '../src/runner/activity';

describe('runActivity', () => {
  const now = new Date('2026-11-16T18:11:22.000Z');

  it('stamps a phase with no action', () => {
    expect(runActivity('thinking', {}, now)).toEqual({ phase: 'thinking', startedAt: '2026-11-16T18:11:22.000Z' });
  });

  it('names the action and redacts its arguments like a step', () => {
    const a = runActivity('acting', { action: { type: 'type', selector: '#pin', text: '987654' }, reason: 'enter the member number', timeoutMs: 45_000 }, now);
    expect(a).toEqual({
      phase: 'acting',
      action: 'type',
      args: { selector: '#pin', text_length: 6 },
      reason: 'enter the member number',
      startedAt: '2026-11-16T18:11:22.000Z',
      timeoutMs: 45_000,
    });
    expect(JSON.stringify(a)).not.toContain('987654');
  });

  it('drops URL queries and trims long reasons', () => {
    const a = runActivity('acting', { action: { type: 'navigate', url: 'https://x.test/a?token=s3cret' }, reason: 'r'.repeat(900) }, now);
    expect(a.args).toEqual({ url: 'https://x.test/a (query removed)' });
    expect(a.reason).toHaveLength(501);
  });
});
