// The scan question's contract and channel rules (#924), without a database.
import { mayAnswerOn, isPublicAnswer } from '../src/questions/channels/channel-rules';
import { questionSpecSchema, validateAnswer, SCAN_TIMEOUT } from '../src/questions/questions.contract';
import { scanDomain } from '../src/questions/scan-capture';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const shared = require('../../../packages/shared/question-rules.js') as { needsSignedIn: (q: object) => boolean; chatAnswerMode: (q: object) => string; answerLabel: (q: object, a: object) => string };

const parse = (raw: Record<string, unknown>) => questionSpecSchema.safeParse({ input: 'scan', kind: 'login', prompt: 'Scan the code', ...raw });

describe('the scan contract (#924)', () => {
  it('is for a sign-in, a passkey, a bank verification or a code, nothing else', () => {
    for (const kind of ['passkey', 'login', 'verification', 'code']) expect(parse({ kind }).success).toBe(true);
    for (const kind of ['captcha', 'confirmation', 'other']) expect(parse({ kind }).success).toBe(false);
  });

  it('waits 3 minutes by default and at most 10, not the administrator\'s general wait', () => {
    const p = parse({});
    expect(p.success && p.data.timeoutMs).toBe(SCAN_TIMEOUT.defaultMs);
    expect(p.success && p.data.timeoutDefaulted).toBeUndefined();
    expect(parse({ timeoutMs: SCAN_TIMEOUT.maxMs }).success).toBe(true);
    expect(parse({ timeoutMs: SCAN_TIMEOUT.maxMs + 1 }).success).toBe(false);
  });

  it('takes the source only; the address and the picture are the server\'s', () => {
    const p = parse({ scanSource: 'desktop', scan: { source: 'page', domain: 'attacker.test', origin: 'https://attacker.test' }, image: 'data:,x' });
    expect(p.success && p.data.scan).toEqual({ source: 'desktop', domain: null, origin: null });
    expect(questionSpecSchema.safeParse({ input: 'none', kind: 'login', prompt: 'x', scanSource: 'page' }).success).toBe(false);
  });

  it('is answered with Done or declined, never a value', () => {
    expect(validateAnswer({ input: 'scan', options: null, constraints: null }, { outcome: 'completed' })).toEqual({ outcome: 'completed' });
    expect(() => validateAnswer({ input: 'scan', options: null, constraints: null }, { outcome: 'completed', value: 'x' })).toThrow();
  });

  it('is answered only on the signed-in web, the Android app and the Inbox, declining too', () => {
    const q = { input: 'scan', risk: null };
    for (const ch of ['web', 'android_app', 'inbox']) expect(mayAnswerOn(ch, q)).toBe(true);
    for (const ch of ['cli', 'tui', 'api', 'mcp', 'notification', 'webhook', 'mcp-oauth', 'mcp-elicitation.claude', 'mcp-app']) {
      expect({ ch, completed: mayAnswerOn(ch, q), cancelled: mayAnswerOn(ch, q, 'cancelled') }).toEqual({ ch, completed: false, cancelled: false });
    }
    expect(isPublicAnswer({ input: 'scan', risk: null, options: null })).toBe(false);
    expect(shared.needsSignedIn({ input: 'scan' })).toBe(true);
    expect(shared.chatAnswerMode({ input: 'scan' })).toBe('signed_in');
    expect(shared.answerLabel({ input: 'scan' }, { outcome: 'completed' })).toBe('Done');
  });

  it('names a page by its registrable domain, or its host when it has none', () => {
    expect(scanDomain('https://login.example-bank.com/qr')).toBe('example-bank.com');
    expect(scanDomain('https://login.example-bank.com.evil.com/qr')).toBe('evil.com');
    // No public suffix: the whole host, so the card never shortens it into something that looks like the bank.
    expect(scanDomain('https://login.example-bank.com.evil.test/qr')).toBe('login.example-bank.com.evil.test');
    expect(scanDomain('http://127.0.0.1:8080/challenge')).toBe('127.0.0.1');
    expect(scanDomain('chrome://settings')).toBeNull();
    expect(scanDomain(null)).toBeNull();
  });
});
