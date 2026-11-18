// The question channels (#289) without a database: which answers each
// channel may collect, the push payload's quick actions and deep link per
// input type, the webhook payloads with and without an answer token, and
// that no payload ever carries a secret value.
import type { ConfigService } from '@nestjs/config';
import { sanitizePushExtras, type NotificationEventDef } from '@marinoscar/platform-api/notifications';

import { HEXACTRA_NOTIFICATIONS, QUESTION_ASKED_EVENT, hexactraPushPayload } from '../src/platform/notifications/hexactra.notifications';
import { QUESTION_ANSWERED_WEBHOOK, questionAskedWebhookSchema, questionSettledWebhookSchema } from '../src/platform/webhooks/hexactra.webhook-events';
import * as sharedRules from '@app/shared/question-rules';

import { isPublicAnswer, mayAnswerOn, quickAnswers } from '../src/questions/channels/channel-rules';
import { NotificationsQuestionChannel } from '../src/questions/channels/notifications.channel';
import { QuestionChannelRegistry } from '../src/questions/channels/question-channel';
import { QuestionChannelDispatcher } from '../src/questions/channels/question-dispatcher';
import { WebhookQuestionChannel } from '../src/questions/channels/webhook.channel';
import type { QuestionView } from '../src/questions/questions.service';
import type { ActionTokenStore } from '../src/tasks/action-token-store';
import { RunActionTokens } from '../src/tasks/run-action-token';

const ID = '33333333-3333-4333-8333-333333333333';
const OWNER = '44444444-4444-4444-8444-444444444444';
const SECRET = 'hunter2-secret-value';
const two = [
  { id: 'early', label: '7:05 flight' },
  { id: 'late', label: '18:40 flight' },
];

function view(over: Partial<QuestionView>): QuestionView {
  return {
    id: ID,
    askedBy: 'agent:test',
    runId: null,
    client: null,
    blocking: true,
    proposal: null,
    conversationId: null,
    handoffId: null,
    browserBound: false,
    input: 'text',
    kind: 'other',
    prompt: 'What should I do?',
    options: null,
    constraints: null,
    confirmLabel: null,
    denyLabel: null,
    risk: null,
    rememberLabel: null,
    gate: null,
    rememberable: null,
    status: 'pending',
    response: null,
    pageTitle: null,
    viewerUrl: null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    answeredAt: null,
    ...over,
  };
}

/** Every input type, as the channels see it. */
const CASES: Record<string, QuestionView> = {
  lowConfirm: view({ input: 'confirm', risk: 'low', confirmLabel: 'Book it', denyLabel: 'Skip' }),
  highConfirm: view({ input: 'confirm', risk: 'high' }),
  choice2: view({ input: 'choice', options: two }),
  choice3: view({ input: 'choice', options: [...two, { id: 'none', label: 'Neither' }] }),
  multi: view({ input: 'multi_choice', options: two }),
  text: view({ input: 'text' }),
  number: view({ input: 'number', constraints: { min: 1, max: 9 } }),
  secret: view({ input: 'secret', runId: '55555555-5555-4555-8555-555555555555' }),
  takeover: view({ input: 'takeover' }),
  none: view({ input: 'none' }),
  credentials: view({ input: 'credentials', kind: 'login', runId: '55555555-5555-4555-8555-555555555555', rememberLabel: 'Keep me signed in' }),
};

beforeAll(() => {
  process.env.JWT_SECRET ??= 'unit-test-jwt-secret-not-real-0000000000';
});

const config = { get: () => 'https://console.example.test/' } as unknown as ConfigService;
let issued = 0;
const store = {
  spendOnce: async () => true,
  issue: async () => `webhook-token-${++issued}-abcdefghijkl`,
} as unknown as ActionTokenStore;

describe('channel rules', () => {
  it('public answers: choice, multi_choice, text, number and a low-risk confirm only', () => {
    const pub = Object.entries(CASES).filter(([, q]) => isPublicAnswer(q)).map(([k]) => k);
    expect(pub.sort()).toEqual(['choice2', 'choice3', 'lowConfirm', 'multi', 'number', 'text']);
  });

  it('quick answers: a low-risk confirm (its labels) and a two-option choice, nothing else', () => {
    expect(quickAnswers(CASES.lowConfirm!)).toEqual([
      { title: 'Book it', value: 'approve' },
      { title: 'Skip', value: 'deny' },
    ]);
    expect(quickAnswers(view({ input: 'confirm', risk: 'low' }))!.map((a) => a.title)).toEqual(['Approve', 'Deny']);
    expect(quickAnswers(CASES.choice2!)).toEqual([
      { title: '7:05 flight', value: 'early' },
      { title: '18:40 flight', value: 'late' },
    ]);
    for (const k of ['highConfirm', 'choice3', 'multi', 'text', 'number', 'secret', 'takeover', 'none']) expect(quickAnswers(CASES[k]!)).toBeNull();
  });

  it('are the shared answer rules the web form and the MCP Apps widgets read (packages/shared/question-rules.js)', () => {
    for (const q of Object.values(CASES)) expect(isPublicAnswer(q)).toBe(sharedRules.isPublicAnswer(q));
    expect(Object.entries(CASES).map(([k, q]) => [k, sharedRules.chatAnswerMode(q)])).toEqual(
      Object.keys(CASES).map((k) => [k, k === 'secret' || k === 'credentials' ? 'secret' : k === 'takeover' ? 'takeover' : k === 'none' ? 'acknowledge' : k === 'highConfirm' ? 'signed_in' : 'form']),
    );
  });

  it('the MCP Apps question card (mcp-app, #467): public answers and acknowledgements, never a secret or a high-risk approval; declining always', () => {
    const allowed = Object.entries(CASES).filter(([, q]) => mayAnswerOn('mcp-app.claude', q)).map(([k]) => k);
    expect(allowed.sort()).toEqual(['choice2', 'choice3', 'lowConfirm', 'multi', 'none', 'number', 'takeover', 'text']);
    expect(mayAnswerOn('mcp-app.chatgpt', CASES.secret!, 'cancelled')).toBe(true);
    expect(mayAnswerOn('mcp-app', CASES.highConfirm!)).toBe(false);
    // A signed-in channel still may.
    expect(mayAnswerOn('web', CASES.highConfirm!)).toBe(true);
  });
});

describe('a sign-in (credentials, #527)', () => {
  it('is answered only where a secret is: signed in to the console, never by a link channel or an AI app; declining always', () => {
    for (const where of ['web', 'inbox', 'chat']) expect(mayAnswerOn(where, CASES.credentials!)).toBe(true);
    for (const where of ['notification', 'webhook', 'mcp-oauth.claude', 'mcp-elicitation.chatgpt', 'mcp-app.claude']) {
      expect(mayAnswerOn(where, CASES.credentials!)).toBe(false);
      expect(mayAnswerOn(where, CASES.credentials!, 'cancelled')).toBe(true);
    }
    expect(isPublicAnswer(CASES.credentials!)).toBe(false);
    expect(quickAnswers(CASES.credentials!)).toBeNull();
  });

  it('a settled sign-in sends a webhook neither the username nor the password', () => {
    const done = view({ input: 'credentials', status: 'answered', response: { outcome: 'completed', value: 'oscar', valueWithheld: true, remember: true, answeredAt: new Date().toISOString() } });
    const out = new WebhookQuestionChannel(new QuestionChannelRegistry(), config, store).settledPayload(done);
    expect(questionSettledWebhookSchema.safeParse(out).success).toBe(true);
    expect(out).toMatchObject({ valueWithheld: true });
    expect(JSON.stringify(out)).not.toContain('oscar');
  });
});

describe('the questions.asked notification', () => {
  const reg = HEXACTRA_NOTIFICATIONS.find((n) => n.event.key === QUESTION_ASKED_EVENT)!;
  const channel = new NotificationsQuestionChannel(new QuestionChannelRegistry(), config, {} as never, new RunActionTokens(store));

  it('reaches the in-app inbox, Web Push, the Android app and email', () => {
    expect(reg.event.channels).toEqual(expect.arrayContaining(['browser', 'push', 'android_app', 'email']));
    expect(reg.emailTemplate).toBe('question-asked');
  });

  it.each(Object.keys(CASES))('%s: deep link, quick actions only where allowed, no answer value', (k) => {
    const q = CASES[k]!;
    const data = channel.payload(q, OWNER);
    expect(data).toMatchObject({ questionId: ID, input: q.input, questionUrl: `https://console.example.test/inbox/q/${ID}` });
    const shown = reg.browserTemplate!(data as never);
    const extras = sanitizePushExtras(hexactraPushPayload(reg.event as NotificationEventDef, data));
    expect(extras.urgency).toBe('high');
    expect(extras.payload.tag).toBe(`question-${ID}`);
    const quick = quickAnswers(q);
    if (quick) {
      expect(shown.link).toBe(`/inbox/q/${ID}?a=${encodeURIComponent(String(data.actionToken))}`);
      expect(extras.payload.actions).toEqual(quick.map((a, i) => ({ action: `answer-${i}`, title: a.title })));
    } else {
      expect(shown.link).toBe(`/inbox/q/${ID}`);
      expect(data.actionToken).toBeUndefined();
      expect(extras.payload.actions).toBeUndefined();
    }
  });

  it('the token answers only the offered values of that question', async () => {
    const tokens = new RunActionTokens(store);
    const data = channel.payload(CASES.choice2!, OWNER);
    const r = await tokens.redeemQuestion(String(data.actionToken), 'answer-1');
    expect(r).toMatchObject({ value: 'late', claims: { questionId: ID, userId: OWNER } });
    // A run token is no question token, and the reverse.
    expect(await tokens.redeem(String(data.actionToken), 'cancel')).toBeNull();
    expect(await tokens.redeemQuestion(tokens.issue(OWNER, ID, null), 'answer-0')).toBeNull();
  });
});

describe('the questions.question.* webhooks', () => {
  const channel = new WebhookQuestionChannel(new QuestionChannelRegistry(), config, store);

  it.each(Object.keys(CASES))('%s: an answer token only for a public answer', async (k) => {
    const q = CASES[k]!;
    const data = (await channel.askedPayload(q))!;
    expect(questionAskedWebhookSchema.safeParse(data).success).toBe(true);
    expect((data.question as { id: string }).id).toBe(ID);
    if (isPublicAnswer(q)) {
      expect(data.answer).toEqual({
        url: `https://console.example.test/api/questions/${ID}/answer-by-token`,
        token: expect.stringMatching(/^webhook-token-/),
        method: 'POST',
        tokenHeader: 'x-question-token',
        expiresAt: q.expiresAt,
      });
    } else expect(data.answer).toBeUndefined();
  });

  it('a settled question carries a public value, never a secret one', () => {
    const answered = view({ input: 'choice', options: two, status: 'answered', response: { outcome: 'completed', value: 'late', valueWithheld: false, channel: 'web', answeredAt: new Date().toISOString() } });
    const pub = channel.settledPayload(answered);
    expect(questionSettledWebhookSchema.safeParse(pub).success).toBe(true);
    expect(pub).toMatchObject({ status: 'answered', outcome: 'completed', value: 'late', channel: 'web' });

    // Even a (wrongly) stored secret value is never sent.
    const secret = view({ input: 'secret', status: 'answered', response: { outcome: 'completed', value: SECRET, valueWithheld: true, answeredAt: new Date().toISOString() } });
    const s = channel.settledPayload(secret);
    expect(questionSettledWebhookSchema.safeParse(s).success).toBe(true);
    expect(s).toMatchObject({ valueWithheld: true });
    expect(JSON.stringify(s)).not.toContain(SECRET);
    expect(QUESTION_ANSWERED_WEBHOOK).toBe('questions.question.answered');

    expect(channel.settledPayload(view({ status: 'expired' }))).toEqual({ question: { id: ID, input: 'text', kind: 'other', runId: null }, status: 'expired' });
  });
});

describe('the channel registry and the dispatcher', () => {
  it('has an open id vocabulary, unique ids, and unregisters', () => {
    const r = new QuestionChannelRegistry();
    const ch = { id: 'fake-chat', canCollect: () => true, deliver: async () => undefined, withdraw: async () => undefined };
    const off = r.register(ch);
    expect(r.get('fake-chat')).toBe(ch);
    expect(() => r.register(ch)).toThrow(/already registered/);
    expect(() => r.register({ ...ch, id: 'Bad Id' })).toThrow(/Invalid/);
    off();
    expect(r.list()).toEqual([]);
  });

  it('asked delivers; answered, cancelled and expired withdraw', () => {
    const base = { questionId: ID, ownerUserId: OWNER, runId: null, input: 'text', kind: 'other', status: 'pending' };
    expect(QuestionChannelDispatcher.payloadFor({ ...base, type: 'question.asked' })).toEqual({ questionId: ID, op: 'deliver', event: 'question.asked', answeredChannel: null });
    for (const type of ['question.answered', 'question.cancelled', 'question.expired'] as const) {
      expect(QuestionChannelDispatcher.payloadFor({ ...base, type, channel: 'web' })).toMatchObject({ op: 'withdraw', event: type });
    }
  });
});
