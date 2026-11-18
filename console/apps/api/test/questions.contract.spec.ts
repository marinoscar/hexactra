// The question contract (#285) as pure functions: what a question may ask and
// what an answer to each input type may be.
import { AnswerInvalidError, canonicalDecimal, questionSpecSchema, toResponse, validateAnswer, type QuestionSpec } from '../src/questions/questions.contract';

const spec = (q: Record<string, unknown>): QuestionSpec => questionSpecSchema.parse(q);
const bad = (q: Record<string, unknown>) => expect(questionSpecSchema.safeParse(q).success).toBe(false);
const refuse = (q: QuestionSpec, a: Record<string, unknown>) => expect(() => validateAnswer(q, a as never)).toThrow(AnswerInvalidError);

describe('questions', () => {
  it('normalises options and defaults', () => {
    expect(spec({ input: 'choice', prompt: 'p', choices: ['A', { id: 'b', label: 'B' }] })).toMatchObject({
      kind: 'other',
      options: [{ id: 'A', label: 'A' }, { id: 'b', label: 'B' }],
      constraints: null,
      risk: null,
      timeoutMs: 3_600_000,
    });
    expect(spec({ input: 'confirm', prompt: 'p' }).risk).toBe('high');
  });

  it('refuses what an input type does not allow', () => {
    bad({ input: 'choice', prompt: 'p', options: [] });
    bad({ input: 'choice', prompt: 'p', options: Array.from({ length: 11 }, (_, i) => `o${i}`) });
    bad({ input: 'choice', prompt: 'p', options: ['a', 'a'] });
    bad({ input: 'choice', prompt: 'p', options: ['a'], choices: ['b'] });
    bad({ input: 'choice', prompt: 'p', options: [{ id: 'x', label: 'y'.repeat(101) }] });
    bad({ input: 'choice', prompt: 'p', options: [{ id: 'x', label: 'y', description: 'z'.repeat(201) }] });
    bad({ input: 'text', prompt: 'p', constraints: { maxLength: 5000 } });
    bad({ input: 'text', prompt: 'p', constraints: { pattern: 'x'.repeat(201) } });
    bad({ input: 'number', prompt: 'p', constraints: { min: 5, max: 1 } });
    bad({ input: 'number', prompt: 'p', constraints: { unit: 'u'.repeat(21) } });
    bad({ input: 'number', prompt: 'p', constraints: { step: 0 } });
    bad({ input: 'multi_choice', prompt: 'p', options: ['a', 'b'], constraints: { minSelections: 2, maxSelections: 1 } });
    bad({ input: 'confirm', prompt: 'p', confirmLabel: 'x'.repeat(41) });
    bad({ input: 'text', prompt: 'p', risk: 'low' });
    bad({ input: 'text', prompt: '' });
    bad({ input: 'text', prompt: 'x'.repeat(2001) });
    bad({ input: 'text', prompt: 'p', timeoutMs: 5 });
  });
});

describe('answers', () => {
  it('text: length, pattern (full match) and single line', () => {
    const q = spec({ input: 'text', prompt: 'p', constraints: { maxLength: 5, pattern: '[a-z]+', multiline: false } });
    expect(validateAnswer(q, { outcome: 'completed', value: 'abc' })).toEqual({ outcome: 'completed', value: 'abc' });
    refuse(q, { outcome: 'completed', value: 'abcdef' });
    refuse(q, { outcome: 'completed', value: 'abc1' });
    refuse(q, { outcome: 'completed', value: 'ab\nc' });
    refuse(q, { outcome: 'completed' });
  });

  it('choice and multi_choice: ids only, unique, within the bounds', () => {
    const c = spec({ input: 'choice', prompt: 'p', options: ['a', 'b'] });
    expect(validateAnswer(c, { outcome: 'completed', value: 'b' }).value).toBe('b');
    refuse(c, { outcome: 'completed', value: 'z' });
    refuse(c, { outcome: 'completed', values: ['a'] });
    const m = spec({ input: 'multi_choice', prompt: 'p', options: ['a', 'b', 'c'] });
    expect(validateAnswer(m, { outcome: 'completed', values: ['a', 'b', 'c'] }).values).toEqual(['a', 'b', 'c']);
    refuse(m, { outcome: 'completed', values: [] });
    refuse(m, { outcome: 'completed', values: ['a', 'a'] });
  });

  it('number: a canonical decimal within min, max and step', () => {
    const q = spec({ input: 'number', prompt: 'p', constraints: { min: 0, max: 1, step: 0.1 } });
    expect(validateAnswer(q, { outcome: 'completed', value: '0.30' }).value).toBe('0.3');
    expect(validateAnswer(q, { outcome: 'completed', value: 1 }).value).toBe('1');
    refuse(q, { outcome: 'completed', value: '0.35' });
    refuse(q, { outcome: 'completed', value: '2' });
    refuse(q, { outcome: 'completed', value: '1e-1' });
    expect(canonicalDecimal('-0.0')).toBe('0');
    expect(canonicalDecimal('abc')).toBeNull();
  });

  it('confirm, none, takeover and a declined answer', () => {
    const c = spec({ input: 'confirm', prompt: 'p' });
    expect(validateAnswer(c, { outcome: 'completed', value: 'approve' }).value).toBe('approve');
    refuse(c, { outcome: 'completed', value: 'ok' });
    refuse(spec({ input: 'none', prompt: 'p' }), { outcome: 'completed', value: 'x' });
    expect(validateAnswer(spec({ input: 'takeover', prompt: 'p' }), { outcome: 'completed' })).toEqual({ outcome: 'completed' });
    expect(validateAnswer(c, { outcome: 'cancelled', value: 'ignored' })).toEqual({ outcome: 'cancelled' });
  });

  it('a secret answer is never part of the response', () => {
    const q = spec({ input: 'secret', prompt: 'p' });
    const a = validateAnswer(q, { outcome: 'completed', value: 's3cr3t' });
    expect(a.value).toBe('s3cr3t');
    const r = toResponse('secret', a, { channel: 'web', by: 'user:u', answeredAt: new Date(0) });
    expect(r).toEqual({ outcome: 'completed', valueWithheld: true, channel: 'web', by: 'user:u', answeredAt: '1970-01-01T00:00:00.000Z' });
    refuse(q, { outcome: 'completed', value: '' });
  });
});

describe('a sign-in (credentials, #527)', () => {
  const spec = (extra: Record<string, unknown> = {}) => questionSpecSchema.parse({ input: 'credentials', kind: 'login', prompt: 'Sign in to Example Bank', ...extra });

  it('carries the site\'s "remember me" words, only on a sign-in or a secret', () => {
    expect(spec({ rememberLabel: '  Keep me signed in ' }).rememberLabel).toBe('Keep me signed in');
    expect(spec().rememberLabel).toBeNull();
    expect(questionSpecSchema.parse({ input: 'secret', prompt: 'Code', rememberLabel: 'Trust this device' }).rememberLabel).toBe('Trust this device');
    expect(questionSpecSchema.safeParse({ input: 'text', prompt: 'Name', rememberLabel: 'Remember me' }).success).toBe(false);
    expect(questionSpecSchema.safeParse({ input: 'credentials', prompt: 'p', rememberLabel: 'x'.repeat(81) }).success).toBe(false);
    expect(questionSpecSchema.safeParse({ input: 'credentials', prompt: 'p', rememberLabel: 'Remember\nme' }).success).toBe(false);
  });

  it('needs a username and a password; the remember choice only when offered', () => {
    const offered = spec({ rememberLabel: 'Remember me' });
    expect(validateAnswer(offered, { outcome: 'completed', value: ' oscar ', secret: 'x9-424243', remember: true })).toEqual({ outcome: 'completed', value: 'oscar', secret: 'x9-424243', remember: true });
    const bad = (q: QuestionSpec, a: Record<string, unknown>) => expect(() => validateAnswer(q, { outcome: 'completed', ...a })).toThrow(AnswerInvalidError);
    bad(offered, { value: 'oscar' });
    bad(offered, { value: 'oscar', secret: '' });
    bad(offered, { value: '  ', secret: 'x9-424243' });
    bad(offered, { value: 'os\ncar', secret: 'x9-424243' });
    bad(spec(), { value: 'oscar', secret: 'x9-424243', remember: true });
    // A password is refused on any other question.
    bad(questionSpecSchema.parse({ input: 'text', prompt: 'Name' }), { value: 'oscar', secret: 'x9-424243' });
    expect(validateAnswer(offered, { outcome: 'cancelled' })).toEqual({ outcome: 'cancelled' });
  });

  it('stores the username and the choice, never the password', () => {
    const a = validateAnswer(spec({ rememberLabel: 'Remember me' }), { outcome: 'completed', value: 'oscar', secret: 'x9-424243', remember: false });
    const r = toResponse('credentials', a, { channel: 'web', by: 'user:u', answeredAt: new Date('2026-11-18T00:00:00Z') });
    expect(r).toEqual({ outcome: 'completed', value: 'oscar', valueWithheld: true, remember: false, channel: 'web', by: 'user:u', answeredAt: '2026-11-18T00:00:00.000Z' });
    expect(JSON.stringify(r)).not.toContain('x9-424243');
  });
});
