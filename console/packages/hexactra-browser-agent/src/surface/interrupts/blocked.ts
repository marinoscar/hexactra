// A CAPTCHA or an "unusual activity" page (E46.15): never automated.
import type { PageSnapshot } from './snapshot';

const TEXT = /\b(captcha|verify (that )?you('| a)re (a )?human|i'?m not a robot|unusual (traffic|activity)|are you a robot|security check)\b/i;
const FRAME = /(recaptcha|hcaptcha|turnstile|captcha)/i;

export function detectBlocked(p: PageSnapshot): boolean {
  return TEXT.test(p.title) || TEXT.test(p.text) || p.frames.some((f) => FRAME.test(f));
}
