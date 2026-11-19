// Task outputs (E39.5, #600): the shared definition and value rules.
import { MAX_OUTPUTS, MAX_OUTPUT_KEY_LENGTH, formatOutputValue, outputDefinitionProblems, outputKey, parseDateText, parseDateTimeText, parseLocalizedNumber, parseMoney, parseOutputValue, parseOutputs, type TaskOutput } from '@app/shared/task-fields';

const out = (o: Partial<TaskOutput> & { key: string; type: TaskOutput['type'] }): TaskOutput => ({ label: o.key, required: true, ...o });

describe('output keys', () => {
  it('derives snake_case from a label', () => {
    expect(outputKey('Confirmation number')).toBe('confirmation_number');
    expect(outputKey('  Amount paid ($) ')).toBe('amount_paid');
    expect(outputKey('Número de confirmación')).toBe('numero_de_confirmacion');
    expect(outputKey('???')).toBe('');
  });
  it('is at most 40 characters', () => {
    expect(outputKey('a'.repeat(80)).length).toBeLessThanOrEqual(MAX_OUTPUT_KEY_LENGTH);
  });
});

describe('definitions', () => {
  it('accepts a good list and flags keys, types, options and limits', () => {
    expect(outputDefinitionProblems([out({ key: 'amount_paid', type: 'money' }), out({ key: 'status', type: 'choice', options: ['Paid', 'Pending'] })])).toEqual([]);
    expect(outputDefinitionProblems([out({ key: 'Bad Key', type: 'text' })])[0]!.message).toMatch(/lower-case/);
    expect(outputDefinitionProblems([out({ key: 'a', type: 'text' }), out({ key: 'a', type: 'text' })]).some((p) => /same key/.test(p.message))).toBe(true);
    expect(outputDefinitionProblems([out({ key: 'a', type: 'choice', options: ['x'] })])[0]!.message).toMatch(/2 to 50/);
    expect(outputDefinitionProblems([out({ key: 'a', type: 'text', options: ['x', 'y'] })])[0]!.message).toMatch(/only for a choice/);
    expect(outputDefinitionProblems([out({ key: 'a', type: 'nope' as never })])[0]!.message).toMatch(/Unknown type/);
    const many = Array.from({ length: MAX_OUTPUTS + 1 }, (_, i) => out({ key: `k${i}`, type: 'text' }));
    expect(outputDefinitionProblems(many).some((p) => /At most 30/.test(p.message))).toBe(true);
  });
});

describe('numbers and money', () => {
  it.each([
    ['1,234.50', 1234.5],
    ['1.234,50', 1234.5],
    ['12,50', 12.5],
    ['1,234', 1234],
    ['1.234.567', 1234567],
    ['(12.5)', -12.5],
    ['-3', -3],
    ['1 234,5', 1234.5],
    ['42', 42],
  ])('reads %s', (text, n) => expect(parseLocalizedNumber(text)).toBe(n));

  it.each(['ten', '1,2,3', '12.', '', 'abc1', '1,23.4,5'])('refuses %j', (text) => expect(parseLocalizedNumber(text)).toBeNull());

  it('reads money with a sign, a code and separators', () => {
    expect(parseMoney('$1,234.50')).toEqual({ amount: 1234.5, currency: 'USD' });
    expect(parseMoney('€ 20')).toEqual({ amount: 20, currency: 'EUR' });
    expect(parseMoney('EUR 20,00')).toEqual({ amount: 20, currency: 'EUR' });
    expect(parseMoney('20.00 CAD')).toEqual({ amount: 20, currency: 'CAD' });
    expect(parseMoney('CA$ 9.99')).toEqual({ amount: 9.99, currency: 'CAD' });
    expect(parseMoney('-$12')).toEqual({ amount: -12, currency: 'USD' });
    expect(parseMoney('(£5.00)')).toBeNull();
    expect(parseMoney('25')).toEqual({ amount: 25, currency: null });
    expect(parseMoney('ten dollars')).toBeNull();
    expect(parseMoney('ten')).toBeNull();
  });
});

describe('dates', () => {
  it.each([
    ['2026-03-25', '2026-03-25'],
    ['03/25/2026', '2026-03-25'],
    ['25/03/2026', '2026-03-25'],
    ['25.03.2026', '2026-03-25'],
    ['2026/03/25', '2026-03-25'],
    ['March 25, 2026', '2026-03-25'],
    ['Wednesday, March 25, 2026', '2026-03-25'],
    ['25 March 2026', '2026-03-25'],
    ['Mar 25th, 2026', '2026-03-25'],
    ['04/04/2026', '2026-04-04'],
  ])('reads %s', (text, iso) => expect(parseDateText(text)).toEqual({ value: iso }));

  it('refuses the ambiguous, the impossible and the not-a-date', () => {
    expect(parseDateText('03/04/2026')).toEqual({ error: expect.stringMatching(/ambiguous/) });
    expect(parseDateText('2026-02-30')).toEqual({ error: expect.stringMatching(/real date/) });
    expect(parseDateText('soon')).toEqual({ error: expect.stringMatching(/not a date/) });
    expect(parseDateText('03/25/26')).toHaveProperty('error');
  });

  it('reads date and time', () => {
    expect(parseDateTimeText('2026-03-25T15:30')).toEqual({ value: '2026-03-25T15:30:00' });
    expect(parseDateTimeText('2026-03-25 15:30:10Z')).toEqual({ value: '2026-03-25T15:30:10Z' });
    expect(parseDateTimeText('2026-03-25T15:30:00+0200')).toEqual({ value: '2026-03-25T15:30:00+02:00' });
    expect(parseDateTimeText('March 25, 2026 3:30 PM')).toEqual({ value: '2026-03-25T15:30:00' });
    expect(parseDateTimeText('March 25, 2026 at 12:05 am')).toEqual({ value: '2026-03-25T00:05:00' });
    expect(parseDateTimeText('2026-03-25')).toHaveProperty('error');
    expect(parseDateTimeText('2026-03-25T25:00')).toHaveProperty('error');
  });
});

describe('values by type', () => {
  it('reads each type and rejects what does not parse', () => {
    expect(parseOutputValue({ type: 'text' }, '  ABC-123  ')).toEqual({ ok: true, value: 'ABC-123' });
    expect(parseOutputValue({ type: 'text' }, 12345)).toEqual({ ok: true, value: '12345' });
    expect(parseOutputValue({ type: 'text' }, 'x'.repeat(501))).toMatchObject({ ok: false });
    expect(parseOutputValue({ type: 'number' }, '1,200')).toEqual({ ok: true, value: 1200 });
    expect(parseOutputValue({ type: 'number' }, 7)).toEqual({ ok: true, value: 7 });
    expect(parseOutputValue({ type: 'number' }, 'ten dollars')).toEqual({ ok: false, error: 'not a number' });
    expect(parseOutputValue({ type: 'money' }, 25.5)).toEqual({ ok: true, value: { amount: 25.5, currency: null } });
    expect(parseOutputValue({ type: 'boolean' }, 'Yes')).toEqual({ ok: true, value: true });
    expect(parseOutputValue({ type: 'boolean' }, false)).toEqual({ ok: true, value: false });
    expect(parseOutputValue({ type: 'boolean' }, 'maybe')).toMatchObject({ ok: false });
    expect(parseOutputValue({ type: 'url' }, 'https://pay.example.test/receipt/1')).toEqual({ ok: true, value: 'https://pay.example.test/receipt/1' });
    expect(parseOutputValue({ type: 'url' }, 'javascript:alert(1)')).toMatchObject({ ok: false });
    expect(parseOutputValue({ type: 'url' }, '/relative')).toMatchObject({ ok: false });
    expect(parseOutputValue({ type: 'choice', options: ['Paid', 'Pending'] }, 'paid')).toEqual({ ok: true, value: 'Paid' });
    expect(parseOutputValue({ type: 'choice', options: ['Paid', 'Pending'] }, 'late')).toMatchObject({ ok: false });
  });
  it('treats null, undefined and blank as missing', () => {
    for (const v of [null, undefined, '', '   ']) expect(parseOutputValue({ type: 'text' }, v)).toMatchObject({ ok: false, missing: true });
  });
});

describe('a set of outputs', () => {
  const defs = [out({ key: 'confirmation_number', type: 'text' }), out({ key: 'amount_paid', type: 'money' }), out({ key: 'note', type: 'text', required: false }), out({ key: 'card', type: 'text', sensitive: true, required: false })];

  it('reads every value, drops unknown keys and is complete', () => {
    const r = parseOutputs(defs, { confirmation_number: 'C-1', amount_paid: '$25.00', extra: 'dropped' });
    expect(r.complete).toBe(true);
    expect(r.problems).toEqual([]);
    expect(Object.keys(r.fields)).toEqual(['confirmation_number', 'amount_paid', 'note', 'card']);
    expect(r.fields.amount_paid).toEqual({ value: { amount: 25, currency: 'USD' }, ok: true });
    expect(r.fields.note).toEqual({ value: null, ok: true });
  });

  it('names what is missing or invalid, without echoing a sensitive value', () => {
    const r = parseOutputs(defs, { amount_paid: 'ten dollars', card: 'x'.repeat(600) });
    expect(r.complete).toBe(false);
    expect(r.problems.map((p) => p.message)).toEqual(['`confirmation_number` is required', "`amount_paid` is not an amount of money: 'ten dollars'", '`card` is longer than 500 characters']);
    expect(r.fields.amount_paid).toEqual({ value: null, ok: false, note: 'Not an amount of money' });
    expect(r.fields.confirmation_number).toEqual({ value: null, ok: false, note: 'Not found' });
  });

  it('copes with an agent that gave no outputs', () => {
    expect(parseOutputs(defs, undefined).complete).toBe(false);
    expect(parseOutputs([out({ key: 'a', type: 'text', required: false })], null).complete).toBe(true);
  });

  it('formats a value for a person or a spreadsheet', () => {
    expect(formatOutputValue({ type: 'money' }, { amount: 25.5, currency: 'USD' })).toBe('USD 25.50');
    expect(formatOutputValue({ type: 'money' }, { amount: 25, currency: null })).toBe('25');
    expect(formatOutputValue({ type: 'boolean' }, true)).toBe('Yes');
    expect(formatOutputValue({ type: 'text' }, null)).toBe('');
    expect(formatOutputValue({ type: 'date' }, '2026-03-25')).toBe('Wednesday, March 25, 2026');
  });
});
