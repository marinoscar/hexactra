// The spreadsheet delivery (E39.6, #603): one row appended to the spreadsheet picked on the task, through the connection's
// `DocumentsCapability` (Google Sheets, Excel). Cell values are written RAW: a value that starts with `=` is text, never a formula.
//
// Exactly once: the row's last column is always "Run ID". When the send is a retry (or an earlier attempt's outcome is unknown) the
// sender reads that column first and, if the run's id is already there, adds nothing. An append the provider answered ambiguously
// (a timeout after the request left) is checked the same way before it is ever repeated.
import { randomBytes } from 'node:crypto';
import { Injectable, Optional } from '@nestjs/common';

import { isCapabilityError } from '../../connections/capabilities';
import { ConnectionCapabilities } from '../../connections/connection-capabilities.service';
import { RunReportLinks } from '../../tasks/run-report-link';
import { DeliveryFailure, failureFrom, type DeliverySender, type SendContext, type SendOutcome } from '../delivery-sender';
import { columnLetter, sheetHeaders, sheetRow } from '../delivery-payload';
import type { SheetRowConfig } from '../delivery.schemas';

@Injectable()
export class SheetRowSender implements DeliverySender {
  readonly kind = 'sheet_row' as const;

  constructor(
    private readonly links: RunReportLinks,
    @Optional() private readonly capabilities?: ConnectionCapabilities,
  ) {}

  async send(ctx: SendContext): Promise<SendOutcome> {
    const cfg = ctx.delivery.config as SheetRowConfig;
    if (!this.capabilities) throw new DeliveryFailure('KIND_UNAVAILABLE');
    const docs = this.capabilities.documents({ connectionId: cfg.connectionId, userId: ctx.delivery.userId, signal: ctx.signal });
    const headers = sheetHeaders(cfg);
    const last = columnLetter(headers.length);
    const sheet = cfg.sheet;
    try {
      let fileId = cfg.fileId;
      let created = false;
      if (!fileId) {
        // `createIfMissing` and no file yet: the first send makes the spreadsheet (headers in its first row) and pins it.
        const file = await docs.createSpreadsheet({ title: cfg.newTitle ?? (ctx.facts.taskName || 'Run results'), headers });
        fileId = file.id;
        created = true;
        await ctx.pin?.({ fileId });
        await ctx.record({ createdFile: true });
      }

      const links = { runUrl: this.links.pageUrl(`/runs/${ctx.facts.runId}`), reportUrl: ctx.test ? null : this.links.url(ctx.delivery.userId, ctx.facts.runId) };
      const row = sheetRow(ctx.facts, cfg, links);
      // A test row is marked in its Run ID cell and never matches a real run.
      const marker = ctx.test ? `TEST-${randomBytes(4).toString('hex')}` : ctx.facts.runId;
      row[row.length - 1] = marker;

      // The retry check: has an earlier attempt already added this run's row?
      if (!ctx.test && (ctx.attempt > 1 || ctx.ambiguous || ctx.prior.appendAmbiguous === true)) {
        const found = await this.hasRow(docs, fileId, sheet, last, marker);
        if (found.present) return { status: 'sent', detail: { destination: 'spreadsheet', rows: 1, deduplicated: true } };
      }

      // Headers: a spreadsheet with an empty first row gets them first (the delivery's own, in the same call as the row).
      const first = await docs.readSheet(fileId, { ...(sheet ? { sheet } : {}), range: `A1:${last}1` });
      const needsHeaders = !created && !first.values.some((r) => r.some((c) => c !== null && c !== ''));
      let res: { ambiguous: boolean; updatedRange: string | null };
      try {
        res = await docs.appendRows(fileId, sheet, needsHeaders ? [headers, row] : [row]);
      } catch (e) {
        // A request that left and got no definite answer: the same as an ambiguous result, checked before anything is repeated.
        if (!(isCapabilityError(e) && e.details.outcomeUnknown)) throw e;
        res = { ambiguous: true, updatedRange: null };
      }
      if (res.ambiguous) {
        await ctx.record({ appendAmbiguous: true });
        // Look before anything is repeated: if the row is there, the append worked.
        if (!ctx.test) {
          const found = await this.hasRow(docs, fileId, sheet, last, marker);
          if (found.present) return { status: 'sent', detail: { destination: 'spreadsheet', rows: 1, verifiedAfterAmbiguous: true } };
        }
        // Not (yet) there: fail retryably. The next attempt checks first, then appends.
        throw new DeliveryFailure('PROVIDER_ERROR', { ambiguous: true });
      }
      return { status: 'sent', detail: { destination: 'spreadsheet', rows: 1, headersWritten: needsHeaders, ...(ctx.test && res.updatedRange ? { location: res.updatedRange } : {}) } };
    } catch (e) {
      throw failureFrom(e);
    }
  }

  /** Is `runId` in the last column? Reads that one column (up to the sheet read limit: past it, the oldest rows are what was read). */
  private async hasRow(docs: ReturnType<ConnectionCapabilities['documents']>, fileId: string, sheet: string | undefined, last: string, runId: string): Promise<{ present: boolean; partial: boolean }> {
    const col = await docs.readSheet(fileId, { ...(sheet ? { sheet } : {}), range: `${last}:${last}` });
    return { present: col.values.some((r) => r.some((c) => String(c) === runId)), partial: col.truncated };
  }
}
