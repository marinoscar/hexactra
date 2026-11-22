// The question that ended a trial as "asked a person" (#884), kept as a failed check: `withAskedQuestion`, without a database.
import type { AskedQuestion } from '../src/benchmark/suite/types';
import { ASKED_PERSON_CHECK, trialOutcome, withAskedQuestion } from '../src/benchmark/trial-verdict';

const q = (over: Partial<AskedQuestion>): AskedQuestion => ({ kind: 'other', input: 'text', prompt: 'Which customer?', at: 1, answered: 'none', ...over });
const askedPerson = trialOutcome({ preset: 'asked_person', run: { status: 'cancelled', stopReason: 'cancelled', error: null }, grade: { checks: [{ name: 'answer', pass: false }] } });

describe('withAskedQuestion (#884)', () => {
  it('adds the last unanswered question as a failed asked-person check, after the grader checks', () => {
    const out = withAskedQuestion(askedPerson, [
      q({ kind: 'confirmation', prompt: 'May I open the list?', answered: 'approve', at: 1 }),
      q({ prompt: 'Which   customer\n did you mean?', at: 2 }),
    ]);
    expect(out).toMatchObject({ verdict: 'fail', failureReason: 'asked_person' });
    expect(out.checks).toEqual([
      { name: 'answer', pass: false },
      { name: ASKED_PERSON_CHECK, pass: false, detail: 'other: Which customer did you mean?' },
    ]);
    expect(ASKED_PERSON_CHECK).toBe('asked-person');
  });

  it('clips a long question and says so when none was recorded', () => {
    const long = withAskedQuestion(askedPerson, [q({ prompt: 'x'.repeat(900) })]);
    expect(long.checks!.at(-1)!.detail!.length).toBe(500);
    expect(withAskedQuestion(askedPerson, []).checks!.at(-1)).toEqual({ name: ASKED_PERSON_CHECK, pass: false, detail: 'The question was not recorded' });
  });

  it('leaves every other outcome as it is', () => {
    const pass = trialOutcome({ preset: null, run: { status: 'succeeded', stopReason: 'finished', error: null }, grade: { checks: [{ name: 'answer', pass: true }] } });
    expect(withAskedQuestion(pass, [q({})])).toBe(pass);
    const timeout = trialOutcome({ preset: 'timeout', run: { status: 'cancelled', stopReason: 'cancelled', error: null }, grade: { checks: [{ name: 'answer', pass: false }] } });
    expect(withAskedQuestion(timeout, [q({})])).toBe(timeout);
  });
});
