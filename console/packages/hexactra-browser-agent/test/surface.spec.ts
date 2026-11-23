// E46.13 (#787): fingerprints and re-resolution against the scriptable FakeBrowser.
import { captureFingerprint, matchFingerprint, resolveFingerprint, type ElementFingerprint, type PageElement } from '../src/surface';
import { FakeBrowser } from '../src/testing';

const pay: PageElement = { selector: '#pay-now', selectors: ['#pay-now', '[data-testid="pay"]', 'form:nth-child(2) > button:nth-child(3)'], role: 'button', name: 'Pay now', tag: 'button', inputType: 'submit', anchor: 'Checkout' };
const cancel: PageElement = { selector: '#cancel', selectors: ['#cancel'], role: 'button', name: 'Cancel order', tag: 'button', inputType: 'submit', anchor: 'Checkout' };
const fp: ElementFingerprint = { role: 'button', name: 'Pay now', tag: 'button', inputType: 'submit', selectors: ['#pay-now', '[data-testid="pay"]', 'form:nth-child(2) > button:nth-child(3)'], anchor: 'Checkout', frame: 'top' };

describe('matchFingerprint', () => {
  it('finds the element by its first selector', () => {
    expect(matchFingerprint(fp, [pay, cancel])).toEqual({ kind: 'found', selector: '#pay-now', confidence: 1, via: 'selector' });
  });
  it('re-resolves after its id changes (another candidate still names it)', () => {
    const moved = { ...pay, selector: '#pay-2026', selectors: ['#pay-2026', '[data-testid="pay"]', 'div > button'] };
    expect(matchFingerprint(fp, [moved, cancel])).toMatchObject({ kind: 'found', selector: '#pay-2026', via: 'selector' });
  });
  it('re-resolves after its position and every selector changed, by role and name within the anchor', () => {
    const elsewhere = { ...pay, selector: '#x1', selectors: ['#x1', 'main > button:nth-child(9)'] };
    expect(matchFingerprint(fp, [cancel, elsewhere])).toMatchObject({ kind: 'found', selector: '#x1', via: 'anchor' });
  });
  it('re-resolves after its text changes slightly', () => {
    const renamed = { ...pay, selector: '#x2', selectors: ['#x2'], name: 'Pay now securely' };
    expect(matchFingerprint(fp, [cancel, renamed])).toMatchObject({ kind: 'found', selector: '#x2' });
  });
  it('two equally good matches are ambiguous: nothing is guessed', () => {
    const a = { ...pay, selector: '#a', selectors: ['#a'] };
    const b = { ...pay, selector: '#b', selectors: ['#b'] };
    expect(matchFingerprint(fp, [a, b])).toEqual({ kind: 'ambiguous', count: 2 });
  });
  it('nothing like it: not found', () => {
    expect(matchFingerprint(fp, [cancel])).toEqual({ kind: 'not_found' });
  });
});

describe('capture and resolve through the page', () => {
  it('captures a fingerprint with no typed value, and resolves it again', async () => {
    const browser = new FakeBrowser();
    const q = { selector: '#q', selectors: ['#q'], role: null, name: 'Search', tag: 'input', inputType: 'text', anchor: 'Find a product' };
    browser.surface = [q, { ...pay }];
    const typed = 'MARKER-typed-secret-4111';
    const got = await captureFingerprint(browser, { selector: '#q' }, { mask: (s) => s.replace(/\d/g, '•') });
    expect(got).toEqual({ role: null, name: 'Search', tag: 'input', inputType: 'text', selectors: ['#q'], anchor: 'Find a product', frame: 'top' });
    expect(JSON.stringify(got)).not.toContain(typed);
    expect(await resolveFingerprint(browser, got!)).toMatchObject({ kind: 'found', selector: '#q' });
    // The page queries are not actions: nothing was sent to the page.
    expect(browser.actions).toHaveLength(0);
  });
  it('a sensitive field keeps role and anchor only', async () => {
    const browser = new FakeBrowser();
    browser.surface = [{ selector: '#card', selectors: ['#card'], role: 'textbox', name: 'Card number', tag: 'input', inputType: 'text', anchor: 'Payment' }];
    expect(await captureFingerprint(browser, { selector: '#card' }, { sensitive: true })).toMatchObject({ name: null, selectors: [], role: 'textbox', anchor: 'Payment' });
  });
});
