// Deliveries (E39.6, #603), the pure parts: templates and file names, the run's facts and the `when` filters, what a webhook and a
// spreadsheet row carry, the signed links, and the configuration schemas. Invented data only.
import { MASKED_OUTPUT } from '@app/shared/task-fields';

import { CONFIG_SCHEMAS, columnSourceSchema, createDeliverySchema } from '../src/deliveries/delivery.schemas';
import { factsOf, needsAttention, outcomeSentence, templateValuesOf, whatToCheck, whenMatches, type RunRow } from '../src/deliveries/delivery-facts';
import { columnLetter, sheetHeaders, sheetRow, webhookData } from '../src/deliveries/delivery-payload';
import { backoffMs } from '../src/deliveries/delivery-pipeline.service';
import { renderTemplate, safeFileName, singleLine, templateProblems } from '../src/deliveries/delivery.templates';
import { DELIVERY_BACKOFF_MS, DELIVERY_ERROR_CODES, DELIVERY_ERROR_TEXT, isRetryableCode } from '../src/deliveries/deliveries.constants';
import { fileNamesFor } from '../src/deliveries/senders/folder.sender';
import { signToken, verifyToken } from '../src/tasks/signed-token';
import { RunReportLinks } from '../src/tasks/run-report-link';

const SECRET = 'unit-test-secret';
const NOW = new Date('2026-11-18T18:00:00Z');

function run(over: Partial<RunRow> = {}): RunRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    taskId: '33333333-3333-4333-8333-333333333333',
    goal: 'Pay the car loan',
    trigger: 'schedule',
    status: 'succeeded',
    result: 'Paid the loan.',
    error: null,
    createdAt: new Date('2026-11-18T17:55:00Z'),
    finishedAt: NOW,
    costUsd: 0.1234,
    costKnown: true,
    stepCount: 14,
    confirmedActions: [],
    outputs: {
      confirmation: { value: 'C-8841', ok: true },
      amount: { value: { amount: 412.5, currency: 'USD' }, ok: true },
      account: { value: 'ACCT-SECRET-7788', ok: true },
    },
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

beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
});

describe('templates and safe text', () => {
  const values = (o: Record<string, string> = {}) => ({ task: 'Pay the car loan', date: '2026-11-18', status: 'succeeded', output: (k: string) => o[k] });

  it('accepts the fixed placeholders and a defined output, and names every problem', () => {
    const keys = new Set(['confirmation']);
    expect(templateProblems('{{task}}: {{status}} on {{date}} ({{output:confirmation}})', keys)).toEqual([]);
    expect(templateProblems('{{secret}}', keys)).toEqual([expect.stringContaining('is not a placeholder')]);
    expect(templateProblems('{{output:other}}', keys)).toEqual([expect.stringContaining('names an output the task does not define')]);
    expect(templateProblems('one\ntwo', keys)).toEqual([expect.stringContaining('line breaks')]);
    expect(templateProblems('x {{task', keys)).toEqual([expect.stringContaining('unclosed')]);
  });

  it('puts a value in as one line of text: a header-like value stays inside the line', () => {
    const hostile = 'Paid\r\nBcc: person-x@example.test\r\nSubject: other';
    const out = renderTemplate('{{task}}: {{output:confirmation}}', values({ confirmation: hostile }), 'line');
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).toBe('Pay the car loan: Paid Bcc: person-x@example.test Subject: other');
  });

  it('caps a value and the whole line', () => {
    const out = renderTemplate('{{output:confirmation}}', values({ confirmation: 'x'.repeat(5000) }), 'line');
    expect(out.length).toBeLessThanOrEqual(81);
    expect(renderTemplate('{{task}} '.repeat(100), values(), 'line').length).toBeLessThanOrEqual(200);
  });

  it('turns a value into a file name, never a path', () => {
    const out = renderTemplate('{{output:confirmation}}', values({ confirmation: '../../etc/passwd' }), 'filename');
    expect(out).not.toMatch(/[\\/]/);
    expect(out).not.toContain('..');
    expect(safeFileName('a/b\\c..d')).toBe('a b c.d');
    expect(safeFileName('..')).toBe('run');
    expect(safeFileName('')).toBe('run');
    expect(safeFileName('con:fig*?"<>|name')).toBe('con fig name');
    expect(safeFileName('x‮txt.exe')).not.toMatch(/‮/);
    expect(safeFileName('a'.repeat(500)).length).toBeLessThanOrEqual(120);
    expect(singleLine('a b\u0000c', 20)).toBe('a b c');
  });

  it('names each file of a folder delivery with the safe base, whatever the run said', () => {
    const base = renderTemplate('{{task}} {{output:confirmation}}', values({ confirmation: '../../x' }), 'filename');
    const names = fileNamesFor(base, [
      { filename: 'r.pdf', contentType: 'application/pdf' },
      { filename: 'r.json', contentType: 'application/json; charset=utf-8' },
      { filename: 'step-3.png', contentType: 'image/png' },
    ]);
    expect(names).toEqual([`${base}.pdf`, `${base}.json`, `${base} step-3.png`]);
    for (const n of names) expect(n).not.toMatch(/[\\/]|\.\./);
  });
});

describe("the run's facts", () => {
  it('masks a sensitive output unless the delivery carries it, and keeps its raw value only in memory for that', () => {
    const f = factsOf(run());
    const account = f.outputs!.find((o) => o.key === 'account')!;
    expect(account.text).toBe(MASKED_OUTPUT);
    expect(account.maskedCell).toBe(MASKED_OUTPUT);
    expect(account.rawText).toBe('ACCT-SECRET-7788');
    expect(JSON.stringify(f.outputs!.map((o) => ({ ...o, rawText: undefined, rawValue: undefined, rawCell: undefined })))).not.toContain('ACCT-SECRET-7788');
    expect(f.outputs!.find((o) => o.key === 'amount')!.text).toBe('USD 412.50');
  });

  it('masks text that looks like a card number or a secret in the result and a value', () => {
    const f = factsOf(run({ result: 'Paid with 4111 1111 1111 1111', outputs: { confirmation: { value: '4111 1111 1111 1111', ok: true } } }));
    expect(f.result).not.toContain('4111 1111 1111 1111');
    expect(f.outputs![0]!.text).not.toContain('4111 1111 1111 1111');
  });

  it('a template only ever sees masked text', () => {
    const f = factsOf(run());
    const v = templateValuesOf(f);
    expect(v.output('account')).toBe(MASKED_OUTPUT);
    expect(v.output('confirmation')).toBe('C-8841');
    expect(v.date).toBe('2026-11-18');
    expect(v.status).toBe('succeeded');
  });

  it('when: always, succeeded, failed and needs_attention each choose the right runs', () => {
    const ok = factsOf(run());
    const failed = factsOf(run({ status: 'failed', outputsComplete: false }));
    const stopped = factsOf(run({ status: 'cancelled', outputsComplete: null }));
    const incomplete = factsOf(run({ outputsComplete: false }));
    const confirmed = factsOf(run({ status: 'failed', outputsComplete: null, confirmedActions: [{ seq: 3, prompt: 'Pay?', action: 'click', at: NOW.toISOString() }] }));
    const stoppedAfterConfirm = factsOf(run({ status: 'cancelled', outputsComplete: null, confirmedActions: [{ seq: 3, prompt: 'Pay?', action: 'click', at: NOW.toISOString() }] }));
    const table: [typeof ok, string[]][] = [
      [ok, ['always', 'succeeded']],
      [failed, ['always', 'failed', 'needs_attention']],
      [stopped, ['always']],
      [incomplete, ['always', 'succeeded', 'needs_attention']],
      [confirmed, ['always', 'failed', 'needs_attention']],
      [stoppedAfterConfirm, ['always', 'needs_attention']],
    ];
    for (const [facts, matching] of table) {
      for (const w of ['always', 'succeeded', 'failed', 'needs_attention'] as const) expect(whenMatches(w, facts)).toBe(matching.includes(w));
    }
    expect(needsAttention(ok)).toBe(false);
    expect(whatToCheck(stoppedAfterConfirm)).toMatch(/confirmed was carried out/);
    expect(whatToCheck(ok)).toBeNull();
    expect(outcomeSentence(incomplete)).toMatch(/not every output/);
    expect(outcomeSentence(stopped)).toMatch(/stopped/);
  });
});

describe('what a webhook and a spreadsheet row carry', () => {
  const facts = factsOf(run());
  const links = { runUrl: 'https://console.example.test/runs/1', reportUrl: 'https://console.example.test/api/reports/tok' };

  it('a webhook carries the run fields, the outputs masked and the links; sensitive values only when asked', () => {
    const plain = webhookData(facts, { includeOutputs: true, includeSensitive: false, includeReportLink: true }, links);
    expect(plain).toMatchObject({ runId: facts.runId, status: 'succeeded', trigger: 'schedule', outputsComplete: true, runUrl: links.runUrl, reportUrl: links.reportUrl });
    expect(JSON.stringify(plain)).not.toContain('ACCT-SECRET-7788');
    expect((plain.outputs as { key: string; value: unknown }[]).find((o) => o.key === 'account')!.value).toBe(MASKED_OUTPUT);
    const carried = webhookData(facts, { includeOutputs: true, includeSensitive: true, includeReportLink: false }, links);
    expect((carried.outputs as { key: string; value: unknown }[]).find((o) => o.key === 'account')!.value).toBe('ACCT-SECRET-7788');
    expect(carried).not.toHaveProperty('reportUrl');
    expect(webhookData(facts, { includeOutputs: false, includeSensitive: false, includeReportLink: false }, links)).not.toHaveProperty('outputs');
  });

  it('a row has one cell per column, typed, with the run id last', () => {
    const cfg = {
      includeSensitive: false,
      columns: [
        { header: 'Date', value: { kind: 'field' as const, field: 'run_date' as const } },
        { header: 'Confirmation', value: { kind: 'output' as const, key: 'confirmation' } },
        { header: 'Amount', value: { kind: 'output' as const, key: 'amount' } },
        { header: 'Account', value: { kind: 'output' as const, key: 'account' } },
        { header: 'Steps', value: { kind: 'field' as const, field: 'steps' as const } },
        { header: 'Cost', value: { kind: 'field' as const, field: 'cost' as const } },
        { header: 'Link', value: { kind: 'field' as const, field: 'run_link' as const } },
        { header: 'Missing', value: { kind: 'output' as const, key: 'nope' } },
      ],
    };
    expect(sheetHeaders(cfg)).toEqual(['Date', 'Confirmation', 'Amount', 'Account', 'Steps', 'Cost', 'Link', 'Missing', 'Run ID']);
    expect(sheetRow(facts, cfg, links)).toEqual(['2026-11-18', 'C-8841', 'USD 412.50', MASKED_OUTPUT, 14, 0.1234, links.runUrl, '', facts.runId]);
    expect(sheetRow(facts, { ...cfg, includeSensitive: true }, links)[3]).toBe('ACCT-SECRET-7788');
  });

  it('a hostile value is a plain string in its cell, never changed into something else', () => {
    const f = factsOf(run({ outputs: { confirmation: { value: '=HYPERLINK("https://evil.example.test","click")', ok: true } } }));
    const row = sheetRow(f, { includeSensitive: false, columns: [{ header: 'C', value: { kind: 'output', key: 'confirmation' } }] }, links);
    expect(row[0]).toBe('=HYPERLINK("https://evil.example.test","click")');
    expect(typeof row[0]).toBe('string');
  });

  it('counts columns in letters', () => {
    expect([1, 26, 27, 52, 53].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA']);
  });
});

describe('configuration schemas', () => {
  it('fills the defaults of an email delivery and refuses an unknown key', () => {
    const c = CONFIG_SCHEMAS.email.parse({ to: ['person-a@example.test'] });
    expect(c).toMatchObject({ via: 'console', attach: { pdf: true, json: false, screenshots: 'none' }, includeOutputs: true, includeSensitive: false });
    expect(CONFIG_SCHEMAS.email.safeParse({ to: ['person-a@example.test'], bcc: ['person-x@example.test'] }).success).toBe(false);
    expect(CONFIG_SCHEMAS.email.safeParse({ to: [] }).success).toBe(false);
    expect(CONFIG_SCHEMAS.email.safeParse({ to: Array.from({ length: 11 }, (_, i) => `p${i}@example.test`) }).success).toBe(false);
    expect(CONFIG_SCHEMAS.email.safeParse({ to: ['not an address'] }).success).toBe(false);
    expect(CONFIG_SCHEMAS.email.safeParse({ to: ['person-a@example.test'], subject: 'line\nbreak' }).success).toBe(false);
  });

  it('a spreadsheet delivery needs a file or createIfMissing, and a column names a closed source', () => {
    const base = { connectionId: '44444444-4444-4444-8444-444444444444', columns: [{ header: 'A', value: { kind: 'field', field: 'status' } }] };
    expect(CONFIG_SCHEMAS.sheet_row.safeParse(base).success).toBe(false);
    expect(CONFIG_SCHEMAS.sheet_row.safeParse({ ...base, createIfMissing: true }).success).toBe(true);
    expect(CONFIG_SCHEMAS.sheet_row.safeParse({ ...base, fileId: 'abc' }).success).toBe(true);
    expect(columnSourceSchema.safeParse({ kind: 'field', field: 'password' }).success).toBe(false);
    expect(columnSourceSchema.safeParse({ kind: 'output', key: 'Not-Snake' }).success).toBe(false);
  });

  it('a folder delivery is storage or a connection folder, and a webhook an address', () => {
    expect(CONFIG_SCHEMAS.folder.parse({ target: 'storage', files: {} }).nameTemplate).toBe('{{task}} {{date}}');
    expect(CONFIG_SCHEMAS.folder.safeParse({ target: { connectionId: '44444444-4444-4444-8444-444444444444' }, files: {} }).success).toBe(false);
    expect(CONFIG_SCHEMAS.webhook.safeParse({ url: 'https://hooks.example.test/x' }).success).toBe(true);
    expect(CONFIG_SCHEMAS.webhook.safeParse({ url: 'nope' }).success).toBe(false);
    expect(createDeliverySchema.safeParse({ kind: 'sms', config: {} }).success).toBe(false);
  });
});

describe('signed links', () => {
  const links = new RunReportLinks({ get: () => 'https://console.example.test/' } as never);
  const u = '22222222-2222-4222-8222-222222222222';
  const r = '11111111-1111-4111-8111-111111111111';

  it('a report link names one run of one user and works for seven days', () => {
    const url = links.url(u, r);
    expect(url.startsWith('https://console.example.test/api/reports/')).toBe(true);
    const token = url.split('/').pop()!;
    expect(links.verify(token)).toMatchObject({ userId: u, runId: r });
    expect(links.verify(token, Date.now() + 6 * 86_400_000)).not.toBeNull();
    expect(links.verify(token, Date.now() + 8 * 86_400_000)).toBeNull();
  });

  it('a tampered, truncated or foreign token verifies as nothing', () => {
    const token = links.issue(u, r);
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ u: '99999999-9999-4999-8999-999999999999', r, k: 'report', exp: 9_999_999_999 })).toString('base64url');
    expect(links.verify(`${forged}.${sig}`)).toBeNull();
    expect(links.verify(`${body}.${sig!.slice(0, -2)}AA`)).toBeNull();
    expect(links.verify(body!)).toBeNull();
    expect(links.verify('')).toBeNull();
    expect(links.verify('a.b.c')).toBeNull();
    // A token made for another purpose does not open a report.
    expect(links.verify(signToken('unsubscribe', { u, r }, 3600))).toBeNull();
    expect(verifyToken('report', token, Date.now(), 'another-secret')).toBeNull();
  });
});

describe('retries', () => {
  it('backs off on the schedule, and a provider wait that is longer wins', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => backoffMs(n))).toEqual([DELIVERY_BACKOFF_MS[0], DELIVERY_BACKOFF_MS[1], DELIVERY_BACKOFF_MS[2], DELIVERY_BACKOFF_MS[3], DELIVERY_BACKOFF_MS[3], DELIVERY_BACKOFF_MS[3]]);
    expect(backoffMs(1, 10 * 60_000)).toBe(10 * 60_000);
    expect(backoffMs(1, 24 * 3_600_000)).toBe(60 * 60_000);
  });

  it('retries a rate limit, a provider error and a network error, and nothing that needs the owner', () => {
    const retry = DELIVERY_ERROR_CODES.filter(isRetryableCode);
    expect(retry.sort()).toEqual(['HTTP_5XX', 'NETWORK_ERROR', 'PROVIDER_ERROR', 'RATE_LIMITED', 'TIMEOUT']);
    for (const code of ['CONNECTION_NEEDS_RECONNECT', 'CAPABILITY_OFF', 'NOT_FOUND', 'PERMISSION_MISSING', 'OUTCOME_UNKNOWN'] as const) expect(isRetryableCode(code)).toBe(false);
  });

  it('every code has a fixed sentence that carries no content', () => {
    for (const c of DELIVERY_ERROR_CODES) expect(DELIVERY_ERROR_TEXT[c]).toMatch(/^[a-z]/);
  });
});
