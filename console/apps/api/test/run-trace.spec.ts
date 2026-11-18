// The run trace (#541): the key moments and the cap, the words of an answer step, and the masked step view.
import { answerSummary, guidanceSummary, isSecretInput, questionMoment, traceAllowed, traceKeyParts, TRACE_MAX_IMAGES } from '../src/runner/trace';
import { stepQuestionView, stepView } from '../src/tasks/run-trace.view';

describe('trace moments and the cap', () => {
  it('keeps every moment under the cap, and only the confirmed-action and final pictures past it', () => {
    for (const m of ['question', 'before_confirmed', 'after_confirmed', 'failure', 'final'] as const) expect(traceAllowed(m, TRACE_MAX_IMAGES - 1)).toBe(true);
    expect(traceAllowed('question', TRACE_MAX_IMAGES)).toBe(false);
    expect(traceAllowed('failure', TRACE_MAX_IMAGES + 5)).toBe(false);
    expect(traceAllowed('before_confirmed', TRACE_MAX_IMAGES)).toBe(true);
    expect(traceAllowed('after_confirmed', 99)).toBe(true);
    expect(traceAllowed('final', 99)).toBe(true);
  });

  it('a confirmation pictures the screen before the confirmed step; secrets take none', () => {
    expect(questionMoment('confirmation')).toBe('before_confirmed');
    expect(questionMoment('code')).toBe('question');
    expect(isSecretInput('secret')).toBe(true);
    expect(isSecretInput('credentials')).toBe(true);
    expect(isSecretInput('text')).toBe(false);
    expect(traceKeyParts('r1', 58, 'after_confirmed')).toEqual(['r1', '58-after_confirmed.jpg']);
    expect(traceKeyParts('r1', 3, 'final', 'image/png')).toEqual(['r1', '3-final.png']);
  });
});

describe('the answer step', () => {
  const base = { kind: 'other', input: 'text', completed: true, outcome: 'completed' } as const;
  it('never says a secret, a sign-in or a withheld value', () => {
    expect(answerSummary({ ...base, kind: 'code', input: 'secret', value: '123456' })).toBe('The owner provided it');
    expect(answerSummary({ ...base, kind: 'login', input: 'credentials', value: 'hunter2' })).toBe('The owner provided the sign-in');
    expect(answerSummary({ ...base, withheld: true, value: 'x' })).toBe('The owner answered (value withheld)');
  });
  it('says what a confirmation became', () => {
    expect(answerSummary({ ...base, kind: 'confirmation', input: 'none' })).toBe('The owner allowed it');
    expect(answerSummary({ ...base, kind: 'confirmation', input: 'confirm', value: 'approve' })).toBe('The owner allowed it');
    expect(answerSummary({ ...base, kind: 'confirmation', input: 'confirm', value: 'deny' })).toBe('The owner declined');
    expect(answerSummary({ ...base, kind: 'confirmation', input: 'none', completed: false, outcome: 'cancelled' })).toBe('The owner declined');
    expect(answerSummary({ ...base, completed: false, outcome: 'expired' })).toBe('The owner did not answer (expired)');
  });
  it('gives a value masked, and a choice by its label', () => {
    expect(answerSummary({ ...base, value: 'Use card 4111 1111 1111 1111' })).toBe('The owner answered: Use card •••• 1111');
    expect(answerSummary({ ...base, input: 'choice', value: 'b', options: [{ id: 'a', label: 'Checking' }, { id: 'b', label: 'Savings' }] })).toBe('The owner answered: Savings');
    expect(guidanceSummary('Pay from account 123456789 please')).not.toContain('123456789');
  });
});

describe('the step view', () => {
  const q = { id: 'q1', kind: 'confirmation', input: 'none', prompt: 'Pay card 4111 1111 1111 1111?', options: null, risk: 'high', status: 'answered', response: { outcome: 'completed', valueWithheld: false, channel: 'web', answeredAt: '2026-11-18T19:00:00Z' } };
  it('drops the object key, says whether there is a picture, and masks the question', () => {
    const v = stepView({ id: 's', seq: 1, screenshotKey: 'runs/u/r/1-before_confirmed.jpg', screenshotMoment: 'before_confirmed', questionId: 'q1', question: q });
    expect(v).not.toHaveProperty('screenshotKey');
    expect(v).toMatchObject({ hasScreenshot: true, screenshotMoment: 'before_confirmed', question: { prompt: 'Pay card •••• 1111?', answer: { outcome: 'completed', valueWithheld: false } } });
    expect(stepView({ id: 's', seq: 2, screenshotKey: null })).toMatchObject({ hasScreenshot: false, question: null });
  });
  it('never gives the value of a secret or a withheld answer', () => {
    expect(stepQuestionView({ ...q, input: 'secret', response: { outcome: 'completed', value: 'otp-1', valueWithheld: false } }).answer).toEqual({ outcome: 'completed', valueWithheld: true, channel: null, answeredAt: null });
    expect(stepQuestionView({ ...q, input: 'text', response: { outcome: 'completed', value: 'acct 123456789', valueWithheld: false } }).answer?.value).toBe('acct ••••6789');
  });
});
