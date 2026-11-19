// "Save this login?" (E37.4b), the pure parts: the question kind's contract, which channels may answer it, the origin and
// name the offer is made with, the owner's "never for this site" list in their settings, and what the Activity list keeps.
import { answerError, chatAnswerMode, needsSignedIn } from '@app/shared/question-rules';

import { CHANNEL_RULES, SAVE_LOGIN_ANSWER_CHANNELS, mayAnswerOn, quickAnswers } from '../src/questions/channels/channel-rules';
import { AnswerInvalidError, QUESTION_INPUTS, SAVE_LOGIN_VALUE_TTL_MS, SERVER_QUESTION_INPUTS, questionAnswerSchema, questionSpecSchema, saveLoginProposalSchema, toResponse, validateAnswer } from '../src/questions/questions.contract';
import { SAVE_LOGIN_PROMPT, isOwnerCardInput, saveLoginCardOf } from '../src/questions/questions.service';
import { ACTIVITY_OUTCOMES, ACTIVITY_PURPOSES, isRefusal, sanitizeSecretsEvent } from '../src/secrets/secrets-activity';
import { offeredName, signInOrigin } from '../src/secrets/save-login.service';
import { MAX_NEVER_SAVE_SITES, SECRETS_USER_SETTINGS, neverSaveLoginSitesOf } from '../src/secrets/secrets.settings';

const proposal = {
  site: 'signin.example.test',
  origin: 'https://signin.example.test',
  domain: 'example.test',
  name: 'Example sign-in',
  username: 'person-a@example.test',
  handoffId: '7f1c2e9a-0000-4000-8000-0000000000b1',
  provider: 'vault' as const,
  valueExpiresAt: '2030-01-01T00:10:00.000Z',
};

describe('the save_login question kind', () => {
  it('is made by the server only: it is not an input an agent or an API caller may ask with', () => {
    expect(SERVER_QUESTION_INPUTS).toContain('save_login');
    expect(QUESTION_INPUTS as readonly string[]).not.toContain('save_login');
    expect(questionSpecSchema.safeParse({ input: 'save_login', kind: 'login', prompt: 'Save this?' }).success).toBe(false);
    expect(isOwnerCardInput('save_login')).toBe(true);
    expect(isOwnerCardInput('memory')).toBe(true);
    expect(isOwnerCardInput('credentials')).toBe(false);
  });

  it('holds the site, the suggested name and the username, never a password; the card does not carry the fabric handoff', () => {
    expect(saveLoginProposalSchema.safeParse(proposal).success).toBe(true);
    // A password has no place on the proposal: strict.
    expect(saveLoginProposalSchema.safeParse({ ...proposal, password: 'x' }).success).toBe(false);
    expect(saveLoginProposalSchema.safeParse({ ...proposal, name: '' }).success).toBe(false);
    expect(saveLoginProposalSchema.safeParse({ ...proposal, name: 'two\nlines' }).success).toBe(false);
    expect(saveLoginProposalSchema.safeParse({ ...proposal, handoffId: 'not-a-uuid' }).success).toBe(false);
    const card = saveLoginCardOf({ input: 'save_login', proposal: proposal as never });
    expect(card).toEqual({ site: 'signin.example.test', domain: 'example.test', name: 'Example sign-in', username: 'person-a@example.test', valueExpiresAt: '2030-01-01T00:10:00.000Z' });
    expect(JSON.stringify(card)).not.toContain(proposal.handoffId);
    expect(saveLoginCardOf({ input: 'memory', proposal: proposal as never })).toBeNull();
    // The prompt, shown in lists and notifications, names nothing.
    expect(SAVE_LOGIN_PROMPT).not.toMatch(/example|person-a/);
    // The fabric holds the password for ten minutes after the answer.
    expect(SAVE_LOGIN_VALUE_TTL_MS).toBe(10 * 60_000);
  });

  it('is answered with a name (Save), declined (Not now) or declined with "Never for this site"', () => {
    const q = { input: 'save_login' as const, options: null, constraints: null };
    expect(validateAnswer(q, questionAnswerSchema.parse({ outcome: 'completed', saveLogin: { name: '  Example sign-in  ' } }))).toEqual({ outcome: 'completed', saveLogin: { name: 'Example sign-in' } });
    expect(validateAnswer(q, questionAnswerSchema.parse({ outcome: 'cancelled' }))).toEqual({ outcome: 'cancelled' });
    expect(validateAnswer(q, questionAnswerSchema.parse({ outcome: 'cancelled', neverForSite: true }))).toEqual({ outcome: 'cancelled', neverForSite: true });
    // Save needs a name; there is no value, no secret and no memory to give; "never" is a declined answer.
    expect(() => validateAnswer(q, questionAnswerSchema.parse({ outcome: 'completed' }))).toThrow(AnswerInvalidError);
    expect(() => validateAnswer(q, questionAnswerSchema.parse({ outcome: 'completed', value: 'x' }))).toThrow(AnswerInvalidError);
    expect(() => validateAnswer(q, questionAnswerSchema.parse({ outcome: 'completed', saveLogin: { name: 'A' }, neverForSite: true }))).toThrow(/declined/);
    expect(() => validateAnswer(q, { outcome: 'completed', saveLogin: { name: 'x'.repeat(201) } } as never)).not.toThrow(); // the schema, not validateAnswer, bounds the name
    expect(questionAnswerSchema.safeParse({ outcome: 'completed', saveLogin: { name: 'x'.repeat(201) } }).success).toBe(false);
    expect(questionAnswerSchema.safeParse({ outcome: 'completed', saveLogin: { name: 'A', password: 'x' } }).success).toBe(false);
    // The fields belong to this kind only.
    for (const input of ['memory', 'text', 'credentials', 'confirm'] as const) {
      expect(() => validateAnswer({ input, options: null, constraints: null }, questionAnswerSchema.parse({ outcome: 'completed', saveLogin: { name: 'A' } }))).toThrow(AnswerInvalidError);
      expect(() => validateAnswer({ input, options: null, constraints: null }, questionAnswerSchema.parse({ outcome: 'cancelled', neverForSite: true }))).toThrow(AnswerInvalidError);
    }
  });

  it('records what the owner decided, never a secret', () => {
    const now = new Date('2030-01-01T00:00:00Z');
    expect(toResponse('save_login', { outcome: 'completed', saveLogin: { name: 'Example sign-in' } }, { channel: 'web', by: 'user:1', answeredAt: now })).toEqual({
      outcome: 'completed',
      valueWithheld: false,
      savedAs: 'Example sign-in',
      channel: 'web',
      by: 'user:1',
      answeredAt: now.toISOString(),
    });
    expect(toResponse('save_login', { outcome: 'cancelled', neverForSite: true }, { channel: 'web', answeredAt: now })).toMatchObject({ outcome: 'cancelled', neverForSite: true, valueWithheld: false });
  });
});

describe('who may answer a "Save this login?" card', () => {
  const q = { input: 'save_login', risk: null, fields: null };

  it('only the signed-in web app and the Android app (and the Inbox, which is the web app): saving writes to the owner\'s vault', () => {
    expect([...SAVE_LOGIN_ANSWER_CHANNELS].sort()).toEqual(['android_app', 'inbox', 'web']);
    for (const ch of ['web', 'android_app', 'inbox', 'web.chrome']) {
      expect(mayAnswerOn(ch, q, 'completed')).toBe(true);
      expect(mayAnswerOn(ch, q, 'cancelled')).toBe(true);
    }
  });

  it('never a hosted app, a webhook, a notification action, MCP, the REST API under another name or the CLI: not to save and not to decline', () => {
    const others = Object.keys(CHANNEL_RULES).filter((c) => !SAVE_LOGIN_ANSWER_CHANNELS.includes(c));
    expect(others).toEqual(expect.arrayContaining(['notification', 'webhook', 'mcp-oauth', 'mcp-elicitation', 'mcp-app', 'mcp', 'cli', 'tui', 'api']));
    for (const ch of [...others, 'mcp-elicitation.claude', 'unknown-channel']) {
      expect(mayAnswerOn(ch, q, 'completed')).toBe(false);
      expect(mayAnswerOn(ch, q, 'cancelled')).toBe(false);
    }
  });

  it('is signed-in only in the shared rules the web form and the widgets read, and offers no one-tap notification button', () => {
    expect(needsSignedIn(q)).toBe(true);
    expect(chatAnswerMode(q)).toBe('signed_in');
    expect(quickAnswers({ ...q, options: null })).toBeNull();
    expect(answerError(q, { outcome: 'completed' })).toBeNull();
  });
});

describe('the sign-in page and the name the offer is made with', () => {
  it('binds the login to an https origin (or loopback http), never a path, never another scheme', () => {
    expect(signInOrigin('https://signin.example.test/login?next=%2F#x')).toBe('https://signin.example.test');
    expect(signInOrigin('https://signin.example.test:8443/a')).toBe('https://signin.example.test:8443');
    expect(signInOrigin('http://127.0.0.1:3000/login')).toBe('http://127.0.0.1:3000');
    for (const bad of ['http://signin.example.test/login', 'ftp://signin.example.test', 'about:blank', 'javascript:alert(1)', 'not a url', '', null, undefined]) expect(signInOrigin(bad as never)).toBeNull();
  });

  it('offers the model\'s name as one clean line, or the site when it gave none', () => {
    expect(offeredName('  Example   Bank \n login ', 'signin.example.test')).toBe('Example Bank login');
    expect(offeredName('', 'signin.example.test')).toBe('signin.example.test');
    expect(offeredName(null, 'signin.example.test')).toBe('signin.example.test');
    expect(offeredName('x'.repeat(500), 'a.example.test')).toHaveLength(120);
  });
});

describe('"Never for this site" in the owner\'s settings', () => {
  const merge = SECRETS_USER_SETTINGS.merge;

  it('is a list of registrable domains, kept with the other secrets settings and dropped when everything is at its default', () => {
    expect(neverSaveLoginSitesOf({ secrets: { neverSaveLoginSites: ['example.test', 3, 'shop.example.org'] } })).toEqual(['example.test', 'shop.example.org']);
    expect(neverSaveLoginSitesOf(undefined)).toEqual([]);
    expect(neverSaveLoginSitesOf({ secrets: {} })).toEqual([]);
    const withSite = merge({ agentUse: { enabled: false } }, { neverSaveLoginSites: ['example.test'] });
    expect(withSite).toEqual({ agentUse: { enabled: false }, neverSaveLoginSites: ['example.test'] });
    // Another change keeps the list; emptying it with nothing else set stores nothing.
    expect(merge(withSite, { agentUse: { enabled: true } })).toEqual({ agentUse: { enabled: true }, neverSaveLoginSites: ['example.test'] });
    expect(merge(withSite, { neverSaveLoginSites: [] })).toBeUndefined();
    // No duplicates.
    expect(merge(undefined, { neverSaveLoginSites: ['example.test', 'example.test'] })).toEqual({ agentUse: { enabled: false }, neverSaveLoginSites: ['example.test'] });
    expect(MAX_NEVER_SAVE_SITES).toBe(200);
  });

  it('accepts a site and refuses anything else', () => {
    const ok = SECRETS_USER_SETTINGS.patchSchema.safeParse({ neverSaveLoginSites: ['Example.Test'] });
    expect(ok.success && ok.data.neverSaveLoginSites).toEqual(['example.test']);
    for (const bad of [['https://example.test/'], ['a b'], [''], Array.from({ length: MAX_NEVER_SAVE_SITES + 1 }, (_, i) => `s${i}.example.test`)]) {
      expect(SECRETS_USER_SETTINGS.patchSchema.safeParse({ neverSaveLoginSites: bad }).success).toBe(false);
    }
  });
});

describe('the Activity list knows a save', () => {
  const event = (data: Record<string, unknown>) => ({ type: 'secrets.release', at: '2030-01-01T00:00:00Z', data: { owner_id: '11111111-1111-4111-8111-111111111111', op_id: '22222222-2222-4222-8222-222222222222', provider: 'vault', field: 'password', origin: 'https://signin.example.test', purpose: 'save_login', outcome: 'saved', released: true, ...data } });

  it('keeps the purpose and the outcome from its closed lists, and a save is not a refusal', () => {
    expect(ACTIVITY_PURPOSES).toContain('save_login');
    expect(ACTIVITY_OUTCOMES).toEqual(expect.arrayContaining(['saved', 'name_taken', 'secret_unavailable', 'unsupported']));
    expect(isRefusal('saved')).toBe(false);
    for (const o of ['name_taken', 'secret_unavailable', 'unauthorized', 'unsupported']) expect(isRefusal(o)).toBe(true);
    expect(sanitizeSecretsEvent(event({}))).toMatchObject({ event: 'release', field: 'password', purpose: 'save_login', outcome: 'saved', site: 'signin.example.test', released: true });
    expect(sanitizeSecretsEvent(event({ outcome: 'name_taken', released: false }))).toMatchObject({ outcome: 'name_taken', released: false });
  });

  it('copies nothing else out of the event: a password or a username put in it by mistake is dropped', () => {
    const row = sanitizeSecretsEvent(event({ password: 'CANARY-pw', username: 'person-a@example.test', name: 'Example sign-in', value: 'CANARY-pw' }));
    expect(JSON.stringify(row)).not.toMatch(/CANARY-pw|person-a@|Example sign-in/);
    // An outcome the lists do not know is `other`, never a copy of the text.
    expect(sanitizeSecretsEvent(event({ outcome: 'CANARY-pw' }))).toMatchObject({ outcome: 'other' });
  });
});
