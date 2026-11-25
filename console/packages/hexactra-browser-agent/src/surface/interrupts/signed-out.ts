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

// Google's own account sign-in (E48.5): the account chooser, the email and password steps and a re-authentication.
const GOOGLE_SIGNIN_HOST = 'accounts.google.com';
const GOOGLE_SIGNIN_PATH = /^\/(?:v\d+\/)?(?:signin|ServiceLogin|AccountChooser|InteractiveLogin)(?:\/|$)/i;

/**
 * Whether a page is Google's account sign-in, from the URL the browser reports (never page text). A takeover
 * asked on it can link the owner to the guided sign-in of the run's profile (E48.5); nothing the model sees changes.
 */
export function isGoogleSignInPage(url: string | null | undefined): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && u.hostname.toLowerCase() === GOOGLE_SIGNIN_HOST && GOOGLE_SIGNIN_PATH.test(u.pathname);
}
