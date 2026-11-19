// Where Google's endpoints are. Plain constants: the adapter talks to these and to nothing else.
export const GOOGLE = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
  gmail: 'https://gmail.googleapis.com/gmail/v1/users/me',
  calendar: 'https://www.googleapis.com/calendar/v3',
  drive: 'https://www.googleapis.com/drive/v3',
  driveUpload: 'https://www.googleapis.com/upload/drive/v3',
  docs: 'https://docs.googleapis.com/v1/documents',
  sheets: 'https://sheets.googleapis.com/v4/spreadsheets',
} as const;

/** The Google services the adapter calls (a bounded vocabulary: metric and span attribute). */
export const GOOGLE_SERVICES = ['gmail', 'calendar', 'drive', 'docs', 'sheets', 'oauth'] as const;
export type GoogleService = (typeof GOOGLE_SERVICES)[number];

/** At most this many requests of one connection are in flight at once. */
export const GOOGLE_CONCURRENCY = 4;
/** At most this many tries of one request (the first plus two retries). */
export const GOOGLE_MAX_TRIES = 3;
/** The longest `Retry-After` the adapter sleeps through; a longer one is reported as RATE_LIMITED for the caller to schedule. */
export const GOOGLE_MAX_WAIT_MS = 30_000;
