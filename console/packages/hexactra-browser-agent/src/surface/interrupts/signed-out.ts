// The page is a sign-in page where the procedure expected a signed-in screen (E46.15).
import type { PageSnapshot } from './snapshot';

const PATH = /\/(login|log-in|signin|sign-in|sign_in|auth|account\/login|session\/new)(\/|$|\?)/i;
const BUTTON = /^(sign in|log in|login|continue|next)$/i;

export function detectSignedOut(p: PageSnapshot): boolean {
  const password = p.elements.some((e) => e.inputType === 'password');
  const button = p.elements.some((e) => e.name !== null && BUTTON.test(e.name.trim()));
  let path = '';
  try {
    path = new URL(p.url ?? '').pathname;
  } catch {
    path = '';
  }
  return (password && button) || (PATH.test(`${path}/`) && password);
}
