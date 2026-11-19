// The pure parts of mail triggers (E39.8, #605): the match rules (a sender is required, open mail domains are refused, the
// server's re-check), the input mapping (fixed, header, capture; hostile patterns), sender authentication parsing, the cursor and
// the poll spread. The poller against a real database is mail-triggers.db.spec.ts.
import { senderAuthFrom } from '../src/connections/mail-auth';
import { captureValue, capturePatternProblem, checkMailInputs, groupCount, mailInputsSchema, mapInputs, needsBody } from '../src/mail-triggers/mail-inputs';
import { isOwnMessage, mailMatchSchema, matchMessage, normalizeMatch, parseFromRule, readMatch, senderMatches, toMailQuery, type MailMatch } from '../src/mail-triggers/mail-match';
import { nextPollAfter, readCursor, writeCursor } from '../src/mail-triggers/mail-trigger.poller';
import type { TaskParameter } from '@app/shared/task-params';

const SINCE = new Date('2026-11-01T00:00:00Z');
const msg = (over: Record<string, unknown> = {}) => ({
  from: { address: 'billing@example.test', name: 'Billing' },
  to: [{ address: 'person-a@example.test', name: null }],
  subject: 'Your invoice is ready',
  hasAttachments: true,
  labels: ['INBOX'],
  date: '2026-11-02T10:00:00Z',
  ...over,
});

describe('the sender rule', () => {
  it('cannot be saved without a sender', () => {
    expect(mailMatchSchema.safeParse({}).success).toBe(false);
    expect(mailMatchSchema.safeParse({ from: [] }).success).toBe(false);
    expect(mailMatchSchema.safeParse({ from: [''] }).success).toBe(false);
    expect(mailMatchSchema.safeParse({ from: ['billing@example.test'] }).success).toBe(true);
  });

  it('takes an exact address or exactly one domain, and nothing that matches anyone', () => {
    for (const bad of ['*', '*@example.test', '@*.example.test', 'example', '@', 'not an address', '@gmail.com', 'outlook.com', '@Yahoo.com', 'a@b@c.test']) {
      expect(mailMatchSchema.safeParse({ from: [bad] }).success).toBe(false);
    }
    expect(parseFromRule('Person-A@Example.test')).toMatchObject({ ok: true, text: 'person-a@example.test' });
    expect(parseFromRule('example.test')).toMatchObject({ ok: true, text: '@example.test' });
    // An exact address at a free mail service is fine: it names one person.
    expect(parseFromRule('person-b@gmail.com')).toMatchObject({ ok: true, rule: { kind: 'address' } });
  });

  it('matches the address or the domain exactly, never a lookalike or a subdomain', () => {
    const from = ['billing@example.test', '@corp.example.test'];
    expect(senderMatches(from, 'Billing@Example.test')).toBe(true);
    expect(senderMatches(from, 'anyone@corp.example.test')).toBe(true);
    for (const no of ['xbilling@example.test', 'billing@example.test.evil.test', 'billing@evil-example.test', 'a@sub.corp.example.test', 'billing@example.testx', 'nobody', '', null]) expect(senderMatches(from, no)).toBe(false);
  });

  it('is canonical once normalised', () => {
    const m = mailMatchSchema.parse({ from: ['Billing@Example.test', 'billing@example.test', 'example.test'] });
    expect(normalizeMatch(m).from).toEqual(['billing@example.test', '@example.test']);
    expect(readMatch({ from: [] })).toBeNull();
    expect(readMatch(null)).toBeNull();
  });
});

describe('the re-check of a message', () => {
  const match = normalizeMatch(mailMatchSchema.parse({ from: ['billing@example.test'], subjectContains: 'invoice', hasAttachment: true }));

  it('passes a message that satisfies every rule', () => {
    expect(matchMessage(match, msg(), { activeSince: SINCE })).toEqual({ ok: true });
  });

  it.each([
    ['another sender', { from: { address: 'someone@example.test', name: 'Billing' } }, 'sender'],
    ['a display name that looks right', { from: { address: 'x@evil.test', name: 'billing@example.test' } }, 'sender'],
    ['another subject', { subject: 'Hello' }, 'subject'],
    ['no attachment', { hasAttachments: false }, 'attachment'],
    ['another folder', { labels: ['SPAM'] }, 'label'],
    ['mail from before the trigger was enabled', { date: '2026-10-31T23:59:00Z' }, 'before_active'],
    ['no date at all', { date: null }, 'before_active'],
  ])('refuses %s', (_n, over, reason) => {
    expect(matchMessage(match, msg(over), { activeSince: SINCE })).toEqual({ ok: false, reason });
  });

  it('needs the text for a text rule, and compares it case-insensitively', () => {
    const m = normalizeMatch(mailMatchSchema.parse({ from: ['billing@example.test'], textContains: 'Amount Due' }));
    expect(matchMessage(m, msg(), { activeSince: SINCE, text: null })).toEqual({ ok: false, reason: 'text' });
    expect(matchMessage(m, msg(), { activeSince: SINCE, text: 'the amount due is 5' })).toEqual({ ok: true });
  });

  it('recognises the account\'s own address', () => {
    expect(isOwnMessage({ from: { address: 'Person-A@example.test', name: null } }, 'person-a@example.test')).toBe(true);
    expect(isOwnMessage({ from: { address: 'billing@example.test', name: null } }, 'person-a@example.test')).toBe(false);
  });

  it('builds a provider query that is a hint: one sender only when there is exactly one rule', () => {
    expect(toMailQuery(match, '2026-11-02T00:00:00.000Z')).toMatchObject({ from: 'billing@example.test', subject: 'invoice', hasAttachment: true, label: 'INBOX', after: '2026-11-02T00:00:00.000Z' });
    const two = normalizeMatch({ ...match, from: ['a@example.test', 'b@example.test'] } as MailMatch);
    expect(toMailQuery(two, 'x').from).toBeUndefined();
  });
});

describe('input mapping', () => {
  const params: TaskParameter[] = [
    { key: 'invoice_number', label: 'Invoice number', type: 'text', required: true },
    { key: 'amount', label: 'Amount', type: 'money', required: true },
    { key: 'sender', label: 'Sender', type: 'email', required: false },
    { key: 'password', label: 'Password', type: 'text', required: true, sensitive: true },
  ];
  const facts = { subject: 'Invoice #INV-2041 is ready', from: 'billing@example.test', date: '2026-11-02T10:00:00Z', text: 'Total due: $25.50 by Friday.' };

  it('fills a fixed value, a header and a captured group', () => {
    const inputs = mailInputsSchema.parse({
      invoice_number: { capture: { source: 'subject', pattern: '#(INV-\\d+)' } },
      amount: { capture: { source: 'text', pattern: 'due: \\$(\\d+\\.\\d{2})' } },
      sender: { header: 'from' },
    });
    expect(needsBody(inputs)).toBe(true);
    expect(mapInputs(inputs, facts)).toEqual({ invoice_number: 'INV-2041', amount: '25.50', sender: 'billing@example.test' });
    expect(mapInputs({ amount: { fixed: '10' }, invoice_number: { header: 'subject' } }, facts)).toEqual({ amount: '10', invoice_number: 'Invoice #INV-2041 is ready' });
    expect(mapInputs({ invoice_number: { header: 'date' } }, facts)).toEqual({ invoice_number: '2026-11-02' });
  });

  it('gives no value when a pattern does not match (the run then waits on the form)', () => {
    expect(mapInputs({ amount: { capture: { source: 'text', pattern: 'owed: (\\d+)' } } }, facts)).toEqual({});
    expect(captureValue({ source: 'text', pattern: '(\\d+)' }, { ...facts, text: null })).toBeNull();
  });

  it('turns a multi-line capture into one line and cuts it', () => {
    expect(captureValue({ source: 'text', pattern: '(Total[\\s\\S]*?Friday)' }, { ...facts, text: 'Total\n due:\r\n 5 by Friday' })).toBe('Total due: 5 by Friday');
    expect(captureValue({ source: 'text', pattern: '(a+)' }, { ...facts, text: 'a'.repeat(900) })!.length).toBe(500);
  });

  it('counts the groups of a pattern', () => {
    expect(groupCount('(a)(b)')).toBe(2);
    expect(groupCount('(?:a)(b)')).toBe(1);
    expect(groupCount('\\(a\\)')).toBe(0);
    expect(groupCount('[(]a(b)')).toBe(1);
    expect(groupCount('(?<n>a)')).toBe(1);
    expect(groupCount('(?=a)b(c)')).toBe(1);
  });

  it('rejects an unsafe, invalid or group-less pattern', () => {
    for (const bad of ['(a+)+', '(\\d*)*x', '(a)\\1', '(', 'no group', '(a)(b)', '']) expect(capturePatternProblem(bad)).not.toBeNull();
    expect(capturePatternProblem('INV-(\\d+)')).toBeNull();
    // A hostile pattern is refused at save, and never runs even if it got stored.
    const bad = checkMailInputs(params, { amount: { capture: { source: 'text', pattern: '(a+)+$' } } });
    expect(bad.issues).toEqual([{ key: 'amount', message: expect.stringContaining('nested quantifiers') }]);
    expect(captureValue({ source: 'text', pattern: '(a+)+$' }, { ...facts, text: `${'a'.repeat(60)}!` })).toBeNull();
  });

  it('is checked against the task: unknown keys, sensitive parameters and fixed values that fail their rules', () => {
    const r = checkMailInputs(params, { nope: { fixed: 'x' }, password: { fixed: 'x' }, amount: { fixed: 'twenty' }, invoice_number: { fixed: 'A-1' }, sender: { header: 'from' } });
    expect(r.issues.map((i) => i.key).sort()).toEqual(['amount', 'nope', 'password']);
    expect(r.inputs).toEqual({ invoice_number: { fixed: 'A-1' }, sender: { header: 'from' } });
    expect(checkMailInputs(params, null)).toEqual({ inputs: null, issues: [] });
  });
});

describe('sender authentication', () => {
  const h = (rest: string) => `mx.example.test; ${rest}`;
  it('passes when DMARC, or an aligned DKIM or SPF, passed', () => {
    expect(senderAuthFrom(h('dkim=pass header.i=@example.test header.s=s1; spf=pass smtp.mailfrom=billing@example.test; dmarc=pass (p=NONE) header.from=example.test'), 'billing@example.test')).toBe('pass');
    expect(senderAuthFrom(h('dkim=pass header.d=mail.example.test'), 'billing@example.test')).toBe('pass');
    expect(senderAuthFrom(h('spf=pass smtp.mailfrom=bounce@example.test'), 'billing@example.test')).toBe('pass');
  });
  it('fails on a DMARC failure, or a failure with nothing aligned that passed', () => {
    expect(senderAuthFrom(h('dmarc=fail header.from=example.test'), 'billing@example.test')).toBe('fail');
    expect(senderAuthFrom(h('spf=softfail smtp.mailfrom=billing@example.test; dkim=none'), 'billing@example.test')).toBe('fail');
    expect(senderAuthFrom(h('dkim=fail header.d=example.test'), 'billing@example.test')).toBe('fail');
  });
  it('does not count a pass for another domain as a pass for the From domain', () => {
    expect(senderAuthFrom(h('dkim=pass header.d=evil.test; spf=pass smtp.mailfrom=x@evil.test'), 'billing@example.test')).toBe('unknown');
    expect(senderAuthFrom(h('dkim=pass header.d=evil.test; spf=fail smtp.mailfrom=billing@example.test'), 'billing@example.test')).toBe('fail');
  });
  it('is unknown with no header, no result or no From', () => {
    expect(senderAuthFrom(undefined, 'a@example.test')).toBe('unknown');
    expect(senderAuthFrom('mx.example.test; none', 'a@example.test')).toBe('unknown');
    expect(senderAuthFrom(h('dmarc=pass'), null)).toBe('unknown');
  });
  it('trusts only the topmost header, and only a trusted server\'s when asked', () => {
    const own = h('dmarc=fail header.from=example.test');
    const forged = 'attacker.test; dmarc=pass header.from=example.test';
    expect(senderAuthFrom([own, forged], 'a@example.test')).toBe('fail');
    expect(senderAuthFrom([forged, own], 'a@example.test', { trusted: (id) => id.endsWith('.example.test') })).toBe('unknown');
    expect(senderAuthFrom([own, forged], 'a@example.test', { trusted: (id) => id.endsWith('.example.test') })).toBe('fail');
  });
  it('ignores a result written inside a comment', () => {
    expect(senderAuthFrom(h('dkim=none (dmarc=pass; spf=pass smtp.mailfrom=a@example.test)'), 'a@example.test')).toBe('unknown');
  });
});

describe('the cursor and the poll spread', () => {
  it('round-trips an instant and refuses anything else', () => {
    const d = new Date('2026-11-02T10:00:00.000Z');
    expect(writeCursor(d)).toBe('t1:2026-11-02T10:00:00.000Z');
    expect(readCursor(writeCursor(d))?.toISOString()).toBe(d.toISOString());
    for (const bad of [null, undefined, '', 'abc', 't1:nonsense', '2026-11-02T10:00:00.000Z']) expect(readCursor(bad)).toBeNull();
  });
  it('spreads triggers over the interval with a fixed offset per trigger', () => {
    const now = new Date('2026-11-02T10:00:00Z');
    const a = nextPollAfter(now, { id: '00000a00-0000-4000-8000-000000000000', pollSeconds: 300 });
    const b = nextPollAfter(now, { id: 'ffffff00-0000-4000-8000-000000000000', pollSeconds: 300 });
    expect(a.getTime()).toBeGreaterThanOrEqual(now.getTime() + 300_000);
    expect(b.getTime()).toBeLessThan(now.getTime() + 300_000 + 30_000);
    expect(a.getTime()).not.toBe(b.getTime());
  });
});
