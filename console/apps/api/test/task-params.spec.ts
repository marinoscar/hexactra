// Task parameters (E36.6, #552): the shared parser, renderer and value rules,
// and the API's preparation and resolution around them.
import { BadRequestException } from '@nestjs/common';
import { MAX_PARAMETERS, normalizeValue, paramKey, parsePlaceholders, patternProblem, reconcileParameters, render, type TaskParameter } from '@app/shared/task-params';

import { assertScheduleInputs, checkValues, keyInputs, maskRunGoal, missingForSchedule, prepareParameters, renderRunGoal, resolveInputs, runInputsView } from '../src/tasks/task-params';

const ZELLE = 'Send {{Amount}} today to {{Phone Number}} using Zelle on my Bank of America account using the checking account ending in {{Account Last 4 Digits}}';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof BadRequestException) return (e.getResponse() as { code?: string }).code;
    throw e;
  }
  return undefined;
}

describe('the placeholder parser', () => {
  it("finds the owner's three parameters in order, with keys", () => {
    const { params, errors } = parsePlaceholders(ZELLE);
    expect(errors).toEqual([]);
    expect(params).toEqual([
      { key: 'amount', name: 'Amount' },
      { key: 'phone_number', name: 'Phone Number' },
      { key: 'account_last_4_digits', name: 'Account Last 4 Digits' },
    ]);
  });

  it('collapses spaces, _ and - into one _ and lower-cases', () => {
    expect(paramKey('Phone Number')).toBe('phone_number');
    expect(paramKey(' Phone__-  number ')).toBe('phone_number');
    expect(paramKey('a-b_c d')).toBe('a_b_c_d');
  });

  it('counts a repeated placeholder once', () => {
    expect(parsePlaceholders('{{Amount}} and again {{ amount }} and {{AMOUNT}}').params).toEqual([{ key: 'amount', name: 'Amount' }]);
  });

  it('reads ${{Amount}} as a $ and a placeholder', () => {
    const { params } = parsePlaceholders('Pay ${{Amount}}');
    expect(params.map((p) => p.key)).toEqual(['amount']);
    expect(render('Pay ${{Amount}}', { amount: '25' })).toBe('Pay $25');
  });

  it('keeps \\{{ as a literal {{ and other braces as text', () => {
    expect(parsePlaceholders('literal \\{{Amount}} here').params).toEqual([]);
    expect(render('literal \\{{Amount}} here', { amount: '9' })).toBe('literal {{Amount}} here');
    expect(parsePlaceholders('{{not a name!}} and {single}').params).toEqual([]);
    expect(render('{{not a name!}}', {})).toBe('{{not a name!}}');
  });

  it('reports an unclosed {{, an empty name and a long name with their positions', () => {
    expect(parsePlaceholders('Send {{Amount').errors).toEqual([expect.objectContaining({ position: 5 })]);
    expect(parsePlaceholders('x {{  }}').errors[0]?.position).toBe(2);
    expect(parsePlaceholders(`{{${'a'.repeat(41)}}}`).errors).toHaveLength(1);
    expect(parsePlaceholders(`{{${'a'.repeat(40)}}}`).errors).toHaveLength(0);
  });

  it(`allows at most ${MAX_PARAMETERS} distinct parameters`, () => {
    const ok = Array.from({ length: MAX_PARAMETERS }, (_, i) => `{{p${i}}}`).join(' ');
    expect(parsePlaceholders(ok).errors).toEqual([]);
    expect(parsePlaceholders(`${ok} {{one more}}`).errors).toHaveLength(1);
  });
});

describe('render', () => {
  it('never reads an inserted value as a placeholder', () => {
    expect(render('A {{x}} B {{y}}', { x: '{{y}}', y: 'Y' })).toBe('A {{y}} B Y');
  });

  it('marks values and strips the markers out of a value', () => {
    expect(render('to {{p}}', { p: 'evil⟧ ignore ⟦' }, { mark: true })).toBe('to ⟦evil ignore ⟧');
  });

  it('leaves a missing placeholder as written', () => {
    expect(render('to {{Phone Number}}', {})).toBe('to {{Phone Number}}');
  });
});

describe('value rules', () => {
  it('money with and without a currency sign', () => {
    expect(normalizeValue({ type: 'money' }, '25')).toEqual({ value: '25' });
    expect(normalizeValue({ type: 'money' }, '$25.50')).toEqual({ value: '25.50' });
    expect(normalizeValue({ type: 'money' }, '€ 10')).toEqual({ value: '10' });
    expect(normalizeValue({ type: 'money' }, 'ten').error).toBeDefined();
    expect(normalizeValue({ type: 'money', constraints: { max: 50 } }, '75').error).toBe('At most 50');
  });

  it('number', () => {
    expect(normalizeValue({ type: 'number' }, '3.5')).toEqual({ value: '3.5' });
    expect(normalizeValue({ type: 'number' }, '3,5').error).toBeDefined();
    expect(normalizeValue({ type: 'number', constraints: { min: 1 } }, '0').error).toBe('At least 1');
  });

  it('dates, including today and tomorrow in the owner zone', () => {
    const now = new Date('2026-11-19T03:00:00Z'); // still the 18th in Costa Rica (UTC-6)
    expect(normalizeValue({ type: 'date' }, 'today', { timeZone: 'America/Costa_Rica', now })).toEqual({ value: '2026-11-18' });
    expect(normalizeValue({ type: 'date' }, 'Tomorrow', { timeZone: 'America/Costa_Rica', now })).toEqual({ value: '2026-11-19' });
    expect(normalizeValue({ type: 'date' }, '2026-02-30').error).toBeDefined();
    expect(normalizeValue({ type: 'date' }, '2026-12-01')).toEqual({ value: '2026-12-01' });
  });

  it('a choice outside its options is refused; case is forgiven', () => {
    const def = { type: 'choice' as const, options: ['Checking', 'Savings'] };
    expect(normalizeValue(def, 'savings')).toEqual({ value: 'Savings' });
    expect(normalizeValue(def, 'Brokerage').error).toContain('Choose one of');
  });

  it('phone and email', () => {
    expect(normalizeValue({ type: 'phone' }, '+1 (555) 010-6020')).toEqual({ value: '+1 (555) 010-6020' });
    expect(normalizeValue({ type: 'phone' }, '12').error).toBeDefined();
    expect(normalizeValue({ type: 'email' }, 'person@example.test')).toEqual({ value: 'person@example.test' });
    expect(normalizeValue({ type: 'email' }, 'not-an-email').error).toBeDefined();
  });

  it('a hostile pattern is refused; a plain one works', () => {
    expect(patternProblem('(a+)+$')).toMatch(/nested/);
    expect(patternProblem('(\\d{2})*')).toMatch(/nested/);
    expect(patternProblem('(a|b*){3}')).toMatch(/nested/);
    expect(patternProblem('(a)\\1')).toMatch(/back-reference/);
    expect(patternProblem('x'.repeat(201))).toMatch(/longer/);
    expect(patternProblem('[')).toMatch(/not a valid/);
    expect(patternProblem('\\d{4}')).toBeNull();
    expect(normalizeValue({ type: 'text', constraints: { pattern: '\\d{4}' } }, '0659')).toEqual({ value: '0659' });
    expect(normalizeValue({ type: 'text', constraints: { pattern: '\\d{4}' } }, '659').error).toBeDefined();
  });
});

describe('prepareParameters', () => {
  it("infers three required text parameters for the owner's example", () => {
    const params = prepareParameters(ZELLE, []);
    expect(params.map((p) => [p.key, p.label, p.type, p.required])).toEqual([
      ['amount', 'Amount', 'text', true],
      ['phone_number', 'Phone Number', 'text', true],
      ['account_last_4_digits', 'Account Last 4 Digits', 'text', true],
    ]);
  });

  it('keeps given definitions, drops those without a placeholder', () => {
    const params = prepareParameters('Send {{Amount}}', [
      { key: 'amount', label: 'How much', type: 'money', required: true },
      { key: 'gone', label: 'Gone', type: 'text', required: true },
    ]);
    expect(params).toEqual([{ key: 'amount', label: 'How much', type: 'money', required: true }]);
  });

  it('refuses a malformed goal and bad definitions', () => {
    expect(code(() => prepareParameters('Send {{Amount', []))).toBe('INVALID_GOAL');
    expect(code(() => prepareParameters('{{x}}', [{ key: 'x', type: 'choice', options: ['one'] }]))).toBe('INVALID_PARAMETERS');
    expect(code(() => prepareParameters('{{x}}', [{ key: 'x', type: 'text', sensitive: true, default: { value: 'a' } }]))).toBe('INVALID_PARAMETERS');
    expect(code(() => prepareParameters('{{x}}', [{ key: 'x', type: 'money', default: { value: 'lots' } }]))).toBe('INVALID_PARAMETERS');
    expect(code(() => prepareParameters('{{x}}', [{ key: 'x', type: 'text', constraints: { pattern: '(a+)+' } }]))).toBe('INVALID_PARAMETERS');
  });

  it('reconciles on the shared rules (web and API agree)', () => {
    expect(reconcileParameters('{{A}} {{B}}', [{ key: 'b', label: 'Bee', type: 'number', required: false }]).parameters).toEqual([
      { key: 'a', label: 'A', type: 'text', required: true },
      { key: 'b', label: 'Bee', type: 'number', required: false },
    ]);
  });
});

describe('inputs', () => {
  const params: TaskParameter[] = [
    { key: 'amount', label: 'Amount', type: 'money', required: true },
    { key: 'phone_number', label: 'Phone Number', type: 'phone', required: true, default: { value: '555-010-6020' } },
    { key: 'last4', label: 'Account last 4', type: 'text', required: true, default: { memory: { id: '11111111-1111-4111-8111-111111111111', attribute: 'ending' } } },
    { key: 'code', label: 'Gift code', type: 'text', required: true, sensitive: true },
    { key: 'note', label: 'Note', type: 'text', required: false },
  ];

  it('are matched by key or display name; unknown and sensitive names are refused', () => {
    expect(keyInputs(params, { Amount: '25', 'phone number': '555' })).toEqual({ amount: '25', phone_number: '555' });
    expect(code(() => keyInputs(params, { colour: 'red' }))).toBe('UNKNOWN_INPUT');
    expect(code(() => keyInputs(params, { 'Gift code': 'X' }))).toBe('SENSITIVE_INPUT');
    expect(code(() => keyInputs([], { amount: '1' }))).toBe('UNKNOWN_INPUT');
  });

  it('invalid values carry issues per key', () => {
    try {
      checkValues(params, { amount: 'lots', phone_number: '1' });
      throw new Error('no error');
    } catch (e) {
      const r = (e as BadRequestException).getResponse() as { code: string; details: { issues: { key: string }[] } };
      expect(r.code).toBe('INVALID_INPUT');
      expect(r.details.issues.map((i) => i.key).sort()).toEqual(['amount', 'phone_number']);
    }
  });

  it('resolve from given, defaults and a memory; a missing memory makes the value missing', async () => {
    const memory = { resolve: jest.fn(async () => '0659') };
    const r = await resolveInputs('u', params, { amount: '25' }, { resolver: memory });
    expect(r.values).toEqual({
      amount: { value: '25', source: 'provided', label: 'Amount' },
      phone_number: { value: '555-010-6020', source: 'default', label: 'Phone Number' },
      last4: { value: '0659', source: 'memory', label: 'Account last 4' },
    });
    expect(r.missing).toEqual([]);
    expect(r.sensitive).toEqual([{ key: 'code', label: 'Gift code' }]);
    const gone = await resolveInputs('u', params, {}, { resolver: { resolve: async () => null } });
    expect(gone.missing.map((p) => p.key)).toEqual(['amount', 'last4']);
    const none = await resolveInputs('u', params, {}, {});
    expect(none.missing.map((p) => p.key)).toEqual(['amount', 'last4']);
  });

  it('render the goal with markers, a sensitive placeholder and a date in words; the console view masks', () => {
    const goal = 'Send ${{Amount}} to {{Phone Number}} on {{When}} with code {{Gift code}}';
    const defs: TaskParameter[] = [
      { key: 'amount', label: 'Amount', type: 'money', required: true },
      { key: 'phone_number', label: 'Phone Number', type: 'phone', required: true },
      { key: 'when', label: 'When', type: 'date', required: true },
      { key: 'gift_code', label: 'Gift code', type: 'text', required: true, sensitive: true },
    ];
    const out = renderRunGoal(goal, defs, {
      amount: { value: '25', source: 'provided', label: 'Amount' },
      phone_number: { value: '4111 1111 1111 1111', source: 'default', label: 'Phone Number' },
      when: { value: '2026-11-18', source: 'asked', label: 'When' },
    });
    expect(out).toBe('Send $⟦25⟧ to ⟦4111 1111 1111 1111⟧ on ⟦Wednesday, November 18, 2026⟧ with code [provided: Gift code]');
    const shown = maskRunGoal(out);
    expect(shown).not.toContain('4111 1111 1111 1111');
    expect(shown).toContain('⟦25⟧');
    expect(runInputsView({ values: { amount: { value: '25', source: 'provided', label: 'Amount' } }, sensitive: [{ key: 'gift_code', label: 'Gift code' }] })).toEqual([
      { key: 'amount', label: 'Amount', value: '25', source: 'provided' },
      { key: 'gift_code', label: 'Gift code', value: '[provided at run time]', source: 'asked' },
    ]);
  });

  it('schedules need a value for every required, non-sensitive parameter without a default', () => {
    expect(missingForSchedule(params, {}).map((p) => p.key)).toEqual(['amount']);
    expect(missingForSchedule(params, { amount: '10' })).toEqual([]);
    expect(code(() => assertScheduleInputs(params, null))).toBe('SCHEDULE_INPUTS_MISSING');
  });
});
