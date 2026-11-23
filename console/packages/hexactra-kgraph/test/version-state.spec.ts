// E46.10 (#784): every legal and illegal move of the version state machine.
import { assertTransition, canTransition, IllegalTransition, VERSION_STATES, VERSION_TRANSITIONS } from '../src/schema';

const legal = new Set(['candidate>verified', 'candidate>retired', 'candidate>rejected', 'verified>active', 'verified>suspended', 'verified>retired', 'active>suspended', 'active>retired', 'suspended>active', 'suspended>retired']);

describe('the version state machine', () => {
  for (const from of VERSION_STATES)
    for (const to of VERSION_STATES) {
      const ok = legal.has(`${from}>${to}`);
      it(`${from} → ${to} is ${ok ? 'allowed' : 'refused'}`, () => {
        expect(canTransition(from, to)).toBe(ok);
        if (ok) expect(() => assertTransition(from, to)).not.toThrow();
        else expect(() => assertTransition(from, to)).toThrow(IllegalTransition);
      });
    }
  it('has exactly the documented table', () => {
    expect(Object.entries(VERSION_TRANSITIONS).flatMap(([f, ts]) => ts.map((t) => `${f}>${t}`)).sort()).toEqual([...legal].sort());
  });
});
