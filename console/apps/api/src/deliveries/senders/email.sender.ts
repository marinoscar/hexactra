// The email delivery (E39.6, #603): the run's report to the addresses typed on the task, one message per address, through the
// console's own sender or through one of the owner's connections (`mail_send`).
//
//   * Recipients come from the delivery's configuration and nowhere else. A run's text can fill a table cell or a subject placeholder;
//     it can add no address, no header, no link and no attachment (the message is composed by the `run-report` template, which escapes
//     every value, and the subject is flattened to one line).
//   * Each address is checked at send time: the owner's own, or confirmed by the owner; one that stopped the emails is skipped.
//   * A recipient who is not the owner gets the one-time notice first, and an unsubscribe link in every message.
//   * Attachments are the masked PDF, JSON and step pictures (RunFilesService), cut to the size the sender allows: over it the message
//     carries a signed link to the report instead and says so.
//   * Progress is recorded per address (`done`), so a retry sends only to the addresses that have not received it.
import { Injectable, Optional } from '@nestjs/common';
import {
  EmailSettingsService,
  EmailTransportResolver,
  TRANSACTIONAL_EMAIL_HEADERS,
  currentEmailRenderContext,
  formatFromHeader,
  renderEmailTemplate,
  type EmailAttachment,
  type EmailMessage,
  type EmailRenderContext,
  type RenderedEmail,
} from '@marinoscar/platform-api/email';

import { ConnectionCapabilities } from '../../connections/connection-capabilities.service';
import { DEFAULT_CAPABILITY_LIMITS, type OutgoingMail } from '../../connections/capabilities';
import { PrismaService } from '../../prisma/prisma.service';
import type { RunFile } from '../../tasks/run-files.service';
import { RunReportLinks } from '../../tasks/run-report-link';
import { SUBJECT_MAX } from '../deliveries.constants';
import { outcomeSentence, statusWord, templateValuesOf, whatToCheck, type RunFacts } from '../delivery-facts';
import { DeliveryLimits } from '../delivery-limits.service';
import { DeliveryRecipients, normalizeAddress } from '../delivery-recipients.service';
import { DeliveryFailure, failureFrom, type DeliverySender, type SendContext, type SendOutcome } from '../delivery-sender';
import { renderTemplate } from '../delivery.templates';
import type { EmailConfig } from '../delivery.schemas';

const DEFAULT_SUBJECT = '{{task}}: {{status}} on {{date}}';
const VALUE_MAX = 500;
const RESULT_MAX = 4000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "18 Nov 2026, 18:00 UTC". */
export function whenText(d: Date | null): string {
  if (!d) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

/** The outputs table rows: the task's own labels, the values as a view shows them (a sensitive one `[hidden]` unless this delivery carries them). */
export function outputRows(facts: RunFacts, includeSensitive: boolean): { label: string; value: string }[] | null {
  if (!facts.outputs?.length) return null;
  return facts.outputs.map((o) => {
    const raw = includeSensitive && o.rawText !== undefined ? o.rawText : o.text;
    const value = raw || (o.note ? `(${o.note})` : '');
    return { label: o.label, value: value.length > VALUE_MAX ? `${value.slice(0, VALUE_MAX - 1)}…` : value };
  });
}

/** `application/json; charset=utf-8` → `application/json`: a connection's attachment type carries no parameters. */
const bareType = (t: string): string => t.split(';')[0]!.trim();

interface Attachments {
  files: RunFile[];
  bytes: number;
  /** A requested file was left out because of its size. */
  leftOut: boolean;
  /** The PDF is among the left-out: the message carries a link instead. */
  pdfLeftOut: boolean;
  /** A requested file could not be produced. */
  failed: boolean;
  pictures: number;
}

@Injectable()
export class EmailSender implements DeliverySender {
  readonly kind = 'email' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly recipients: DeliveryRecipients,
    private readonly links: RunReportLinks,
    private readonly limits: DeliveryLimits,
    @Optional() private readonly emailSettings?: EmailSettingsService,
    @Optional() private readonly transports?: EmailTransportResolver,
    @Optional() private readonly capabilities?: ConnectionCapabilities,
  ) {}

  async send(ctx: SendContext): Promise<SendOutcome> {
    const cfg = ctx.delivery.config as EmailConfig;
    const via = cfg.via === 'console' ? 'console' : 'connection';
    if (via === 'console' && (!this.emailSettings || !this.transports)) throw new DeliveryFailure('KIND_UNAVAILABLE');
    if (via === 'connection' && !this.capabilities) throw new DeliveryFailure('KIND_UNAVAILABLE');
    const userId = ctx.delivery.userId;

    // Who gets it, in order, once each: `to`, then `cc`.
    const wanted = [...new Set([...cfg.to, ...(cfg.cc ?? [])].map(normalizeAddress))];
    const states = await this.recipients.states(userId, wanted);
    if ([...states.values()].includes('unconfirmed')) throw new DeliveryFailure('RECIPIENT_NOT_CONFIRMED', { recipients: wanted.length });
    const active = wanted.filter((a) => states.get(a) !== 'unsubscribed');
    if (active.length === 0) return { status: 'skipped', code: 'RECIPIENT_UNSUBSCRIBED', detail: { via, recipients: 0, skippedUnsubscribed: wanted.length } };

    const done = new Set<number>(Array.isArray(ctx.prior.done) ? (ctx.prior.done as number[]) : []);
    let messages = typeof ctx.prior.messages === 'number' ? ctx.prior.messages : 0;
    const todo = active.map((a, i) => ({ a, i })).filter((r) => !done.has(r.i));

    // The daily cap, before anything goes out: the report to each address that has not had it, and the first-use notices.
    const notices = (await Promise.all(todo.map(async (r) => (states.get(r.a) === 'confirmed' && (await this.recipients.noticeDue(userId, r.a)) ? 1 : 0)))).reduce<number>((s, n) => s + n, 0);
    const lim = await this.limits.get();
    if ((await this.limits.emailsInLastDay(userId)) + todo.length + notices > lim.maxEmailsPerDay) {
      throw new DeliveryFailure('DAILY_LIMIT', { limit: lim.maxEmailsPerDay });
    }

    const maxBytes = via === 'console' ? lim.maxAttachmentBytes : Math.min(this.capabilities!.limits.outgoingMailBytes, DEFAULT_CAPABILITY_LIMITS.outgoingMailBytes);
    const attachments = await this.attachmentsFor(ctx, cfg, maxBytes, via === 'connection' ? this.capabilities!.limits.attachmentBytes : maxBytes);
    const note = this.attachmentsNote(ctx, cfg, attachments);
    const subject = (ctx.test ? '[TEST] ' : '') + renderTemplate(cfg.subject ?? DEFAULT_SUBJECT, templateValuesOf(ctx.facts), 'line', SUBJECT_MAX);
    const reportUrl = attachments.pdfLeftOut && !ctx.test ? this.links.url(userId, ctx.facts.runId) : null;
    const runUrl = ctx.test ? null : this.links.pageUrl(`/runs/${ctx.facts.runId}`);
    const owner = await this.ownerName(userId);

    const baseDetail = { via, recipients: active.length, attachments: { pdf: attachments.files.some((f) => f.contentType === 'application/pdf'), json: attachments.files.some((f) => f.contentType.startsWith('application/json')), pictures: attachments.pictures, bytes: attachments.bytes }, reportLink: reportUrl !== null, ...(attachments.failed ? { attachmentFailed: true } : {}) };

    for (const { a, i } of todo) {
      if (ctx.signal?.aborted) throw new DeliveryFailure('ABORTED');
      const state = states.get(a)!;
      const unsubscribeUrl = state === 'confirmed' ? this.recipients.unsubscribeUrl(userId, a) : null;
      // The one-time notice goes first, so the recipient knows who is writing before the first report.
      if (unsubscribeUrl && (await this.recipients.noticeDue(userId, a))) {
        const notice = this.render('delivery-notice', { owner, unsubscribeUrl }, via);
        await this.deliver(ctx, via, a, notice, [], unsubscribeUrl);
        await this.recipients.markNoticeSent(userId, a);
        messages += 1;
        await ctx.record({ messages });
      }
      const rendered = this.render(
        'run-report',
        {
          taskName: ctx.facts.taskName,
          statusWord: statusWord(ctx.facts.status),
          outcome: outcomeSentence(ctx.facts),
          finishedAt: whenText(ctx.facts.finishedAt ?? ctx.facts.createdAt),
          outputs: cfg.includeOutputs ? outputRows(ctx.facts, cfg.includeSensitive) : null,
          result: ctx.facts.result ? ctx.facts.result.slice(0, RESULT_MAX) : null,
          whatToCheck: whatToCheck(ctx.facts),
          runUrl,
          reportUrl,
          attachmentsNote: note,
          test: ctx.test,
          unsubscribeUrl,
          subject,
        },
        via,
      );
      await this.deliver(ctx, via, a, { ...rendered, subject }, attachments.files, unsubscribeUrl);
      done.add(i);
      messages += 1;
      await ctx.record({ done: [...done], messages });
    }
    return { status: 'sent', detail: { ...baseDetail, messages, done: [...done], skippedUnsubscribed: wanted.length - active.length } };
  }

  // ----- composing ---------------------------------------------------------------------------------------------------

  /** A connection sends no inline image part: its messages render without the layout's brand mark (the console route keeps it). */
  private render<K extends 'run-report' | 'delivery-notice'>(name: K, data: Parameters<typeof renderEmailTemplate<K>>[1], via: 'console' | 'connection'): RenderedEmail {
    let rc: EmailRenderContext | undefined;
    if (via === 'connection') {
      const cur = currentEmailRenderContext();
      rc = { ...cur, layout: { ...cur.layout, brandMark: null, attachments: [] } } as EmailRenderContext;
    }
    return renderEmailTemplate(name, data, rc);
  }

  private async ownerName(userId: string): Promise<string> {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { displayName: true, email: true } });
    return u?.displayName?.trim() || u?.email || 'someone';
  }

  /** The files the owner asked for, cut to what fits. A file that does not fit is left out; a PDF that does not fit becomes a link. */
  private async attachmentsFor(ctx: SendContext, cfg: EmailConfig, maxBytes: number, perFile: number): Promise<Attachments> {
    const out: Attachments = { files: [], bytes: 0, leftOut: false, pdfLeftOut: false, failed: false, pictures: 0 };
    if (!ctx.material) return out;
    const m = ctx.material;
    const want = cfg.attach;
    const add = (f: RunFile): boolean => {
      if (f.bytes.length > perFile || out.bytes + f.bytes.length > maxBytes) return false;
      out.files.push(f);
      out.bytes += f.bytes.length;
      return true;
    };
    if (want.pdf) {
      try {
        let pdf = await m.pdf(want.screenshots !== 'none');
        // Pictures inside the PDF make it large: try it without them before giving up on it.
        if (want.screenshots !== 'none' && (pdf.bytes.length > perFile || pdf.bytes.length > maxBytes)) pdf = await m.pdf(false);
        if (!add(pdf)) {
          out.leftOut = true;
          out.pdfLeftOut = true;
        }
      } catch {
        out.failed = true;
      }
    }
    if (want.json) {
      try {
        if (!add(await m.json())) out.leftOut = true;
      } catch {
        out.failed = true;
      }
    }
    if (want.screenshots !== 'none') {
      try {
        for (const p of await m.pictures(want.screenshots)) {
          if (add(p)) out.pictures += 1;
          else out.leftOut = true;
        }
      } catch {
        out.failed = true;
      }
    }
    return out;
  }

  private attachmentsNote(ctx: SendContext, cfg: EmailConfig, a: Attachments): string | null {
    if (ctx.test) return 'A real report carries the attachments you chose; a test carries none.';
    const parts: string[] = [];
    if (a.failed) parts.push('A file could not be created and is not attached.');
    if (a.leftOut) parts.push(a.pdfLeftOut ? 'Some files were too large to attach.' : 'Some files were too large to attach and were left out.');
    return parts.length ? parts.join(' ') : null;
  }

  // ----- sending -----------------------------------------------------------------------------------------------------

  private async deliver(ctx: SendContext, via: 'console' | 'connection', to: string, rendered: RenderedEmail, files: RunFile[], unsubscribeUrl: string | null): Promise<void> {
    if (via === 'console') return this.viaConsole(to, rendered, files, unsubscribeUrl);
    return this.viaConnection(ctx, to, rendered, files);
  }

  private async viaConsole(to: string, rendered: RenderedEmail, files: RunFile[], unsubscribeUrl: string | null): Promise<void> {
    let settings;
    try {
      settings = await this.emailSettings!.get();
    } catch {
      throw new DeliveryFailure('EMAIL_NOT_CONFIGURED');
    }
    if (!settings.provider || !settings.enabled || !settings.fromAddress) throw new DeliveryFailure('EMAIL_NOT_CONFIGURED');
    const attachments: EmailAttachment[] = [
      ...(rendered.attachments ?? []),
      ...files.map((f): EmailAttachment => ({ filename: f.filename, contentType: bareType(f.contentType), contentBase64: f.bytes.toString('base64'), disposition: 'attachment' })),
    ];
    const message: EmailMessage = {
      to,
      from: formatFromHeader(settings.fromAddress, settings.fromName),
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      headers: {
        ...TRANSACTIONAL_EMAIL_HEADERS,
        ...(rendered.headers ?? {}),
        ...(unsubscribeUrl ? { 'List-Unsubscribe': `<${unsubscribeUrl}>` } : {}),
      },
      ...(attachments.length ? { attachments } : {}),
    };
    const result = await this.transports!.send(settings, message);
    if (result.success) return;
    if (result.rateLimited) throw new DeliveryFailure('RATE_LIMITED', {}, result.retryAfterMs);
    // The provider's text can carry an address or a subject: it is read only to tell a transient network failure from a refusal, never stored.
    if (/timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket|network/i.test(result.error ?? '')) throw new DeliveryFailure('NETWORK_ERROR');
    throw new DeliveryFailure('EMAIL_REFUSED');
  }

  private async viaConnection(ctx: SendContext, to: string, rendered: RenderedEmail, files: RunFile[]): Promise<void> {
    const cfg = ctx.delivery.config as EmailConfig;
    if (cfg.via === 'console') throw new DeliveryFailure('CONFIG_INVALID');
    const mail: OutgoingMail = {
      to: [{ address: to }],
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      ...(files.length ? { attachments: files.map((f) => ({ filename: f.filename, contentType: bareType(f.contentType), bytes: f.bytes })) } : {}),
    };
    try {
      await this.capabilities!.mail({ connectionId: cfg.via.connectionId, userId: ctx.delivery.userId, signal: ctx.signal }).send(mail);
    } catch (e) {
      throw failureFrom(e);
    }
  }
}
