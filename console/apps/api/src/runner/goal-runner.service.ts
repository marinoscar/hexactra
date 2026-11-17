import { Injectable, Logger, Optional } from '@nestjs/common';
import { AiService, defineTool, type AiDefinedTool, type AiToolLoopResult } from '@marinoscar/platform-api/ai';
import { z } from 'zod';

import { FabricClient, FabricError } from '../fabric/fabric.client';
import { chooseHost } from './host-choice';
import { PrismaService } from '../prisma/prisma.service';
import { questionSpecSchema, type QuestionConstraints, type QuestionInputType, type QuestionOption, type QuestionResponse, type QuestionSpec } from '../questions/questions.contract';
import { QuestionsService } from '../questions/questions.service';
import { redactActionArgs, redactUrl } from '../tasks/redact';
import { RunNotifier } from '../tasks/run-notifier';
import { TasksService } from '../tasks/tasks.service';
import { BROWSER_AGENT_FEATURE_ID } from './browser-agent.feature';
import { FabricSession, handoffOutcome, type CreatedHandoff } from './fabric-session';
import { domainAllowed, looksRisky } from './policy';
import { captureScreen, markCenter, roundInput, type Screen, type ScreenMark, type ScreenView } from './vision';

/** Round-trips per `runTools` call (the platform's cap is 20). */
const CHUNK_STEPS = 20;
/** Lines of the step log handed back to the model each chunk. */
const LOG_LINES = 60;
const OBSERVATION_CHARS = 6_000;

/** What the run keeps between chunks and across a handoff (`runs.transcript`). Never secrets. */
export interface RunMemory {
  log: string[];
  /** A secret handoff whose value `type_handoff_secret` may type (once). */
  secretHandoffId?: string | null;
  /** A person approved one risky action. */
  confirmationGranted?: boolean;
  chunks: number;
  /** The provider refused images: the run continues without screenshots (#366). */
  visionOff?: boolean;
  /** The screen the next round shows the model (default: the page). */
  look?: Screen | null;
}

export type RunOutcome = 'succeeded' | 'failed' | 'cancelled' | 'waiting_human' | 'requeue';

/** Ends a chunk early: the loop is stopped from `onStep`. */
class StopLoop extends Error {
  constructor(readonly reason: 'finish' | 'pause' | 'cancel' | 'budget' | 'look') {
    super(reason);
  }
}

const INSTRUCTIONS = `You are the user's hands and eyes on their own computer. You operate a real Chrome browser, and the desktop it runs on, to reach their goal the way a skilled person sitting at the machine would. You act with the user's full authority.

How to see:
- A round may start with a screenshot of the page, with interactive elements boxed and numbered, and their positions listed. Use it to understand the layout, what is visible, and what changed.
- observe_elements lists interactive elements with CSS selectors; read_text reads the page text. Use them for exact targets and content.
- look takes a fresh screenshot (screen "desktop" shows the whole computer screen). It ends your turn; the next turn starts with the image.

How to act (choose what works, as a person would):
- By element: click and type_text with selectors, or click_mark with a number from the screenshot.
- By position, with real mouse and keyboard events: click_at, hover_at, drag, scroll_at, type_keys, key. Use them for canvas, custom widgets, hover menus, sliders, drag and drop, and whenever a selector click does nothing.
- run_javascript runs any JavaScript in the page and returns its value: read state, fill complex forms, call the page's own functions, or get past a stubborn widget.
- Tabs: tabs, switch_tab, new_tab. navigate opens any URL.
- Outside the page (native file pickers, OS dialogs, permission prompts, other windows): look at the desktop, then desktop_click, desktop_type, desktop_key, desktop_scroll, desktop_drag.
- Check the result of each action before the next one. If something does not work, try another way before giving up.

When you need the person:
- Only for what only they have: a code sent to their phone or email, a passkey or security-key touch, a password you were not given, or a CAPTCHA puzzle you cannot pass (tick an "I am not a robot" box yourself, as a person would). Call request_human. For a code or password they give you, call type_handoff_secret: you never see secret values.
- If a click is refused because the task asks for confirmation before purchases, call request_human with kind "confirmation", then try again.

When done, or when the goal is impossible, call finish with a short, factual result.`;

function trim(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** The model's `request_human` arguments (snake_case, nulls for what does not apply). */
export interface RequestHumanArgs {
  kind: string;
  prompt: string;
  input: string;
  choices?: string[] | null;
  options?: { id: string; label: string; description?: string | null }[] | null;
  constraints?: Partial<Record<'max_length' | 'pattern' | 'multiline' | 'min' | 'max' | 'step' | 'unit' | 'min_selections' | 'max_selections', unknown>> | null;
  confirm_label?: string | null;
  deny_label?: string | null;
  risk?: 'low' | 'high' | null;
}

const CONSTRAINT_FROM_MODEL = {
  max_length: 'maxLength',
  pattern: 'pattern',
  multiline: 'multiline',
  min: 'min',
  max: 'max',
  step: 'step',
  unit: 'unit',
  min_selections: 'minSelections',
  max_selections: 'maxSelections',
} as const;

/** The model's `request_human` arguments as the console's question contract (camelCase, nulls dropped), ready to validate. */
export function requestHumanSpec(a: RequestHumanArgs): Record<string, unknown> {
  const options = a.options?.length
    ? a.options.map((o) => ({ id: o.id, label: o.label, ...(o.description ? { description: o.description } : {}) }))
    : a.choices?.length
      ? a.choices.map((c) => c.slice(0, 100))
      : undefined;
  const constraints: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a.constraints ?? {})) {
    const key = CONSTRAINT_FROM_MODEL[k as keyof typeof CONSTRAINT_FROM_MODEL];
    if (key && v !== null && v !== undefined) constraints[key] = v;
  }
  return {
    kind: a.kind,
    prompt: a.prompt,
    input: a.input,
    ...(options && (a.input === 'choice' || a.input === 'multi_choice') ? { options } : {}),
    ...(Object.keys(constraints).length ? { constraints } : {}),
    ...(a.input === 'confirm' && a.confirm_label ? { confirmLabel: a.confirm_label } : {}),
    ...(a.input === 'confirm' && a.deny_label ? { denyLabel: a.deny_label } : {}),
    ...(a.input === 'confirm' && a.risk ? { risk: a.risk } : {}),
  };
}

/** What the model reads after a person answered (never a secret). */
export function answerLine(a: { input: string; kind: string; value?: string; values?: string[]; options: QuestionOption[] | null; unit: string | null }): string {
  const label = (id: string) => (a.options ?? []).find((o) => o.id === id)?.label ?? id;
  switch (a.input) {
    case 'secret':
      return 'The person provided the secret. Type it with type_handoff_secret(selector).';
    case 'confirm':
      return a.value === 'approve' ? 'The person approved.' : 'The person denied it. Do not do it; finish if you cannot continue another way.';
    case 'choice':
      return `The person chose: ${trim(label(a.value ?? ''), 500)}`;
    case 'multi_choice':
      return `The person selected: ${trim((a.values ?? []).map(label).join(', '), 500)}`;
    case 'number':
      return `The person entered: ${trim(`${a.value ?? ''}${a.unit ? ` ${a.unit}` : ''}`, 500)}`;
    case 'text':
      return `The person answered: ${trim(a.value ?? '', 500)}`;
    case 'takeover':
      return 'The person took over the browser and is done. Check the page and continue.';
    default:
      return `The person completed the ${a.kind} step. Check the page and continue.`;
  }
}

@Injectable()
export class GoalRunnerService {
  private readonly log = new Logger(GoalRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly fabric: FabricClient,
    private readonly ai: AiService,
    @Optional() private readonly notifier?: RunNotifier,
    @Optional() private readonly questions?: QuestionsService,
  ) {}

  /**
   * Advance a run: start it, resume it after a handoff, or finish it.
   * Returns what the caller (the job) should do next.
   */
  async advance(runId: string, userId: string, orgId: string | null): Promise<RunOutcome> {
    const db = this.prisma.forUser({ userId });
    const run = await db.run.findFirst({ where: { id: runId }, include: { task: true } });
    if (!run) return 'failed';
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') return run.status;
    const session = new FabricSession(this.fabric);
    const memory: RunMemory = (run.transcript as unknown as RunMemory | null) ?? { log: [], chunks: 0 };

    if (run.cancelRequested) {
      await this.finish(userId, run.id, run.sessionId, session, 'cancelled', { error: 'Cancelled by the user' });
      return 'cancelled';
    }

    // Resume after a handoff: fold the person's answer into the memory.
    if (run.status === 'waiting_human') {
      if (!run.handoffId) {
        await this.tasks.transition(userId, run.id, 'failed', { error: 'Waiting for a person without a handoff' });
        return 'failed';
      }
      const h = await session.getHandoff(run.handoffId);
      if (h.status === 'pending') return 'waiting_human';
      await this.questions?.reconcileHandoff(h);
      // The answer as the broker recorded it (labels of choices), else as the fabric reports it.
      const q = await db.question.findFirst({ where: { handoffId: h.id }, select: { response: true, options: true, constraints: true, input: true } });
      const resp = (q?.response as unknown as QuestionResponse | null) ?? null;
      const outcome = resp?.outcome ?? handoffOutcome(h);
      if (h.status === 'completed' && outcome === 'completed') {
        const line = answerLine({
          input: (q?.input as QuestionInputType | undefined) ?? h.input,
          kind: h.kind,
          value: resp?.value ?? h.response?.value,
          values: resp?.values ?? h.response?.values,
          options: (q?.options as unknown as QuestionOption[] | null) ?? null,
          unit: (q?.constraints as unknown as QuestionConstraints | null)?.unit ?? null,
        });
        if (h.input === 'secret') memory.secretHandoffId = h.id;
        if (h.input === 'confirm' && (resp?.value ?? h.response?.value) === 'approve' && h.kind === 'confirmation') memory.confirmationGranted = true;
        if (h.kind === 'confirmation' && h.input !== 'confirm') memory.confirmationGranted = true;
        memory.log.push(line);
      } else {
        memory.log.push(`The person did not help (handoff ${h.status}${outcome === 'cancelled' ? ', declined' : ''}). Do not retry the same request; finish if you cannot continue.`);
      }
      await this.tasks.transition(userId, run.id, 'running', { handoffId: null, transcript: memory as never });
    } else {
      await this.tasks.transition(userId, run.id, 'running');
      await this.notifier?.started?.(userId, run);
    }

    let sessionId = run.sessionId;
    if (!sessionId) {
      try {
        const hosts = run.hostId ? await this.fabric.hosts() : [];
        const choice = chooseHost(hosts, run.hostId, run.hostFallback);
        if (choice.kind === 'fail') {
          await this.finish(userId, run.id, null, session, 'failed', { error: choice.error });
          return 'failed';
        }
        if (choice.note) {
          memory.log.push(choice.note);
          this.log.log(`run ${run.id}: ${choice.note}`);
        }
        sessionId = await session.create({ profile: run.profile, hostId: choice.hostId, label: `run ${run.id}` });
      } catch (e) {
        await this.finish(userId, run.id, null, session, 'failed', { error: `No browser available: ${e instanceof Error ? e.message : String(e)}` });
        return 'failed';
      }
      await db.run.updateMany({ where: { id: run.id }, data: { sessionId } });
    }

    const policy = {
      allowedDomains: run.task?.allowedDomains ?? [],
      maxSteps: run.task?.maxSteps ?? 100,
      deadline: (run.startedAt ?? new Date()).getTime() + (run.task?.maxMinutes ?? 30) * 60_000,
      confirmRisky: run.task?.confirmRiskyActions ?? false,
      model: run.task?.model ?? undefined,
    };
    const state = {
      stepCount: run.stepCount,
      stop: null as StopLoop['reason'] | null,
      finished: null as { success: boolean; result: string } | null,
      handoffId: null as string | null,
      handoffExpiresAt: null as Date | null,
      handoffAsk: null as { prompt: string; kind: string; input: string } | null,
      labels: new Map<string, string>(),
      /** The numbered marks of the last page screenshot. */
      marks: new Map<number, ScreenMark>(),
      /** The last screen the model was shown. */
      view: null as ScreenView | null,
    };

    const record = async (kind: string, action: string | null, args: Record<string, unknown> | null, ok: boolean, summary: string, started: number, reasoning?: string) => {
      state.stepCount += 1;
      this.tasks.metrics.step(kind, ok);
      await this.prisma.runStep.create({
        data: {
          runId: run.id,
          seq: state.stepCount,
          kind,
          action,
          args: args ? (redactActionArgs(action ?? '', args) as never) : undefined,
          ok,
          summary: trim(summary, 1_900),
          reasoning: reasoning ? trim(reasoning, 1_900) : null,
          durationMs: Date.now() - started,
        },
      });
      await db.run.updateMany({ where: { id: run.id }, data: { stepCount: state.stepCount } });
      memory.log.push(`${state.stepCount}. ${action ?? kind}${args ? ` ${JSON.stringify(redactActionArgs(action ?? '', args))}` : ''} → ${ok ? 'ok' : 'FAILED'}: ${trim(summary, 300)}`);
    };

    /** Run one fabric action under the policy, record it, and return what the model sees. */
    const act = async (action: Record<string, unknown>, reason?: string): Promise<string> => {
      const started = Date.now();
      const type = String(action.type);
      if (state.stepCount >= policy.maxSteps) {
        state.stop = 'budget';
        return 'Step budget exhausted.';
      }
      let op;
      try {
        op = await session.act(sessionId!, action);
      } catch (e) {
        const msg = e instanceof FabricError ? e.message : String(e);
        await record('action', type, action, false, msg, started, reason);
        return `Error: ${msg}`;
      }
      if (op.state !== 'succeeded') {
        const msg = op.error ?? op.state;
        await record('action', type, action, false, msg, started, reason);
        return `Failed (${op.state}): ${msg}`;
      }
      const result = op.result ?? {};
      let summary = 'done';
      let forModel = 'ok';
      if (type === 'navigate') {
        // The model needs the real URL; the stored step gets it without its query.
        forModel = `at ${String(result.url ?? '')} — ${String(result.title ?? '')}`;
        summary = `at ${redactUrl(String(result.url ?? ''))} — ${trim(String(result.title ?? ''), 200)}`;
      }
      if (type === 'text') {
        const text = String(result.text ?? '');
        summary = `read ${text.length} characters`;
        forModel = trim(text, OBSERVATION_CHARS);
      }
      if (type === 'elements') {
        const els = (result.elements as Array<Record<string, unknown>> | undefined) ?? [];
        state.labels.clear();
        for (const el of els) state.labels.set(String(el.selector), `${String(el.text ?? '')} ${String(el.aria_label ?? el.name ?? '')}`);
        summary = `${els.length} interactive elements`;
        forModel = trim(JSON.stringify(els.map((el) => ({ selector: el.selector, tag: el.tag, role: el.role, text: el.text, type: el.type, name: el.name }))), OBSERVATION_CHARS);
      }
      if (type === 'scroll') summary = forModel = `scrolled to ${String(result.y ?? '?')}`;
      if (type === 'evaluate') {
        const value = JSON.stringify(result.value ?? null) ?? 'undefined';
        summary = `returned ${String(result.type ?? typeof result.value)} (${value.length} characters)`;
        forModel = trim(`${String(result.type ?? '')}: ${value}${result.description ? ` (${String(result.description)})` : ''}`, OBSERVATION_CHARS);
      }
      if (type === 'tabs') {
        const tabs = (result.tabs as Record<string, unknown>[] | undefined) ?? [];
        summary = `${tabs.length} tabs`;
        forModel = trim(JSON.stringify(tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active }))), OBSERVATION_CHARS);
      }
      if (type === 'new_tab') summary = forModel = `opened tab ${String(result.tab_id ?? '?')}`;
      await record('action', type, action, true, summary, started, reason);
      return forModel;
    };

    const tools: AiDefinedTool[] = [
      defineTool({
        name: 'observe_elements',
        description: 'List the interactive elements of the current page with CSS selectors.',
        parameters: z.object({}),
        execute: () => act({ type: 'elements', max_elements: 80 }),
      }),
      defineTool({
        name: 'read_text',
        description: 'Read the visible text of the page, or of one element.',
        parameters: z.object({ selector: z.string().max(2000).nullable() }),
        execute: ({ selector }) => act({ type: 'text', ...(selector ? { selector } : {}), max_chars: OBSERVATION_CHARS }),
      }),
      defineTool({
        name: 'navigate',
        description: 'Open any URL in the current tab.',
        parameters: z.object({ url: z.string().max(8000), reason: z.string().max(500) }),
        execute: async ({ url, reason }) => {
          if (!domainAllowed(url, policy.allowedDomains)) {
            await record('action', 'navigate', { url }, false, 'refused by policy: site not allowed', Date.now(), reason);
            return `Refused: ${url.startsWith('javascript:') ? 'use run_javascript instead of a javascript: URL' : `that site is not allowed for this task (${policy.allowedDomains.join(', ')})`}.`;
          }
          return act({ type: 'navigate', url }, reason);
        },
      }),
      defineTool({
        name: 'click',
        description: 'Click the element matching a CSS selector.',
        parameters: z.object({ selector: z.string().max(2000), reason: z.string().max(500) }),
        execute: async ({ selector, reason }) => {
          if (policy.confirmRisky && !memory.confirmationGranted && looksRisky(selector, state.labels.get(selector), reason)) {
            await record('action', 'click', { selector }, false, 'paused by policy: needs a person\'s confirmation', Date.now(), reason);
            return 'Refused: this looks like a purchase, payment or irreversible submission. Call request_human with kind "confirmation" describing exactly what will happen, then try again.';
          }
          const out = await act({ type: 'click', selector }, reason);
          if (looksRisky(selector, state.labels.get(selector), reason)) memory.confirmationGranted = false;
          return out;
        },
      }),
      defineTool({
        name: 'type_text',
        description: 'Type text into an input (not secrets: use type_handoff_secret for those).',
        parameters: z.object({ selector: z.string().max(2000), text: z.string().max(10_000), submit: z.boolean() }),
        execute: ({ selector, text, submit }) => act({ type: 'type', selector, text, clear: true, submit }),
      }),
      defineTool({
        name: 'press_key',
        description: 'Press a key such as Enter, Tab or Escape.',
        parameters: z.object({ key: z.string().max(40) }),
        execute: ({ key }) => act({ type: 'press', key }),
      }),
      defineTool({
        name: 'scroll',
        description: 'Scroll the page vertically by a number of pixels (negative scrolls up).',
        parameters: z.object({ dy: z.number().int().min(-20000).max(20000) }),
        execute: ({ dy }) => act({ type: 'scroll', dy }),
      }),
      defineTool({
        name: 'wait_for',
        description: 'Wait until an element matching a selector appears (up to 15 s).',
        parameters: z.object({ selector: z.string().max(2000) }),
        execute: ({ selector }) => act({ type: 'wait_for', selector, timeout_ms: 15_000 }),
      }),
      defineTool({
        name: 'go_back',
        description: 'Go back one page.',
        parameters: z.object({}),
        execute: () => act({ type: 'back' }),
      }),
      defineTool({
        name: 'look',
        description:
          'Take a fresh screenshot and end this turn; the next turn starts with the image. screen "page" shows the tab with numbered interactive elements; "desktop" shows the whole computer screen (native dialogs, file pickers, other windows).',
        parameters: z.object({ screen: z.enum(['page', 'desktop']), reason: z.string().max(500) }),
        execute: async ({ screen, reason }) => {
          if (memory.visionOff) return 'Screenshots are not available with this model: use observe_elements and read_text.';
          if (state.stepCount >= policy.maxSteps) {
            state.stop = 'budget';
            return 'Step budget exhausted.';
          }
          await record('observe', 'look', { screen }, true, `looked at the ${screen}`, Date.now(), reason);
          memory.look = screen;
          state.stop = 'look';
          return 'Looking; the screenshot comes with the next turn.';
        },
      }),
      defineTool({
        name: 'click_mark',
        description: 'Click the element numbered n on the latest page screenshot, with a real mouse click at its center.',
        parameters: z.object({ n: z.number().int().min(1), double: z.boolean(), reason: z.string().max(500) }),
        execute: async ({ n, double, reason }) => {
          const mark = state.marks.get(n);
          if (!mark) return `There is no mark ${n} on the latest screenshot. Call look to refresh it.`;
          if (policy.confirmRisky && !memory.confirmationGranted && looksRisky(mark.selector, mark.text, reason)) {
            await record('action', 'click_at', { mark: n }, false, "paused by policy: needs a person's confirmation", Date.now(), reason);
            return 'Refused: this looks like a purchase, payment or irreversible submission. Call request_human with kind "confirmation" describing exactly what will happen, then try again.';
          }
          const { x, y } = markCenter(mark);
          const out = await act({ type: 'click_at', x, y, ...(double ? { click_count: 2 } : {}) }, reason);
          if (looksRisky(mark.selector, mark.text, reason)) memory.confirmationGranted = false;
          return out;
        },
      }),
      defineTool({
        name: 'click_at',
        description: 'Real mouse click at viewport coordinates (CSS pixels, as on the page screenshot). button left/middle/right; double for a double click; modifiers alt, ctrl, meta, shift.',
        parameters: z.object({
          x: z.number().int().min(0),
          y: z.number().int().min(0),
          button: z.enum(['left', 'middle', 'right']),
          double: z.boolean(),
          modifiers: z.array(z.enum(['alt', 'ctrl', 'meta', 'shift'])),
          reason: z.string().max(500),
        }),
        execute: async ({ x, y, button, double, modifiers, reason }) => {
          if (policy.confirmRisky && !memory.confirmationGranted && looksRisky(reason)) {
            await record('action', 'click_at', { x, y }, false, "paused by policy: needs a person's confirmation", Date.now(), reason);
            return 'Refused: this looks like a purchase, payment or irreversible submission. Call request_human with kind "confirmation" describing exactly what will happen, then try again.';
          }
          const out = await act({ type: 'click_at', x, y, ...(button !== 'left' ? { button } : {}), ...(double ? { click_count: 2 } : {}), ...(modifiers.length ? { modifiers } : {}) }, reason);
          if (looksRisky(reason)) memory.confirmationGranted = false;
          return out;
        },
      }),
      defineTool({
        name: 'hover_at',
        description: 'Move the mouse to viewport coordinates (opens hover menus and tooltips).',
        parameters: z.object({ x: z.number().int().min(0), y: z.number().int().min(0) }),
        execute: ({ x, y }) => act({ type: 'mouse', op: 'move', x, y }),
      }),
      defineTool({
        name: 'drag',
        description: 'Real mouse drag from one viewport point to another (sliders, drag and drop, drawing).',
        parameters: z.object({ from_x: z.number().int().min(0), from_y: z.number().int().min(0), to_x: z.number().int().min(0), to_y: z.number().int().min(0) }),
        execute: (a) => act({ type: 'drag', ...a }),
      }),
      defineTool({
        name: 'scroll_at',
        description: 'Mouse-wheel scroll at a viewport point: scrolls whatever is under it (a list, a map, a panel). Positive dy scrolls down.',
        parameters: z.object({ x: z.number().int().min(0), y: z.number().int().min(0), dy: z.number().int().min(-20000).max(20000) }),
        execute: ({ x, y, dy }) => act({ type: 'scroll_at', x, y, dx: 0, dy }),
      }),
      defineTool({
        name: 'type_keys',
        description: 'Type text into whatever has focus with real keyboard events (click the field first). Use for fields that ignore type_text.',
        parameters: z.object({ text: z.string().min(1).max(10_000) }),
        execute: ({ text }) => act({ type: 'type_keys', text }),
      }),
      defineTool({
        name: 'key',
        description: 'Press one key with real keyboard events, with modifiers: key "a" with ["ctrl"] selects all, "Enter", "Escape", "Tab", "ArrowDown", "PageDown", "F5".',
        parameters: z.object({ key: z.string().min(1).max(40), modifiers: z.array(z.enum(['alt', 'ctrl', 'meta', 'shift'])) }),
        execute: ({ key, modifiers }) => act({ type: 'key', key, ...(modifiers.length ? { modifiers } : {}) }),
      }),
      defineTool({
        name: 'run_javascript',
        description:
          'Run JavaScript in the current page and get its value back (like the DevTools console: the last expression is the value; top-level await works). Use it to read page state, fill or submit complex forms, call the page\'s functions, or work around stubborn widgets.',
        parameters: z.object({ script: z.string().min(1).max(100_000), reason: z.string().max(500) }),
        execute: ({ script, reason }) => act({ type: 'evaluate', script, await_promise: true }, reason),
      }),
      defineTool({
        name: 'tabs',
        description: 'List the open tabs (id, title, URL, which is active).',
        parameters: z.object({}),
        execute: () => act({ type: 'tabs' }),
      }),
      defineTool({
        name: 'switch_tab',
        description: 'Make a tab (by id from tabs) the active one; later actions use it.',
        parameters: z.object({ tab_id: z.number().int() }),
        execute: ({ tab_id }) => act({ type: 'activate_tab', tab_id }),
      }),
      defineTool({
        name: 'new_tab',
        description: 'Open a new tab, optionally at a URL, and make it active.',
        parameters: z.object({ url: z.string().max(8000).nullable() }),
        execute: async ({ url }) => {
          if (url && !domainAllowed(url, policy.allowedDomains)) {
            await record('action', 'new_tab', { url }, false, 'refused by policy: site not allowed', Date.now());
            return `Refused: that site is not allowed for this task (${policy.allowedDomains.join(', ')}).`;
          }
          return act({ type: 'new_tab', ...(url ? { url } : {}) });
        },
      }),
      defineTool({
        name: 'desktop_click',
        description: 'Click anywhere on the computer screen, at screen coordinates from a desktop screenshot (look with screen "desktop").',
        parameters: z.object({ x: z.number().int().min(0), y: z.number().int().min(0), button: z.enum(['left', 'middle', 'right']), double: z.boolean() }),
        execute: ({ x, y, button, double }) => act({ type: 'desktop_click', x, y, ...(button !== 'left' ? { button } : {}), ...(double ? { click_count: 2 } : {}) }),
      }),
      defineTool({
        name: 'desktop_type',
        description: 'Type text into whatever has focus on the computer (a native file dialog\'s path box, another window).',
        parameters: z.object({ text: z.string().min(1).max(10_000) }),
        execute: ({ text }) => act({ type: 'desktop_type', text }),
      }),
      defineTool({
        name: 'desktop_key',
        description: 'Press a key chord on the computer, xdotool style: "Return", "Escape", "ctrl+l", "alt+F4", "ctrl+a BackSpace".',
        parameters: z.object({ key: z.string().min(1).max(64) }),
        execute: ({ key }) => act({ type: 'desktop_key', key }),
      }),
      defineTool({
        name: 'desktop_scroll',
        description: 'Scroll on the computer screen by mouse-wheel clicks at a point (positive dy scrolls down).',
        parameters: z.object({ x: z.number().int().min(0), y: z.number().int().min(0), dy: z.number().int().min(-100).max(100) }),
        execute: ({ x, y, dy }) => act({ type: 'desktop_scroll', x, y, dy }),
      }),
      defineTool({
        name: 'desktop_drag',
        description: 'Drag on the computer screen from one point to another.',
        parameters: z.object({ from_x: z.number().int().min(0), from_y: z.number().int().min(0), to_x: z.number().int().min(0), to_y: z.number().int().min(0) }),
        execute: (a) => act({ type: 'desktop_drag', ...a }),
      }),
      defineTool({
        name: 'request_human',
        description:
          'Ask the person for help: a CAPTCHA, a one-time code, a passkey, a login, a choice, a number, or a confirmation before an irreversible step. ' +
          'input: none (they do something, then press Done), text, secret (a code or password; type it with type_handoff_secret), choice (one of options), ' +
          'multi_choice (several of options), number (with constraints min/max/step/unit), confirm (approve or deny; risk "high" by default), takeover (they take over the browser, then press Done). ' +
          'Set the fields that do not apply to null. The run pauses until they answer.',
        parameters: z.object({
          kind: z.enum(['captcha', 'code', 'passkey', 'login', 'confirmation', 'other']),
          prompt: z.string().min(1).max(1500),
          input: z.enum(['none', 'text', 'secret', 'choice', 'multi_choice', 'number', 'confirm', 'takeover']),
          /** Bare option labels (each its own id); or use `options`. */
          choices: z.array(z.string().max(100)).max(10).nullable(),
          options: z.array(z.object({ id: z.string().max(64), label: z.string().max(100), description: z.string().max(200).nullable() })).max(10).nullable(),
          constraints: z
            .object({
              max_length: z.number().int().nullable(),
              pattern: z.string().max(200).nullable(),
              multiline: z.boolean().nullable(),
              min: z.number().nullable(),
              max: z.number().nullable(),
              step: z.number().nullable(),
              unit: z.string().max(20).nullable(),
              min_selections: z.number().int().nullable(),
              max_selections: z.number().int().nullable(),
            })
            .nullable(),
          confirm_label: z.string().max(40).nullable(),
          deny_label: z.string().max(40).nullable(),
          risk: z.enum(['low', 'high']).nullable(),
        }),
        execute: async (args) => {
          const started = Date.now();
          const parsed = questionSpecSchema.safeParse(requestHumanSpec(args));
          if (!parsed.success) return `Invalid request_human: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'question'}: ${i.message}`).join('; ')}. Fix it and call request_human again.`;
          const spec = parsed.data;
          try {
            const created = await session.openHandoff(sessionId!, {
              kind: spec.kind,
              prompt: spec.prompt,
              input: spec.input,
              choices: spec.options ?? [],
              constraints: spec.constraints,
              confirmLabel: spec.confirmLabel,
              denyLabel: spec.denyLabel,
              risk: spec.risk,
            });
            state.handoffId = created.id;
            state.handoffExpiresAt = created.expiresAt;
            await this.mirror(userId, run.id, sessionId!, created, spec);
          } catch (e) {
            await record('handoff', null, null, false, `could not ask a person: ${e instanceof Error ? e.message : String(e)}`, started);
            return 'Could not reach a person right now.';
          }
          await record('handoff', null, { kind: spec.kind, input: spec.input }, true, `asked a person (${spec.kind}): ${trim(spec.prompt, 300)}`, started);
          state.handoffAsk = { prompt: spec.prompt, kind: spec.kind, input: spec.input };
          state.stop = 'pause';
          return 'Waiting for the person.';
        },
      }),
      defineTool({
        name: 'type_handoff_secret',
        description: 'Type the secret (code or password) the person gave through request_human into an input. You never see the value.',
        parameters: z.object({ selector: z.string().max(2000), submit: z.boolean() }),
        execute: async ({ selector, submit }) => {
          const started = Date.now();
          if (!memory.secretHandoffId) return 'No secret is available: call request_human with input "secret" first.';
          const handoffId = memory.secretHandoffId;
          memory.secretHandoffId = null;
          let op;
          try {
            // The fabric types the value itself: the console never sees it.
            op = await session.typeSecret(sessionId!, { handoffId, selector, clear: true, submit });
          } catch {
            await record('action', 'type', { selector, secret: '' }, false, 'the secret was already used or expired', started);
            return 'The secret is no longer available; ask the person again if needed.';
          }
          const ok = op.state === 'succeeded';
          await record('action', 'type', { selector, submit }, ok, ok ? 'typed the secret' : (op.error ?? op.state), started);
          return ok ? 'Typed the secret.' : `Failed: ${op.error ?? op.state}`;
        },
      }),
      defineTool({
        name: 'finish',
        description: 'End the run with a short factual result.',
        parameters: z.object({ success: z.boolean(), result: z.string().min(1).max(4000) }),
        execute: async ({ success, result }) => {
          state.finished = { success, result };
          state.stop = 'finish';
          await record('finish', null, null, success, trim(result, 1_900), Date.now());
          return 'Finished.';
        },
      }),
    ];

    const goal = run.goal;
    const remainingChunks = Math.max(1, Math.ceil(policy.maxSteps / 4));
    let usage = { input: 0, output: 0 };
    for (let chunk = 0; chunk < remainingChunks; chunk++) {
      memory.chunks += 1;
      state.stop = null;
      const stepsBefore = state.stepCount;
      const input = [
        `Goal: ${goal}`,
        `Allowed sites: ${policy.allowedDomains.join(', ') || 'any'}. Steps used: ${state.stepCount} of ${policy.maxSteps}.`,
        memory.log.length ? `Progress so far (latest last):\n${memory.log.slice(-LOG_LINES).join('\n')}` : 'Nothing has been done yet. Start by navigating or observing the page.',
        memory.confirmationGranted ? 'The person approved the next irreversible step.' : '',
        'Continue toward the goal.',
      ]
        .filter(Boolean)
        .join('\n\n');
      // What the model sees this round: the screen, as a person would (#366).
      let view: ScreenView | null = null;
      if (!memory.visionOff) {
        const screen: Screen = memory.look ?? 'page';
        memory.look = null;
        try {
          view = await captureScreen(session, this.fabric, sessionId!, screen);
          if (screen === 'page') state.marks = new Map(view.marks.map((m) => [m.n, m]));
          state.view = view;
        } catch (e) {
          this.log.debug(`run ${run.id}: no ${screen} screenshot this round: ${e instanceof Error ? e.message : String(e)}`);
          memory.log.push(`(No ${screen} screenshot this round: ${trim(e instanceof Error ? e.message : String(e), 200)})`);
        }
      }
      let result: AiToolLoopResult | null = null;
      const call = (withImage: boolean) =>
        this.ai.forUser(userId, { feature: BROWSER_AGENT_FEATURE_ID, ...(orgId ? { orgId } : {}) }).runTools({
          ...(policy.model ? { model: policy.model } : {}),
          instructions: INSTRUCTIONS,
          input: roundInput(input, withImage ? view : null),
          tools,
          maxSteps: CHUNK_STEPS,
          onStep: (step) => {
            usage = { input: usage.input + (step.response.usage.inputTokens ?? 0), output: usage.output + (step.response.usage.outputTokens ?? 0) };
            if (Date.now() > policy.deadline) state.stop = 'budget';
            if (state.stop) throw new StopLoop(state.stop);
          },
        });
      try {
        try {
          result = await call(view !== null);
        } catch (e) {
          // A provider or model without vision refuses the image: carry on without.
          if (e instanceof StopLoop || view === null || state.stepCount > stepsBefore) throw e;
          this.log.warn(`run ${run.id}: the model refused the screenshot, continuing without vision: ${e instanceof Error ? e.message : String(e)}`);
          memory.visionOff = true;
          memory.log.push('(Screenshots are off: this model does not accept images. Use observe_elements and read_text.)');
          result = await call(false);
        }
      } catch (e) {
        if (!(e instanceof StopLoop)) {
          await this.saveMemory(userId, run.id, memory, usage);
          throw e;
        }
      }
      await this.saveMemory(userId, run.id, memory, usage);
      usage = { input: 0, output: 0 };

      const fresh = await db.run.findFirst({ where: { id: run.id }, select: { cancelRequested: true } });
      if (fresh?.cancelRequested) {
        await this.finish(userId, run.id, sessionId, session, 'cancelled', { error: 'Cancelled by the user' });
        return 'cancelled';
      }
      if (state.stop === 'pause' && state.handoffId) {
        await this.tasks.transition(userId, run.id, 'waiting_human', { handoffId: state.handoffId, handoffExpiresAt: state.handoffExpiresAt });
        await this.notifier?.needsYou(userId, { ...run, handoffId: state.handoffId ?? null }, state.handoffAsk?.prompt ?? 'The agent needs you.', state.handoffAsk?.kind ?? 'other', state.handoffAsk?.input ?? 'none', state.handoffExpiresAt);
        return 'waiting_human';
      }
      if (state.stop === 'finish' && state.finished) {
        const to = state.finished.success ? 'succeeded' : 'failed';
        await this.finish(userId, run.id, sessionId, session, to, state.finished.success ? { result: state.finished.result } : { result: state.finished.result, error: 'The agent could not reach the goal' });
        return to;
      }
      if (state.stop === 'budget') {
        await this.finish(userId, run.id, sessionId, session, 'failed', { error: Date.now() > policy.deadline ? 'Time budget exhausted' : 'Step budget exhausted' });
        return 'failed';
      }
      if (result && result.stopReason === 'completed') {
        // The model answered without calling finish: take its answer as the result.
        await this.finish(userId, run.id, sessionId, session, 'succeeded', { result: trim(result.final.outputText || 'Done.', 7_900) });
        return 'succeeded';
      }
      // steps_exhausted: another chunk.
    }
    await this.finish(userId, run.id, sessionId, session, 'failed', { error: 'The agent did not finish within its budget' });
    return 'failed';
  }

  /** Record the handoff in the question broker (the inbox and the channels read it there). Never fails the run. */
  private async mirror(userId: string, runId: string, sessionId: string, created: CreatedHandoff, spec: QuestionSpec) {
    if (!this.questions) return;
    try {
      await this.questions.mirrorHandoff({ id: userId }, spec, created, { askedBy: `run:${runId}`, runId, fabricSessionId: sessionId });
    } catch (e) {
      this.log.warn(`run ${runId}: could not mirror handoff ${created.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async saveMemory(userId: string, runId: string, memory: RunMemory, usage: { input: number; output: number }) {
    memory.log = memory.log.slice(-200);
    this.tasks.metrics.tokens(usage.input, usage.output);
    await this.prisma.forUser({ userId }).run.updateMany({
      where: { id: runId },
      data: { transcript: memory as never, inputTokens: { increment: usage.input }, outputTokens: { increment: usage.output } },
    });
  }

  private async finish(
    userId: string,
    runId: string,
    sessionId: string | null,
    session: FabricSession,
    to: 'succeeded' | 'failed' | 'cancelled',
    patch: { result?: string; error?: string },
  ) {
    if (sessionId) await session.end(sessionId);
    const done = await this.tasks.transition(userId, runId, to, patch);
    this.log.log(`run ${runId}: ${to}`);
    await this.notifier?.finished(userId, done, to, patch.result ?? patch.error);
  }
}
