import { html, plainText, renderLayout, resolveEmailRenderContext, type EmailRenderContext, type RenderedEmail } from '@marinoscar/platform-api/email';

/** Everything the template renders: the question, never an answer. */
export interface QuestionAskedEmailData {
  prompt: string;
  /** Absolute URL of the question's page; the layout omits the button without it. */
  questionUrl?: string;
}

/** "A question for you": an agent (or your own automation) asks something. */
export function questionAskedEmail(data: QuestionAskedEmailData, ctx?: EmailRenderContext): RenderedEmail {
  const context = resolveEmailRenderContext(ctx);
  const bodyHtml = html`<p style="margin:0;">${data.prompt}</p>`;
  const cta = data.questionUrl ? 'Answer it' : undefined;
  return {
    subject: `A question for you on ${context.appName}`,
    html: renderLayout({ title: 'A question for you', previewText: data.prompt, bodyHtml, ctaLabel: cta, ctaUrl: data.questionUrl }, context),
    text: plainText({ title: 'A question for you', lines: [data.prompt], ctaLabel: cta, ctaUrl: data.questionUrl }, context),
  };
}
