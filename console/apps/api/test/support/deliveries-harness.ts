// Fakes for the delivery senders (E39.6, #603): a capability hub over the in-memory provider, a recipients book, limits, a report link
// signer and the files of a run, so a sender is tested with no database, no network and no provider. Invented data only.
import { configureEmailRendering, registerEmailTemplates } from '@marinoscar/platform-api/email';

import { createTestCapabilities } from '../../src/connections/testing';
import type { ConnectionCapabilities } from '../../src/connections/connection-capabilities.service';
import { EMAIL_MODULE_OPTIONS } from '../../src/platform/email/email.options';
import { EMAIL_SLICE_TEMPLATES } from '../../src/platform/email/templates';
import { RunReportLinks } from '../../src/tasks/run-report-link';
import type { RunRow } from '../../src/deliveries/delivery-facts';
import { factsOf } from '../../src/deliveries/delivery-facts';
import { RunMaterial, type SendContext } from '../../src/deliveries/delivery-sender';
import type { RecipientState } from '../../src/deliveries/delivery-recipients.service';

let rendering = false;
/** Email rendering configured and the two delivery templates registered (once per process). */
export function setupEmailTemplates(): void {
  if (rendering) return;
  rendering = true;
  process.env.JWT_SECRET ||= 'unit-test-secret';
  configureEmailRendering(EMAIL_MODULE_OPTIONS);
  registerEmailTemplates(EMAIL_SLICE_TEMPLATES.filter((t) => t.name === 'run-report' || t.name === 'delivery-notice'));
}

export const USER = '22222222-2222-4222-8222-222222222222';
export const RUN = '11111111-1111-4111-8111-111111111111';
export const TASK = '33333333-3333-4333-8333-333333333333';
export const DELIVERY = '55555555-5555-4555-8555-555555555555';
export const SENSITIVE = 'ACCT-SECRET-7788';

export function runRow(over: Partial<RunRow> = {}): RunRow {
  return {
    id: RUN,
    userId: USER,
    taskId: TASK,
    goal: 'Pay the car loan',
    trigger: 'schedule',
    status: 'succeeded',
    result: 'Paid the loan.',
    error: null,
    createdAt: new Date('2026-11-18T17:55:00Z'),
    finishedAt: new Date('2026-11-18T18:00:00Z'),
    costUsd: 0.12,
    costKnown: true,
    stepCount: 14,
    confirmedActions: [],
    outputs: { confirmation: { value: 'C-8841', ok: true }, amount: { value: { amount: 412.5, currency: 'USD' }, ok: true }, account: { value: SENSITIVE, ok: true } },
    outputsSpec: [
      { key: 'confirmation', label: 'Confirmation number', type: 'text', required: true },
      { key: 'amount', label: 'Amount paid', type: 'money', required: true },
      { key: 'account', label: 'Account', type: 'text', required: false, sensitive: true },
    ],
    outputsComplete: true,
    task: { name: 'Pay the car loan' },
    ...over,
  };
}

export const links = new RunReportLinks({ get: () => 'https://console.example.test' } as never);

export class FakeRecipients {
  states_ = new Map<string, RecipientState>();
  notices = new Set<string>();
  marked: string[] = [];
  async states(_u: string, addresses: readonly string[]) {
    return new Map(addresses.map((a): [string, RecipientState] => [a.toLowerCase(), this.states_.get(a.toLowerCase()) ?? 'own']));
  }
  async noticeDue(_u: string, a: string) {
    return this.states_.get(a.toLowerCase()) === 'confirmed' && !this.notices.has(a.toLowerCase());
  }
  async markNoticeSent(_u: string, a: string) {
    this.notices.add(a.toLowerCase());
    this.marked.push(a);
  }
  unsubscribeUrl(_u: string, a: string) {
    return `https://console.example.test/api/deliveries/unsubscribe/tok-${a}`;
  }
}

export class FakeLimits {
  max = { maxRecipientsPerTask: 10, maxEmailsPerDay: 100, maxAttachmentBytes: 1_000_000 };
  used = 0;
  async get() {
    return this.max;
  }
  async emailsInLastDay() {
    return this.used;
  }
}

/** What a run's files are in these tests: marked masked bytes. */
export function fakeFiles(over: { pdf?: Buffer; json?: Buffer; pictures?: number } = {}) {
  const calls: string[] = [];
  return {
    calls,
    files: {
      pdf: async (_u: string, _r: string, o: { screenshots: string }) => (calls.push(`pdf:${o.screenshots}`), { filename: 'hexactra-run-11111111-20261118.pdf', contentType: 'application/pdf', bytes: over.pdf ?? Buffer.from('%PDF-1.4 MASKED-REPORT') }),
      json: async () => (calls.push('json'), { filename: 'hexactra-run-11111111-20261118.json', contentType: 'application/json; charset=utf-8', bytes: over.json ?? Buffer.from('{"masking":{"applied":true}}') }),
      pictures: async (_u: string, _r: string, which: string) => (calls.push(`pics:${which}`), Array.from({ length: over.pictures ?? 0 }, (_, i) => ({ seq: i + 1, moment: 'final', filename: `step-${i + 1}.png`, contentType: 'image/png', bytes: Buffer.from(`PNG-MASKED-${i}`) }))),
    },
  };
}

export interface Harness {
  fake: ReturnType<typeof createTestCapabilities>['fake'];
  hub: ConnectionCapabilities;
  mailConn: { id: string; userId: string };
  docsConn: { id: string; userId: string };
  ctx(over: Partial<SendContext> & { config: unknown; kind: SendContext['delivery']['kind'] }): SendContext;
  recorded: Record<string, unknown>[];
  files: ReturnType<typeof fakeFiles>;
}

/** A hub over the fake provider with one mail+docs connection per role (so a test can prove that nothing crosses). */
export function harness(opts: { run?: Partial<RunRow>; files?: Parameters<typeof fakeFiles>[0] } = {}): Harness {
  const t = createTestCapabilities({ provider: 'microsoft' });
  const mailConn = t.connections.add({ userId: USER, provider: 'microsoft', label: 'Work', accountEmail: 'person-a@example.test', capabilities: ['mail_send', 'docs_write'] });
  const docsConn = t.connections.add({ userId: USER, provider: 'microsoft', label: 'Files', accountEmail: 'person-a@example.test', capabilities: ['docs_write'] });
  const files = fakeFiles(opts.files);
  const recorded: Record<string, unknown>[] = [];
  return {
    fake: t.fake,
    hub: t.hub as unknown as ConnectionCapabilities,
    mailConn,
    docsConn,
    files,
    recorded,
    ctx: (over) => {
      const { config, kind, ...rest } = over;
      return {
        delivery: { id: DELIVERY, userId: USER, taskId: TASK, kind, config },
        facts: factsOf(runRow(opts.run)),
        material: new RunMaterial(files.files as never, USER, RUN),
        attempt: 1,
        ambiguous: false,
        prior: {},
        idempotencyKey: `run:${RUN}:delivery:${DELIVERY}`,
        test: false,
        record: async (patch) => void recorded.push(patch),
        ...rest,
      };
    },
  };
}
