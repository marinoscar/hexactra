// Generated run traces for the PDF report tests (#543). Generated data only:
// invented goals, sites and pictures (jpeg-js gradients), deterministic.
import * as jpeg from 'jpeg-js';

import type { RunTrace, RunTraceStep } from '../../src/tasks/run-trace.schemas';

/** A deterministic JPEG: a gradient with a band, `width` × `height`. */
export function testJpeg(width: number, height: number, seed = 0): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const band = y > height * 0.12 && y < height * 0.2;
      data[o] = band ? 75 : (x * 255) / width;
      data[o + 1] = band ? 75 : (y * 255) / height;
      data[o + 2] = band ? 232 : (seed * 40) % 255;
      data[o + 3] = 255;
    }
  }
  return Buffer.from(jpeg.encode({ data, width, height }, 70).data);
}

const RUN_ID = '5e1f3c2a-7b4d-4e8f-9a61-0c2d3e4f5a6b';
const T0 = Date.parse('2026-11-18T18:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

export interface TraceFixtureOptions {
  steps?: number;
  images?: number;
  imageSize?: [number, number];
  status?: RunTrace['run']['status'];
  partial?: boolean;
  soft?: boolean;
  withData?: boolean;
}

/**
 * A finished run of `steps` steps: two questions (a confirmation at step 12,
 * a code at step 30, answered at 31), one confirmed action (step 13), a
 * failed step (20), a routing step (25), owner guidance (40), runs of page
 * observations, and `images` key-moment pictures.
 */
export function traceFixture(o: TraceFixtureOptions = {}): RunTrace {
  const n = o.steps ?? 60;
  const imageCount = o.images ?? 6;
  const [iw, ih] = o.imageSize ?? [320, 200];
  const withData = o.withData ?? true;
  const steps: RunTraceStep[] = [];
  const shotSeqs = new Set<number>();
  // Key moments: the two questions, the confirmed step, the failure, the final screen, then spread.
  for (const s of [12, 30, 13, 20, n]) if (shotSeqs.size < imageCount && s <= n) shotSeqs.add(s);
  for (let s = 3; shotSeqs.size < imageCount && s <= n; s += Math.max(1, Math.floor(n / imageCount))) shotSeqs.add(s);

  for (let seq = 1; seq <= n; seq++) {
    const base: RunTraceStep = {
      seq,
      at: at(seq * 4),
      kind: 'action',
      action: 'click',
      args: { selector: `#item-${seq}` },
      ok: true,
      summary: `Clicked item ${seq} on the fare list`,
      reasoning: seq % 5 === 0 ? `Item ${seq} looks like the next fare to compare.` : null,
      durationMs: 600 + (seq % 7) * 150,
      question: null,
      screenshot: null,
    };
    if (seq % 9 === 4 || seq % 9 === 5) Object.assign(base, { action: 'text', summary: 'Read the page text', reasoning: null });
    if (seq === 12)
      Object.assign(base, {
        kind: 'handoff',
        action: null,
        summary: 'Asked you to confirm the booking',
        question: { id: '11111111-1111-4111-8111-111111111111', kind: 'confirmation', input: 'confirm', prompt: 'Book fare Alpha for $120.00?', options: null, risk: 'high', status: 'answered', answer: { outcome: 'completed', value: 'approve', valueWithheld: false, channel: 'notification', answeredAt: at(12 * 4 + 95) } },
      });
    if (seq === 13) Object.assign(base, { summary: 'Clicked Book now', action: 'click' });
    if (seq === 20) Object.assign(base, { ok: false, kind: 'error', action: 'click', summary: 'The payment page did not load' });
    if (seq === 25) Object.assign(base, { kind: 'routing', action: null, args: { from: 'standard', to: 'frontier', reason: 'stalled' }, summary: 'standard → frontier: stalled', durationMs: 0 });
    if (seq === 30)
      Object.assign(base, {
        kind: 'handoff',
        action: null,
        summary: 'Asked you for the code from the confirmation message',
        question: { id: '22222222-2222-4222-8222-222222222222', kind: 'code', input: 'secret', prompt: 'Enter the code sent to your phone', options: null, risk: null, status: 'answered', answer: { outcome: 'completed', valueWithheld: true, channel: 'inbox', answeredAt: at(31 * 4) } },
      });
    if (seq === 31) Object.assign(base, { kind: 'handoff', action: 'answered', summary: 'The owner provided it' });
    if (seq === 40) Object.assign(base, { kind: 'guidance', action: null, args: null, summary: 'Prefer the morning flight if the prices are close.', durationMs: 0 });
    if (seq === n) Object.assign(base, { kind: 'end', action: null, summary: 'Final screen', durationMs: 0 });
    if (shotSeqs.has(seq)) {
      const moment = seq === 12 ? 'before_confirmed' : seq === 30 ? 'question' : seq === 13 ? 'after_confirmed' : seq === 20 ? 'failure' : seq === n ? 'final' : 'question';
      base.screenshot = { moment, masked: seq === 12 ? 2 : 0, note: null, contentType: 'image/jpeg', bytes: null, ...(withData ? { data: testJpeg(iw, ih, seq).toString('base64') } : {}) };
      if (base.action === 'text') base.action = 'click';
    }
    steps.push(base);
  }

  const soft = o.soft ?? false;
  return {
    type: 'hexactra.run-trace',
    formatVersion: 1,
    exportedAt: '2026-11-18T19:00:00.000Z',
    partial: o.partial ?? false,
    console: { version: '0.0.0' },
    masking: { applied: true, patternsVersion: 1, hits: {} },
    run: {
      id: RUN_ID,
      goal: 'Find the cheapest morning fare from City A to City B and book it',
      status: o.status ?? 'succeeded',
      stopReason: (o.status ?? 'succeeded') === 'succeeded' ? 'finished' : null,
      result: 'Booked fare Alpha for $120.00. The confirmation is in the account.',
      error: null,
      trigger: soft ? 'chat' : 'manual',
      origin: 'web',
      client: null,
      taskId: '33333333-3333-4333-8333-333333333333',
      taskName: 'Morning fares',
      conversationId: null,
      profile: 'default',
      traceIds: [],
      host: { id: '44444444-4444-4444-8444-444444444444', name: 'Node Alpha' },
      createdAt: at(0),
      startedAt: at(1),
      finishedAt: o.partial ? null : at(n * 4 + 5),
      confirmedActions: [{ seq: 13, prompt: 'Book fare Alpha for $120.00?', action: 'click', at: at(13 * 4) }],
      usage: { stepCount: n, modelCalls: n + 4, inputTokens: 120_000, outputTokens: 8_000, cachedInputTokens: 0, costUsd: 0.42, costKnown: true, activeMs: n * 3_000 },
    },
    policy: null,
    budget: {
      effective: { actions: 100, modelCalls: 200, activeMinutes: 20, inputTokens: null, outputTokens: null, cost: 2, warnAtPercent: 80 },
      used: { actions: n, modelCalls: n + 4, activeMinutes: 3, inputTokens: 120_000, outputTokens: 8_000, cost: 0.42 },
      percent: { actions: n, modelCalls: ((n + 4) / 2), activeMinutes: 15, inputTokens: null, outputTokens: null, cost: 21 },
      source: { actions: 'policy', modelCalls: 'policy', activeMinutes: 'policy', inputTokens: null, outputTokens: null, cost: 'ceiling' },
      costKnown: true,
      enforcement: soft ? 'soft' : 'hard',
      over: [],
    },
    models: [
      { tier: 'standard', model: 'provider-x:model-standard', calls: null },
      { tier: 'frontier', model: 'provider-x:model-frontier', calls: null },
    ],
    steps,
    chat: [],
  } as RunTrace;
}
