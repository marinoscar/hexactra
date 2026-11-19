import { SafeHtml, html, plainText, renderCallout, renderLayout, resolveEmailRenderContext, safeUrl, type EmailRenderContext, type RenderedEmail } from '@marinoscar/platform-api/email';

/** One output of the run as the message shows it. A sensitive one reads `[hidden]` unless the delivery was set up to carry it. */
export interface RunReportOutputRow {
  label: string;
  value: string;
}

/**
 * Everything the "run report" email renders (E39.6, #603). Every value is data: it is escaped into the HTML, printed as text in the
 * plain part and can introduce no header, no link and no image. The only links are the two the console made itself.
 */
export interface RunReportEmailData {
  taskName: string;
  /** "succeeded", "failed", "stopped". */
  statusWord: string;
  /** One sentence. */
  outcome: string;
  /** "18 Nov 2026, 18:00 UTC". */
  finishedAt: string;
  /** The task's outputs as a two-column table; null for a run without outputs or a delivery that leaves them out. */
  outputs: RunReportOutputRow[] | null;
  /** The run's result text, masked. */
  result: string | null;
  /** The "what to check" line of a run that ended after a confirmed step. */
  whatToCheck: string | null;
  /** The console's page for the run. */
  runUrl: string | null;
  /** Set when the PDF was too big to attach: a signed link to it (valid 7 days). */
  reportUrl: string | null;
  /** What was attached (or why not), one line; null for no attachment. */
  attachmentsNote: string | null;
  /** A TEST send says so at the top. */
  test?: boolean;
  /** For a recipient who is not the owner: the link that stops these emails. */
  unsubscribeUrl: string | null;
  /** The subject the owner's template produced. */
  subject: string;
}

const MASKING_NOTE = 'Sensitive data is masked. Attachments are the masked report. Not a bank or legal record.';

/** "<task>: <status>": the outcome, the outputs, the result, what to check, a button to the run. Plain-text and HTML parts; no remote images. */
export function runReportEmail(data: RunReportEmailData, ctx?: EmailRenderContext): RenderedEmail {
  const context = resolveEmailRenderContext(ctx);
  const title = data.test ? `TEST: ${data.taskName || 'Run report'}` : data.taskName || 'Run report';
  const cell = 'padding:6px 12px 6px 0;vertical-align:top;border-bottom:1px solid #e3e3ea;';
  const rows = (data.outputs ?? []).map((o) => html`<tr><td style="${cell}color:#555;">${o.label}</td><td style="${cell}"><strong>${o.value || '—'}</strong></td></tr>`);
  const table = rows.length ? html`<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px 0;border-collapse:collapse;width:100%;">${SafeHtml.unsafeFromTrustedString(rows.map((r) => r.toString()).join(''))}</table>` : SafeHtml.EMPTY;
  const test = data.test ? html`<p style="margin:0 0 16px 0;"><strong>This is a test.</strong> The values below are samples; no run was sent.</p>` : SafeHtml.EMPTY;
  const check = data.whatToCheck ? html`${renderCallout({ tone: 'warning', label: 'What to check', bodyHtml: html`<p style="margin:0;">${data.whatToCheck}</p>` }, context)}` : SafeHtml.EMPTY;
  const result = data.result ? html`<p style="margin:0 0 4px 0;color:#555;">Result</p><p style="margin:0 0 16px 0;white-space:pre-wrap;">${data.result}</p>` : SafeHtml.EMPTY;
  const reportLink = data.reportUrl && safeUrl(data.reportUrl) ? html`<p style="margin:0 0 16px 0;">The report is too large to attach. <a href="${data.reportUrl}">Open the PDF report</a> (the link works for 7 days).</p>` : SafeHtml.EMPTY;
  const attach = data.attachmentsNote ? html`<p style="margin:0 0 16px 0;color:#555;">${data.attachmentsNote}</p>` : SafeHtml.EMPTY;
  const unsub = data.unsubscribeUrl && safeUrl(data.unsubscribeUrl) ? html`<p style="margin:16px 0 0 0;color:#555;font-size:12px;">You receive these reports because someone you know set them up. <a href="${data.unsubscribeUrl}">Stop these emails</a>.</p>` : SafeHtml.EMPTY;
  const bodyHtml = html`${test}<p style="margin:0 0 16px 0;">${data.outcome}</p>${table}${result}${check}${reportLink}${attach}<p style="margin:16px 0 0 0;color:#555;font-size:12px;">${MASKING_NOTE}</p>${unsub}`;

  const lines: string[] = [data.test ? 'This is a test. The values below are samples; no run was sent.' : '', data.outcome, `Finished: ${data.finishedAt}`].filter(Boolean);
  if (data.outputs?.length) lines.push('', ...data.outputs.map((o) => `${o.label}: ${o.value || '-'}`));
  if (data.result) lines.push('', `Result: ${data.result}`);
  if (data.whatToCheck) lines.push('', `What to check: ${data.whatToCheck}`);
  if (data.reportUrl && safeUrl(data.reportUrl)) lines.push('', `The report is too large to attach. PDF report (valid 7 days): ${data.reportUrl}`);
  if (data.attachmentsNote) lines.push('', data.attachmentsNote);
  lines.push('', MASKING_NOTE);
  if (data.unsubscribeUrl && safeUrl(data.unsubscribeUrl)) lines.push('', `Stop these emails: ${data.unsubscribeUrl}`);
  const cta = data.runUrl && safeUrl(data.runUrl) ? 'Open the run' : undefined;
  return {
    subject: data.subject,
    html: renderLayout({ title, previewText: data.outcome, bodyHtml, ctaLabel: cta, ctaUrl: cta ? data.runUrl! : undefined }, context),
    text: plainText({ title, lines: lines as [string, ...string[]], ctaLabel: cta, ctaUrl: cta ? data.runUrl! : undefined }, context),
  };
}
