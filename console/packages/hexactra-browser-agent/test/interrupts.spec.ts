// E46.15 (#789): each detector with positive and negative fixtures.
import { detectBlocked, detectConsent, detectInterrupt, detectOverlay, detectSignedOut, isConsentChoice, isGoogleSignInPage, pageSnapshot, type PageSnapshot } from '../src/surface';
import { FakeBrowser } from '../src/testing';

const el = (o: Partial<PageSnapshot['elements'][number]>) => ({ selector: '#x', selectors: ['#x'], role: null, name: null, tag: 'button', inputType: null, anchor: null, ...o });
const page = (o: Partial<PageSnapshot> = {}): PageSnapshot => ({ url: 'https://shop.example.com/cart', title: 'Cart', text: '', elements: [], frames: [], ...o });

describe('consent', () => {
  const banner = page({ elements: [el({ selector: '#accept', name: 'Accept all', anchor: 'We use cookies' }), el({ selector: '#reject', name: 'Reject all', anchor: 'We use cookies' })] });
  it('finds a banner with its choices', () => expect(detectConsent(banner)).toEqual({ choices: ['#accept', '#reject'] }));
  it('a page that merely mentions cookies is not a banner', () => {
    expect(detectConsent(page({ text: 'Read our cookie policy. We value your privacy.', elements: [el({ name: 'Cookie policy', tag: 'a' }), el({ name: 'Checkout', anchor: 'Cart' })] }))).toBeNull();
  });
  it('recognises a recorded choice', () => {
    expect(isConsentChoice({ name: 'Reject all', anchor: 'Cookie preferences' })).toBe(true);
    expect(isConsentChoice({ name: 'Buy now', anchor: 'Cookie preferences' })).toBe(false);
  });
});

describe('overlay', () => {
  it('a modal with exactly one close control', () => {
    expect(detectOverlay(page({ elements: [el({ role: 'dialog', name: 'Newsletter', tag: 'div' }), el({ selector: '#close', name: 'Close', anchor: 'Newsletter' })] }))).toEqual({ close: '#close' });
  });
  it('two controls it cannot tell apart: not dismissed', () => {
    expect(detectOverlay(page({ elements: [el({ role: 'dialog', name: 'Offer', tag: 'div' }), el({ selector: '#a', name: 'Close', anchor: 'Offer' }), el({ selector: '#b', name: 'Not now', anchor: 'Offer' })] }))).toBeNull();
    expect(detectOverlay(page({ elements: [el({ name: 'Checkout' })] }))).toBeNull();
  });
});

describe('signed_out', () => {
  it('a sign-in page', () => {
    expect(detectSignedOut(page({ url: 'https://shop.example.com/login', elements: [el({ tag: 'input', inputType: 'password' }), el({ name: 'Sign in' })] }))).toBe(true);
  });
  it('a page with a "Sign in" link but no password field is not', () => {
    expect(detectSignedOut(page({ elements: [el({ name: 'Sign in', tag: 'a' })] }))).toBe(false);
  });
  it("Google's own account sign-in is told from the URL alone (E48.5)", () => {
    for (const url of [
      'https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmail.google.com',
      'https://accounts.google.com/signin/v2/challenge/pwd',
      'https://accounts.google.com/ServiceLogin?service=mail',
      'https://accounts.google.com/AccountChooser',
      'https://Accounts.Google.com/InteractiveLogin',
    ]) {
      expect(isGoogleSignInPage(url)).toBe(true);
    }
    for (const url of [
      null,
      undefined,
      '',
      'not a url',
      'http://accounts.google.com/signin',
      'https://accounts.google.com/',
      'https://accounts.google.com/b/0/ManageAccount',
      'https://accounts.google.com.evil.example/signin',
      'https://evil.example/accounts.google.com/signin',
      'https://mail.google.com/mail/u/0/',
      'https://shop.example.com/signin',
    ]) {
      expect(isGoogleSignInPage(url)).toBe(false);
    }
  });
});

describe('blocked', () => {
  it('a CAPTCHA by text or frame', () => {
    expect(detectBlocked(page({ title: 'Security check', text: 'Please verify you are human' }))).toBe(true);
    expect(detectBlocked(page({ frames: ['https://www.google.com/recaptcha/api2/anchor'] }))).toBe(true);
  });
  it('an ordinary page is not', () => expect(detectBlocked(page({ text: 'Your order of 3 robots ships Friday' }))).toBe(false));
  it('is the most severe when several apply', () => {
    expect(detectInterrupt(page({ title: 'Unusual activity', elements: [el({ name: 'Accept all', anchor: 'Cookies' })] }))).toEqual({ kind: 'blocked' });
  });
});

it('a snapshot reads the page through the fake browser without an action', async () => {
  const b = new FakeBrowser();
  b.snapshot = { title: 'Login', text: 'Sign in to continue' };
  b.surface = [el({ selector: '#pw', tag: 'input', inputType: 'password' })];
  const s = await pageSnapshot(b);
  expect(s).toMatchObject({ title: 'Login', elements: [expect.objectContaining({ selector: '#pw' })] });
  expect(b.actions).toHaveLength(0);
});
