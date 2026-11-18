// What the runner needs of saved approvals (#555), pure: the facts a question
// may be remembered as, the fixed topics, the advice line, the end-of-run
// sentence, the amount the owner's inputs make known; and the answer contract
// and channel rule of the "Don't ask again" tick.
import { askRememberable, askTopicOf, askTopicsLine, gateRememberable, knownAmount, savedApprovalsLine, siteOf } from '../src/approvals/approval-runner';
import { findRule } from '../src/approvals/approval-match';
import { mayRememberOn, REMEMBER_RULE_CHANNELS } from '../src/questions/channels/channel-rules';
import { questionAnswerSchema, questionSpecSchema } from '../src/questions/questions.contract';

describe('saved approvals in the runner (#555)', () => {
  it('siteOf: the registrable domain of a URL or a bare host; null for what never matches', () => {
    expect(siteOf('https://www.secure.example.com/pay')).toBe('example.com');
    expect(siteOf('secure.example.com')).toBe('example.com');
    expect(siteOf('example.com.evil.example.net')).toBe('example.net');
    expect(siteOf('localhost')).toBeNull();
    expect(siteOf('10.0.0.1')).toBeNull();
    expect(siteOf('file:///etc/passwd')).toBeNull();
    expect(siteOf(null)).toBeNull();
  });

  it('askTopicOf: a topic from the fixed list, anything else is "other"', () => {
    expect(askTopicOf('choose_date')).toBe('choose_date');
    expect(askTopicOf('open_menu')).toBe('open_menu');
    expect(askTopicOf('pay_everything')).toBe('other');
    expect(askTopicOf('CHOOSE_DATE')).toBe('other');
    expect(askTopicOf(null)).toBe('other');
    expect(askTopicOf(42)).toBe('other');
  });

  it("gateRememberable: the gate's own facts; null when the site, the label or the category is unknown", () => {
    expect(gateRememberable({ host: 'secure.example.com', category: 'payment', label: '  Pay  now ' })).toEqual({ kind: 'gate', host: 'example.com', category: 'payment', matchKey: 'Pay now', summary: "Press 'Pay now' on example.com" });
    expect(gateRememberable({ host: null, category: 'payment', label: 'Pay' })).toBeNull();
    expect(gateRememberable({ host: 'localhost', category: 'payment', label: 'Pay' })).toBeNull();
    expect(gateRememberable({ host: 'example.com', category: 'payment', label: null })).toBeNull();
    expect(gateRememberable({ host: 'example.com', category: 'payment', label: '  ...  ' })).toBeNull();
    expect(gateRememberable({ host: 'example.com', category: 'everything', label: 'Pay' })).toBeNull();
    expect(gateRememberable(null)).toBeNull();
  });

  it('askRememberable: the topic and the site; never "other"', () => {
    expect(askRememberable('choose_date', 'https://a.example.com/x')).toEqual({ kind: 'ask', host: 'example.com', category: null, matchKey: 'choose_date', summary: 'Choose dates on example.com' });
    expect(askRememberable('other', 'https://a.example.com/x')).toBeNull();
    expect(askRememberable('choose_date', null)).toBeNull();
    expect(askRememberable('choose_date', 'chrome://settings')).toBeNull();
  });

  it('askTopicsLine: the ask topics of the current site, in plain words; nothing without one', () => {
    expect(askTopicsLine('example.com', ['choose_date', 'open_menu', 'choose_date'])).toBe(
      'On example.com the owner does not want to be asked before: choosing dates, opening menus. (When you ask anyway, give request_human the topic.)',
    );
    expect(askTopicsLine('example.com', ['other'])).toBeNull();
    expect(askTopicsLine('example.com', [])).toBeNull();
    expect(askTopicsLine(null, ['choose_date'])).toBeNull();
    // A gate key is never a topic: it is not listed.
    expect(askTopicsLine('example.com', ['pay'])).toBeNull();
  });

  it('savedApprovalsLine: one sentence for the end of a run', () => {
    expect(savedApprovalsLine([])).toBeNull();
    expect(savedApprovalsLine([{ summary: "Press 'Pay' on example.com" }])).toBe("1 step went ahead on a saved approval: Press 'Pay' on example.com.");
    expect(savedApprovalsLine([{ summary: "Press 'Pay' on example.com" }, { summary: "Press 'Pay' on example.com" }])).toBe("2 steps went ahead on a saved approval: Press 'Pay' on example.com.");
    expect(savedApprovalsLine([{ summary: "Press 'Pay' on example.com" }, { summary: "Press 'Send' on example.org" }])).toBe("2 steps went ahead on saved approvals: Press 'Pay' on example.com; Press 'Send' on example.org.");
  });

  it('knownAmount: the one money parameter of the task (#552); unknown otherwise', () => {
    const task = { parameters: [{ key: 'amount', type: 'money' }, { key: 'phone', type: 'phone' }] };
    expect(knownAmount({ task, inputs: { values: { amount: { value: '25' } } } })).toBe(25);
    expect(knownAmount({ task, inputs: { values: { amount: { value: '$1,250.50' } } } })).toBe(1250.5);
    expect(knownAmount({ task, inputs: { values: { amount: { value: 'twenty' } } } })).toBeNull();
    expect(knownAmount({ task, inputs: null })).toBeNull();
    expect(knownAmount({ task: null, inputs: { values: { amount: { value: '25' } } } })).toBeNull();
    expect(knownAmount({ task: { parameters: [{ key: 'a', type: 'money' }, { key: 'b', type: 'money' }] }, inputs: { values: { a: { value: '1' }, b: { value: '2' } } } })).toBeNull();
  });

  it('with maxAmount 50: 25 passes, 75 asks, an unknown amount asks', () => {
    const rule = { id: 'r', kind: 'gate' as const, host: 'example.com', category: 'payment', matchKey: 'pay', taskId: null, conversationId: null, maxAmount: '50.00', expiresAt: null, enabled: true };
    const q = (amount: number | null) => ({ kind: 'gate' as const, host: 'example.com', category: 'payment', matchKey: 'pay', taskId: null, conversationId: null, amount, now: new Date() });
    const task = { parameters: [{ key: 'amount', type: 'money' }] };
    expect(findRule([rule], q(knownAmount({ task, inputs: { values: { amount: { value: '25' } } } })))).toBe(rule);
    expect(findRule([rule], q(knownAmount({ task, inputs: { values: { amount: { value: '75' } } } })))).toBeNull();
    expect(findRule([rule], q(knownAmount({ task: null })))).toBeNull();
  });

  it('the answer contract: rememberRule is strict; a question spec never takes rememberable or gate from a request', () => {
    expect(questionAnswerSchema.safeParse({ outcome: 'completed', value: 'approve', rememberRule: { enabled: true, scope: 'this_task', maxAmount: 50, expiresInDays: 30 } }).success).toBe(true);
    expect(questionAnswerSchema.safeParse({ outcome: 'completed', value: 'approve', rememberRule: { enabled: false } }).success).toBe(false);
    expect(questionAnswerSchema.safeParse({ outcome: 'completed', value: 'approve', rememberRule: { enabled: true, host: 'evil.example.net' } }).success).toBe(false);
    expect(questionAnswerSchema.safeParse({ outcome: 'completed', value: 'approve', rememberRule: { enabled: true, scope: 'everywhere_on_the_web' } }).success).toBe(false);
    expect(questionAnswerSchema.safeParse({ outcome: 'completed', value: 'approve', rememberRule: { enabled: true, maxAmount: -1 } }).success).toBe(false);
    const spec = questionSpecSchema.parse({ kind: 'confirmation', input: 'confirm', prompt: 'May I?', rememberable: { kind: 'gate', host: 'evil.example.net' }, gate: { host: 'x' } } as never);
    expect('rememberable' in spec).toBe(false);
    expect('gate' in spec).toBe(false);
  });

  it('the channel rule: only the signed-in web and Android app may tick it', () => {
    expect([...REMEMBER_RULE_CHANNELS]).toEqual(['web', 'android_app']);
    expect(mayRememberOn('web')).toBe(true);
    expect(mayRememberOn('android_app')).toBe(true);
    for (const c of ['notification', 'webhook', 'mcp', 'mcp-oauth.claude', 'mcp-elicitation.chatgpt', 'mcp-app.claude', 'cli', 'tui', 'api', 'inbox']) expect(mayRememberOn(c)).toBe(false);
  });
});
