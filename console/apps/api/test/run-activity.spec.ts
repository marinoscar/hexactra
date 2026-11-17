// What a live run is doing right now (#379): the activity the run page shows.
import { actionTarget, runActivity } from '../src/runner/activity';

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

describe('actionTarget (#381)', () => {
  const marks = [{ selector: '#member', x: 10, y: 20, w: 300, h: 40 }];

  it('uses coordinates, the start of a drag, or the marked element of a selector', () => {
    expect(actionTarget({ type: 'click_at', x: 612, y: 340 })).toEqual({ x: 612, y: 340 });
    expect(actionTarget({ type: 'drag', from_x: 1, from_y: 2, to_x: 3, to_y: 4 })).toEqual({ x: 1, y: 2 });
    expect(actionTarget({ type: 'type', selector: '#member', text: 'x' }, marks)).toEqual({ x: 10, y: 20, w: 300, h: 40 });
  });

  it('has none for an unknown selector, a desktop action, or an action without a place', () => {
    expect(actionTarget({ type: 'click', selector: '#other' }, marks)).toBeUndefined();
    expect(actionTarget({ type: 'desktop_click', x: 5, y: 5 })).toBeUndefined();
    expect(actionTarget({ type: 'navigate', url: 'https://x.test/' })).toBeUndefined();
  });

  it('is carried on the activity', () => {
    expect(runActivity('acting', { action: { type: 'click_at', x: 1, y: 2 }, target: { x: 1, y: 2 } }).target).toEqual({ x: 1, y: 2 });
  });
});
