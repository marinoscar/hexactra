// A credential given in words is never a site fact (E46.39): "The password is hunter2-Secret-9931" is refused by `validateSiteFact`'s secret
// rule whatever the host binds, while a plain mention ("Sign-in asks for a one-time code") passes.
import { defaultSecretCheck, deriveSiteFacts, hasCredentialPhrase, type SiteTraceEvent, validateSiteFact } from '../src';

const REFUSED = [
  'The password is hunter2-Secret-9931',
  'password: hunter2',
  'Password = "correct horse"',
  'The passcode is 0042',
  'passphrase: blue-moon-river',
  'PIN: 4821',
  'The PIN is 4821',
  'Use PIN 4821 at the till',
  'use API key abc123def456',
  'API key: zz9plural',
  'the code is 551203',
  'Code: 551203',
  'The one-time code is 551203',
  'OTP 551203',
  'verification code: 778812',
  'The security answer is fluffy',
  'Security answer: "Rex"',
  'token: abcd-1234',
  'The secret is opensesame',
  'access token 9f8e7d6c',
];

const ALLOWED = [
  'Sign-in asks for a one-time code',
  'the PIN pad is at the bottom',
  'The password field is under Account, then Security',
  'The password is case-sensitive',
  'The password must be reset every 90 days',
  'The PIN is 4 digits',
  'Promo code SAVE2024 works at checkout',
  'Error code: 404 means the session expired',
  'A verification code is texted to the phone on file',
  'Invoices: Billing → History',
  'The security answer is asked after the password',
  'Secret Santa sign-ups are under Events',
  'The statements page loads slowly (about 12 s)',
  'A cookie banner appears on first visit',
];

const ok = { site: 'example.com', kind: 'sign_in', source: 'owner', evidence: {} };

describe('hasCredentialPhrase', () => {
  it.each(REFUSED)('refuses %j', (text) => {
    expect(hasCredentialPhrase(text)).toBe(true);
    expect(defaultSecretCheck.hasSecret(text)).toBe(true);
  });

  it.each(ALLOWED)('passes %j', (text) => {
    expect(hasCredentialPhrase(text)).toBe(false);
  });

  it('never throws on odd input and stays bounded', () => {
    expect(hasCredentialPhrase('' as string)).toBe(false);
    expect(hasCredentialPhrase(undefined as unknown as string)).toBe(false);
    const started = Date.now();
    expect(hasCredentialPhrase('password '.repeat(5_000))).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('validateSiteFact and credential phrases', () => {
  it.each(REFUSED)('a fact %j breaks the secret rule, with no echo of the text', (text) => {
    const v = validateSiteFact({ ...ok, text });
    expect(v.map((x) => x.rule)).toContain('secret');
    expect(JSON.stringify(v)).not.toContain(text);
  });

  it('refuses a credential phrase even when the host binds a check that sees nothing', () => {
    expect(validateSiteFact({ ...ok, text: 'The password is hunter2-Secret-9931' }, { secretCheck: { hasSecret: () => false } }).map((x) => x.rule)).toEqual(['secret']);
  });

  it.each(ALLOWED)('a fact %j passes', (text) => {
    expect(validateSiteFact({ ...ok, text })).toEqual([]);
  });

  it('the derived one-time-code sign-in fact still passes', () => {
    const events: SiteTraceEvent[] = [
      { seq: 1, tool: 'navigate', family: 'browser', commits: false, ok: true, outcome: 'ran', bindings: { url: { kind: 'literal', value: 'https://bank.co.uk/' } }, post: { host: 'bank.co.uk', path: '/' } },
      { seq: 2, tool: 'type_saved_code', family: 'browser', commits: false, ok: true, outcome: 'ran', bindings: {}, post: { host: 'bank.co.uk', path: '/login' } },
    ];
    expect(deriveSiteFacts({ runId: 'r', events }, { screens: [], elements: [] }).map((f) => f.text)).toContain('Sign-in asks for a one-time code');
  });
});
