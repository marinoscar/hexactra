import { html, plainText, renderLayout, resolveEmailRenderContext, type EmailRenderContext, type RenderedEmail } from '@marinoscar/platform-api/email';

/** Everything the template renders: the agent's request, never a secret. */
export interface RunNeedsYouEmailData {
  goal: string;
  prompt: string;
  /** Absolute URL of the console's Inbox; the layout omits the button without it. */
  inboxUrl?: string;
}

/** "An agent needs you": a CAPTCHA, a code, a sign-in or a confirmation. */
export function runNeedsYouEmail(data: RunNeedsYouEmailData, ctx?: EmailRenderContext): RenderedEmail {
  const context = resolveEmailRenderContext(ctx);
  const bodyHtml = html`<p style="margin:0 0 16px 0;">${data.prompt}</p>
    <p style="margin:0;color:#555;">For: ${data.goal}</p>`;
  return {
    subject: `An agent needs you on ${context.appName}`,
    html: renderLayout({ title: 'An agent needs you', previewText: data.prompt, bodyHtml, ctaLabel: data.inboxUrl ? 'Open the inbox' : undefined, ctaUrl: data.inboxUrl }, context),
    text: plainText({ title: 'An agent needs you', lines: [data.prompt, `For: ${data.goal}`], ctaLabel: data.inboxUrl ? 'Open the inbox' : undefined, ctaUrl: data.inboxUrl }, context),
  };
}
