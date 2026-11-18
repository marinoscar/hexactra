// What the browser agent is told about asking its person (#524): a sign-in is
// the agent's job, asked for value by value, and a takeover is the exception.
import { INSTRUCTIONS } from '../src/runner/goal-runner.service';

describe("the browser agent's instructions for a sign-in", () => {
  const signIn = INSTRUCTIONS.slice(INSTRUCTIONS.indexOf('When you need the person:'));

  it('tells it to sign in itself and not to send the person to the browser', () => {
    expect(signIn).toContain('Signing in is your job, not theirs.');
    expect(signIn).toContain('Do not ask them to sign in in the browser.');
  });

  it('gives the order: the username as text, the password as a secret, then a code as a secret', () => {
    const username = signIn.indexOf('kind "login", input "text"');
    const password = signIn.indexOf('kind "login", input "secret"');
    const code = signIn.indexOf('kind "code", input "secret"');
    expect(username).toBeGreaterThan(-1);
    expect(password).toBeGreaterThan(username);
    expect(code).toBeGreaterThan(password);
    expect(signIn).toContain('Never ask for a password or a code with input "text".');
    expect(signIn).toContain('type_handoff_secret: you never see secret values');
  });

  it('keeps a takeover for what cannot be typed for the person', () => {
    expect(signIn).toMatch(/Use input "takeover" only for what cannot be typed for them: a passkey or security-key touch, a CAPTCHA puzzle you cannot pass/);
    expect(signIn).toContain('when they declined to give a username, password or code');
  });
});
