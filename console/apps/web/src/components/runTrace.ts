// How a run's trace reads on its page (#544): the questions it asked with the
// answers given, the owner's guidance, and the captions of its key-moment
// pictures (#541). Pure.
import type { RunStep, ScreenshotMoment, StepQuestion } from '../types/runs';
import { formatTime } from '../ui';
import { shortDuration } from './runRow';

/** The caption of each key moment's picture. */
export const MOMENT_CAPTION: Record<ScreenshotMoment, string> = {
  question: 'The screen when the agent asked',
  before_confirmed: 'The screen when the agent asked',
  after_confirmed: 'After the confirmed step',
  failure: 'When it stopped',
  final: 'Final screen',
};

/** "1 area masked", "3 areas masked", or null for none. */
export function maskedWords(n: number | null | undefined): string | null {
  if (!n || n <= 0) return null;
  return `${n} ${n === 1 ? 'area' : 'areas'} masked`;
}

/** The caption of a step's picture: its moment, or "Screen" for one without. */
export function imageCaption(step: Pick<RunStep, 'screenshotMoment'>): string {
  return step.screenshotMoment ? MOMENT_CAPTION[step.screenshotMoment] : 'Screen';
}

/** The picture's caption with how much was masked: "Final screen · 2 areas masked". */
export function imageCaptionLong(step: Pick<RunStep, 'screenshotMoment' | 'screenshotMasked'>): string {
  return [imageCaption(step), maskedWords(step.screenshotMasked)].filter(Boolean).join(' · ');
}

/** The owner's answer step (#541): a `handoff` the runner writes when a question is answered. Not an action. */
export const isAnswerStep = (s: Pick<RunStep, 'kind' | 'action'>) => s.kind === 'handoff' && s.action === 'answered';

/** A step that asked a person: it carries the question and is not the answer. */
export const isQuestionStep = (s: Pick<RunStep, 'kind' | 'action' | 'question'>) => Boolean(s.question) && !isAnswerStep(s);

/** A message the owner typed in the chat while the run worked (#490, #541). */
export const isGuidanceStep = (s: Pick<RunStep, 'kind'>) => s.kind === 'guidance';

/** "You added: …" from the step's "The owner added: …". */
export function guidanceText(summary: string): string {
  const text = summary.replace(/^The owner added:\s*/i, '').trim();
  return `You added: ${text}`;
}

/** The chip of a question's kind: Confirmation, Sign-in, Code, Choice, or Question. */
export function questionKindLabel(q: Pick<StepQuestion, 'kind' | 'input'>): string {
  if (q.input === 'confirm' || q.kind === 'confirmation') return 'Confirmation';
  if (q.input === 'credentials' || q.kind === 'login' || q.kind === 'passkey') return 'Sign-in';
  if (q.kind === 'code' || q.kind === 'captcha' || q.input === 'secret') return 'Code';
  if (q.input === 'choice' || q.input === 'multi_choice') return 'Choice';
  if (q.input === 'form') return 'Details';
  return 'Question';
}

/** Where a person answered, in words; `fromChat` names the chat for a chat run's console answer. */
export function channelWords(channel: string | null | undefined, fromChat = false): string | null {
  if (!channel) return null;
  if (channel === 'web') return fromChat ? 'from the chat' : 'from the console';
  if (channel === 'cli') return 'from the CLI';
  if (channel === 'push') return 'from a notification';
  if (channel === 'android') return 'from the Android app';
  if (channel === 'webhook') return 'from a link';
  if (channel === 'api') return 'through the API';
  if (channel.startsWith('mcp')) return 'from an AI app';
  return `from ${channel}`;
}

/** What the answer was: Allowed, Declined, Provided (not recorded), Chose: …, Answered: … */
function outcomeWords(q: StepQuestion): string {
  const a = q.answer!;
  if (a.outcome === 'cancelled') return 'Declined';
  if (a.valueWithheld) return 'Provided (not recorded)';
  if (q.input === 'confirm') return a.value === 'deny' ? 'Declined' : 'Allowed';
  if (q.input === 'none' || q.input === 'takeover') return 'Done';
  if (q.input === 'form') return 'Provided';
  if (!a.value) return 'Answered';
  if ((q.input === 'choice' || q.input === 'multi_choice') && q.options) {
    const labels = a.value.split(',').map((id) => id.trim()).map((id) => q.options!.find((o) => o.id === id)?.label ?? id);
    return `Chose: ${labels.join(', ')}`;
  }
  return `Answered: ${a.value}`;
}

/** The answer line under a question, and whether the question still waits (then it links to its card). */
export interface AnswerLine {
  text: string;
  state: 'answered' | 'declined' | 'pending' | 'expired' | 'cancelled';
}

/**
 * The line under a question step: "Allowed · from the chat · 12:41 PM · waited 38 s",
 * "Declined", "Provided (not recorded)", "Expired", or "Waiting for your answer".
 * `askedAt` is the question step's time; `answeredAt` falls back to the answer step's.
 */
export function answerLine(q: StepQuestion, ctx: { askedAt?: string; answeredAt?: string | null; fromChat?: boolean; timeZone?: string } = {}): AnswerLine {
  if (!q.answer) {
    if (q.status === 'expired') return { text: 'Expired', state: 'expired' };
    if (q.status === 'cancelled') return { text: 'Cancelled', state: 'cancelled' };
    return { text: 'Waiting for your answer', state: 'pending' };
  }
  const words = outcomeWords(q);
  const at = q.answer.answeredAt ?? ctx.answeredAt ?? null;
  const asked = ctx.askedAt ? Date.parse(ctx.askedAt) : Number.NaN;
  const answered = at ? Date.parse(at) : Number.NaN;
  const waited = Number.isNaN(asked) || Number.isNaN(answered) || answered < asked ? null : `waited ${shortDuration(answered - asked)}`;
  const parts = [words, channelWords(q.answer.channel, ctx.fromChat), at ? formatTime(at, ctx.timeZone ? { timeZone: ctx.timeZone } : {}) : null, waited];
  return { text: parts.filter(Boolean).join(' · '), state: words === 'Declined' ? 'declined' : 'answered' };
}

/** A form's answer, one line per field (E40.2): "Amount: 25", or "Card PIN: provided" for a sensitive field. */
export function formAnswerLines(q: StepQuestion): string[] {
  return (q.answer?.fields ?? []).map((f) => `${f.label}: ${f.value ?? 'provided'}`);
}

/** The steps that have a picture, oldest first: the lightbox's previous and next. */
export function pictureSteps<S extends Pick<RunStep, 'seq' | 'hasScreenshot'>>(steps: readonly S[]): S[] {
  return steps.filter((s) => s.hasScreenshot).sort((a, b) => a.seq - b.seq);
}
