// What every delivery kind implements (E39.6, #603), and the failure type they share.
//
// A sender is deterministic: it formats the run's FACTS (delivery-facts.ts) with the delivery's FIXED configuration and sends. It
// never reads a model, a transcript or a page, and it never takes a recipient, a destination or a file path from a run.
import { CapabilityError, isCapabilityError } from '../connections/capabilities';
import type { RunFile, RunFilesService, RunPicture } from '../tasks/run-files.service';
import { DELIVERY_ERROR_TEXT, isRetryableCode, type DeliveryErrorCode, type DeliveryKind, type RunDeliveryStatus } from './deliveries.constants';
import type { RunFacts } from './delivery-facts';

/** A delivery failed (or was skipped) for a reason from the closed list. `detail` holds safe facts only. */
export class DeliveryFailure extends Error {
  constructor(
    readonly code: DeliveryErrorCode,
    readonly detail: Record<string, unknown> = {},
    readonly retryAfterMs?: number,
  ) {
    super(DELIVERY_ERROR_TEXT[code]);
    this.name = 'DeliveryFailure';
  }

  get retryable(): boolean {
    return isRetryableCode(this.code);
  }
}

/**
 * Whatever a sender threw, as the failure the pipeline records. A capability error keeps its code; a write whose outcome is unknown
 * becomes OUTCOME_UNKNOWN (it is never repeated blindly); anything else is INTERNAL with no message copied.
 */
export function failureFrom(e: unknown): DeliveryFailure {
  if (e instanceof DeliveryFailure) return e;
  if (isCapabilityError(e)) {
    if (e.details.outcomeUnknown) return new DeliveryFailure('OUTCOME_UNKNOWN', { providerStatus: e.details.status ?? null });
    return new DeliveryFailure(e.code, e.details.status !== undefined ? { providerStatus: e.details.status } : {}, e.retryAfterMs);
  }
  return new DeliveryFailure('INTERNAL');
}

/** The connection of a delivery, as a sender needs it. */
export interface SendTarget {
  id: string;
  userId: string;
  taskId: string;
  kind: DeliveryKind;
  /** Parsed and validated against the kind's schema. */
  config: unknown;
}

/** A run's files, built once and kept for the run's other deliveries. */
export class RunMaterial {
  private readonly memo = new Map<string, Promise<unknown>>();

  constructor(
    private readonly files: Pick<RunFilesService, 'pdf' | 'json' | 'pictures'>,
    readonly userId: string,
    readonly runId: string,
  ) {}

  private once<T>(key: string, make: () => Promise<T>): Promise<T> {
    let p = this.memo.get(key) as Promise<T> | undefined;
    if (!p) {
      p = make();
      this.memo.set(key, p);
      // A failure is not kept: the next delivery (or a retry) tries again.
      p.catch(() => this.memo.delete(key));
    }
    return p;
  }

  pdf(embed: boolean): Promise<RunFile> {
    return this.once(`pdf:${embed}`, () => this.files.pdf(this.userId, this.runId, { screenshots: embed ? 'embed' : 'none' }));
  }

  json(): Promise<RunFile> {
    return this.once('json', () => this.files.json(this.userId, this.runId, { screenshots: 'none' }));
  }

  pictures(which: 'final' | 'all'): Promise<RunPicture[]> {
    return this.once(`pics:${which}`, () => this.files.pictures(this.userId, this.runId, which));
  }
}

export interface SendContext {
  delivery: SendTarget;
  facts: RunFacts;
  /** Null for a test send: there are no real files. */
  material: RunMaterial | null;
  attempt: number;
  /** An earlier attempt may have sent without recording it (its job died): a sender that can check for its own earlier work does. */
  ambiguous: boolean;
  /** Safe facts recorded by earlier attempts (`done` recipients, ...). */
  prior: Record<string, unknown>;
  /** `run:<runId>:delivery:<deliveryId>`: stable across retries. */
  idempotencyKey: string;
  test: boolean;
  signal?: AbortSignal;
  /** Records progress (safe facts) before the attempt ends, so a retry knows what already went out. */
  record(patch: Record<string, unknown>): Promise<void>;
  /**
   * `sheet_row` with `createIfMissing` only: the spreadsheet the first send created is pinned into the delivery's configuration, so
   * the next run appends to it. The one change the system makes to a destination, and it makes it to a file it just created itself.
   */
  pin?(patch: { fileId: string }): Promise<void>;
}

export interface SendOutcome {
  status: Extract<RunDeliveryStatus, 'sent' | 'skipped'>;
  /** Safe facts only: the destination label, sizes, counts, a provider id. Never an address, a subject, a body, a cell or a file name. */
  detail: Record<string, unknown>;
  /** `skipped` only. */
  code?: DeliveryErrorCode;
}

export interface DeliverySender {
  readonly kind: DeliveryKind;
  send(ctx: SendContext): Promise<SendOutcome>;
}

export { CapabilityError };
