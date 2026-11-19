// A task's deliveries: what the owner configures (E39.6, #603). Every write is validated here, and the validation is the guard of the
// design rule "recipients and destinations are fixed at setup": they are stored on the delivery, by the owner's own request, and nothing
// else in the system writes them. (The one exception is a spreadsheet the delivery itself created with `createIfMissing`: its id is pinned.)
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, type TaskDelivery } from '@prisma/client';
import { WEBHOOKS_OPTIONS, WebhookEgressError, generateWebhookSecret, parseWebhookUrl, type ResolvedWebhooksModuleOptions } from '@marinoscar/platform-api/webhooks';
import type { z } from 'zod';

import { capabilitiesOf } from '../connections/connection-view';
import { PrismaService } from '../prisma/prisma.service';
import { readOutputs } from '../tasks/task-outputs.schemas';
import './deliveries.errors';
import { DELIVERY_AUDIT, MAX_DELIVERIES_PER_TASK, isDeliveryKind, type DeliveryKind, type DeliveryWhen } from './deliveries.constants';
import { DeliveryWebhookSecrets } from './deliveries.credentials';
import { DeliveryEvents } from './deliveries.events';
import { DeliveryLimits } from './delivery-limits.service';
import { DeliveryRecipients, normalizeAddress, type RecipientState } from './delivery-recipients.service';
import { CONFIG_SCHEMAS, type DeliveryConfig, type EmailConfig, type FolderConfig, type SheetRowConfig, type WebhookConfig } from './delivery.schemas';
import { templateProblems } from './delivery.templates';


export interface DeliveryView {
  id: string;
  taskId: string;
  kind: DeliveryKind;
  enabled: boolean;
  when: DeliveryWhen;
  position: number;
  config: Record<string, unknown>;
  recipients: { address: string; state: RecipientState }[];
  connection: { id: string; label: string | null } | null;
  disabledReason: 'connection_removed' | null;
  webhookSecretConfigured: boolean | null;
  createdAt: string;
  updatedAt: string;
}

/** The connection a configuration uses, for the column that lets Disconnect find it. */
export function connectionIdOf(kind: DeliveryKind, config: unknown): string | null {
  if (kind === 'email') {
    const via = (config as EmailConfig).via;
    return via !== 'console' && via && typeof via === 'object' ? via.connectionId : null;
  }
  if (kind === 'sheet_row') return (config as SheetRowConfig).connectionId ?? null;
  if (kind === 'folder') {
    const t = (config as FolderConfig).target;
    return t !== 'storage' && t && typeof t === 'object' ? t.connectionId : null;
  }
  return null;
}

/** The addresses of an email configuration, lower-case, once each, in order. */
export const addressesOf = (c: Pick<EmailConfig, 'to' | 'cc'>): string[] => [...new Set([...c.to, ...(c.cc ?? [])].map(normalizeAddress))];

interface Issue {
  path: string;
  message: string;
}

const invalid = (issues: Issue[]): BadRequestException =>
  new BadRequestException({ code: 'INVALID_DELIVERY', message: issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; '), details: { issues } });

export function zodIssues(e: z.ZodError, prefix = 'config'): Issue[] {
  return e.issues.map((i) => ({ path: [prefix, ...i.path].filter((p) => p !== '').join('.'), message: i.message }));
}

@Injectable()
export class DeliveriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recipients: DeliveryRecipients,
    private readonly limits: DeliveryLimits,
    private readonly events: DeliveryEvents,
    @Optional() private readonly secrets?: DeliveryWebhookSecrets,
    @Optional() @Inject(WEBHOOKS_OPTIONS) private readonly webhookOptions?: ResolvedWebhooksModuleOptions,
  ) {}

  private task(userId: string, taskId: string) {
    return this.prisma.forUser({ userId }).task.findFirst({ where: { id: taskId }, select: { id: true, name: true, outputs: true } });
  }

  private async requireTask(userId: string, taskId: string) {
    const t = await this.task(userId, taskId);
    if (!t) throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: 'Task not found' });
    return t;
  }

  async getRow(userId: string, taskId: string, id: string): Promise<TaskDelivery> {
    const row = await this.prisma.forUser({ userId }).taskDelivery.findFirst({ where: { id, taskId } });
    if (!row) throw new NotFoundException({ code: 'DELIVERY_NOT_FOUND', message: 'Delivery not found' });
    return row;
  }

  // ----- reads -------------------------------------------------------------------------------------------------------

  async list(userId: string, taskId: string): Promise<DeliveryView[]> {
    await this.requireTask(userId, taskId);
    const rows = await this.prisma.forUser({ userId }).taskDelivery.findMany({ where: { taskId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
    return this.views(userId, rows);
  }

  async get(userId: string, taskId: string, id: string): Promise<DeliveryView> {
    return (await this.views(userId, [await this.getRow(userId, taskId, id)]))[0]!;
  }

  private async views(userId: string, rows: TaskDelivery[]): Promise<DeliveryView[]> {
    const emailAddrs = rows.filter((r) => r.kind === 'email').flatMap((r) => addressesOf(r.config as unknown as EmailConfig));
    const states = emailAddrs.length ? await this.recipients.states(userId, emailAddrs) : new Map<string, RecipientState>();
    const ids = [...new Set(rows.map((r) => connectionIdOf(r.kind as DeliveryKind, r.config)).filter((x): x is string => Boolean(x)))];
    const conns = ids.length ? await this.prisma.connection.findMany({ where: { userId, id: { in: ids } }, select: { id: true, label: true } }) : [];
    const labels = new Map(conns.map((c) => [c.id, c.label]));
    return Promise.all(
      rows.map(async (r): Promise<DeliveryView> => {
        const kind = r.kind as DeliveryKind;
        const cid = connectionIdOf(kind, r.config);
        return {
          id: r.id,
          taskId: r.taskId,
          kind,
          enabled: r.enabled,
          when: r.when as DeliveryWhen,
          position: r.position,
          config: r.config as Record<string, unknown>,
          recipients: kind === 'email' ? addressesOf(r.config as unknown as EmailConfig).map((address) => ({ address, state: states.get(address) ?? 'unconfirmed' })) : [],
          connection: cid ? { id: cid, label: labels.get(cid) ?? null } : null,
          disabledReason: r.disabledReason === 'connection_removed' ? 'connection_removed' : null,
          webhookSecretConfigured: kind === 'webhook' ? ((await this.secrets?.has(userId, r.id)) ?? false) : null,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        };
      }),
    );
  }

  // ----- validation --------------------------------------------------------------------------------------------------

  /**
   * The configuration as it will be stored, or 400 `INVALID_DELIVERY`. Checks what the schema cannot: the templates against the task's
   * outputs, the columns against them, the connection (the owner's, with the capability on), the webhook address, the recipients.
   */
  private async prepare(userId: string, task: { id: string; outputs: unknown }, kind: DeliveryKind, raw: unknown, enabled: boolean, otherEmailAddresses: string[], strict = true): Promise<DeliveryConfig> {
    const parsed = CONFIG_SCHEMAS[kind].safeParse(raw);
    if (!parsed.success) throw invalid(zodIssues(parsed.error));
    const config = parsed.data as DeliveryConfig;
    const issues: Issue[] = [];
    const keys = new Set(readOutputs(task.outputs).map((o) => o.key));

    if (kind === 'email') {
      const c = config as EmailConfig;
      if (c.subject) for (const m of templateProblems(c.subject, keys)) issues.push({ path: 'config.subject', message: m });
      if (strict && c.via !== 'console') await this.requireCapability(userId, c.via.connectionId, 'mail_send', 'config.via.connectionId', issues);
    } else if (kind === 'webhook') {
      const c = config as WebhookConfig;
      try {
        parseWebhookUrl(c.url, { allowInsecureHttp: this.webhookOptions?.allowInsecureHttp ?? false, allowPrivateTargets: this.webhookOptions?.allowPrivateTargets ?? false, allowedHosts: this.webhookOptions?.allowedHosts ?? [] });
      } catch (e) {
        if (e instanceof WebhookEgressError) issues.push({ path: 'config.url', message: 'This address is not allowed (https only, no private network).' });
        else throw e;
      }
    } else if (kind === 'sheet_row') {
      const c = config as SheetRowConfig;
      if (strict) await this.requireCapability(userId, c.connectionId, 'docs_write', 'config.connectionId', issues);
      c.columns.forEach((col, i) => {
        if (col.value.kind === 'output' && !keys.has(col.value.key)) issues.push({ path: `config.columns.${i}.value.key`, message: `the task has no output "${col.value.key}"` });
      });
    } else {
      const c = config as FolderConfig;
      for (const m of templateProblems(c.nameTemplate, keys, { maxLength: 120 })) issues.push({ path: 'config.nameTemplate', message: m });
      if (strict && c.target !== 'storage') await this.requireCapability(userId, c.target.connectionId, 'docs_write', 'config.target.connectionId', issues);
      if (!c.files.pdf && !c.files.json && c.files.screenshots === 'none') issues.push({ path: 'config.files', message: 'choose at least one file to save' });
    }
    if (issues.length) throw invalid(issues);

    if (kind === 'email') {
      const c = config as EmailConfig;
      const mine = addressesOf(c);
      c.to = [...new Set(c.to.map(normalizeAddress))];
      if (c.cc) c.cc = [...new Set(c.cc.map(normalizeAddress))].filter((a) => !c.to.includes(a));
      await this.checkRecipients(userId, mine, otherEmailAddresses, enabled);
    }
    return config;
  }

  private async requireCapability(userId: string, connectionId: string, capability: 'mail_send' | 'docs_write', path: string, issues: Issue[]): Promise<void> {
    const row = await this.prisma.connection.findFirst({ where: { id: connectionId, userId } });
    if (!row) return void issues.push({ path, message: 'this connection was not found' });
    if (!capabilitiesOf(row).includes(capability)) issues.push({ path, message: `this connection does not have ${capability === 'mail_send' ? 'Mail: send' : 'Documents: write'} switched on` });
  }

  /** The cap on different addresses over the task's email deliveries, and (for a delivery that is on) the confirmation of each. */
  private async checkRecipients(userId: string, mine: string[], others: string[], enabled: boolean): Promise<void> {
    const cap = (await this.limits.get()).maxRecipientsPerTask;
    const all = new Set([...mine, ...others]);
    if (all.size > cap) throw new UnprocessableEntityException({ code: 'RECIPIENT_LIMIT', message: `A task may use at most ${cap} different email addresses.`, details: { limit: cap } });
    if (!enabled) return;
    const missing = await this.recipients.unconfirmed(userId, mine);
    if (missing.length) {
      throw new ConflictException({
        code: 'RECIPIENT_NOT_CONFIRMED',
        message: 'Confirm each address that is not yours before this delivery can be on (POST /api/delivery-recipients), or save it switched off.',
        details: { addresses: missing },
      });
    }
  }

  private async otherAddresses(userId: string, taskId: string, exceptId?: string): Promise<string[]> {
    const rows = await this.prisma.forUser({ userId }).taskDelivery.findMany({ where: { taskId, kind: 'email', ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { config: true } });
    return rows.flatMap((r) => addressesOf(r.config as unknown as EmailConfig));
  }

  // ----- writes ------------------------------------------------------------------------------------------------------

  async create(userId: string, taskId: string, body: { kind: DeliveryKind; config: Record<string, unknown>; enabled?: boolean; when?: DeliveryWhen; position?: number }): Promise<{ view: DeliveryView; signingSecret: string | null }> {
    const task = await this.requireTask(userId, taskId);
    const count = await this.prisma.forUser({ userId }).taskDelivery.count({ where: { taskId } });
    if (count >= MAX_DELIVERIES_PER_TASK) throw new UnprocessableEntityException({ code: 'TOO_MANY_DELIVERIES', message: `A task has at most ${MAX_DELIVERIES_PER_TASK} deliveries.` });
    const enabled = body.enabled ?? true;
    const config = await this.prepare(userId, task, body.kind, body.config, enabled, await this.otherAddresses(userId, taskId));
    const last = await this.prisma.forUser({ userId }).taskDelivery.findFirst({ where: { taskId }, orderBy: { position: 'desc' }, select: { position: true } });
    const row = await this.prisma.taskDelivery.create({
      data: {
        userId,
        taskId,
        kind: body.kind,
        enabled,
        when: body.when ?? 'always',
        position: body.position ?? (last ? last.position + 1 : 0),
        config: config as unknown as Prisma.InputJsonValue,
        connectionId: connectionIdOf(body.kind, config),
      },
    });
    let signingSecret: string | null = null;
    if (body.kind === 'webhook') {
      if (!this.secrets) {
        await this.prisma.taskDelivery.delete({ where: { id: row.id } });
        throw new BadRequestException({ code: 'INVALID_DELIVERY', message: 'Webhooks are not available on this deployment.', details: { issues: [{ path: 'kind', message: 'webhooks are not available' }] } });
      }
      signingSecret = generateWebhookSecret();
      await this.secrets.put(userId, row.id, signingSecret);
    }
    await this.events.audit(userId, DELIVERY_AUDIT.created, row.id, { taskId, kind: body.kind, enabled, recipients: body.kind === 'email' ? addressesOf(config as EmailConfig).length : 0 });
    return { view: await this.get(userId, taskId, row.id), signingSecret };
  }

  async update(userId: string, taskId: string, id: string, body: { enabled?: boolean; when?: DeliveryWhen; position?: number; config?: Record<string, unknown> }): Promise<DeliveryView> {
    const row = await this.getRow(userId, taskId, id);
    const task = await this.requireTask(userId, taskId);
    const kind = row.kind as DeliveryKind;
    if (!isDeliveryKind(kind)) throw new NotFoundException({ code: 'DELIVERY_NOT_FOUND', message: 'Delivery not found' });
    const enabled = body.enabled ?? row.enabled;
    const nextRaw = body.config ?? row.config;
    // Re-validated whenever the delivery will be on: a change of a connection, a template or an address cannot slip past; so cannot enabling.
    const config = await this.prepare(userId, task, kind, nextRaw, enabled, await this.otherAddresses(userId, taskId, id), enabled || body.config !== undefined);
    const updated = await this.prisma.taskDelivery.update({
      where: { id },
      data: {
        enabled,
        ...(body.when ? { when: body.when } : {}),
        ...(body.position !== undefined ? { position: body.position } : {}),
        config: config as unknown as Prisma.InputJsonValue,
        connectionId: connectionIdOf(kind, config),
        // A delivery the owner switches on again, or points at another connection, is no longer "connection removed".
        ...(body.config !== undefined || body.enabled === true ? { disabledReason: null } : {}),
      },
    });
    await this.events.audit(userId, DELIVERY_AUDIT.updated, id, { taskId, kind, enabled, configChanged: body.config !== undefined });
    return this.get(userId, taskId, updated.id);
  }

  async remove(userId: string, taskId: string, id: string): Promise<void> {
    const row = await this.getRow(userId, taskId, id);
    await this.prisma.taskDelivery.delete({ where: { id } });
    if (row.kind === 'webhook') await this.secrets?.remove(userId, id).catch(() => undefined);
    await this.events.audit(userId, DELIVERY_AUDIT.removed, id, { taskId, kind: row.kind });
  }

  /** Before a task is deleted: its webhook secrets (the rows go by cascade). */
  async removeSecretsOfTask(userId: string, taskId: string): Promise<void> {
    if (!this.secrets) return;
    const rows = await this.prisma.forUser({ userId }).taskDelivery.findMany({ where: { taskId, kind: 'webhook' }, select: { id: true } });
    for (const r of rows) await this.secrets.remove(userId, r.id).catch(() => undefined);
  }

  /** The owner confirms an address (the dialog): the one act that lets an address that is not theirs receive their reports. */
  async confirmRecipient(userId: string, address: string) {
    const r = await this.recipients.confirm(userId, address);
    // The audit event carries the fact, never the address.
    await this.events.audit(userId, DELIVERY_AUDIT.recipientConfirmed, userId, { confirmed: true }, 'user');
    return r;
  }
}
