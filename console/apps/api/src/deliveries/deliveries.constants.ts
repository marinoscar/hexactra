// The vocabulary of deliveries (E39.6, #603). Closed lists on purpose: a kind is a way of sending a run's result out of the console, an
// error code is a fact the owner reads in the log, and each is a decision, not a string. A job type and an event key are permanent.

export const DELIVERY_KINDS = ['email', 'webhook', 'sheet_row', 'folder'] as const;
export type DeliveryKind = (typeof DELIVERY_KINDS)[number];
export const isDeliveryKind = (v: unknown): v is DeliveryKind => typeof v === 'string' && (DELIVERY_KINDS as readonly string[]).includes(v);

/** When a delivery is sent. `needs_attention`: a failed run, a run whose outputs are not all there, and a run that ended without success after a confirmed step (#540). */
export const DELIVERY_WHEN = ['always', 'succeeded', 'failed', 'needs_attention'] as const;
export type DeliveryWhen = (typeof DELIVERY_WHEN)[number];

/** `sending`: a job holds it right now. `skipped`: nothing was sent on purpose (every recipient had stopped the emails). */
export const RUN_DELIVERY_STATUSES = ['pending', 'sending', 'sent', 'failed', 'skipped'] as const;
export type RunDeliveryStatus = (typeof RUN_DELIVERY_STATUSES)[number];

/** At most this many deliveries on one task. */
export const MAX_DELIVERIES_PER_TASK = 10;
/** At most this many addresses on one email delivery (`to` and `cc` together). */
export const MAX_RECIPIENTS_PER_DELIVERY = 10;
/** The deployment defaults of the two caps (the `deliveries` system settings can lower or raise them). */
export const DEFAULT_MAX_RECIPIENTS_PER_TASK = 10;
export const DEFAULT_MAX_EMAILS_PER_DAY = 100;
/** The attachments of a console email are cut here (a provider's limit is lower than any mailbox's): over it the email carries the link instead. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 7 * 1024 * 1024;

/** The permanent job type that sends one delivery of one run. */
export const DELIVERY_SEND_JOB = 'deliveries.send';
export const DELIVERY_SEND_REASONS = {
  runEnded: { id: 'delivery_run_ended', label: 'Run ended' },
  retry: { id: 'delivery_retry', label: 'Delivery retried' },
  owner: { id: 'delivery_owner_retry', label: 'Delivery retried by the owner' },
} as const;
export type DeliverySendReason = (typeof DELIVERY_SEND_REASONS)[keyof typeof DELIVERY_SEND_REASONS]['id'];

export const DELIVERY_JOB_MAX_RUNTIME_MS = 3 * 60_000;
/** Up to this many attempts per run delivery (the first and four retries). */
export const DELIVERY_MAX_ATTEMPTS = 5;
/** The wait before attempt 2, 3, 4 and 5. */
export const DELIVERY_BACKOFF_MS: readonly number[] = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
/** A delivery still `sending` after this long was held by a job that died: the next attempt treats its outcome as unknown. */
export const STALE_SENDING_MS = 10 * 60_000;

/** How long a report link works. */
export const REPORT_LINK_TTL_S = 7 * 24 * 60 * 60;
/** The unsubscribe link of a recipient. */
export const UNSUBSCRIBE_LINK_TTL_S = 2 * 365 * 24 * 60 * 60;

/** The longest text a template value or a result line contributes to a subject or a file name. */
export const TEMPLATE_VALUE_MAX = 80;
export const SUBJECT_MAX = 200;
export const FILE_NAME_MAX = 120;

/**
 * The closed set of reasons a delivery failed or was skipped. Never a provider's text (it can carry the very content the owner trusted
 * us with). The first thirteen are the capability errors (connections/capabilities.ts) carried through unchanged.
 */
export const DELIVERY_ERROR_CODES = [
  'CONNECTION_NEEDS_RECONNECT',
  'CAPABILITY_OFF',
  'PERMISSION_MISSING',
  'NOT_FOUND',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'TOO_LARGE',
  'PROVIDER_ERROR',
  'CONNECTION_PAUSED',
  'CONNECTION_NOT_FOUND',
  'INVALID_INPUT',
  'NOT_SUPPORTED',
  'ABORTED',
  /** A write whose request was sent and got no definite answer: it may have happened, and it was not repeated. */
  'OUTCOME_UNKNOWN',
  'NETWORK_ERROR',
  'TIMEOUT',
  'HTTP_4XX',
  'HTTP_5XX',
  /** The webhook address resolves to a place the console must not call (a private network). */
  'DESTINATION_BLOCKED',
  'SECRET_MISSING',
  /** The slice this kind needs (email, storage, webhooks) is not on in this deployment. */
  'KIND_UNAVAILABLE',
  'EMAIL_NOT_CONFIGURED',
  'EMAIL_REFUSED',
  'DAILY_LIMIT',
  'RECIPIENT_UNSUBSCRIBED',
  'RECIPIENT_NOT_CONFIRMED',
  'CONFIG_INVALID',
  'INTERNAL',
] as const;
export type DeliveryErrorCode = (typeof DELIVERY_ERROR_CODES)[number];
export const isDeliveryErrorCode = (v: unknown): v is DeliveryErrorCode => typeof v === 'string' && (DELIVERY_ERROR_CODES as readonly string[]).includes(v);

/** What the owner reads next to a code in the run page's log and in the notification. Fixed sentences. */
export const DELIVERY_ERROR_TEXT: Record<DeliveryErrorCode, string> = {
  CONNECTION_NEEDS_RECONNECT: 'the connection needs reconnecting',
  CAPABILITY_OFF: 'the connection does not allow this any more',
  PERMISSION_MISSING: 'the account did not grant the permission this needs',
  NOT_FOUND: 'the file or folder was not found',
  RATE_LIMITED: 'the provider asked to slow down',
  QUOTA_EXCEEDED: 'the provider quota is used up',
  TOO_LARGE: 'the file is larger than the provider allows',
  PROVIDER_ERROR: 'the provider could not do it',
  CONNECTION_PAUSED: 'the connection is paused',
  CONNECTION_NOT_FOUND: 'the connection was removed',
  INVALID_INPUT: 'the request was not valid',
  NOT_SUPPORTED: 'the provider does not support this',
  ABORTED: 'the send was cancelled',
  OUTCOME_UNKNOWN: 'it is not known whether it was sent; it was not repeated so as not to send it twice',
  NETWORK_ERROR: 'the destination could not be reached',
  TIMEOUT: 'the destination did not answer in time',
  HTTP_4XX: 'the destination refused it',
  HTTP_5XX: 'the destination had an error',
  DESTINATION_BLOCKED: 'the address is not allowed',
  SECRET_MISSING: 'the signing secret is missing',
  KIND_UNAVAILABLE: 'this kind of delivery is not available on this deployment',
  EMAIL_NOT_CONFIGURED: 'email is not set up on this deployment',
  EMAIL_REFUSED: 'the email provider refused the message',
  DAILY_LIMIT: 'the daily email limit was reached',
  RECIPIENT_UNSUBSCRIBED: 'every recipient stopped these emails',
  RECIPIENT_NOT_CONFIRMED: 'a recipient is not confirmed',
  CONFIG_INVALID: 'the delivery is set up in a way that cannot be sent',
  INTERNAL: 'something went wrong on the console',
};

/** Failures a later attempt can cure and cannot duplicate. Everything else fails at once. */
export const RETRYABLE_ERROR_CODES: readonly DeliveryErrorCode[] = ['RATE_LIMITED', 'PROVIDER_ERROR', 'NETWORK_ERROR', 'TIMEOUT', 'HTTP_5XX'];
export const isRetryableCode = (c: DeliveryErrorCode): boolean => RETRYABLE_ERROR_CODES.includes(c);

/** The audit actions of deliveries: ids and kinds and counts, never an address, a subject, a body, a cell or a file name. */
export const DELIVERY_AUDIT = {
  created: 'delivery.created',
  updated: 'delivery.updated',
  removed: 'delivery.removed',
  recipientConfirmed: 'delivery.recipient_confirmed',
  recipientUnsubscribed: 'delivery.recipient_unsubscribed',
  sent: 'delivery.sent',
  failed: 'delivery.failed',
  retried: 'delivery.retried',
  tested: 'delivery.tested',
  cleared: 'delivery.connection_cleared',
} as const;
