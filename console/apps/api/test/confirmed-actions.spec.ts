// The confirmed steps a run carried out (#540): what is stored, and the sentence a result leads with.
import { appendConfirmedAction, confirmedLead, MAX_CONFIRMED_ACTIONS, noReportResult, readConfirmedActions, storedPrompt, withConfirmedLead } from '../src/runner/confirmed-actions';

const at = new Date('2026-11-18T19:00:00Z');

describe('confirmed actions', () => {
  it('stores the prompt folded, cut to 300 characters and masked', () => {
    expect(storedPrompt('Pay  with card\n4111 1111 1111 1111?')).toBe('Pay with card •••• 1111?');
    const long = storedPrompt(`${'a'.repeat(400)}`);
    expect(long).toHaveLength(300);
    expect(long.endsWith('…')).toBe(true);
  });

  it('appends up to twenty entries and drops malformed ones on read', () => {
    let list: unknown = [{ seq: 'x' }, null, { seq: 1, prompt: 'p', action: 'click', at: at.toISOString() }];
    expect(readConfirmedActions(list)).toHaveLength(1);
    for (let i = 0; i < 30; i++) list = appendConfirmedAction(list, { seq: i + 2, prompt: 'Send it?', action: 'click', at });
    expect(readConfirmedActions(list)).toHaveLength(MAX_CONFIRMED_ACTIONS);
    expect(readConfirmedActions(null)).toEqual([]);
  });

  it('leads a result that did not succeed, never a succeeded one', () => {
    const one = [{ seq: 58, prompt: 'Send $10 to Person A?', action: 'click', at: at.toISOString() }];
    expect(confirmedLead(one, 'failed')).toBe("The step you confirmed was carried out (step 58: 'Send $10 to Person A?'), but the run ended before it could check the outcome. Check before you run it again.");
    expect(confirmedLead(one, 'succeeded')).toBeNull();
    expect(confirmedLead([], 'failed')).toBeNull();
    expect(withConfirmedLead('Summary.', one, 'cancelled')).toMatch(/^The step you confirmed.*\n\nSummary\.$/s);
    expect(withConfirmedLead('', one, 'failed')).toBe(confirmedLead(one, 'failed'));
    const two = [...one, { seq: 70, prompt: 'Again?', action: 'key', at: at.toISOString() }];
    expect(confirmedLead(two, 'failed')).toContain("(step 70: 'Again?') (and 1 earlier confirmed step)");
  });

  it('a wrap-up without words reports the last five steps, masked', () => {
    const log = ['Goal noted', ...Array.from({ length: 7 }, (_, i) => `${i + 1}. click {"selector":"#b${i}"} → ok: account 123456789`)];
    const text = noReportResult(log);
    expect(text.split('\n')).toHaveLength(6);
    expect(text).toMatch(/^Stopped before the agent could report\. Last steps:\n3\. click/);
    expect(text).not.toContain('123456789');
    expect(noReportResult([])).toBe('Stopped before the agent could report.');
  });
});
