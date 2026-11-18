// The masking module (E35.3, #538): the pattern table of
// @app/shared/sensitive-patterns, applied by maskSensitive/maskValue
// (src/tasks/mask.ts). Table-driven cases per pattern, the false-positive
// guards, the passthroughs, idempotence and the time bound; and the "What is
// masked" table of docs/runs.md, generated from the pattern table:
//
//   UPDATE_MASK_DOCS=1 npx jest --config ./test/jest.config.js mask
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CONSOLE_TOKEN_PREFIXES as SHARED_PREFIXES,
  REDACTED_TOKEN as SHARED_REDACTED,
  SENSITIVE_PATTERNS,
  SENSITIVE_PATTERN_IDS,
  aba,
  luhn,
  maskText,
  mod97,
  type PatternId,
} from '@app/shared/sensitive-patterns';

import { CONSOLE_TOKEN_PREFIXES, REDACTED_TOKEN } from '../src/mcp/mcp.redact';
import { maskSensitive, maskValue } from '../src/tasks/mask';

const DOC = join(__dirname, '..', '..', '..', 'docs', 'runs.md');
const START = '<!-- masked-patterns:start -->';
const END = '<!-- masked-patterns:end -->';
const UPDATE = process.env.UPDATE_MASK_DOCS === '1';

/** [input, expected output] — the pattern under test must hit at least once. */
type Positive = [string, string];

const POSITIVE: Record<PatternId, Positive[]> = {
  card: [
    ['Card 4242424242424242 saved', 'Card •••• 4242 saved'],
    ['4111 1111 1111 1111', '•••• 1111'],
    ['paid with 5555-5555-5555-4444.', 'paid with •••• 4444.'],
    ['Amex 378282246310005', 'Amex •••• 0005'],
    ['Amex 3782 822463 10005', 'Amex •••• 0005'],
    ['Discover: 6011111111111117', 'Discover: •••• 1117'],
  ],
  iban: [
    ['IBAN GB82WEST12345698765432', 'IBAN GB•• •••• 5432'],
    ['GB82 WEST 1234 5698 7654 32', 'GB•• •••• 5432'],
    ['to DE89370400440532013000.', 'to DE•• •••• 3000.'],
    ['FR1420041010050500013M02606', 'FR•• •••• 2606'],
    ['NL91ABNA0417164300', 'NL•• •••• 4300'],
    ['ES91 2100 0418 4502 0005 1332', 'ES•• •••• 1332'],
  ],
  ssn: [
    ['SSN 123-45-6789', 'SSN •••-••-6789'],
    ['ssn: 123456789', 'ssn: •••-••-6789'],
    ['her number is 078-05-1120.', 'her number is •••-••-1120.'],
    ['Social Security Number: 219099999', 'Social Security Number: •••-••-9999'],
    ['Social Security #: 123-45-6789', 'Social Security #: •••-••-6789'],
  ],
  routing: [
    ['routing 021000021', 'routing •••••0021'],
    ['Routing number: 011000015', 'Routing number: •••••0015'],
    ['ABA 026009593', 'ABA •••••9593'],
    ['RTN: 121000358', 'RTN: •••••0358'],
    ['Bank routing #: 322271627', 'Bank routing #: •••••1627'],
  ],
  account: [
    ['account 12345678', 'account ••••5678'],
    ['Acct: 000123456789', 'Acct: ••••6789'],
    ['checking 987654', 'checking ••••7654'],
    ['Savings account no. 1234567890123', 'Savings account no. ••••0123'],
    ['Acct # 12345678', 'Acct # ••••5678'],
    ['Order #1234567 shipped', 'Order #••••4567 shipped'],
  ],
  digits: [
    ['ref 987654321', 'ref ••••4321'],
    ['id 1234567890123', 'id ••••0123'],
    ['code 123456789012345678901234567890', 'code ••••7890'],
    ['Ref.123456789', 'Ref.••••6789'],
    ['1234567890', '••••7890'],
    ['card 4242424242424241 (bad check)', 'card ••••4241 (bad check)'],
  ],
  email: [
    ['olivia@example.test', 'o•••@example.test'],
    ['o.reilly+news@mail.example.co.uk', 'o•••@mail.example.co.uk'],
    ['A@b.io', 'A•••@b.io'],
    ['from first_last@sub.domain.org today', 'from f•••@sub.domain.org today'],
    ['contact: person.a@example.test.', 'contact: p•••@example.test.'],
  ],
  phone: [
    ['Call (555) 123-4567', 'Call •••-•••-4567'],
    ['555-123-4567', '•••-•••-4567'],
    ['555.123.4567', '•••-•••-4567'],
    ['+1 555 123 4567', '•••-•••-4567'],
    ['+44 20 7946 0958', '•••-•••-0958'],
    ['tel +33 1 23 45 67 89.', 'tel •••-•••-6789.'],
  ],
  token: [
    ['pat_abcdefghijklmnop1234', REDACTED_TOKEN],
    ['Authorization: Bearer abc.def.ghi12345', `Authorization: ${REDACTED_TOKEN}`],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl', REDACTED_TOKEN],
    ['key sk-proj-abc123def456ghi789', `key ${REDACTED_TOKEN}`],
    ['key-0123456789abcdef0123', REDACTED_TOKEN],
    ['AKIAABCDEFGHIJ012345 leaked', `${REDACTED_TOKEN} leaked`],
  ],
  urlSecret: [
    ['https://x.test/a/b?token=1&x=2', 'https://x.test/a/b (query removed)'],
    ['see https://bank.example.test/login#access=abc.', 'see https://bank.example.test/login (query removed).'],
    ['http://example.test/?q=1', 'http://example.test/ (query removed)'],
    ['(https://example.test/cb?code=abc)', '(https://example.test/cb (query removed))'],
    ['"https://a.example.test/p/q?x=y"', '"https://a.example.test/p/q (query removed)"'],
  ],
};

/** Inputs the pattern under test must not hit. */
const NEGATIVE: Record<PatternId, string[]> = {
  card: ['4242424242424241', '2026-11-18', '4242 4242', '1234567812345678', '12345678-1234-1234-1234-123456789012', '0.4242424242424242'],
  iban: ['GB82WEST12345698765433', 'GB82 WEST', 'gb82west12345698765432', 'AB12CDEF', 'XGB82WEST12345698765432'],
  ssn: ['000-12-3456', '666-12-3456', '900-12-3456', '123-00-4567', '123-45-0000', '2026-11-18', 'id 123456789'],
  routing: ['routing 123456789', '021000021', 'routing 02100002', 'routing 0210000210', 'aba\n021000021'],
  account: ['account ending 0659', 'account 12345', 'Savings 123456.78', 'step #12', 'account\n12345678', '&#123456;'],
  digits: ['12345678', '550e8400-e29b-41d4-a716-446655440000', '3.14159265358979', '$1,234,567,890.00', 'abc123456789', 'item-123456789'],
  email: ['icon@2x.png', '@marinoscar/platform-api', 'user@localhost', 'no at sign', 'a@b', 'o•••@gmail.com'],
  phone: ['10:45:30', '2026-11-18', '11/18/2026', '$1,234,567.00', '555-1234', '+1 5', '192.168.100.1'],
  token: ['pat_holder_name_field', 'Bearer responsibility', 'key-value-pair-container', 'sk-learn', '#peerpayHome', 'eyJ'],
  urlSecret: ['https://x.test/a/b', 'https://x.test/?', 'not a url?x=1', 'ftp://x.test/?a=1', 'https://x.test/path (query removed)'],
};

/** Text no pattern may touch (the issue's false-positive guards). */
const UNCHANGED = [
  '2026-11-18',
  '11/18/2026',
  '2026-11-18T10:45:30.123Z',
  '10:45',
  '10:45:30',
  '$1,234,567.00',
  '€ 1.234.567,00',
  'Step 12 of 40',
  'step #3',
  '#peerpayHome',
  'pat_holder_name_field',
  'div.card > #account-number input[name="acct"]',
  '550e8400-e29b-41d4-a716-446655440000',
  'run 3f1c2a9e-0b7d-4c55-9e7a-1d2b3c4d5e6f',
  '1920px',
  'width: 1280px; height: 720px',
  '1920x1080',
  'v1.2.3',
  'phone ending 6020',
  'checking ending 0659',
  'card ending in 4242',
  'account ending in 0659',
  'acct ending 0659',
  'Balance $12,345.67',
  'Jane Doe, 1 Main Street, Springfield',
];

describe('sensitive patterns (#538)', () => {
  it('has the ten ids in a fixed order, a version, and a check where the issue names one', () => {
    expect([...SENSITIVE_PATTERN_IDS]).toEqual(['token', 'urlSecret', 'email', 'iban', 'card', 'ssn', 'routing', 'account', 'phone', 'digits']);
    expect(Object.fromEntries(SENSITIVE_PATTERNS.map((p) => [p.id, p.check]))).toEqual({
      token: null, urlSecret: null, email: null, iban: 'mod97', card: 'luhn', ssn: null, routing: 'aba', account: null, phone: null, digits: null,
    });
    for (const p of SENSITIVE_PATTERNS) expect([p.id, p.flags.includes('g')]).toEqual([p.id, true]);
  });

  it('bounds every quantifier (no *, + or open-ended {n,})', () => {
    for (const p of SENSITIVE_PATTERNS) {
      // Strip escapes and character classes, then look for unbounded quantifiers.
      const bare = p.source.replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
      expect([p.id, /[*+]|\{\d+,\}/.test(bare)]).toEqual([p.id, false]);
    }
  });

  it('shares the console token prefixes and redaction text with mcp.redact.ts', () => {
    expect([...SHARED_PREFIXES]).toEqual([...CONSOLE_TOKEN_PREFIXES]);
    expect(SHARED_REDACTED).toBe(REDACTED_TOKEN);
  });

  it('checks: Luhn, mod 97, ABA', () => {
    expect(luhn('4242 4242 4242 4242')).toBe(true);
    expect(luhn('4242424242424241')).toBe(false);
    expect(mod97('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(mod97('GB82WEST12345698765433')).toBe(false);
    expect(aba('021000021')).toBe(true);
    expect(aba('123456789')).toBe(false);
  });

  describe.each(SENSITIVE_PATTERN_IDS.map((id) => [id]))('%s', (id) => {
    it('has at least five positive and five negative cases', () => {
      expect(POSITIVE[id].length).toBeGreaterThanOrEqual(5);
      expect(NEGATIVE[id].length).toBeGreaterThanOrEqual(5);
    });

    it.each(POSITIVE[id])('masks %j', (input, expected) => {
      const r = maskSensitive(input);
      expect(r.text).toBe(expected);
      expect(r.hits[id]).toBeGreaterThanOrEqual(1);
    });

    it.each(NEGATIVE[id].map((s) => [s]))('does not match %j', (input) => {
      expect(maskSensitive(input).hits[id]).toBe(0);
    });
  });

  it.each(UNCHANGED.map((s) => [s]))('leaves %j unchanged', (input) => {
    const r = maskSensitive(input);
    expect(r.text).toBe(input);
    expect(Object.values(r.hits).every((n) => n === 0)).toBe(true);
  });

  it('a 9-digit number with no banking word that fails the ABA check is masked by digits only', () => {
    const r = maskSensitive('reference 123456789 here');
    expect(r.text).toBe('reference ••••6789 here');
    expect(r.hits).toEqual({ token: 0, urlSecret: 0, email: 0, iban: 0, card: 0, ssn: 0, routing: 0, account: 0, phone: 0, digits: 1 });
  });

  it('a 9-digit number passing ABA with no banking word nearby is digits, not routing', () => {
    expect(maskSensitive('021000021').hits).toMatchObject({ routing: 0, digits: 1 });
  });

  it('is idempotent and deterministic on every case', () => {
    const all = [...Object.values(POSITIVE).flat().map(([i]) => i), ...Object.values(NEGATIVE).flat(), ...UNCHANGED];
    for (const s of all) {
      const once = maskSensitive(s);
      const twice = maskSensitive(once.text);
      expect([s, twice.text]).toEqual([s, once.text]);
      expect(Object.values(twice.hits).every((n) => n === 0)).toBe(true);
      expect(maskSensitive(s)).toEqual(once);
    }
  });

  it('the shared maskText (web, extension) agrees with the API on every case', () => {
    const all = [...Object.values(POSITIVE).flat().map(([i]) => i), ...Object.values(NEGATIVE).flat(), ...UNCHANGED];
    for (const s of all) expect([s, maskText(s)]).toEqual([s, maskSensitive(s)]);
  });

  it('counts each match once and masks several in one string', () => {
    const r = maskSensitive('Pay 4242 4242 4242 4242 from account 12345678 and mail olivia@example.test or call 555-123-4567.');
    expect(r.text).toBe('Pay •••• 4242 from account ••••5678 and mail o•••@example.test or call •••-•••-4567.');
    expect(r.hits).toMatchObject({ card: 1, account: 1, email: 1, phone: 1, digits: 0 });
  });

  describe('maskValue', () => {
    it('keeps shape and key names, masks strings at any depth and sums the hits', () => {
      const input = {
        goal: 'Pay card 4242424242424242',
        'account 12345678': 'key unchanged',
        steps: [{ n: 1, summary: 'mail olivia@example.test' }, { n: 2, summary: 'ok', at: null, done: true }],
        nested: { deep: ['ref 987654321', 42] },
      };
      const r = maskValue(input);
      expect(r.value).toEqual({
        goal: 'Pay card •••• 4242',
        'account 12345678': 'key unchanged',
        steps: [{ n: 1, summary: 'mail o•••@example.test' }, { n: 2, summary: 'ok', at: null, done: true }],
        nested: { deep: ['ref ••••4321', 42] },
      });
      expect(r.hits).toMatchObject({ card: 1, email: 1, digits: 1 });
      expect(input.goal).toBe('Pay card 4242424242424242');
    });

    it('passes non-strings through and is idempotent', () => {
      const d = new Date(0);
      expect(maskValue(7).value).toBe(7);
      expect(maskValue(null).value).toBeNull();
      expect(maskValue(d).value).toBe(d);
      const once = maskValue({ a: ['SSN 123-45-6789'] });
      expect(maskValue(once.value).value).toEqual(once.value);
      expect(Object.values(maskValue(once.value).hits).every((n) => n === 0)).toBe(true);
    });
  });

  it('masks 100 kB in under 50 ms, also on hostile input', () => {
    const sample = 'Paid 4242 4242 4242 4242 to GB82 WEST 1234 5698 7654 32, routing 021000021 account 12345678, mail olivia@example.test, call (555) 123-4567, see https://x.test/a?t=1 2026-11-18 $1,234.00 #peerpayHome ';
    const inputs = [
      sample.repeat(Math.ceil(100_000 / sample.length)).slice(0, 100_000),
      '1'.repeat(100_000),
      '1 '.repeat(50_000),
      '1-'.repeat(50_000),
      'a'.repeat(100_000),
      'a.'.repeat(50_000),
      `${'a'.repeat(99_000)}@${'b.'.repeat(500)}`,
      'account '.repeat(12_500),
      '+1 '.repeat(33_000),
      'https://x.test/'.repeat(6_000),
      'GB82 '.repeat(20_000),
      'Bearer '.repeat(14_000),
    ];
    for (const input of inputs) {
      maskSensitive(input.slice(0, 1000)); // warm up
      const t = process.hrtime.bigint();
      maskSensitive(input);
      const ms = Number(process.hrtime.bigint() - t) / 1e6;
      expect([input.slice(0, 20), ms < 50]).toEqual([input.slice(0, 20), true]);
    }
  });
});

/** The "What is masked" table of docs/runs.md, from the pattern table. */
function maskedTable(): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|');
  const rows = SENSITIVE_PATTERNS.map((p, i) => `| ${i + 1} | \`${p.id}\` | ${cell(p.description)} | ${p.check ? `\`${p.check}\`` : '—'} | \`${p.shownAs}\` |`);
  return ['| Order | Pattern | What matches | Check | Shown as |', '|---|---|---|---|---|', ...rows].join('\n');
}

describe('docs/runs.md, "What is masked" (#538)', () => {
  it('is generated from the pattern table (UPDATE_MASK_DOCS=1 rewrites it)', () => {
    const doc = readFileSync(DOC, 'utf8');
    const a = doc.indexOf(START);
    const b = doc.indexOf(END);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    const block = `${START}\n${maskedTable()}\n${END}`;
    if (UPDATE) writeFileSync(DOC, doc.slice(0, a) + block + doc.slice(b + END.length));
    else expect(doc.slice(a, b + END.length)).toBe(block);
  });
});
