// What the browser agent is told about asking its person (#524, #527): a
// sign-in is the agent's job, asked for in one request, the site's "remember
// me" is the person's choice, and a takeover is the exception.
import { INSTRUCTIONS, answerLine, requestHumanSpec } from '../src/runner/goal-runner.service';

describe("the browser agent's instructions for a sign-in", () => {
  const signIn = INSTRUCTIONS.slice(INSTRUCTIONS.indexOf('When you need the person:'));

  it('tells it to sign in itself and not to send the person to the browser', () => {
    expect(signIn).toContain('Signing in is your job, not theirs.');
    expect(signIn).toContain('Do not ask them to sign in in the browser.');
  });

  it('asks for the username and password in one request, then a code as a secret', () => {
    const both = signIn.indexOf('kind "login", input "credentials"');
    const code = signIn.indexOf('kind "code", input "secret"');
    expect(both).toBeGreaterThan(-1);
    expect(code).toBeGreaterThan(both);
    expect(signIn).toContain('Ask for the username and password together, in one request');
    expect(signIn).toContain('Never ask for a password or a code with input "text".');
    expect(signIn).toContain('type_handoff_secret (you never see secret values)');
  });

  it('passes the page\'s "remember me" words, and follows the person\'s choice only', () => {
    expect(signIn).toContain('pass its words as remember_label');
    expect(signIn).toContain('Without their answer, leave the box as it is.');
  });

  it('keeps a takeover for what cannot be typed for the person', () => {
    expect(signIn).toMatch(/Use input "takeover" only for what cannot be typed for them: a passkey or security-key touch, a CAPTCHA puzzle you cannot pass/);
    expect(signIn).toContain('when they declined to sign in');
  });
});

describe('the remember option between the model and the person', () => {
  const base = { kind: 'login', prompt: 'Sign in to Example Bank', choices: null, options: null, constraints: null, confirm_label: null, deny_label: null, risk: null };

  it('carries the page\'s words on a sign-in or a code, one line and at most 80 characters, and nowhere else', () => {
    expect(requestHumanSpec({ ...base, input: 'credentials', remember_label: '  Keep me\n signed in ' })).toMatchObject({ input: 'credentials', rememberLabel: 'Keep me signed in' });
    expect(requestHumanSpec({ ...base, input: 'secret', remember_label: 'x'.repeat(120) }).rememberLabel).toHaveLength(80);
    expect(requestHumanSpec({ ...base, input: 'text', remember_label: 'Remember me' })).not.toHaveProperty('rememberLabel');
    expect(requestHumanSpec({ ...base, input: 'credentials', remember_label: null })).not.toHaveProperty('rememberLabel');
  });

  it('tells the model what the person chose, and nothing when they were not asked', () => {
    const a = { input: 'credentials', kind: 'login', value: 'oscar', options: null, unit: null };
    expect(answerLine({ ...a, rememberLabel: 'Remember me', remember: true })).toMatch(/Type the username "oscar" with type_text[\s\S]*type_handoff_secret[\s\S]*chose to tick "Remember me": make sure that box is ticked/);
    expect(answerLine({ ...a, rememberLabel: 'Remember me', remember: false })).toContain('chose not to tick "Remember me": make sure that box is unticked');
    expect(answerLine({ ...a, rememberLabel: null })).not.toMatch(/tick/);
    expect(answerLine({ input: 'secret', kind: 'code', options: null, unit: null, rememberLabel: 'Trust this device', remember: true })).toContain('chose to tick "Trust this device"');
  });
});
