// The PDF report of a run (#543): a clean record of what was asked, what the
// agent did step by step, what it asked the owner and what they answered,
// the screens at the key moments, and how it ended.
//
// One source: the `RunTrace` of `RunTraceService.build` (#542), which is
// already masked. Nothing here reads the database or masks again, so what the
// JSON file hides, the report hides.
//
// Two halves:
// - `buildReportDefinition(trace, opts)` is pure: it returns the pdfmake
//   document definition (snapshot-tested). Images too wide are re-encoded
//   here, deterministically.
// - `renderPdf(definition)` lays it out and streams the PDF. Fonts are the
//   repository's own (Inter, SIL OFL 1.1, `apps/api/assets/fonts/`); every
//   URL and local file access is refused, so rendering never touches the
//   network or the disk beyond those fonts. No browser.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';

import * as jpeg from 'jpeg-js';
import type { Content, ContextPageSize, TDocumentDefinitions, TFontDictionary } from 'pdfmake/interfaces';

import { formatOutputValue } from '@app/shared/task-fields';

import type { RunTrace, RunTraceStep } from './run-trace.schemas';

export const REPORT_PAPERS = ['a4', 'letter'] as const;
export type ReportPaper = (typeof REPORT_PAPERS)[number];

export interface ReportOptions {
  /** A4 (the default) or US letter. */
  paper?: ReportPaper;
  /** `none` leaves every image out, even one the trace carries. */
  screenshots?: 'embed' | 'none';
}

/** The footer note on every page. */
export const REPORT_FOOTER_NOTE = 'Sensitive data masked. Not a bank or legal record.';
/** The banner of a run that was live when it was exported. */
export const REPORT_PARTIAL_BANNER = 'Run in progress: partial report';
/** Wider images are re-encoded to this width before they are embedded. */
export const REPORT_IMAGE_MAX_PX = 1600;

/** 18 mm in points. */
const MARGIN = (18 / 25.4) * 72;
const PAGE: Record<ReportPaper, { size: 'A4' | 'LETTER'; width: number; height: number }> = {
  a4: { size: 'A4', width: 595.28, height: 841.89 },
  letter: { size: 'LETTER', width: 612, height: 792 },
};
/** The brand primary (packages/shared/identity.json `themeColor`): the one accent. */
const ACCENT = '#4b4be8';
const MARK_ACCENT = '#ff6b4a';
const TEXT = '#12131c';
const MUTED = '#5a5e72';
const RULE = '#d5d6e3';
const SOFT_FILL = '#f2f2fb';
/** Failures: red, and always with the word "Failed" so they read in greyscale. */
const FAIL = '#b3261e';
/** The longest stated reason a step prints. */
const MAX_REASONING = 1_000;

/** The Trace mark (docs/brand/hexactra-mark.svg), as the web app's `BrandMark` draws it. */
const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path d="M60 60V108L18.4 84V36L60 12L101.6 36V84L80 96.5" fill="none" stroke="${ACCENT}" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/><circle cx="60" cy="60" r="13" fill="${MARK_ACCENT}"/></svg>`;

// --- words ------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "18 Nov 2026, 18:00:01 UTC". Reports are in UTC: the server does not know the reader's zone. */
export function reportDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

/** "18:00:01" (UTC). */
function clock(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** "850 ms", "4.2 s", "3 min 5 s", "1 h 2 min" (as the run page says it). */
export function reportDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

/** "$2.40", "$0.0042"; "at least $2.40" while part of the run could not be priced. */
function usd(amount: number, known = true): string {
  const n = Number.isFinite(amount) ? amount : 0;
  const text = n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
  return known ? text : `at least ${text}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The outcome chip's words. */
export function outcomeLabel(trace: RunTrace): string {
  const { status, confirmedActions } = trace.run;
  if (trace.partial) return status === 'waiting_human' ? 'In progress: waiting for you' : 'In progress';
  if (status === 'succeeded') return 'Succeeded';
  if (confirmedActions.length > 0) return 'Ended after a confirmed step';
  return status === 'cancelled' ? 'Stopped' : 'Failed';
}

const ORIGIN_LABEL: Record<string, string> = { web: 'Console', android: 'Android app', cli: 'CLI', api: 'API', mcp: 'AI app', schedule: 'Schedule', system: 'Console' };

/** Where the run was started from: chat, a task, a schedule, an AI app, … */
export function startedFrom(run: RunTrace['run']): string {
  const app = run.client?.name ? `AI app (${run.client.name})` : null;
  if (run.trigger === 'chat') return 'Chat';
  if (run.trigger === 'email') return run.taskName ? `Email (task "${run.taskName}")` : 'Email';
  if (run.trigger === 'schedule' || run.origin === 'schedule') return run.taskName ? `Schedule (task "${run.taskName}")` : 'Schedule';
  if (app) return app;
  if (run.origin === 'mcp' || run.trigger === 'mcp') return 'AI app';
  if (run.taskName) return `Task "${run.taskName}"`;
  return ORIGIN_LABEL[run.origin] ?? run.origin;
}

const TIER_LABEL: Record<string, string> = { fast: 'Fast', standard: 'Standard', frontier: 'Frontier' };
const STOP_REASON: Record<string, string> = {
  finished: 'Finished',
  budget_actions: 'Stopped by the actions budget',
  budget_model_calls: 'Stopped by the model calls budget',
  budget_active_time: 'Stopped by the active time budget',
  budget_input_tokens: 'Stopped by the input tokens budget',
  budget_output_tokens: 'Stopped by the output tokens budget',
  budget_cost: 'Stopped by the cost budget',
  stalled: 'Stopped: the agent was stuck',
  cancelled: 'Stopped by you',
  error: 'Stopped by an error',
  no_model: 'Stopped: no model was available',
};

const BUDGET_ROWS = [
  ['actions', 'Actions'],
  ['modelCalls', 'Model calls'],
  ['activeMinutes', 'Active time'],
  ['inputTokens', 'Input tokens'],
  ['outputTokens', 'Output tokens'],
  ['cost', 'Cost'],
] as const;

function budgetAmount(key: string, n: number, costKnown = true): string {
  if (key === 'cost') return usd(n, costKnown);
  if (key === 'activeMinutes') return n < 10 ? `${Math.floor(n * 10) / 10} min` : `${Math.floor(n)} min`;
  return Math.round(n).toLocaleString('en');
}

const CHANNEL_LABEL: Record<string, string> = { web: 'Console', chat: 'Chat', notification: 'Notification', inbox: 'Inbox', webhook: 'Webhook', mcp: 'AI app', cli: 'CLI', android: 'Android app' };

type Question = NonNullable<RunTraceStep['question']>;

/** "Allowed", "Declined", "Provided (not recorded)", "Provided: <value>", the chosen option… */
export function answerLabel(q: Question): string {
  const a = q.answer;
  if (!a) {
    if (q.status === 'expired') return 'Expired: not answered';
    if (q.status === 'cancelled') return 'Withdrawn';
    return 'Not answered yet';
  }
  if (a.outcome === 'cancelled' || a.outcome === 'declined') return 'Declined';
  if (a.outcome === 'expired') return 'Expired: not answered';
  if (a.outcome !== 'completed') return a.outcome;
  if (q.kind === 'confirmation' || q.input === 'confirm') return !a.value || a.value === 'approve' ? 'Allowed' : 'Declined';
  if (q.input === 'takeover') return 'Took over and handed back';
  if (q.input === 'none') return 'Done';
  if (a.valueWithheld || q.input === 'secret' || q.input === 'credentials') return 'Provided (not recorded)';
  if (!a.value) return 'Provided';
  if (q.input === 'choice' || q.input === 'multi_choice') {
    const label = (v: string) => q.options?.find((o) => o.id === v)?.label ?? v;
    const values = q.input === 'multi_choice' ? a.value.split(',').map((v) => v.trim()).filter(Boolean) : [a.value];
    return `Chose: ${values.map(label).join(', ')}`;
  }
  return `Provided: ${cut(a.value, 300)}`;
}

const MOMENT_WORDS: Record<string, string> = {
  question: 'the screen when the agent asked you',
  before_confirmed: 'the screen when the agent asked for confirmation',
  after_confirmed: 'the screen after the confirmed step',
  failure: 'the screen when the step failed',
  final: 'the final screen',
};
const NOTE_WORDS: Record<string, string> = {
  unavailable: 'no picture: the screen could not be captured',
  masked_failed: 'no picture: masking failed, so none was kept',
  no_storage: 'no picture: no storage is configured',
  capped: 'no picture: the run reached its picture limit',
};

/** "Step 57 · the screen when the agent asked for confirmation · 2 areas masked". */
export function screenshotCaption(seq: number, shot: NonNullable<RunTraceStep['screenshot']>, extra?: string): string {
  const parts = [`Step ${seq}`, MOMENT_WORDS[shot.moment ?? ''] ?? 'the screen'];
  if (shot.note) parts.push(NOTE_WORDS[shot.note] ?? `no picture: ${shot.note}`);
  else if (shot.masked !== null && shot.masked !== undefined) parts.push(shot.masked === 0 ? 'nothing masked' : `${plural(shot.masked, 'area')} masked`);
  if (extra) parts.push(extra);
  return parts.join(' · ');
}

// --- images -----------------------------------------------------------------

/** Width and height of a JPEG or PNG from its header; null when it is neither. */
export function imageSize(bytes: Buffer): { type: 'jpeg' | 'png'; width: number; height: number } | null {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) {
    return { type: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = bytes.readUInt16BE(i + 2);
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { type: 'jpeg', height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** A JPEG re-encoded at `REPORT_IMAGE_MAX_PX` wide (area-averaged), quality 82. */
function downscaleJpeg(bytes: Buffer, width: number): Buffer | null {
  try {
    const src = jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: 200, maxMemoryUsageInMB: 1024 });
    const w = REPORT_IMAGE_MAX_PX;
    const h = Math.max(1, Math.round((src.height * w) / width));
    const out = Buffer.alloc(w * h * 4);
    const sx = src.width / w;
    const sy = src.height / h;
    for (let y = 0; y < h; y++) {
      const y0 = Math.floor(y * sy);
      const y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor((y + 1) * sy)));
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor(x * sx);
        const x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor((x + 1) * sx)));
        let r = 0;
        let g = 0;
        let b = 0;
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) {
            const p = (yy * src.width + xx) * 4;
            r += src.data[p]!;
            g += src.data[p + 1]!;
            b += src.data[p + 2]!;
          }
        }
        const n = (y1 - y0) * (x1 - x0);
        const o = (y * w + x) * 4;
        out[o] = Math.round(r / n);
        out[o + 1] = Math.round(g / n);
        out[o + 2] = Math.round(b / n);
        out[o + 3] = 255;
      }
    }
    return Buffer.from(jpeg.encode({ data: out, width: w, height: h }, 82).data);
  } catch {
    return null;
  }
}

/**
 * The picture as the report embeds it: a JPEG wider than 1,600 px re-encoded
 * at 1,600 px; anything else as stored. Null when it is not a readable JPEG
 * or PNG (the step then says so in its caption).
 */
export function reportImage(data: string): { bytes: Buffer; width: number; height: number } | null {
  const bytes = Buffer.from(data, 'base64');
  const size = imageSize(bytes);
  if (!size || size.width <= 0 || size.height <= 0) return null;
  if (size.type === 'jpeg' && size.width > REPORT_IMAGE_MAX_PX) {
    const smaller = downscaleJpeg(bytes, size.width);
    if (!smaller) return null;
    return { bytes: smaller, width: REPORT_IMAGE_MAX_PX, height: Math.max(1, Math.round((size.height * REPORT_IMAGE_MAX_PX) / size.width)) };
  }
  return { bytes, width: size.width, height: size.height };
}

// --- the timeline -----------------------------------------------------------

/** Steps that only look at the page (as the run page folds them, apps/web runTimeline.ts). */
const OBSERVATION_ACTIONS: ReadonlySet<string> = new Set(['text', 'elements', 'look', 'screenshot', 'tabs']);
const isObservation = (s: RunTraceStep) => s.ok && !s.screenshot && (s.kind === 'observe' || (s.action !== null && OBSERVATION_ACTIONS.has(s.action)));

type Row = { kind: 'step'; step: RunTraceStep } | { kind: 'observed'; steps: RunTraceStep[] };

/** Steps in order, two or more observations in a row folded into one row. */
export function timelineRows(steps: readonly RunTraceStep[]): Row[] {
  const rows: Row[] = [];
  for (const s of [...steps].sort((a, b) => a.seq - b.seq)) {
    const last = rows[rows.length - 1];
    if (isObservation(s) && last?.kind === 'observed') {
      last.steps.push(s);
      continue;
    }
    if (isObservation(s) && last?.kind === 'step' && isObservation(last.step)) {
      rows[rows.length - 1] = { kind: 'observed', steps: [last.step, s] };
      continue;
    }
    rows.push({ kind: 'step', step: s });
  }
  return rows;
}

const TIERS = ['fast', 'standard', 'frontier'];

/** A routing step (#405) in words: "Moved up to Frontier: stalled". */
function routingLine(s: RunTraceStep): string {
  const a = s.args ?? {};
  const reason = typeof a.reason === 'string' && a.reason.trim() ? a.reason.trim() : s.summary;
  if (typeof a.from === 'string' && typeof a.to === 'string' && TIERS.includes(a.from) && TIERS.includes(a.to) && a.from !== a.to) {
    const up = TIERS.indexOf(a.to) > TIERS.indexOf(a.from);
    return `${up ? 'Moved up' : 'Moved down'} to the ${TIER_LABEL[a.to]} model${reason ? `: ${reason}` : ''}`;
  }
  return `Switched model${reason ? `: ${reason}` : ''}`;
}

// --- the definition ---------------------------------------------------------

/** The images of a definition, by name, as `renderPdf` embeds them. */
export type ReportImages = Record<string, Buffer>;

/** A report's pdfmake document, its pictures in memory. */
export type ReportDefinition = Omit<TDocumentDefinitions, 'images'> & { images: ReportImages };

function heading(text: string, id: string): Content {
  // `outline` makes a bookmark: a reader's outline of the report's sections.
  return { text, style: 'h2', outline: true, outlineText: text, id } as Content;
}

function factsTable(rows: [string, string][]): Content {
  return {
    table: { widths: [110, '*'], body: rows.map(([k, v]) => [{ text: k, style: 'factKey' }, { text: v, style: 'factValue' }]) },
    layout: { hLineWidth: (i: number) => (i === 0 ? 0 : 0.5), vLineWidth: () => 0, hLineColor: () => RULE, paddingLeft: () => 0, paddingTop: () => 3, paddingBottom: () => 3 },
    margin: [0, 6, 0, 0],
  } as Content;
}

function boxed(stack: Content[], opts: { fill?: string; border?: string; leftBar?: boolean; margin?: [number, number, number, number] } = {}): Content {
  const border = opts.border ?? ACCENT;
  return {
    table: { widths: ['*'], body: [[{ stack, fillColor: opts.fill ?? SOFT_FILL }]] },
    layout: {
      hLineWidth: () => (opts.leftBar ? 0 : 0.8),
      vLineWidth: (i: number) => (opts.leftBar ? (i === 0 ? 3 : 0) : 0.8),
      hLineColor: () => border,
      vLineColor: () => border,
      paddingLeft: () => 8,
      paddingRight: () => 8,
      paddingTop: () => 6,
      paddingBottom: () => 6,
    },
    margin: opts.margin ?? [0, 6, 0, 6],
  } as Content;
}

/** The facts of the cover block. */
function coverFacts(trace: RunTrace): [string, string][] {
  const r = trace.run;
  const end = r.finishedAt ?? (trace.partial ? trace.exportedAt : null);
  const elapsed = r.startedAt && end ? new Date(end).getTime() - new Date(r.startedAt).getTime() : null;
  const active = reportDuration(r.usage.activeMs);
  const duration = reportDuration(elapsed);
  const models = trace.models.map((m) => `${TIER_LABEL[m.tier] ?? m.tier}: ${m.model ?? 'no model resolved'}${m.calls !== null ? ` (${plural(m.calls, 'call')})` : ''}`);
  const policy = trace.policy ? `${trace.policy.name} (version ${trace.policy.version})` : 'No policy recorded';
  return [
    ['Started', r.startedAt ? reportDate(r.startedAt) : `Not started (created ${reportDate(r.createdAt)})`],
    ['Finished', r.finishedAt ? reportDate(r.finishedAt) : trace.partial ? 'Still running' : '—'],
    ['Duration', duration ? `${duration}${active ? ` (working: ${active})` : ''}${trace.partial ? ' so far' : ''}` : '—'],
    ['Started from', startedFrom(r)],
    ['Node', r.host ? (r.host.name ?? `Node ${r.host.id.slice(0, 8)}`) : 'Not assigned'],
    ['Browser profile', r.profile],
    ['Policy and model', [policy, ...models].join('\n')],
    ['Steps', String(r.usage.stepCount)],
    ['Model calls', String(r.usage.modelCalls)],
    ['Cost', usd(r.usage.costUsd, r.usage.costKnown)],
  ];
}

function cover(trace: RunTrace, images: ReportImages): Content[] {
  void images;
  const out: Content[] = [
    {
      columns: [
        { svg: MARK_SVG, width: 22, height: 22 },
        { text: [{ text: 'hexactra', style: 'wordmark' }, { text: '   Run report', style: 'kicker' }], margin: [6, 4, 0, 0], width: '*' },
      ],
      columnGap: 0,
    } as Content,
    { text: trace.run.goal, style: 'title', outline: true, outlineText: 'Run report', id: 'title' } as Content,
    {
      table: { body: [[{ text: outcomeLabel(trace), style: 'chip' }]] },
      layout: { hLineWidth: () => 0.8, vLineWidth: () => 0.8, hLineColor: () => ACCENT, vLineColor: () => ACCENT, paddingLeft: () => 7, paddingRight: () => 7, paddingTop: () => 2, paddingBottom: () => 2 },
      margin: [0, 2, 0, 4],
    } as Content,
  ];
  if (trace.partial) {
    out.unshift(
      boxed([{ text: REPORT_PARTIAL_BANNER, style: 'bannerTitle' }, { text: `Exported ${reportDate(trace.exportedAt)} while the run was still working: what it did after that is not in this report.`, style: 'small' }], {
        border: MUTED,
      }),
    );
  }
  out.push(factsTable(coverFacts(trace)));
  return out;
}

function outcome(trace: RunTrace): Content[] {
  const r = trace.run;
  const out: Content[] = [heading('Outcome', 'outcome')];
  const reason = r.stopReason && r.stopReason !== 'finished' ? STOP_REASON[r.stopReason] ?? r.stopReason : null;
  if (reason) out.push({ text: reason, style: 'strong' });
  if (r.result) out.push({ text: [{ text: 'Result: ', style: 'strong' }, r.result], margin: [0, 3, 0, 0] });
  if (r.error) out.push({ text: [{ text: 'Reason: ', style: 'strong' }, r.error], margin: [0, 3, 0, 0] });
  if (!r.result && !r.error && !reason) out.push({ text: trace.partial ? 'The run has not ended yet.' : 'The run recorded no result.', style: 'muted' });
  if (r.confirmedActions.length) {
    out.push(
      boxed([
        { text: `You confirmed ${plural(r.confirmedActions.length, 'step')} that the run carried out`, style: 'boxTitle' },
        { text: 'These happened on the site and are not undone by the run ending.', style: 'small', margin: [0, 0, 0, 3] },
        { ul: r.confirmedActions.map((a) => `Step ${a.seq} at ${clock(a.at)} UTC: ${a.prompt} (${a.action})`), style: 'body' } as Content,
      ]),
    );
  }
  return out;
}

/** What the run returned (E39.5): one row per output, "not found" for a missing one; a sensitive value is already `[hidden]` in the trace. Nothing for a run without outputs. */
function outputsSection(trace: RunTrace): Content[] {
  const list = trace.outputs;
  if (!list?.length) return [];
  const rows: [string, string][] = list.map((o) => [o.label, o.value === null ? `Not found${o.note && o.note !== 'Not found' ? ` (${o.note})` : ''}` : typeof o.value === 'string' && o.sensitive ? o.value : formatOutputValue(o, o.value)]);
  return [heading('Outputs', 'outputs'), ...(trace.outputsComplete === false ? [{ text: 'Not every output was found.', style: 'muted' } as Content] : []), factsTable(rows)];
}

function questions(trace: RunTrace): Content[] {
  const seen = new Map<string, { at: string; q: Question }>();
  for (const s of trace.steps) {
    if (!s.question) continue;
    const prev = seen.get(s.question.id);
    // The asking step comes first; a later answer step carries the same question with its answer.
    if (!prev) seen.set(s.question.id, { at: s.at, q: s.question });
    else if (!prev.q.answer && s.question.answer) prev.q = s.question;
  }
  const out: Content[] = [heading('Questions and answers', 'questions')];
  if (!seen.size) return [...out, { text: 'The agent asked you nothing during this run.', style: 'muted' }];
  const head = ['Time', 'What was asked', 'Answer', 'Where', 'Waited'].map((t) => ({ text: t, style: 'th' }));
  const body = [...seen.values()].map(({ at, q }) => {
    const answered = q.answer?.answeredAt ?? null;
    const waited = answered ? reportDuration(new Date(answered).getTime() - new Date(at).getTime()) : null;
    const options = q.options?.length && (q.input === 'choice' || q.input === 'multi_choice') ? `\nOptions: ${q.options.map((o) => o.label).join(', ')}` : '';
    return [
      { text: clock(at), style: 'td' },
      { text: `${q.prompt}${options}`, style: 'td' },
      { text: answerLabel(q), style: 'tdStrong' },
      { text: q.answer?.channel ? (CHANNEL_LABEL[q.answer.channel] ?? q.answer.channel) : '—', style: 'td' },
      { text: waited ?? '—', style: 'td' },
    ];
  });
  out.push({
    table: { headerRows: 1, dontBreakRows: true, widths: [44, '*', 110, 56, 44], body: [head, ...body] },
    layout: { hLineWidth: (i: number) => (i === 1 ? 0.8 : 0.4), vLineWidth: () => 0, hLineColor: () => RULE, paddingLeft: () => 3, paddingRight: () => 3, paddingTop: () => 3, paddingBottom: () => 3 },
    margin: [0, 4, 0, 0],
  } as Content);
  return out;
}

function budget(trace: RunTrace): Content[] {
  const out: Content[] = [heading('Budget', 'budget')];
  const b = trace.budget;
  if (!b) return [...out, { text: 'No budget was recorded for this run.', style: 'muted' }];
  const soft = b.enforcement === 'soft';
  if (soft) out.push({ text: 'Limits not enforced (chat run): they are shown for reference, and a chat run is not stopped by them.', style: 'note', margin: [0, 0, 0, 4] });
  const head = ['Budget', 'Used', 'Limit', 'Percent'].map((t, i) => ({ text: t, style: 'th', alignment: i ? 'right' : 'left' }));
  const rows = BUDGET_ROWS.map(([key, label]) => {
    const limit = b.effective[key];
    const used = b.used[key] ?? 0;
    const pct = b.percent[key];
    const over = b.over.includes(key);
    const limitText = limit === null ? 'Unlimited' : `${budgetAmount(key, limit)}${soft ? ' (not enforced)' : ''}`;
    const pctText = pct === null ? '—' : `${pct}%${over ? (soft ? ' (over)' : ' (used up)') : ''}`;
    return [
      { text: label, style: 'td' },
      { text: budgetAmount(key, used, key === 'cost' ? b.costKnown : true), style: 'td', alignment: 'right' },
      { text: limitText, style: 'td', alignment: 'right' },
      { text: pctText, style: over ? 'tdStrong' : 'td', alignment: 'right' },
    ];
  });
  out.push({
    table: { headerRows: 1, dontBreakRows: true, widths: ['*', 90, 110, 80], body: [head, ...rows] },
    layout: { hLineWidth: (i: number) => (i === 1 ? 0.8 : 0.4), vLineWidth: () => 0, hLineColor: () => RULE, paddingLeft: () => 3, paddingRight: () => 3, paddingTop: () => 2.5, paddingBottom: () => 2.5 },
  } as Content);
  return out;
}

function stepColumns(seq: string, at: string, body: Content, duration: string | null): Content {
  return {
    columns: [
      { text: seq, width: 34, style: 'seq' },
      { text: at, width: 44, style: 'time' },
      { ...(body as object), width: '*' } as unknown as Content,
      { text: duration ?? '', width: 48, style: 'time', alignment: 'right' },
    ],
    columnGap: 6,
    margin: [0, 2.5, 0, 2.5],
  } as Content;
}

function timeline(trace: RunTrace, opts: Required<ReportOptions>, images: ReportImages, contentWidth: number, contentHeight: number): Content[] {
  const out: Content[] = [heading('Timeline', 'timeline'), { text: 'Times are UTC.', style: 'muted', margin: [0, 0, 0, 4] }];
  const confirmed = new Set(trace.run.confirmedActions.map((a) => a.seq));
  if (!trace.steps.length) return [...out, { text: 'The run recorded no steps.', style: 'muted' }];
  for (const row of timelineRows(trace.steps)) {
    if (row.kind === 'observed') {
      const first = row.steps[0]!;
      const lastStep = row.steps[row.steps.length - 1]!;
      const total = row.steps.reduce((n, s) => n + (s.durationMs ?? 0), 0);
      out.push(stepColumns(`${first.seq}–${lastStep.seq}.`, clock(first.at), { text: `Observed the page (${row.steps.length} steps)`, style: 'observed' }, reportDuration(total)));
      continue;
    }
    const s = row.step;
    if (s.kind === 'guidance') {
      out.push(stepColumns(`${s.seq}.`, clock(s.at), boxed([{ text: 'Your guidance', style: 'boxTitle' }, { text: s.summary, style: 'body' }], { leftBar: true, margin: [0, 0, 0, 2] }), null));
      continue;
    }
    const lines: Content[] = [];
    if (s.kind === 'routing') lines.push({ text: routingLine(s), style: 'routing' });
    else if (!s.ok) lines.push({ text: [{ text: '✗ Failed: ', bold: true }, s.summary], style: 'failed' });
    else lines.push({ text: s.summary || s.action || s.kind, style: 'body' });
    if (confirmed.has(s.seq)) lines.push({ text: 'Confirmed by you', style: 'confirmedTag' });
    if (s.reasoning) lines.push({ text: `Why: ${cut(s.reasoning.replace(/\s+/g, ' ').trim(), MAX_REASONING)}`, style: 'reason' });
    out.push(stepColumns(`${s.seq}.`, clock(s.at), { stack: lines }, reportDuration(s.durationMs)));
    const shot = s.screenshot;
    if (!shot) continue;
    if (shot.note) {
      out.push({ text: screenshotCaption(s.seq, shot), style: 'caption', margin: [84, 0, 0, 4] });
      continue;
    }
    if (opts.screenshots === 'none') continue;
    const picture = shot.data ? reportImage(shot.data) : null;
    if (!picture) {
      if (shot.data) out.push({ text: screenshotCaption(s.seq, shot, 'the picture could not be read'), style: 'caption', margin: [84, 0, 0, 4] });
      continue;
    }
    const name = `step-${s.seq}`;
    images[name] = picture.bytes;
    // Scaled to the content width, never taller than 60 % of the page; never split (unbreakable).
    const scale = Math.min(contentWidth / picture.width, (contentHeight * 0.6) / picture.height);
    out.push({
      stack: [
        { image: name, width: Math.round(picture.width * scale * 100) / 100, height: Math.round(picture.height * scale * 100) / 100, alignment: 'center' },
        { text: screenshotCaption(s.seq, shot), style: 'caption', alignment: 'center', margin: [0, 3, 0, 0] },
      ],
      unbreakable: true,
      margin: [0, 4, 0, 8],
    } as Content);
  }
  return out;
}

/**
 * The pdfmake document of a run's report: pure (no I/O, no clock; the trace
 * carries `exportedAt`). Its `images` hold the embedded pictures by name.
 */
export function buildReportDefinition(trace: RunTrace, options: ReportOptions = {}): ReportDefinition {
  const opts: Required<ReportOptions> = { paper: options.paper ?? 'a4', screenshots: options.screenshots ?? 'embed' };
  const page = PAGE[opts.paper];
  const contentWidth = page.width - 2 * MARGIN;
  const contentHeight = page.height - 2 * MARGIN;
  const images: ReportImages = {};
  const id8 = trace.run.id.slice(0, 8);
  const exported = reportDate(trace.exportedAt);
  const content: Content[] = [
    ...cover(trace, images),
    ...outcome(trace),
    ...outputsSection(trace),
    ...questions(trace),
    // The budget is short: heading and table stay on one page.
    { stack: budget(trace), unbreakable: true } as Content,
    ...timeline(trace, opts, images, contentWidth, contentHeight),
  ];
  return {
    pageSize: page.size,
    pageMargins: [MARGIN, MARGIN, MARGIN, MARGIN],
    info: {
      title: `Run report: ${cut(trace.run.goal.replace(/\s+/g, ' ').trim(), 80)}`,
      author: 'Hexactra',
      subject: `Hexactra run ${trace.run.id}`,
      creator: 'Hexactra Console',
      producer: 'Hexactra Console',
      creationDate: new Date(trace.exportedAt),
    },
    language: 'en-US',
    displayTitle: true,
    version: '1.7',
    tagged: true,
    images,
    content,
    footer: (currentPage: number, pageCount: number, pageSize?: ContextPageSize): Content => {
      void pageSize;
      return {
        margin: [MARGIN, 14, MARGIN, 0],
        stack: [
          {
            columns: [
              { text: `Run ${id8}`, width: '*' },
              { text: `Page ${currentPage} of ${pageCount}`, width: 'auto' },
              { text: `Exported ${exported}`, width: '*', alignment: 'right' },
            ],
            style: 'footer',
          },
          { text: REPORT_FOOTER_NOTE, style: 'footer', alignment: 'center', margin: [0, 2, 0, 0] },
        ],
      } as Content;
    },
    defaultStyle: { font: 'Inter', fontSize: 9.5, lineHeight: 1.22, color: TEXT },
    styles: {
      wordmark: { fontSize: 13, bold: true, color: TEXT },
      kicker: { fontSize: 10, color: MUTED },
      title: { fontSize: 18, bold: true, lineHeight: 1.15, margin: [0, 10, 0, 6] },
      chip: { fontSize: 9, bold: true, color: ACCENT },
      h2: { fontSize: 12.5, bold: true, color: ACCENT, margin: [0, 16, 0, 5] },
      strong: { bold: true },
      body: { fontSize: 9.5 },
      muted: { color: MUTED },
      small: { fontSize: 8.5, color: MUTED },
      note: { fontSize: 9, italics: true, color: MUTED },
      bannerTitle: { fontSize: 11, bold: true },
      boxTitle: { bold: true, margin: [0, 0, 0, 2] },
      factKey: { color: MUTED, fontSize: 9 },
      factValue: { fontSize: 9.5 },
      th: { bold: true, fontSize: 8.5, color: MUTED },
      td: { fontSize: 9 },
      tdStrong: { fontSize: 9, bold: true },
      seq: { fontSize: 9, bold: true, color: MUTED },
      time: { fontSize: 8.5, color: MUTED },
      observed: { color: MUTED, italics: true },
      routing: { color: MUTED, italics: true },
      failed: { color: FAIL },
      confirmedTag: { fontSize: 8.5, bold: true, color: ACCENT },
      reason: { fontSize: 8.5, color: MUTED, margin: [0, 1, 0, 0] },
      caption: { fontSize: 8.5, italics: true, color: MUTED },
      footer: { fontSize: 7.5, color: MUTED },
    },
  } as ReportDefinition;
}

// --- rendering --------------------------------------------------------------

/** The repository's fonts: `apps/api/assets/fonts` (two levels up from both src/tasks and dist/tasks). */
const FONT_DIR = join(__dirname, '..', '..', 'assets', 'fonts');
let fonts: TFontDictionary | null = null;

function reportFonts(): TFontDictionary {
  if (!fonts) {
    const f = (name: string) => readFileSync(join(FONT_DIR, name));
    fonts = { Inter: { normal: f('Inter-Regular.ttf'), bold: f('Inter-SemiBold.ttf'), italics: f('Inter-Italic.ttf'), bolditalics: f('Inter-SemiBoldItalic.ttf') } };
  }
  return fonts;
}

type PdfMake = typeof import('pdfmake');
let engine: PdfMake | null = null;

function pdfmake(): PdfMake {
  if (!engine) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    engine = require('pdfmake') as PdfMake;
    // No network and no file system at render time: fonts and images are in memory.
    engine.setUrlAccessPolicy(() => false);
    engine.setLocalAccessPolicy(() => false);
  }
  engine.setFonts(reportFonts());
  return engine;
}

/** Lay the definition out and stream the PDF. Errors arrive on the stream. */
export function renderPdf(definition: ReportDefinition): Readable {
  const out = new PassThrough();
  let doc: Promise<NodeJS.ReadableStream & { end(): void }>;
  try {
    doc = pdfmake().createPdf(definition as unknown as TDocumentDefinitions).getStream() as unknown as Promise<NodeJS.ReadableStream & { end(): void }>;
  } catch (err) {
    process.nextTick(() => out.destroy(err as Error));
    return out;
  }
  doc.then(
    (pdf) => {
      pdf.on('error', (err: Error) => out.destroy(err));
      pdf.pipe(out);
      pdf.end();
    },
    (err: Error) => out.destroy(err),
  );
  return out;
}

/** The whole PDF in memory (tests, the CLI-sized case). */
export async function renderPdfBuffer(definition: ReportDefinition): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of renderPdf(definition)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
