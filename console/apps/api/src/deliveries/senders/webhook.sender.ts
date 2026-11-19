// The webhook delivery (E39.6, #603): one signed POST of the run's fields to the address typed on the task.
//
//   * The address is fixed on the delivery. The body is `{ id, type, createdAt, apiVersion, org, data }`, the platform's envelope, with the
//     `runs.run.finished` fields as `data` (plus the outputs, the run's link and, if asked, a signed link to the masked PDF).
//   * Signed as Standard Webhooks with the delivery's own secret (credential store, shown once at creation), by the platform's own
//     `signedHeaders`. The call goes through the platform's egress guard: https only, never a private network address.
//   * The `webhook-id` header is the delivery's idempotency key (`run:<runId>:delivery:<deliveryId>`), the same on every attempt, so a
//     receiver that keeps ids sees a retried send as one event.
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  WEBHOOKS_OPTIONS,
  WebhookEgressError,
  WebhookTransportError,
  buildEnvelope,
  hostForLog,
  nodeWebhookTransport,
  parseRetryAfter,
  resolveWebhookTarget,
  signedHeaders,
  systemHostResolver,
  type HostResolver,
  type ResolvedWebhooksModuleOptions,
  type WebhookTransport,
} from '@marinoscar/platform-api/webhooks';
import { APP_NAME } from '@app/shared';

import { RunReportLinks } from '../../tasks/run-report-link';
import { DeliveryWebhookSecrets } from '../deliveries.credentials';
import { webhookData } from '../delivery-payload';
import { DeliveryFailure, type DeliverySender, type SendContext, type SendOutcome } from '../delivery-sender';
import type { WebhookConfig } from '../delivery.schemas';

/** Tests replace the network with these (the platform's own seams are not exported by its module). */
export const DELIVERY_WEBHOOK_TRANSPORT = Symbol('DELIVERY_WEBHOOK_TRANSPORT');
export const DELIVERY_WEBHOOK_RESOLVER = Symbol('DELIVERY_WEBHOOK_RESOLVER');

/** The `type` of a test send: never mistaken for a run's event. */
export const TEST_EVENT_TYPE = 'deliveries.test';
export const RUN_EVENT_TYPE = 'runs.run.finished';

@Injectable()
export class WebhookSender implements DeliverySender {
  readonly kind = 'webhook' as const;

  constructor(
    private readonly links: RunReportLinks,
    @Optional() private readonly secrets?: DeliveryWebhookSecrets,
    @Optional() @Inject(WEBHOOKS_OPTIONS) private readonly options?: ResolvedWebhooksModuleOptions,
    @Optional() @Inject(DELIVERY_WEBHOOK_TRANSPORT) private readonly transport?: WebhookTransport,
    @Optional() @Inject(DELIVERY_WEBHOOK_RESOLVER) private readonly resolver?: HostResolver,
  ) {}

  async send(ctx: SendContext): Promise<SendOutcome> {
    const cfg = ctx.delivery.config as WebhookConfig;
    if (!this.secrets) throw new DeliveryFailure('KIND_UNAVAILABLE');
    const secret = await this.secrets.get(ctx.delivery.userId, ctx.delivery.id);
    if (!secret) throw new DeliveryFailure('SECRET_MISSING');

    const policy = { allowInsecureHttp: this.options?.allowInsecureHttp ?? false, allowPrivateTargets: this.options?.allowPrivateTargets ?? false, allowedHosts: this.options?.allowedHosts ?? [] };
    let target;
    try {
      target = await resolveWebhookTarget(cfg.url, policy, this.resolver ?? this.options?.resolver ?? systemHostResolver);
    } catch (e) {
      // An address that does not resolve may resolve later; one that is refused never will.
      if (e instanceof WebhookEgressError && e.code !== 'unresolvable') throw new DeliveryFailure('DESTINATION_BLOCKED');
      throw new DeliveryFailure('NETWORK_ERROR');
    }

    const runUrl = this.links.pageUrl(`/runs/${ctx.facts.runId}`);
    const reportUrl = ctx.test ? null : this.links.url(ctx.delivery.userId, ctx.facts.runId);
    const data = webhookData(ctx.facts, cfg, { runUrl, reportUrl }, ctx.test ? { test: true } : {});
    const body = JSON.stringify(buildEnvelope({ eventId: ctx.idempotencyKey, eventKey: ctx.test ? TEST_EVENT_TYPE : RUN_EVENT_TYPE, orgId: null, data, occurredAt: ctx.facts.finishedAt ?? new Date() }));
    const headers = await signedHeaders({ id: ctx.idempotencyKey, timestamp: Math.floor(Date.now() / 1000), body, secrets: [secret], userAgent: `${APP_NAME}-Webhooks/1.0` });

    let res;
    try {
      res = await (this.transport ?? this.options?.transport ?? nodeWebhookTransport).send({ target, headers, body, timeoutMs: this.options?.requestTimeoutMs ?? 10_000 });
    } catch (e) {
      throw new DeliveryFailure(e instanceof WebhookTransportError && e.code === 'timeout' ? 'TIMEOUT' : 'NETWORK_ERROR');
    }
    const host = hostForLog(cfg.url);
    if (res.status >= 200 && res.status < 300) return { status: 'sent', detail: { destination: host, httpStatus: res.status, bytes: Buffer.byteLength(body) } };
    if (res.status === 429) throw new DeliveryFailure('RATE_LIMITED', { httpStatus: res.status }, parseRetryAfter(res.retryAfter) ?? undefined);
    throw new DeliveryFailure(res.status >= 500 ? 'HTTP_5XX' : 'HTTP_4XX', { httpStatus: res.status, destination: host }, parseRetryAfter(res.retryAfter) ?? undefined);
  }
}
