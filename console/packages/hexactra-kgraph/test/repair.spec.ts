// E46.17 (#791): the repair diff and its classification. Each rule: the sensitive case and the nearest structural one.
import { classifyRepair, diffVersions } from '../src/repair';
import { aVersion, call, lit, out, param, secret } from '../src/testing';
import type { ProcedureVersionInput, Tool } from '../src/schema';

const TOOLS: Tool[] = [
  { name: 'navigate', family: 'browser', commits: false },
  { name: 'click', family: 'browser', commits: false },
  { name: 'type_text', family: 'browser', commits: false },
  { name: 'read_text', family: 'browser', commits: false },
  { name: 'mail_search', family: 'accounts', commits: false },
  { name: 'mail_send', family: 'accounts', commits: true },
  { name: 'sheet_append', family: 'accounts', commits: false },
  { name: 'crm_lookup', family: 'mcp:c1', commits: false },
  { name: 'sign_in_with_saved_login', family: 'secrets', commits: true },
];
const el = (id: string, sel: string, label = 'Search', role = 'button') => ({ id, screen: 'sc', role, label, selectors: [sel] });
const base = (over: Partial<ProcedureVersionInput> = {}, steps?: ProcedureVersionInput['steps']) =>
  aVersion(
    steps ?? [
      call('s1', 'navigate', { url: lit('https://shop.example.com/') }),
      call('s2', 'click', { selector: lit('#go') }, { element: 'el:1' }),
      call('s3', 'read_text', { selector: lit('#total') }),
      call('s4', 'mail_send', { to: lit('finance@example.com'), body: out('s3') }, { commitClass: true }),
    ],
    { screens: [{ id: 'sc', site: 's1', label: 'x' }], elements: [el('el:1', '#go')], ...over },
  );
const classify = (prev: ReturnType<typeof base>, next: ReturnType<typeof base>) => classifyRepair(prev, next, diffVersions(prev, next), TOOLS);
const reasons = (prev: ReturnType<typeof base>, next: ReturnType<typeof base>) => classify(prev, next).reasons.map((r) => r.reason);

describe('diffVersions', () => {
  it('unchanged, relocated, rebound, inserted, removed and retargeted', () => {
    const prev = base();
    const next = base({ elements: [el('el:2', '#search-v2')] }, [
      call('t1', 'navigate', { url: lit('https://shop.example.com/') }),
      call('t2', 'click', { selector: lit('#search-v2') }, { element: 'el:2' }),
      call('t9', 'type_text', { selector: lit('#q'), text: lit('pens') }),
      call('t3', 'read_text', { selector: lit('#grand-total') }),
      call('t4', 'mail_send', { to: lit('finance@example.com'), body: out('t3') }, { commitClass: true }),
    ]);
    expect(diffVersions(prev, next).map((c) => c.kind)).toEqual(['unchanged', 'relocated', 'inserted', 'rebound', 'unchanged']);
    const swapped = base({}, [call('t1', 'navigate', { url: lit('https://shop.example.com/') }), call('t2', 'mail_search', { q: lit('x') })]);
    expect(diffVersions(base({}, [call('s1', 'navigate', { url: lit('https://shop.example.com/') }), call('s2', 'click', { selector: lit('#go') })]), swapped).map((c) => c.kind)).toEqual(['unchanged', 'retargeted']);
  });
});

describe('classifyRepair', () => {
  it('a relocated or relabelled ordinary button is structural', () => {
    const next = base({ elements: [el('el:2', '#search-v2', 'Find')] }, base().steps.map((s) => (s.id === 's2' ? { ...s, element: 'el:2', args: { selector: lit('#search-v2') } } : s)) as never);
    expect(classify(base(), next)).toEqual({ changeClass: 'structural', reasons: [] });
  });
  it('commit step inserted is sensitive; an inserted ordinary step is not', () => {
    const steps = base().steps;
    expect(reasons(base(), base({}, [...steps, call('s5', 'mail_send', { to: lit('finance@example.com') }, { commitClass: true })] as never))).toContain('commit_step');
    expect(classify(base(), base({}, [...steps.slice(0, 3), call('s9', 'click', { selector: lit('#more') }), steps[3]!] as never)).changeClass).toBe('structural');
  });
  it('a commit step removed is sensitive', () => {
    expect(reasons(base(), base({}, base().steps.slice(0, 3) as never))).toContain('commit_step');
  });
  it("changing a commit step's argument is sensitive; moving it to the same control (same role and label) is not", () => {
    const rebound = base({}, base().steps.map((s) => (s.id === 's4' ? { ...s, args: { to: lit('finance@example.com'), body: lit('fixed text') } } : s)) as never);
    expect(reasons(base(), rebound)).toContain('commit_args');
    const withEl = (id: string, sel: string, label: string) => base({ elements: [el('el:1', '#go'), { ...el(id, sel, label), role: 'button' }] }, base().steps.map((s) => (s.id === 's4' ? { ...s, element: id } : s)) as never);
    expect(classify(withEl('el:p', '#pay', 'Send'), withEl('el:q', '#pay-v2', 'Send')).changeClass).toBe('structural');
    expect(reasons(withEl('el:p', '#pay', 'Send'), withEl('el:q', '#pay-v2', 'Send to all'))).toContain('commit_args');
  });
  it('a new site is sensitive; another path on a known site is not', () => {
    expect(reasons(base(), base({ sites: [{ id: 's1', domain: 'example.com' }, { id: 's2', domain: 'evil.example.net' }] }))).toContain('new_site');
    const otherPath = base({}, base().steps.map((s) => (s.id === 's1' ? { ...s, args: { url: lit('https://shop.example.com/cart') } } : s)) as never);
    expect(classify(base(), otherPath).changeClass).toBe('structural');
  });
  it('a new account or added tool is sensitive; a known account tool again is not', () => {
    const steps = base().steps;
    expect(reasons(base(), base({}, [...steps, call('s5', 'crm_lookup', { key: lit('a') })] as never))).toContain('account');
    expect(reasons(base(), base({ accounts: [{ id: 'a1', connectionId: 'c9', provider: 'google' }] }))).toContain('account');
    const prevWithSearch = base({}, [call('s0', 'mail_search', { q: lit('x') }), ...steps] as never);
    expect(classify(prevWithSearch, base({}, [call('s0', 'mail_search', { q: lit('x') }), ...steps, call('s5', 'mail_search', { q: lit('y') })] as never)).changeClass).toBe('structural');
  });
  it('a new saved-login reference is sensitive; the same one is not', () => {
    const login = (label: string) => base({ secretRefs: [{ id: 'r1', kind: 'login', label }] }, [...base().steps.slice(0, 3), call('s9', 'type_text', { selector: lit('#pw'), text: secret('r1') }), base().steps[3]!] as never);
    expect(reasons(login('Shop'), login('Other shop'))).toContain('secret_ref');
    expect(classify(login('Shop'), login('Shop')).changeClass).toBe('structural');
  });
  it('a changed recipient or destination is sensitive, including parameter → literal; another non-destination argument is not', () => {
    const sheet = (b: ReturnType<typeof param>) => base({ parameters: [{ id: 'p:sheet', name: 'Sheet' }] }, [...base().steps.slice(0, 3), call('s8', 'sheet_append', { sheet: b, values: out('s3') })] as never);
    expect(reasons(sheet(param('p:sheet')), sheet(lit('Attacker sheet')))).toContain('recipient');
    const to = (v: string) => base({}, base().steps.map((s) => (s.id === 's4' ? { ...s, args: { to: lit(v), body: out('s3') } } : s)) as never);
    expect(reasons(to('finance@example.com'), to('attacker@example.test'))).toContain('recipient');
    const sel = base({}, base().steps.map((s) => (s.id === 's3' ? { ...s, args: { selector: lit('#sum') } } : s)) as never);
    expect(classify(base(), sel).changeClass).toBe('structural');
  });
  it('a judge that newly feeds a commit step is sensitive; a judge feeding an ordinary step is not', () => {
    const j = { id: 'j1', kind: 'judge', label: 'write', inputs: { t: out('s3') }, output: [{ name: 'body', type: 'string' }] } as never;
    const withJudge = (feedsCommit: boolean) => base({}, [...base().steps.slice(0, 3), j, feedsCommit ? call('s4', 'mail_send', { to: lit('finance@example.com'), body: { kind: 'judge', step: 'j1', field: 'body' } }, { commitClass: true }) : call('s4', 'mail_send', { to: lit('finance@example.com'), body: out('s3') }, { commitClass: true }), call('s5', 'type_text', { selector: lit('#n'), text: { kind: 'judge', step: 'j1', field: 'body' } })] as never);
    expect(reasons(base(), withJudge(true))).toContain('judge_feeds_commit');
    expect(reasons(base(), withJudge(false))).not.toContain('judge_feeds_commit');
  });
});
