// `run_export` (#542): a run's trace for a hosted client, without images and
// within the tool result size limit (#462). Pure: the tool fetches the trace
// through `GET /runs/{id}/export?screenshots=none`, this fits it.
import { z } from 'zod';

import { runTraceSchema, type RunTrace } from '../tasks/run-trace.schemas';

/** Room kept for the untrusted notice and the summary line the result adds before the JSON. */
const LEAD_ROOM = 2_000;

/** What `run_export` returns: the trace, and what was left out to fit. */
export const runExportOutputSchema = runTraceSchema.extend({
  truncated: z.boolean().describe('True when the trace was cut to fit the result size limit: see `truncation`. The full file is `hexactra runs export <id>` or the console.'),
  truncation: z
    .object({
      reasoningDropped: z.boolean().describe("Every step's `reasoning` was set to null (dropped first)"),
      stepsOmitted: z.number().int().describe('How many of the oldest steps were left out (dropped next)'),
      chatOmitted: z.number().int().describe('How many of the oldest chat messages were left out (dropped last, only once every step is gone)'),
    })
    .describe('What was left out to fit; false and 0 when nothing was'),
  untrusted: z.boolean().optional().describe('Set: the trace holds text from web pages (step summaries, the result)'),
});
export type RunExportOutput = z.infer<typeof runExportOutputSchema>;

/** The size the result's text block takes: the pretty JSON the client reads. */
const sizeOf = (v: unknown) => JSON.stringify(v, null, 2).length;

/** The fewest `n` in [1, max] for which `fits(n)` (monotone), or `max` when none does. */
function fewest(max: number, fits: (n: number) => boolean): number {
  let lo = 1;
  let hi = max;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * The trace without images, cut to `maxChars`: first every step's
 * `reasoning`, then the oldest steps, and only once no step is left the
 * oldest chat messages; `truncated` and `truncation` say what went. Images
 * never reach a tool result.
 */
export function fitRunTrace(trace: RunTrace, maxChars: number): RunExportOutput {
  const max = Math.max(1_000, maxChars - LEAD_ROOM);
  const steps = trace.steps.map((s) => {
    if (!s.screenshot) return s;
    const { data: _d, ...shot } = s.screenshot;
    return { ...s, screenshot: shot };
  });
  const out: RunExportOutput = { ...trace, steps, truncated: false, truncation: { reasoningDropped: false, stepsOmitted: 0, chatOmitted: 0 } };
  if (sizeOf(out) <= max) return out;
  const bare = steps.map((s) => ({ ...s, reasoning: null }));
  const cut = (stepsOmitted: number, chatOmitted = 0): RunExportOutput => ({
    ...out,
    steps: bare.slice(stepsOmitted),
    chat: trace.chat.slice(chatOmitted),
    truncated: true,
    truncation: { reasoningDropped: true, stepsOmitted, chatOmitted },
  });
  const fits = (v: RunExportOutput) => sizeOf(v) <= max;
  if (fits(cut(0))) return cut(0);
  if (bare.length && fits(cut(bare.length))) return cut(fewest(bare.length, (n) => fits(cut(n))));
  if (!trace.chat.length) return cut(bare.length);
  return cut(bare.length, fewest(trace.chat.length, (n) => fits(cut(bare.length, n))));
}

/** Whether the trace holds page-derived text (MCP rule 4: the result is marked untrusted). */
export function traceHasPageText(t: RunTrace): boolean {
  return Boolean(t.run.result || t.run.error || t.steps.length || t.chat.length);
}
