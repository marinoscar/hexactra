// Deterministic procedure matching (E46.27, #849): a site match, a words-only match, lookalikes that never match, suspended and candidate
// versions excluded, a stable order and the limit. Pure: no store, no model.
import { matchProcedures, siteOf, sitesInText, wordsOf, type LibraryEntry } from '../src/match';
import type { ProcedureVersionInput } from '../src/schema';
import { aProcedure, aVersion, call } from '../src/testing';

function entry(id: string, name: string, over: Partial<ProcedureVersionInput> = {}, description?: string): LibraryEntry {
  const version = aVersion([call('c1', 'navigate')], { id: `${id}-v`, procedure: id, state: 'active', sites: [], ...over });
  return { procedure: aProcedure({ id, name, activeVersion: version.id }), version, ...(description === undefined ? {} : { description }) };
}
const site = (domain: string) => ({ sites: [{ id: `site:${domain}`, domain }] });
const runs = (successes: number, failures: number, repairs = 0) => ({ evidence: { successes, failures, repairs, lastSuccessAt: null, lastFailureAt: null } });

describe('the helpers', () => {
  it('normalises words: case, accents, stop words, plurals, camelCase and snake_case', () => {
    expect([...wordsOf('Download the Monthly INVOICES from my café')].sort()).toEqual(['cafe', 'download', 'invoice', 'monthly']);
    expect([...wordsOf('entries boxes branches status')].sort()).toEqual(['box', 'branch', 'entry', 'status']);
    expect([...wordsOf('accountNumber due_date')].sort()).toEqual(['account', 'date', 'due', 'number']);
  });

  it('reads registrable domains from a goal, not from an e-mail address', () => {
    expect(sitesInText('Check https://www.Bank.com/accounts then shop.example.co.uk, and mail bob@acme.org.')).toEqual(['bank.com', 'example.co.uk']);
    expect(siteOf('https://login.bank.com/x')).toBe('bank.com');
    expect(siteOf('not a host')).toBeNull();
  });
});

describe('matchProcedures', () => {
  it('matches on a site named in the goal', () => {
    const lib = [entry('p-bank', 'Statement download', site('bank.com')), entry('p-shop', 'Order history', site('shop.com'))];
    expect(matchProcedures({ goal: 'Get my balance from https://secure.bank.com' }, lib)).toEqual([{ procedureId: 'p-bank', score: expect.any(Number), reasons: ['site'] }]);
  });

  it('matches on an allowed site the caller passes, and on an account the goal names', () => {
    const lib = [entry('p-bank', 'Statement download', site('bank.com')), entry('p-mail', 'Weekly digest', { accounts: [{ id: 'a1', connectionId: 'conn-1', provider: 'google' }] })];
    expect(matchProcedures({ goal: 'Do the usual', sites: ['www.bank.com'], accounts: ['conn-1'] }, lib).map((m) => [m.procedureId, m.reasons])).toEqual([
      ['p-bank', ['site']],
      ['p-mail', ['account']],
    ]);
  });

  it('matches on words alone, with at least two shared words, from the name, the description and the parameter names', () => {
    const lib = [
      entry('p-inv', 'Download invoices', {}, 'Saves each month'),
      entry('p-one', 'Download photos'),
      entry('p-param', 'Report', { parameters: [{ id: 'm', name: 'billingMonth' }] }),
    ];
    expect(matchProcedures({ goal: 'download the monthly invoice' }, lib).map((m) => [m.procedureId, m.reasons])).toEqual([['p-inv', ['words']]]);
    expect(matchProcedures({ goal: 'the billing report for each month' }, lib).map((m) => m.procedureId)).toEqual(['p-param']);
    expect(matchProcedures({ goal: 'download' }, lib)).toEqual([]);
    expect(matchProcedures({ goal: 'download' }, lib, { minWords: 1 }).map((m) => m.procedureId)).toEqual(['p-inv', 'p-one']);
  });

  it('never matches a lookalike domain', () => {
    const lib = [entry('p-pay', 'Pay the bill', site('paypal.com')), entry('p-uk', 'Pay the bill', site('bank.co.uk'))];
    for (const goal of ['Pay on paypa1.com', 'Pay on paypal.com.evil.io', 'Pay on mypaypal.com', 'Pay on paypal.co', 'Pay on evil.co.uk', 'Pay on paypal-com.net']) {
      expect(matchProcedures({ goal }, lib, { minWords: 9 })).toEqual([]);
    }
    expect(matchProcedures({ goal: 'x', sites: ['paypal.com.evil.io', 'xn--pypal-4ve.com', 'co.uk'] }, lib, { minWords: 9 })).toEqual([]);
    // A subdomain of the exact registrable domain is the same site.
    expect(matchProcedures({ goal: 'Pay on www.paypal.com' }, lib, { minWords: 9 }).map((m) => m.procedureId)).toEqual(['p-pay']);
  });

  it('never returns a suspended, candidate, verified or retired version', () => {
    const lib = (['candidate', 'suspended', 'verified', 'retired', 'active'] as const).map((state) => entry(`p-${state}`, 'Statement download', { state, ...site('bank.com') }));
    expect(matchProcedures({ goal: 'statement download on bank.com' }, lib).map((m) => m.procedureId)).toEqual(['p-active']);
  });

  it('ranks site, then shared words, then clean-replay rate, then id, and the order is stable across runs and input orders', () => {
    const lib = [
      entry('p-d', 'Download statement', { ...site('bank.com'), ...runs(1, 1) }),
      entry('p-c', 'Download statement', { ...site('bank.com'), ...runs(9, 1) }),
      entry('p-b', 'Download statement', { ...site('bank.com'), ...runs(9, 1) }),
      entry('p-e', 'Monthly statement download', site('bank.com')),
      entry('p-a', 'Monthly statement download', { ...runs(10, 0) }),
      entry('p-f', 'Balance', site('bank.com')),
    ];
    const goal = 'Download the monthly statement from bank.com';
    const expected = ['p-e', 'p-b', 'p-c', 'p-d', 'p-f'];
    expect(matchProcedures({ goal }, lib).map((m) => m.procedureId)).toEqual(expected);
    expect(matchProcedures({ goal }, lib, { limit: 10 }).map((m) => m.procedureId)).toEqual([...expected, 'p-a']);
    const first = JSON.stringify(matchProcedures({ goal }, lib, { limit: 10 }));
    for (let i = 0; i < 20; i++) {
      const shuffled = [...lib].sort(() => (Math.random() < 0.5 ? -1 : 1));
      expect(JSON.stringify(matchProcedures({ goal }, shuffled, { limit: 10 }))).toBe(first);
    }
    const scores = matchProcedures({ goal }, lib, { limit: 10 }).map((m) => m.score);
    for (const s of scores) expect(s).toBeGreaterThanOrEqual(0);
    for (const s of scores) expect(s).toBeLessThanOrEqual(1);
  });

  it('returns at most the limit: 5 by default', () => {
    const lib = Array.from({ length: 8 }, (_, i) => entry(`p-${i}`, `Job ${i}`, site('bank.com')));
    expect(matchProcedures({ goal: 'bank.com' }, lib)).toHaveLength(5);
    expect(matchProcedures({ goal: 'bank.com' }, lib, { limit: 2 }).map((m) => m.procedureId)).toEqual(['p-0', 'p-1']);
    expect(matchProcedures({ goal: 'bank.com' }, lib, { limit: 0 })).toEqual([]);
  });

  it('ignores an entry whose version is not its procedure\'s, and a repeated procedure', () => {
    const a = entry('p-a', 'Statement', site('bank.com'));
    const stray = { ...a, version: { ...a.version, procedure: 'p-other' } };
    expect(matchProcedures({ goal: 'bank.com' }, [stray])).toEqual([]);
    expect(matchProcedures({ goal: 'bank.com' }, [a, a])).toHaveLength(1);
  });
});
