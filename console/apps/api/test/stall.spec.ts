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
  clearStallEvidence,
  stableDigest,
  stableText,
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

  it('counts the same action from the same page over the whole run, not only the last 10 (E52.2)', () => {
    const s = newStallState();
    observeAction(s, th, act('click', { selector: '#a' }));
    observeAction(s, th, act('click', { selector: '#a' }));
    for (let i = 0; i < 10; i += 1) observeAction(s, th, act('click', { selector: `#other${i}` }));
    // Before E52.2 the window of 10 forgot the first two; a cycle longer than the window never stalled.
    expect(observeAction(s, th, act('click', { selector: '#a' })).signal).toMatchObject({ kind: 'repeat', reason: 'repeated click on #a 3 times from the same page' });
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

// E52.2: a cycle of any period. The run that started it went picker -> select contact -> thread -> back, about 16 times, with reads and
// looks between, and never stalled: every lap was longer than the window of 10, and the page view changed every round.
describe('cycles (E52.2)', () => {
  const picker = (clock: string) => ({ url: 'https://chat.example.test/web/new', title: 'Messages', view: `picker-${clock}`, stable: stableDigest([{ selector: '#to', text: 'To' }, { selector: '#c1', text: 'Sam Example' }, { selector: '#clock', text: clock }]) });
  const thread = (clock: string) => ({ url: 'https://chat.example.test/web/c/1', title: 'Messages', view: `thread-${clock}`, stable: stableDigest([{ selector: '#title', text: 'Samantha Example' }, { selector: '#clock', text: clock }]) });

  /** One lap (5 actions): start a chat from the thread, then on the picker look, read, list the elements and pick the contact. */
  function lap(s: ReturnType<typeof newStallState>, n: number) {
    const signals = [];
    signals.push(observePage(s, th, thread(`9:${10 + n} PM`)));
    signals.push(observeAction(s, th, act('click_at', { x: 89, y: 104 })).signal);
    signals.push(observePage(s, th, picker(`9:${10 + n} PM`)));
    signals.push(observeAction(s, th, act('look', { screen: 'page' })).signal);
    signals.push(observeAction(s, th, act('text', { selector: 'body' }, { contentHash: `picker${n}` })).signal);
    signals.push(observeAction(s, th, act('elements', { max_elements: 80 }, { contentHash: `els${n}` })).signal);
    signals.push(observeAction(s, th, act('click_at', { x: 1155, y: 541 })).signal);
    return signals.filter(Boolean);
  }

  it('signals at the third lap of a 5-action cycle (longer than the window allows to see), although the clock on the page changes every lap', () => {
    const s = newStallState();
    expect(lap(s, 1)).toEqual([]);
    expect(lap(s, 2)).toEqual([]);
    expect(lap(s, 3)).toEqual([expect.objectContaining({ kind: 'repeat', reason: 'repeated click at 89,104 3 times from the same page' }), expect.objectContaining({ kind: 'repeat', reason: 'repeated click at 1155,541 3 times from the same page' })]);
  });

  it('after a nudge one more repeat signals again (the policy then escalates); after a handoff the count starts over', () => {
    const s = newStallState();
    lap(s, 1);
    lap(s, 2);
    lap(s, 3);
    clearStallEvidence(s);
    expect(lap(s, 4).length).toBeGreaterThan(0);
    resetStall(s);
    expect(lap(s, 5)).toEqual([]);
    expect(lap(s, 6)).toEqual([]);
  });

  it('a page already seen is no progress; a new one is', () => {
    const s = newStallState();
    observePage(s, th, thread('9:10 PM'));
    observePage(s, th, picker('9:10 PM'));
    for (let i = 0; i < 4; i += 1) observeAction(s, th, act('click_at', { x: i * 50, y: 10 }));
    observePage(s, th, thread('9:11 PM'));
    expect(s.sinceProgress).toBe(4);
    observePage(s, th, { url: 'https://chat.example.test/web/c/2', title: 'Messages', view: 'other', stable: stableDigest([{ selector: '#title', text: 'Samuel Example' }]) });
    expect(s.sinceProgress).toBe(0);
  });

  it('does not misfire on pages that really change', () => {
    // "Next page" 20 times: each page lists other items.
    let s = newStallState();
    for (let i = 0; i < 20; i += 1) {
      observePage(s, th, { url: 'https://shop.example.test/list', title: 'List', view: `v${i}`, stable: stableDigest([{ selector: '#next', text: 'Next' }, { selector: '#item', text: `Item ${i * 10 + 1}` }]) });
      expect(observeAction(s, th, act('click', { selector: '#next' })).signal).toBeNull();
    }
    // A quantity "+" 5 times: the number on the page changes, and digits are kept.
    s = newStallState();
    for (let q = 1; q <= 5; q += 1) {
      observePage(s, th, { url: 'https://shop.example.test/cart', title: 'Cart', view: `q${q}`, stable: stableDigest([{ selector: '#plus', text: '+' }, { selector: '#qty', text: String(q) }]) });
      expect(observeAction(s, th, act('click', { selector: '#plus' })).signal).toBeNull();
    }
    // A list and different details: each detail is opened once.
    s = newStallState();
    for (let i = 0; i < 6; i += 1) {
      observePage(s, th, { url: 'https://shop.example.test/list', title: 'List', view: 'list', stable: 'list' });
      expect(observeAction(s, th, act('click', { selector: `#item${i}` })).signal).toBeNull();
      observePage(s, th, { url: `https://shop.example.test/item/${i}`, title: 'Item', view: `item${i}`, stable: `item${i}` });
      expect(observeAction(s, th, act('click', { selector: '#back' })).signal).toBeNull();
    }
  });

  it('the same item opened three times from the same list is a stall', () => {
    const s = newStallState();
    let signal = null;
    for (let i = 0; i < 3; i += 1) {
      observePage(s, th, { url: 'https://shop.example.test/list', title: 'List', view: `list${i}`, stable: 'list' });
      signal = observeAction(s, th, act('click', { selector: '#item1' })).signal ?? signal;
      observePage(s, th, { url: 'https://shop.example.test/item/1', title: 'Item', view: `item${i}`, stable: 'item1' });
      for (let r = 0; r < 4; r += 1) observeAction(s, th, act('text', {}, { contentHash: `t${i}${r}` }));
      observeAction(s, th, act('click', { selector: '#back' }));
    }
    expect(signal).toMatchObject({ kind: 'repeat' });
  });

  it('stableText blanks clock and relative times and keeps other digits', () => {
    expect(stableText('  Sent 9:41 PM ')).toBe('sent #');
    expect(stableText('11:02:33')).toBe('#');
    expect(stableText('2 min')).toBe('#');
    expect(stableText('3 hours ago')).toBe('#');
    expect(stableText('Yesterday')).toBe('#');
    expect(stableText('Now')).toBe('#');
    expect(stableText('Page 2 of 9')).toBe('page 2 of 9');
    expect(stableText('$12.50')).toBe('$12.50');
    expect(stableText('Qty 3')).toBe('qty 3');
    expect(stableDigest([])).toBeNull();
    expect(stableDigest([{ selector: '#a', text: '9:10' }])).toBe(stableDigest([{ selector: '#a', text: '10:45' }]));
  });

  it('reads a run memory written before E52.2, and stores no typed text or secret', () => {
    const old = readStallState({ recent: [], failures: 0, sinceProgress: 2, page: { url: 'https://x.example.test/', title: 'X', view: 'v' }, observable: true, seen: [] });
    expect(old.counts).toEqual([]);
    expect(old.stableSeen).toEqual([]);
    expect(old.page).toMatchObject({ stable: null });
    const s = newStallState();
    for (let i = 0; i < 3; i += 1) observeAction(s, th, act('type', { selector: '#msg', text: 'Hello Sam, see you at 7' }));
    observeAction(s, th, { ...act('type', { selector: '#pw', text: 'hunter2-secret' }), secret: true });
    const stored = JSON.stringify(readStallState(JSON.parse(JSON.stringify(s))));
    expect(stored).not.toContain('Hello Sam');
    expect(stored).not.toContain('hunter2');
    expect(s.counts.length).toBe(1);
  });
});
