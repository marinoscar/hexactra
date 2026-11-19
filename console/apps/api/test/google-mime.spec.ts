// The RFC 5322 composer, the Gmail query builder, the Google scopes and the incoming-mail readers (E39.3, #601).
import { CapabilityError, type OutgoingMail } from '../src/connections/capabilities';
import { buildGmailQuery, quoteTerm, quoteWords } from '../src/connections/google/gmail-query';
import { composeMessage, encodeWords, formatAddress } from '../src/connections/google/mime';
import { decodeMimeWords, htmlToText, parseAddressList } from '../src/connections/google/mime-parse';
import { capabilitiesFromScopes, capabilityScopes, scopesForCapabilities, SCOPE } from '../src/connections/google/google.scopes';
import { CAPABILITIES } from '../src/connections/connections.constants';

const base: OutgoingMail = { to: [{ address: 'person-b@example.test' }], subject: 'Hello', text: 'Plain body' };
const compose = (m: Partial<OutgoingMail> = {}, o: Parameters<typeof composeMessage>[1] = { from: 'person-a@example.test' }) => composeMessage({ ...base, ...m }, o);
const code = (fn: () => unknown): string => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return e instanceof CapabilityError ? e.code : 'other';
  }
};

describe('the mail composer', () => {
  it('writes the headers, a base64 UTF-8 body and the account as From', () => {
    const mime = compose({}, { from: 'person-a@example.test', date: new Date('2026-03-02T09:00:00Z') });
    expect(mime).toContain('From: person-a@example.test\r\n');
    expect(mime).toContain('To: person-b@example.test\r\n');
    expect(mime).toContain('Subject: Hello\r\n');
    expect(mime).toContain('Date: Mon, 02 Mar 2026 09:00:00 +0000\r\n');
    expect(mime).toContain('MIME-Version: 1.0\r\n');
    expect(mime).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(mime.split('\r\n\r\n')[1]).toBe(Buffer.from('Plain body').toString('base64'));
    expect(mime).not.toMatch(/[^\r]\n/); // CRLF only
  });

  it('encodes a UTF-8 subject and display name as RFC 2047 words, none longer than 75 characters', () => {
    const subject = 'Reunión de Año Nuevo: 日本語のテスト and a long tail '.repeat(4);
    const mime = compose({ subject, to: [{ address: 'person-b@example.test', name: 'Zoë Ñandú' }] });
    const head = mime.split('\r\n\r\n')[0]!;
    expect(head).toContain('=?UTF-8?B?');
    for (const w of head.match(/=\?UTF-8\?B\?[^?]+\?=/g) ?? []) expect(w.length).toBeLessThanOrEqual(75);
    const decoded = decodeMimeWords(head.split('Subject: ')[1]!.split('\r\nDate:')[0]!.replace(/\r\n /g, ' '));
    expect(decoded).toBe(subject);
    expect(decodeMimeWords(head.split('To: ')[1]!.split('\r\n')[0]!)).toBe('Zoë Ñandú <person-b@example.test>');
    for (const line of head.split('\r\n')) expect(line.length).toBeLessThanOrEqual(998);
  });

  it('sends plain and HTML as alternatives', () => {
    const mime = compose({ html: '<p>Hi <b>there</b></p>' });
    expect(mime).toMatch(/Content-Type: multipart\/alternative; boundary="=_hx_[0-9a-f]+"/);
    expect(mime).toContain('text/plain; charset=UTF-8');
    expect(mime).toContain('text/html; charset=UTF-8');
    const htmlOnly = compose({ text: undefined, html: '<p>x</p>' });
    expect(htmlOnly).toContain('Content-Type: text/html; charset=UTF-8');
    expect(htmlOnly).not.toContain('multipart');
  });

  it('attaches files as multipart/mixed with the name encoded for non-ASCII', () => {
    const mime = compose({ html: '<p>x</p>', attachments: [{ filename: 'report.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-1.4 x') }, { filename: 'Resumé.txt', contentType: 'text/plain', bytes: Buffer.from('é') }] });
    expect(mime).toMatch(/Content-Type: multipart\/mixed; boundary=/);
    expect(mime).toContain('Content-Disposition: attachment; filename="report.pdf"');
    expect(mime).toContain("filename*=UTF-8''Resum%C3%A9.txt");
    expect(mime).toContain(Buffer.from('%PDF-1.4 x').toString('base64'));
    expect(mime).toContain('multipart/alternative');
  });

  it('threads a reply with In-Reply-To and References and drops anything malformed', () => {
    const mime = compose({}, { from: 'person-a@example.test', reply: { messageId: '<orig@example.test>', references: '<a@example.test> <b@example.test>' } });
    expect(mime).toContain('In-Reply-To: <orig@example.test>\r\n');
    expect(mime).toContain('References: <a@example.test> <b@example.test> <orig@example.test>\r\n');
    const hostile = compose({}, { from: 'person-a@example.test', reply: { messageId: '<x@example.test>\r\nBcc: attacker@example.test', references: '<ok@example.test> junk\r\nBcc: z@example.test' } });
    expect(hostile).not.toContain('In-Reply-To');
    expect(hostile).not.toMatch(/\r\nBcc:/);
  });

  it('makes header injection impossible: a line break in a subject, a name, an address or a file name is refused', () => {
    expect(code(() => compose({ subject: 'Hi\r\nBcc: attacker@example.test' }))).toBe('INVALID_INPUT');
    expect(code(() => compose({ subject: 'Hi\nBcc: attacker@example.test' }))).toBe('INVALID_INPUT');
    expect(code(() => compose({ subject: 'Hi Bcc: x' }))).toBe('INVALID_INPUT');
    expect(code(() => compose({ to: [{ address: 'person-b@example.test', name: 'P\r\nBcc: attacker@example.test' }] }))).toBe('INVALID_INPUT');
    expect(code(() => compose({ to: [{ address: 'person-b@example.test\r\nBcc: attacker@example.test' }] }))).toBe('INVALID_INPUT');
    expect(code(() => compose({ cc: [{ address: 'a@example.test, attacker@example.test' }] }))).toBe('INVALID_INPUT');
    expect(code(() => compose({ to: [{ address: 'Person B <person-b@example.test>' }] }))).toBe('INVALID_INPUT');
    expect(code(() => compose({ attachments: [{ filename: 'a\r\nX: y.txt', contentType: 'text/plain', bytes: Buffer.from('x') }] }))).toBe('INVALID_INPUT');
    expect(code(() => compose({ attachments: [{ filename: 'a.txt', contentType: 'text/plain\r\nX: y', bytes: Buffer.from('x') }] }))).toBe('INVALID_INPUT');
    expect(code(() => compose({}, { from: 'person-a@example.test\r\nBcc: x@example.test' }))).toBe('INVALID_INPUT');
    expect(code(() => compose({ subject: 'tab\tis fine' }))).toBe('ok');
  });

  it('a body can neither form a header nor a boundary', () => {
    const mime = compose({ text: 'line\r\nBcc: attacker@example.test\r\n--=_hx_abc' });
    expect(mime.split('\r\n\r\n')[0]).not.toContain('attacker');
    expect(mime).not.toContain('attacker@example.test');
  });

  it('quotes a display name that needs it', () => {
    expect(formatAddress({ address: 'person-b@example.test', name: 'Person B' }, 'to')).toBe('Person B <person-b@example.test>');
    expect(formatAddress({ address: 'person-b@example.test', name: 'B, Person "PB"' }, 'to')).toBe('"B, Person \\"PB\\"" <person-b@example.test>');
    expect(encodeWords('x'.repeat(200)).split('\r\n ').every((w) => w.length <= 75)).toBe(true);
  });
});

describe('MailQuery to a Gmail query', () => {
  it('quotes every value and removes what could end the quote', () => {
    expect(quoteTerm('Person B')).toBe('"Person B"');
    expect(quoteTerm('say "hi" \\ there')).toBe('"say hi there"');
    expect(quoteTerm('line\nbreak')).toBe('"line break"');
    expect(quoteTerm('   ')).toBeNull();
    expect(quoteWords('invoice OR -spam label:x')).toEqual(['"invoice"', '"OR"', '"-spam"', '"label:x"']);
  });

  it('treats a value containing query operators as text', () => {
    const hostile = 'x" OR in:anywhere -in:trash from:(boss@example.test) {a b}';
    const { q } = buildGmailQuery({ subject: hostile, text: hostile });
    expect(q).toBe('subject:"x OR in:anywhere -in:trash from:(boss@example.test) {a b}" "x" "OR" "in:anywhere" "-in:trash" "from:(boss@example.test)" "{a" "b}"');
    // every character that is not inside a quoted term is part of the builder's own grammar
    expect(q!.replace(/"[^"]*"/g, '').replace(/\s+/g, ' ').trim()).toBe('subject:');
    expect(buildGmailQuery({ from: 'a"b' }).q).toBe('from:"a b"');
  });

  it('builds the structured fields, epoch dates, flags and a label id apart from the query', () => {
    const r = buildGmailQuery({ from: 'person-b@example.test', to: 'person-a@example.test', subject: 'Invoice', text: 'march total', after: '2026-03-01T00:00:00Z', before: '2026-03-31T00:00:00Z', unread: true, hasAttachment: false, label: 'Label_1' });
    expect(r.q).toBe('from:"person-b@example.test" to:"person-a@example.test" subject:"Invoice" "march" "total" after:1772323200 before:1774915200 is:unread -has:attachment');
    expect(r.labelIds).toEqual(['Label_1']);
    expect(buildGmailQuery({}).q).toBeUndefined();
    expect(buildGmailQuery({ unread: false, hasAttachment: true }).q).toBe('is:read has:attachment');
  });
});

describe('Google scopes (the decision record)', () => {
  it('asks exactly the permissions of the switched-on capabilities, plus the identity scopes', () => {
    expect(scopesForCapabilities(['mail_read'])).toEqual(['openid', 'email', 'profile', SCOPE.gmailRead]);
    expect(scopesForCapabilities(['mail_read', 'mail_send'])).toEqual(['openid', 'email', 'profile', SCOPE.gmailRead, SCOPE.gmailSend]);
    expect(capabilityScopes(['calendar_read'])).toEqual([SCOPE.calendarRead]);
    expect(capabilityScopes(['calendar_read', 'calendar_write'])).toEqual([SCOPE.calendarRead, SCOPE.calendarEvents]);
    expect(capabilityScopes(['docs_read'])).toEqual([SCOPE.driveFile, SCOPE.documentsRead, SCOPE.sheetsRead]);
    expect(capabilityScopes(['docs_read', 'docs_write'])).toEqual([SCOPE.driveFile, SCOPE.documents, SCOPE.sheets]);
  });

  it('modify subsumes read: asking for both asks only gmail.modify', () => {
    expect(capabilityScopes(['mail_read', 'mail_modify'])).toEqual([SCOPE.gmailModify]);
  });

  it('reads the granted scopes back into capabilities, and a missing scope leaves its capability off', () => {
    const all = CAPABILITIES.flatMap((c) => capabilityScopes([c]));
    expect(capabilitiesFromScopes(all)).toEqual([...CAPABILITIES]);
    expect(capabilitiesFromScopes([SCOPE.gmailRead, SCOPE.calendarEvents])).toEqual(['mail_read', 'calendar_write']);
    expect(capabilitiesFromScopes([SCOPE.driveFile, SCOPE.documents, SCOPE.sheetsRead])).toEqual(['docs_read']);
    expect(capabilitiesFromScopes([SCOPE.gmailModify])).toEqual(['mail_read', 'mail_modify']);
    expect(capabilitiesFromScopes(['openid', 'email'])).toEqual([]);
  });
});

describe('reading incoming mail', () => {
  it('decodes encoded words in headers', () => {
    expect(decodeMimeWords('=?UTF-8?B?UmV1bmnDs24=?=')).toBe('Reunión');
    expect(decodeMimeWords('=?ISO-8859-1?Q?Caf=E9_cr=E8me?=')).toBe('Café crème');
    expect(decodeMimeWords('=?UTF-8?B?w6k=?= =?UTF-8?B?w6k=?=')).toBe('éé');
  });

  it('parses address lists with names, quotes, commas in names and junk', () => {
    expect(parseAddressList('Person B <person-b@example.test>, "Doe, Person" <person-c@example.test>, person-d@example.test, undisclosed-recipients:;, <>')).toEqual([
      { address: 'person-b@example.test', name: 'Person B' },
      { address: 'person-c@example.test', name: 'Doe, Person' },
      { address: 'person-d@example.test', name: null },
    ]);
    expect(parseAddressList('=?UTF-8?B?Wm/Dqw==?= <person-e@example.test>')[0]!.name).toBe('Zoë');
    expect(parseAddressList(undefined)).toEqual([]);
  });

  it('reduces HTML to text with no markup, scripts or styles', () => {
    const t = htmlToText('<html><head><style>p{color:red}</style><title>t</title></head><body><script>alert(1)</script><p>Hello&nbsp;&amp; <b>welcome</b></p><ul><li>one</li><li>two</li></ul><table><tr><td>a</td><td>b</td></tr></table><!-- c --></body></html>');
    expect(t).not.toMatch(/[<>]/);
    expect(t).not.toContain('alert');
    expect(t).not.toContain('color');
    expect(t).toContain('Hello & welcome');
    expect(t).toContain('- one');
    expect(t).toContain('a\tb');
  });
});
