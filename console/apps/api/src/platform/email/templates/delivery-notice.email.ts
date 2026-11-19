import { html, plainText, renderLayout, resolveEmailRenderContext, safeUrl, type EmailRenderContext, type RenderedEmail } from '@marinoscar/platform-api/email';

/** The one-time notice to a recipient who is not the owner (E39.6, #603). */
export interface DeliveryNoticeEmailData {
  /** Who set it up: the owner's name, else their email. */
  owner: string;
  /** The signed link that stops these emails. */
  unsubscribeUrl: string;
}

/** "You will receive run reports from <owner> through Hexactra. Stop these emails: <link>". Sent once per recipient, before the first report. */
export function deliveryNoticeEmail(data: DeliveryNoticeEmailData, ctx?: EmailRenderContext): RenderedEmail {
  const context = resolveEmailRenderContext(ctx);
  const line = `You will receive run reports from ${data.owner} through ${context.appName}.`;
  const ok = safeUrl(data.unsubscribeUrl) !== null;
  const bodyHtml = html`<p style="margin:0 0 16px 0;">${line}</p><p style="margin:0;color:#555;">If you do not want them, you can stop them at any time.</p>`;
  return {
    subject: `You will receive run reports from ${data.owner}`,
    html: renderLayout({ title: 'Run reports are coming', previewText: line, bodyHtml, ctaLabel: ok ? 'Stop these emails' : undefined, ctaUrl: ok ? data.unsubscribeUrl : undefined }, context),
    text: plainText({ title: 'Run reports are coming', lines: [line, ok ? `Stop these emails: ${data.unsubscribeUrl}` : 'To stop them, ask the sender.'], ...(ok ? { ctaLabel: 'Stop these emails', ctaUrl: data.unsubscribeUrl } : {}) }, context),
  };
}
