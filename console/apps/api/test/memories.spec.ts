// Memories (#551), the pure parts: the Secret Material check, the request
// schemas (a body cannot set source, status, userId or the source ids) and
// the export file.
import { createMemorySchema, supersedeMemorySchema, updateMemorySchema } from '../src/memories/memories.schemas';
import { findMemorySecrets } from '../src/memories/memory-secrets';
import { buildMemoryFile, memoryFileName, memoryFileSchema } from '../src/memories/memory-transfer';

const refused = (attributes: Record<string, string>) => findMemorySecrets({ attributes });

describe('the memory secret check', () => {
  it.each([
    ['a password key', { password: 'hunter2' }, 'key'],
    ['a passcode key', { 'bank passcode': 'abc' }, 'key'],
    ['a PIN key', { PIN: '1234' }, 'key'],
    ['an OTP key', { otp: '123456' }, 'key'],
    ['a CVV key', { cvv: '123' }, 'key'],
    ['a security answer key', { 'security answer': 'Rex' }, 'key'],
    ['a token key', { token: 'abc' }, 'key'],
    ['a secret key', { secret: 'x' }, 'key'],
    ['a full card number', { card: '4242 4242 4242 4242' }, 'card'],
    ['a full card number without spaces', { number: '4111111111111111' }, 'card'],
    ['a 12-digit account number', { account: '123456789012' }, 'account'],
    ['a 12-digit number under any name', { number: '123456789012' }, 'digits'],
    ['a full SSN', { ssn: '123-45-6789' }, 'ssn'],
    ['an SSN in other words', { 'tax id': '123-45-6789' }, 'ssn'],
    ['a routing number', { routing: '011000015' }, 'routing'],
    ['an API key', { note: 'sk-proj-abcdefghijklmnop1234' }, 'token'],
  ])('refuses %s', (_name, attributes, reason) => {
    const hits = refused(attributes);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ field: Object.keys(attributes)[0], reason });
    expect(hits[0]!.message).toContain('last four digits');
  });

  it.each([
    ['an ending', { account: 'ending 0659' }],
    ['the last four', { last4: '0659' }],
    ['a phone number', { phone: '555-010-6020' }],
    ['an international phone number', { phone: '+44 20 7946 0958' }],
    ['a plain phone number', { phone: '5550106020' }],
    ['an email', { email: 'person.a@example.test' }],
    ['a name', { name: 'Person A', relation: 'wife' }],
    ['a bank name', { bank: 'Bank of Example', type: 'checking' }],
    ['a preference', { seat: 'aisle' }],
  ])('accepts %s', (_name, attributes) => {
    expect(refused(attributes)).toEqual([]);
  });

  it('checks the label, the aliases and the note too', () => {
    expect(findMemorySecrets({ label: 'Card 4242424242424242' })[0]).toMatchObject({ field: 'label', reason: 'card' });
    expect(findMemorySecrets({ aliases: ['123-45-6789'] })[0]).toMatchObject({ field: 'aliases' });
    expect(findMemorySecrets({ note: 'my ssn is 123-45-6789' })[0]).toMatchObject({ field: 'note', reason: 'ssn' });
    expect(findMemorySecrets({ label: 'My wife', aliases: ['wife'], note: 'Uses Zelle' })).toEqual([]);
  });

  it('names every failing attribute', () => {
    const hits = refused({ password: 'x', card: '4242424242424242', name: 'Person A' });
    expect(hits.map((h) => h.field)).toEqual(['password', 'card']);
  });
});

describe('the memory request schemas', () => {
  it('refuses a body that sets source, status, userId or the source ids', () => {
    for (const extra of [{ source: 'agent_proposed' }, { status: 'archived' }, { userId: '00000000-0000-4000-8000-000000000000' }, { sourceRunId: '00000000-0000-4000-8000-000000000000' }, { sourceConversationId: '00000000-0000-4000-8000-000000000000' }]) {
      expect(createMemorySchema.safeParse({ kind: 'person', label: 'My wife', ...extra }).success).toBe(false);
      expect(updateMemorySchema.safeParse({ label: 'x', ...extra }).success).toBe(false);
      expect(supersedeMemorySchema.safeParse({ attributes: { a: 'b' }, ...extra }).success).toBe(false);
    }
  });

  it('lower-cases and de-duplicates aliases and limits the attributes', () => {
    const ok = createMemorySchema.parse({ kind: 'person', label: ' My wife ', aliases: ['Wife', 'wife', 'Paula  Molina'], attributes: { name: 'Person A' } });
    expect(ok).toMatchObject({ label: 'My wife', aliases: ['wife', 'paula molina'] });
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v']));
    expect(createMemorySchema.safeParse({ kind: 'fact', label: 'x', attributes: many }).success).toBe(false);
    expect(createMemorySchema.safeParse({ kind: 'fact', label: 'x', attributes: { a: 'v'.repeat(501) } }).success).toBe(false);
    expect(createMemorySchema.safeParse({ kind: 'fact', label: 'x', aliases: Array.from({ length: 11 }, (_, i) => `a${i}`) }).success).toBe(false);
  });
});

describe('the memories export file', () => {
  const now = new Date('2026-11-18T12:00:00Z');
  const rows = [
    { kind: 'person', label: 'My wife', aliases: ['wife'], attributes: { name: 'Person A', phone: '555-010-6020' }, note: null, status: 'active', source: 'owner', lastUsedAt: null, createdAt: now },
    { kind: 'account', label: 'Checking', aliases: [], attributes: { ending: '0659' }, note: 'Main', status: 'archived', source: 'agent_proposed', lastUsedAt: now, createdAt: now },
    { kind: 'fact', label: 'Old', aliases: [], attributes: {}, note: null, status: 'superseded', source: 'owner', lastUsedAt: null, createdAt: now },
  ];

  it('validates, round-trips and holds no ids', () => {
    const file = buildMemoryFile(rows, now);
    const parsed = memoryFileSchema.parse(JSON.parse(JSON.stringify(file)));
    expect(parsed).toEqual(file);
    expect(file).toMatchObject({ kind: 'hexactra.memories', formatVersion: 1, exportedAt: now.toISOString() });
    expect(file.memories.map((m) => m.label)).toEqual(['My wife', 'Checking']);
    const text = JSON.stringify(file);
    expect(text).not.toMatch(/"(id|userId|sourceRunId|sourceConversationId|supersededById)"/);
    expect(memoryFileName(now)).toBe('hexactra-memories-20261118.json');
  });
});

describe('identity details (E37.6): a memory may name a saved item, never hold its number', () => {
  it('accepts a reference to a saved item by name and refuses the numbers an identity item holds', () => {
    expect(findMemorySecrets({ label: 'My passport', attributes: { saved_details: "Passport (in your secrets provider)", expires: 'March 2031' } })).toEqual([]);
    // A full ID or account number, an SSN and a long digit run are refused wherever they appear.
    expect(refused({ id: '123-45-6789' })).toHaveLength(1);
    expect(refused({ 'id number': '4111 1111 1111 1111' })).toHaveLength(1);
    expect(refused({ note: 'ID 123456789012' })).toHaveLength(1);
    // The last four are fine.
    expect(refused({ id: 'ending 6789' })).toEqual([]);
  });
});
