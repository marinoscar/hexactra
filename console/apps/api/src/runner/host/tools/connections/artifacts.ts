// A run's own artifacts, by handle (E39.7), and the previous job's of the same chat (E41.4): a masked trace screenshot of one of its steps,
// or its PDF report. A tool hands one to a connection (an attachment of a message, `file_upload`) by naming it; the bytes come from the
// run's own store, never from the model and never inline. Another run is reachable only as `previous`: the most recent finished run of the
// same owner and the same chat. A run id from the model is never accepted. Shared support, not a tool.
import { ATTR } from '../../../trace-attributes';
import type { HostContext } from '../../context';

/** The most one artifact may weigh (the capability's own limit is the same). */
export const ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;

export interface RunArtifactRef {
  source: 'screenshot' | 'report';
  step: number | null;
  /** 'this' (default) or 'previous': the most recent finished job of the same chat. */
  run?: 'this' | 'previous' | null;
}

export type LoadedArtifact = { ok: true; name: string; contentType: string; bytes: Buffer; origin: string } | { ok: false; text: string };

/** The previous job of the run's chat: the most recent finished run of the same owner and chat, never this one. */
export async function previousRunOf(ctx: HostContext): Promise<{ id: string } | 'no_chat' | 'none'> {
  const { conversationId, userId, id } = ctx.run;
  if (!conversationId) return 'no_chat';
  const prev = await ctx.ext.d.prisma.forUser({ userId }).run.findFirst({
    where: { conversationId, userId, id: { not: id }, status: { in: ['succeeded', 'failed', 'cancelled'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  return prev ?? 'none';
}

/** Where an attachment comes from, in the words the owner's approval card shows. */
export function artifactOrigin(ref: RunArtifactRef): string {
  const previous = ref.run === 'previous';
  if (ref.source === 'report') return previous ? 'Report of the previous job (PDF)' : "This job's report (PDF)";
  if (ref.step === null) return previous ? 'Screenshot from the previous job (final screen)' : 'Screenshot of this job';
  return previous ? `Screenshot from the previous job (step ${ref.step})` : `Screenshot of step ${ref.step}`;
}

/**
 * Why a step of THIS run cannot be attached, and what to do instead (E54.4, #1085): the agent once tried steps 8, 11 and 59 in turn, never
 * called save_screenshot, and asked the owner for a sign-in to work around it. The text names the tool that stores a picture and the steps
 * of this run that have one (the newest 10), so the next call can succeed.
 */
async function missingStepText(d: HostContext['ext']['d'], runId: string, step: number | null): Promise<string> {
  const stored = await d.prisma.runStep.findMany({ where: { runId, screenshotKey: { not: null } }, orderBy: { seq: 'desc' }, take: 10, select: { seq: true } });
  const list = stored.map((s) => s.seq).sort((a, b) => a - b);
  const which = list.length ? `Steps of this job with a stored screenshot: ${list.join(', ')}.` : 'No step of this job has a stored screenshot yet.';
  return `Step ${step} has no stored screenshot. Use save_screenshot to store the page as it is now: it returns the step to attach. ${which}`;
}

/** Loads one artifact of THIS run, or of the previous job of its chat. A run of another owner or chat, an unmasked image or a missing one is refused with a reason the model can act on. */
export async function loadRunArtifact(ctx: HostContext, ref: RunArtifactRef): Promise<LoadedArtifact> {
  const { d } = ctx.ext;
  let runId = ctx.run.id;
  const previous = ref.run === 'previous';
  if (previous) {
    const prev = await previousRunOf(ctx);
    if (prev === 'no_chat') return { ok: false, text: 'This job has no previous job to take that from.' };
    if (prev === 'none') return { ok: false, text: 'There is no earlier job in this chat.' };
    runId = prev.id;
  }
  const origin = artifactOrigin(ref);
  if (ref.source === 'screenshot') {
    if (!d.artifacts) return { ok: false, text: 'Run screenshots are not stored on this deployment.' };
    if (ref.step === null && !previous) return { ok: false, text: 'A screenshot needs the step number it was taken at.' };
    // The previous job's final screen when no step is given: its `final` picture, else its newest stored one.
    const where = ref.step !== null ? { runId, seq: ref.step, screenshotKey: { not: null } } : { runId, screenshotKey: { not: null } };
    const row =
      ref.step !== null
        ? await d.prisma.runStep.findFirst({ where, select: { seq: true, screenshotKey: true, screenshotMasked: true } })
        : ((await d.prisma.runStep.findFirst({ where: { ...where, screenshotMoment: 'final' }, orderBy: { seq: 'desc' }, select: { seq: true, screenshotKey: true, screenshotMasked: true } })) ??
          (await d.prisma.runStep.findFirst({ where, orderBy: { seq: 'desc' }, select: { seq: true, screenshotKey: true, screenshotMasked: true } })));
    // Only the masked trace picture: there is no unmasked one (a stored picture is masked at capture).
    if (!row?.screenshotKey) {
      if (previous) return { ok: false, text: ref.step === null ? 'The previous job has no stored screenshot. Open the page and use save_screenshot.' : `Step ${ref.step} of the previous job has no stored screenshot.` };
      return { ok: false, text: await missingStepText(d, runId, ref.step) };
    }
    const got = await d.artifacts.get(row.screenshotKey);
    if (!got) return { ok: false, text: `The screenshot of step ${row.seq} is no longer stored.` };
    if (got.bytes.length > ARTIFACT_MAX_BYTES) return { ok: false, text: 'That screenshot is larger than the limit.' };
    const ext = got.contentType === 'image/png' ? 'png' : 'jpg';
    return { ok: true, name: previous ? `previous-job-screenshot-step-${row.seq}.${ext}` : `screenshot-step-${row.seq}.${ext}`, contentType: got.contentType, bytes: got.bytes, origin };
  }
  if (!d.traces) return { ok: false, text: 'The PDF report is not available on this deployment.' };
  const file = await d.traces.exportPdf(ctx.run.userId, runId, { screenshots: 'embed', orgId: ctx.run.orgId });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of file.stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buf.length;
    if (size > ARTIFACT_MAX_BYTES) {
      file.stream.destroy();
      return { ok: false, text: 'The report is larger than the limit.' };
    }
    chunks.push(buf);
  }
  return { ok: true, name: file.filename, contentType: 'application/pdf', bytes: Buffer.concat(chunks), origin };
}

/** The trace attributes of an attachment (E41.4): its kind and whether it is this job's or the previous one's. Never a name or a key. */
export function noteArtifact(ctx: HostContext, ref: RunArtifactRef): void {
  ctx.ports.telemetry.toolAttributes({ [ATTR.artifactSource]: ref.source, [ATTR.artifactRun]: ref.run === 'previous' ? 'previous' : 'this' });
}
