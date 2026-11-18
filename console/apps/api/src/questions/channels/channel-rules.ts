// What each kind of channel may collect (epic #285), as plain functions over
// a question, so the channel that offers an answer and the route that takes
// it apply the same rule.
//
// - Public answers (choice, multi_choice, text, number, low-risk confirm)
//   can be collected on any channel.
// - A secret: every channel gets only a link to the protected page.
// - A high-risk confirm: only where the console signs the person in (web,
//   Android app, CLI/TUI); never a webhook or a push button.
// - takeover and none need the page itself.
// - An MCP client signed in with OAuth (a hosted chat app) relays what the
//   person typed in the chat, and an MCP elicitation is a form the client
//   draws: neither is a console sign-in, so they collect public answers only
//   (#463). A personal access token (channel `mcp`) is the person's own
//   credential and keeps answering everything but a secret's value.
// - The MCP Apps question card (#467, channel `mcp-app`) is a form the
//   person clicks in the chat: a first-hand answer, but still not a console
//   sign-in, so it collects public answers and acknowledgements only.
//
// Which inputs are public and which need a sign-in are the shared answer
// rules (packages/shared/question-rules.js), the ones the web form and the
// widgets read too.
import { isPublicAnswer as sharedIsPublicAnswer, needsSignedIn as sharedNeedsSignedIn } from '@app/shared/question-rules';

import type { QuestionInputType, QuestionOption } from '../questions.contract';

/** The fields of a question the rules read. */
export interface RuleQuestion {
  input: QuestionInputType | string;
  risk: 'low' | 'high' | string | null;
  options: QuestionOption[] | null;
  confirmLabel?: string | null;
  denyLabel?: string | null;
}

/** Whether the answer is public: a channel that does not sign the person in (a webhook) may collect it (packages/shared/question-rules.js). */
export function isPublicAnswer(q: RuleQuestion): boolean {
  return sharedIsPublicAnswer(q);
}

/** Whether a channel signs the person in to the console itself (the rule for high-risk confirms and secrets). */
export interface ChannelRule {
  signedIn: boolean;
  /** What the channel is, for the docs and the refusal. */
  label: string;
}

/**
 * Every channel an answer is recorded under, by its id (the part before a
 * `.`: `mcp-elicitation.claude` is `mcp-elicitation` from a Claude client).
 * A channel that is not signed in never records a secret or approves a
 * high-risk confirm: `QuestionsService` refuses it (`CHANNEL_NOT_ALLOWED`).
 * What else a channel offers (one-tap buttons, public answers only) is its
 * own business (`quickAnswers`, `isPublicAnswer`). Unknown ids are treated
 * as signed in (the REST caller is the person, as before).
 */
export const CHANNEL_RULES: Readonly<Record<string, ChannelRule>> = {
  web: { signedIn: true, label: 'the web app' },
  android_app: { signedIn: true, label: 'the Android app' },
  cli: { signedIn: true, label: 'the CLI' },
  tui: { signedIn: true, label: 'the terminal app' },
  inbox: { signedIn: true, label: 'the inbox' },
  api: { signedIn: true, label: 'the REST API' },
  mcp: { signedIn: true, label: 'an MCP client with a personal access token' },
  notification: { signedIn: false, label: 'a notification button' },
  webhook: { signedIn: false, label: 'a webhook receiver' },
  'mcp-oauth': { signedIn: false, label: 'an AI app connected with OAuth, relaying the chat' },
  'mcp-elicitation': { signedIn: false, label: "an AI app's form (MCP elicitation)" },
  'mcp-app': { signedIn: false, label: "an AI app's question card (MCP Apps), where the person clicked" },
};

/** The rule id of a channel label (`mcp-elicitation.claude` → `mcp-elicitation`). */
export function channelId(channel: string): string {
  return channel.split('.')[0] ?? channel;
}

/** Whether a question needs a signed-in channel to be answered: a secret, or a confirm that is not low risk (packages/shared/question-rules.js). */
export function needsSignedIn(q: Pick<RuleQuestion, 'input' | 'risk'>): boolean {
  return sharedNeedsSignedIn(q);
}

/** Whether `channel` may record this answer to `q`. Declining is allowed everywhere. */
export function mayAnswerOn(channel: string, q: Pick<RuleQuestion, 'input' | 'risk'>, outcome: 'completed' | 'cancelled' = 'completed'): boolean {
  if (outcome === 'cancelled') return true;
  const rule = CHANNEL_RULES[channelId(channel)];
  return !rule || rule.signedIn || !needsSignedIn(q);
}

/** One quick-answer button: what it says and the answer value it sends. */
export interface QuickAnswer {
  title: string;
  value: string;
}

const label = (s: string) => (s.length > 64 ? `${s.slice(0, 63)}…` : s);

/**
 * The notification buttons that answer a question in one tap, or `null`:
 * a low-risk confirm (Approve / Deny) or a choice with exactly two options
 * (one button each). Everything else opens the question.
 */
export function quickAnswers(q: RuleQuestion): QuickAnswer[] | null {
  if (q.input === 'confirm' && q.risk === 'low') {
    return [
      { title: label(q.confirmLabel || 'Approve'), value: 'approve' },
      { title: label(q.denyLabel || 'Deny'), value: 'deny' },
    ];
  }
  if (q.input === 'choice' && q.options?.length === 2) return q.options.map((o) => ({ title: label(o.label), value: o.id }));
  return null;
}

/**
 * The channels where "Don't ask again" may be ticked (#555): only where a secret may be answered by the person
 * signed in to the console in a browser, the web app and the Android app. A notification button, the answer
 * link, a webhook, the MCP relay, an elicitation form, an MCP Apps card and a hosted AI app approve once and
 * cannot make a saved approval; the CLI and a REST caller with a token neither.
 */
export const REMEMBER_RULE_CHANNELS: readonly string[] = ['web', 'android_app'];

/** Whether `channel` may create a saved approval with its answer (#555). */
export function mayRememberOn(channel: string): boolean {
  return REMEMBER_RULE_CHANNELS.includes(channelId(channel));
}
