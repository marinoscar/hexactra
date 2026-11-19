// The folder delivery (E39.6, #603): the run's masked files saved to a folder picked on the task: one of the owner's connections
// (Drive, OneDrive) or the deployment's own object storage under the owner's prefix.
//
//   * The folder is fixed on the delivery. The file name comes from the delivery's template: the run's text can fill a placeholder,
//     one line, capped, and never a path: `/`, `\`, `..` and control characters are replaced, so a value names a file and never a place.
//   * The files are the masked PDF, JSON trace and step pictures (RunFilesService): there is no unmasked file.
//   * Storage keys are made only of ids and the safe file name (`deliveries/<userId>/<runId>/<name>`), and are written with the same key on
//     every attempt, so a retry overwrites instead of adding. A connection folder is checked for the name before a retried upload.
import { Inject, Injectable, Optional } from '@nestjs/common';

import { ConnectionCapabilities } from '../../connections/connection-capabilities.service';
import type { RunFile } from '../../tasks/run-files.service';
import { RUN_ARTIFACT_STORE, type RunArtifactStore } from '../../tasks/run-delete.service';
import { FILE_NAME_MAX } from '../deliveries.constants';
import { templateValuesOf } from '../delivery-facts';
import { DeliveryFailure, failureFrom, type DeliverySender, type SendContext, type SendOutcome } from '../delivery-sender';
import { renderTemplate, safeFileName } from '../delivery.templates';
import type { FolderConfig } from '../delivery.schemas';

interface NamedFile {
  name: string;
  contentType: string;
  bytes: Buffer;
}

const EXT: Record<string, string> = { 'application/pdf': 'pdf', 'application/json': 'json', 'image/png': 'png', 'image/jpeg': 'jpg', 'text/plain': 'txt' };
const bareType = (t: string): string => t.split(';')[0]!.trim();

/** `<base>.pdf`, `<base>.json`, `<base> step-3.png`: the base is already safe, and so is the whole. */
export function fileNamesFor(base: string, files: { filename: string; contentType: string }[]): string[] {
  return files.map((f) => {
    const type = bareType(f.contentType);
    const ext = EXT[type] ?? 'bin';
    const step = /^step-(\d+)\./.exec(f.filename);
    return safeFileName(step ? `${base} step-${step[1]}.${ext}` : `${base}.${ext}`, 200);
  });
}

@Injectable()
export class FolderSender implements DeliverySender {
  readonly kind = 'folder' as const;

  constructor(
    @Optional() private readonly capabilities?: ConnectionCapabilities,
    @Optional() @Inject(RUN_ARTIFACT_STORE) private readonly store?: RunArtifactStore,
  ) {}

  async send(ctx: SendContext): Promise<SendOutcome> {
    const cfg = ctx.delivery.config as FolderConfig;
    const base = renderTemplate(cfg.nameTemplate, templateValuesOf(ctx.facts), 'filename');
    const files = await this.collect(ctx, cfg, base);
    if (files.length === 0) throw new DeliveryFailure('CONFIG_INVALID', { files: 0 });

    const done = new Set<number>(Array.isArray(ctx.prior.done) ? (ctx.prior.done as number[]) : []);
    let bytes = 0;
    if (cfg.target === 'storage') {
      if (!this.store) throw new DeliveryFailure('KIND_UNAVAILABLE');
      const prefix = ctx.test ? `deliveries/${ctx.delivery.userId}/test/${ctx.delivery.id}` : `deliveries/${ctx.delivery.userId}/${ctx.facts.runId}`;
      for (const [i, f] of files.entries()) {
        if (done.has(i)) continue;
        try {
          await this.store.put(`${prefix}/${f.name}`, f.bytes, f.contentType);
        } catch {
          throw new DeliveryFailure('PROVIDER_ERROR', { files: files.length });
        }
        done.add(i);
        bytes += f.bytes.length;
        await ctx.record({ done: [...done] });
      }
      return { status: 'sent', detail: { destination: 'storage', files: files.length, bytes } };
    }

    if (!this.capabilities) throw new DeliveryFailure('KIND_UNAVAILABLE');
    const docs = this.capabilities.documents({ connectionId: cfg.target.connectionId, userId: ctx.delivery.userId, signal: ctx.signal });
    const folderId = cfg.target.folderId;
    try {
      for (const [i, f] of files.entries()) {
        if (done.has(i)) continue;
        // A retry (or an attempt whose outcome is unknown) first looks for the file by name in the folder: no second copy.
        if (!ctx.test && (ctx.attempt > 1 || ctx.ambiguous)) {
          const page = await docs.searchFiles({ text: f.name, folderId, pageSize: 50 });
          if (page.items.some((x) => x.name === f.name && (x.parentId === null || x.parentId === folderId))) {
            done.add(i);
            await ctx.record({ done: [...done] });
            continue;
          }
        }
        await docs.uploadFile({ name: f.name, contentType: bareType(f.contentType), bytes: f.bytes, folderId });
        done.add(i);
        bytes += f.bytes.length;
        await ctx.record({ done: [...done] });
      }
    } catch (e) {
      throw failureFrom(e);
    }
    return { status: 'sent', detail: { destination: 'folder', files: files.length, bytes } };
  }

  /** The files this delivery saves, each with its safe name. A test saves one small text file and never a real run's report. */
  private async collect(ctx: SendContext, cfg: FolderConfig, base: string): Promise<NamedFile[]> {
    if (!ctx.material) {
      const text = Buffer.from('This is a test file from your task\'s folder delivery. No run was saved.\n', 'utf8');
      return [{ name: safeFileName(`${base} TEST.txt`, 200), contentType: 'text/plain', bytes: text }];
    }
    const m = ctx.material;
    const raw: RunFile[] = [];
    try {
      if (cfg.files.pdf) raw.push(await m.pdf(cfg.files.screenshots !== 'none'));
      if (cfg.files.json) raw.push(await m.json());
      if (cfg.files.screenshots !== 'none') raw.push(...(await m.pictures(cfg.files.screenshots)));
    } catch {
      throw new DeliveryFailure('INTERNAL', { stage: 'files' });
    }
    const names = fileNamesFor(base, raw);
    return raw.map((f, i) => ({ name: names[i]!, contentType: f.contentType, bytes: f.bytes }));
  }
}
