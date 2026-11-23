// The stall detector (#405): pure, so every signal is proved at its threshold.
import {
  decideStall,
  describeAction,
  fingerprint,
  lastActions,
  newStallState,
  nudgeText,
  observeAction,
  observePage,
  readStallState,
  resetStall,
  type ActionObservation,
  type StallThresholds,
} from '../src/runner/stall';

const th: StallThresholds = { maxConsecutiveFailures: 4, maxRepeatedAction: 3, noProgressActions: 10 };
const act = (type: string, args: Record<string, unknown>, extra: Partial<ActionObservation> = {}): ActionObservation => ({ type, args, ok: true, ...extra });
const page = (view: string, url = 'https://shop.example.test/') => ({ url, title: 'Shop', view });

describe('consecutive failures', () => {
  it('fires at the threshold and not before; a success resets the count', () => {
    const s = newStallState();
    for (let i = 0; i < 3; i += 1) expect(observeAction(s, th, { ...act('click', { selector: `#b${i}` }), ok: false }).signal).toBeNull();
    expect(observeAction(s, th, act('click', { selector: '#ok' })).signal).toBeNull();
    for (let i = 0; i < 3; i += 1) expect(observeAction(s, th, { ...act('click', { selector: `#c${i}` }), ok: false }).signal).toBeNull();
    const signal = observeAction(s, th, { ...act('click', { selector: '#c9' }), ok: false }).signal;
    expect(signal).toMatchObject({ kind: 'failures', reason: '4 actions failed in a row' });
  });
});

describe('repeated action', () => {
  it('fires when one fingerprint reaches the threshold inside the window of 10', () => {
    const s = newStallState();
    expect(observeAction(s, th, act('click', { selector: '#submit' })).signal).toBeNull();
    expect(observeAction(s, th, act('click', { selector: '#submit' })).signal).toBeNull();
    expect(observeAction(s, th, act('click', { selector: '#submit' })).signal).toMatchObject({ kind: 'repeat', reason: 'repeated click on #submit 3 times' });
  });

  it('counts only the last 10 actions', () => {
    const s = newStallState();
    observeAction(s, th, act('click', { selector: '#a' }));
    observeAction(s, th, act('click', { selector: '#a' }));
    for (let i = 0; i < 10; i += 1) observeAction(s, th, act('click', { selector: `#other${i}` }));
    expect(observeAction(s, th, act('click', { selector: '#a' })).signal).toBeNull();
  });

  it('rounds positions: clicks a few pixels apart are the same click', () => {
    const s = newStallState();
    observeAction(s, th, act('click_at', { x: 101, y: 199 }));
    observeAction(s, th, act('click_at', { x: 103, y: 201 }));
    expect(observeAction(s, th, act('click_at', { x: 98, y: 204 })).signal?.kind).toBe('repeat');
  });

  it('does not count the same scroll when the page really moved', () => {
    const s = newStallState();
    for (const y of [400, 800, 1200, 1600]) expect(observeAction(s, th, act('scroll', { dy: 400 }, { resultKey: `y${y}` })).signal).toBeNull();
  });

  // #909: a read returns what the page shows now. Re-reading a page that changed is an observe-act loop, not a repeat.
  it('re-reading a page that changed is no repeat: text; click A; text; click B; text, same URL and view', () => {
    const s = newStallState();
    observePage(s, th, page('v1'));
    expect(observeAction(s, th, act('text', {}, { contentHash: 'page-1' })).signal).toBeNull();
    expect(observeAction(s, th, act('click', { selector: '#a' })).signal).toBeNull();
    expect(observeAction(s, th, act('text', {}, { contentHash: 'page-2' })).signal).toBeNull();
    expect(observeAction(s, th, act('click', { selector: '#b' })).signal).toBeNull();
    expect(observeAction(s, th, act('text', {}, { contentHash: 'page-3' })).signal).toBeNull();
    // Each new read reset the no-progress count.
    expect(s.sinceProgress).toBe(0);
  });

  it('reading identical content 3 times is still a repeat: text; click A; text; click B; text', () => {
    const s = newStallState();
    observePage(s, th, page('v1'));
    observeAction(s, th, act('text', {}, { contentHash: 'same' }));
    observeAction(s, th, act('click', { selector: '#a' }));
    observeAction(s, th, act('text', {}, { contentHash: 'same' }));
    observeAction(s, th, act('click', { selector: '#b' }));
    expect(observeAction(s, th, act('text', {}, { contentHash: 'same' })).signal).toMatchObject({ kind: 'repeat', reason: 'repeated text 3 times' });
  });

  it('evaluate 4 times: the same value is a repeat, four different values are not', () => {
    const same = newStallState();
    const signals = [0, 1, 2, 3].map(() => observeAction(same, th, act('evaluate', { script: 'loadMore()' }, { contentHash: 'v' })).signal);
    expect(signals.slice(0, 2)).toEqual([null, null]);
    expect(signals[2]).toMatchObject({ kind: 'repeat', reason: 'repeated evaluate 3 times' });
    const fresh = newStallState();
    for (const v of ['v1', 'v2', 'v3', 'v4']) expect(observeAction(fresh, th, act('evaluate', { script: 'loadMore()' }, { contentHash: v })).signal).toBeNull();
  });

  it('elements after each of 3 clicks in an SPA (same URL), with different content, is no repeat', () => {
    const s = newStallState();
    observePage(s, th, page('v1', 'https://app.example.test/#/settings'));
    for (const tab of ['general', 'privacy', 'billing']) {
      expect(observeAction(s, th, act('click', { selector: `#nav-${tab}` })).signal).toBeNull();
      expect(observeAction(s, th, act('elements', {}, { contentHash: `elements-${tab}` })).signal).toBeNull();
    }
  });

  it('a read keeps its result key when it has one (a scroll): the content digest does not replace it', () => {
    const a = fingerprint(act('scroll', { dy: 400 }, { resultKey: 'y400', contentHash: 'c1' }), null);
    const b = fingerprint(act('scroll', { dy: 400 }, { resultKey: 'y400', contentHash: 'c2' }), null);
    expect(a).toBe(b);
    // An action that changes the page is fingerprinted by what it did, not by any content it reported.
    expect(fingerprint(act('click', { selector: '#x' }, { contentHash: 'c1' }), null)).toBe(fingerprint(act('click', { selector: '#x' }, { contentHash: 'c2' }), null));
  });

  it('a URL differing only in its query is the same URL', () => {
    const s = newStallState();
    observeAction(s, th, act('navigate', { url: 'https://shop.example.test/a?token=1' }));
    observeAction(s, th, act('navigate', { url: 'https://shop.example.test/a?token=2' }));
    expect(observeAction(s, th, act('navigate', { url: 'https://shop.example.test/a?token=3' })).signal?.kind).toBe('repeat');
  });
});

describe('no progress', () => {
  it('with a measured page it is judged at the chunk boundary, from what changed', () => {
    const s = newStallState();
    expect(observePage(s, th, page('v1'))).toBeNull();
    for (let i = 0; i < 12; i += 1) expect(observeAction(s, th, act('click_at', { x: i * 50, y: 10 })).signal).toBeNull();
    // The screenshot did not change: the signal fires now.
    expect(observePage(s, th, page('v1'))).toMatchObject({ kind: 'no_progress' });
  });

  it('a changed URL, title or view at the boundary is progress', () => {
    for (const next of [page('v2'), page('v1', 'https://shop.example.test/cart'), { ...page('v1'), title: 'Cart' }]) {
      const s = newStallState();
      observePage(s, th, page('v1'));
      for (let i = 0; i < 12; i += 1) observeAction(s, th, act('click_at', { x: i * 50, y: 10 }));
      expect(observePage(s, th, next)).toBeNull();
      expect(s.sinceProgress).toBe(0);
    }
  });

  it('observations alone do not count as progress; new returned content does', () => {
    const s = newStallState();
    observePage(s, th, page('v1'));
    for (let i = 0; i < 4; i += 1) observeAction(s, th, act('text', { max_chars: 100 }, { contentHash: 'same', resultKey: `r${i}` }));
    // The first read was new content (progress); the three after it are not.
    expect(s.sinceProgress).toBe(3);
    for (let i = 0; i < 5; i += 1) observeAction(s, th, act('elements', { max_elements: 10 + i }, { contentHash: 'same-elements' }));
    // The first elements listing was new content, the four after it are not.
    expect(s.sinceProgress).toBe(4);
    observeAction(s, th, act('evaluate', { script: '1+1' }, { contentHash: 'fresh' }));
    expect(s.sinceProgress).toBe(0);
  });

  it('a failed read returns no content and is no progress', () => {
    const s = newStallState();
    observePage(s, th, page('v1'));
    observeAction(s, th, { ...act('text', {}, { contentHash: 'x' }), ok: false });
    expect(s.sinceProgress).toBe(1);
  });

  it('without a measured page (no screenshots) a new successful change is progress, and the signal fires on its own', () => {
    const s = newStallState();
    expect(observePage(s, th, null)).toBeNull();
    for (let i = 0; i < 30; i += 1) expect(observeAction(s, th, act('click_at', { x: i * 50, y: 10 })).signal).toBeNull();
    // Reads alone, with nothing new, reach the threshold.
    let signal = null;
    for (let i = 0; i < 12 && !signal; i += 1) signal = observeAction(s, th, act('scroll', { dy: i + 1 }, { resultKey: `y${i}` })).signal;
    expect(signal).toMatchObject({ kind: 'no_progress' });
  });
});

describe('handoffs and secrets', () => {
  it('a handoff resets every counter', () => {
    const s = newStallState();
    observePage(s, th, page('v1'));
    for (let i = 0; i < 3; i += 1) observeAction(s, th, { ...act('click', { selector: '#x' }), ok: false });
    resetStall(s);
    expect(s).toMatchObject({ recent: [], failures: 0, sinceProgress: 0, page: null, seen: [] });
    expect(observeAction(s, th, { ...act('click', { selector: '#x' }), ok: false }).signal).toBeNull();
  });

  it('secret typing is ignored: it neither counts nor repeats', () => {
    const s = newStallState();
    for (let i = 0; i < 20; i += 1) expect(observeAction(s, th, { ...act('type', { selector: '#code', submit: true }), ok: false, secret: true }).signal).toBeNull();
    expect(s.recent).toEqual([]);
    expect(s.failures).toBe(0);
  });

  it('typed text and secrets never enter a fingerprint or the stored state', () => {
    const typed = 'correct-horse-battery-staple';
    const a = fingerprint(act('type', { selector: '#pw', text: typed, clear: true }), null);
    const b = fingerprint(act('type', { selector: '#pw', text: 'x'.repeat(typed.length), clear: true }), null);
    // Only the length is looked at, so these are equal: the text itself is not.
    expect(a).toBe(b);
    const s = newStallState();
    observeAction(s, th, act('type', { selector: '#pw', text: typed }));
    observeAction(s, th, act('type_keys', { text: typed }));
    observeAction(s, th, act('navigate', { url: 'https://shop.example.test/login?token=abc123' }));
    const stored = JSON.stringify(s);
    expect(stored).not.toContain(typed);
    expect(stored).not.toContain('abc123');
    expect(JSON.stringify(readStallState(JSON.parse(stored)))).toBe(stored);
  });
});

describe('texts and decisions', () => {
  it('describes actions and lists the last ones', () => {
    expect(describeAction('click', { selector: '#submit' })).toBe('click on #submit');
    expect(describeAction('click_at', { x: 1, y: 2 })).toBe('click at 1,2');
    const s = newStallState();
    observeAction(s, th, act('click', { selector: '#a' }));
    observeAction(s, th, { ...act('click', { selector: '#b' }), ok: false });
    expect(lastActions(s)).toBe('click on #a; click on #b (failed)');
  });

  it('the nudge reads as the issue words it', () => {
    expect(nudgeText('repeated click on #submit 3 times', 'click on #submit')).toBe(
      'You appear stuck: repeated click on #submit 3 times (last actions: click on #submit). Do not repeat the same action. Try a different approach (another selector, position, keyboard, run_javascript, or a different page), or call finish if the goal is impossible.',
    );
  });

  it('answers a stall per mode', () => {
    const base = { stallsHere: 0, canEscalate: true, canAsk: true };
    expect(decideStall({ ...base, mode: 'nudge_then_escalate' })).toBe('nudge');
    expect(decideStall({ ...base, mode: 'nudge_then_escalate', stallsHere: 1 })).toBe('escalate');
    expect(decideStall({ ...base, mode: 'nudge_then_escalate', stallsHere: 1, canEscalate: false })).toBe('ask');
    expect(decideStall({ ...base, mode: 'nudge_then_escalate', stallsHere: 1, canEscalate: false, canAsk: false })).toBe('fail');
    expect(decideStall({ ...base, mode: 'escalate' })).toBe('escalate');
    expect(decideStall({ ...base, mode: 'escalate', canEscalate: false })).toBe('fail');
    expect(decideStall({ ...base, mode: 'ask_human' })).toBe('ask');
    expect(decideStall({ ...base, mode: 'ask_human', canAsk: false })).toBe('fail');
    expect(decideStall({ ...base, mode: 'fail' })).toBe('fail');
  });
});
