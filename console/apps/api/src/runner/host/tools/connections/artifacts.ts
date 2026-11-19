// A run's own artifacts, by handle (E39.7): a masked trace screenshot of one of its steps, or its PDF report. A tool hands one to a connection
// (an attachment of a message, `file_upload`) by naming it; the bytes come from the run's own store, never from the model and never inline.
// Shared support, not a tool.
import type { HostContext } from '../../context';

/** The most one artifact may weigh (the capability's own limit is the same). */
export const ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;

export interface RunArtifactRef {
  source: 'screenshot' | 'report';
  step: number | null;
}

export type LoadedArtifact = { ok: true; name: string; contentType: string; bytes: Buffer } | { ok: false; text: string };

/** Loads one artifact of THIS run. A step of another run, an unmasked image or a missing one is refused with a reason the model can act on. */
export async function loadRunArtifact(ctx: HostContext, ref: RunArtifactRef): Promise<LoadedArtifact> {
  const { d } = ctx.ext;
  if (ref.source === 'screenshot') {
    if (!d.artifacts) return { ok: false, text: 'Run screenshots are not stored on this deployment.' };
    if (ref.step === null) return { ok: false, text: 'A screenshot needs the step number it was taken at.' };
    const row = await d.prisma.runStep.findFirst({ where: { runId: ctx.run.id, seq: ref.step, screenshotKey: { not: null } }, select: { screenshotKey: true, screenshotMasked: true } });
    // Only the masked trace picture: there is no unmasked one (a stored picture is masked at capture).
    if (!row?.screenshotKey) return { ok: false, text: `Step ${ref.step} has no stored screenshot.` };
    const got = await d.artifacts.get(row.screenshotKey);
    if (!got) return { ok: false, text: `The screenshot of step ${ref.step} is no longer stored.` };
    if (got.bytes.length > ARTIFACT_MAX_BYTES) return { ok: false, text: 'That screenshot is larger than the limit.' };
    return { ok: true, name: `screenshot-step-${ref.step}.${got.contentType === 'image/png' ? 'png' : 'jpg'}`, contentType: got.contentType, bytes: got.bytes };
  }
  if (!d.traces) return { ok: false, text: 'The PDF report is not available on this deployment.' };
  const file = await d.traces.exportPdf(ctx.run.userId, ctx.run.id, { screenshots: 'embed', orgId: ctx.run.orgId });
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
  return { ok: true, name: file.filename, contentType: 'application/pdf', bytes: Buffer.concat(chunks) };
}
