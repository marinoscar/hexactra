// The diagnostics framework without a database (E50.10, #980): the overall rule, the closed codes, the data schema that refuses an
// email address, a token, a URL or prose, the stage runner (stop at the first failure, independent and dependent stages, a stage's own
// deadline, the report's deadline), the mapping of a connection error to a code, and the remedy table: every code a stage can return
// has an entry, and every entry is well formed.
import { DIAGNOSTIC_REMEDIES } from '@app/shared';

import { CONNECTION_DIAGNOSTIC_CODES, RECONNECT_REASONS, outcomeOfError } from '../src/connections/connection-diagnostics.service';
import { ConnectionError } from '../src/connections/connections.errors';
import { CODE_PATTERN, closedCode, overall, sanitizeStages, stageDataSchema, stageDataStringSchema, type DiagnosticStage } from '../src/diagnostics/diagnostic-report';
import { MCP_DIAGNOSTIC_CODES } from '../src/connections/mcp/mcp-diagnostics';
import { DiagnosticsRegistry } from '../src/diagnostics/diagnostics.registry';
import { REMEDY_CODES } from '../src/diagnostics/remedies';
import { runStages } from '../src/diagnostics/stages';

const stage = (status: DiagnosticStage['status']): DiagnosticStage => ({ id: 'x', status, code: null, remedy: null, ms: null });

describe('the report', () => {
  it('is fail over warn over pass, and skipped when nothing ran', () => {
    expect(overall([stage('pass'), stage('warn'), stage('fail'), stage('skipped')])).toBe('fail');
    expect(overall([stage('pass'), stage('warn'), stage('skipped')])).toBe('warn');
    expect(overall([stage('pass'), stage('skipped')])).toBe('pass');
    expect(overall([stage('skipped'), stage('skipped')])).toBe('skipped');
    expect(overall([])).toBe('skipped');
  });

  it('keeps a code from the closed list and replaces anything else with UNKNOWN', () => {
    const allowed = new Set(['FORBIDDEN']);
    expect(closedCode('FORBIDDEN', allowed)).toBe('FORBIDDEN');
    expect(closedCode('RATE_LIMITED', allowed)).toBe('UNKNOWN');
    expect(closedCode('Invalid credentials for person.a@example.test')).toBe('UNKNOWN');
    expect(closedCode('forbidden')).toBe('UNKNOWN');
    expect(closedCode('A'.repeat(41))).toBe('UNKNOWN');
    expect(closedCode(403)).toBe('UNKNOWN');
  });
});

describe('the data schema', () => {
  it('accepts counts, booleans, a host name, an API id and a permission id', () => {
    for (const v of ['mcp.example.test', 'gmail.googleapis.com', 'Mail.Read', 'calendar_read', 'drive.file']) expect(stageDataStringSchema.safeParse(v).success).toBe(true);
    expect(stageDataSchema.safeParse({ tools: 3, enabled: true, host: 'mcp.example.test', api: 'gmail.googleapis.com' }).success).toBe(true);
  });

  it('refuses a value that looks like an email address, a token, a URL, a path, a query or prose', () => {
    const refused = [
      'person.a@example.test',
      'mailto:person.a@example.test',
      'ya29.a0AfH6SMBx7Qk2LbH3uZy9VnRtPq0WlXe4Yz8DcF',
      'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl',
      'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
      `MARKER-google-access-3-${'0f8fad5b-d9cb-469f-a165-70867728950e'}`,
      'https://mcp.example.test/mcp',
      'mcp.example.test/mcp',
      'search?q=invoice',
      'Quarterly invoice from Person B',
      'Bearer abc',
      'a'.repeat(201),
      '',
    ];
    for (const v of refused) expect([v, stageDataStringSchema.safeParse(v).success]).toEqual([v, false]);
    expect(stageDataSchema.safeParse({ account: 'person.a@example.test' }).success).toBe(false);
    expect(stageDataSchema.safeParse({ 'Bad Key': 1 }).success).toBe(false);
    expect(stageDataSchema.safeParse({ n: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(stageDataSchema.safeParse({ nested: { a: 1 } }).success).toBe(false);
  });

  it('sanitizes stages: drops every refused value, closes the code, and falls back to the code for an unknown remedy', () => {
    const { stages, dropped } = sanitizeStages(
      [
        { id: 'capability:mail_read', status: 'fail', code: 'Mailbox person.a@example.test not found', remedy: 'NOPE', ms: 12.4, data: { email: 'person.a@example.test', subject: 'Quarterly invoice', count: 2 } },
        { id: 'Not An Id', status: 'weird', code: null, remedy: null, ms: -1 },
        { id: 'server', status: 'pass', code: null, remedy: null, ms: 3, data: { tools: 3 } },
      ],
      new Set(['FORBIDDEN']),
      REMEDY_CODES,
    );
    expect(stages).toEqual([
      { id: 'capability:mail_read', status: 'fail', code: 'UNKNOWN', remedy: 'UNKNOWN', ms: 12, data: { count: 2 } },
      { id: 'unknown', status: 'fail', code: 'UNKNOWN', remedy: 'UNKNOWN', ms: null },
      { id: 'server', status: 'pass', code: null, remedy: null, ms: 3, data: { tools: 3 } },
    ]);
    expect(dropped).toBe(2);
    expect(JSON.stringify(stages)).not.toMatch(/person\.a|invoice/i);
  });
});

describe('the stage runner', () => {
  const opts = (signal = new AbortController().signal) => ({ signal, stageTimeoutMs: 200, abortCode: () => 'DEADLINE_EXCEEDED' });

  it('runs in order and skips the rest after the first failure, except an independent stage', async () => {
    const ran: string[] = [];
    const step = (id: string, status: 'pass' | 'fail', extra: { independent?: boolean } = {}) => ({ id, ...extra, run: () => (ran.push(id), { status, code: status === 'fail' ? 'FORBIDDEN' : null }) });
    const out = await runStages([step('a', 'pass'), step('b', 'fail'), step('c', 'pass'), step('d', 'pass', { independent: true })], opts());
    expect(out.map((s) => [s.id, s.status, s.code])).toEqual([
      ['a', 'pass', null],
      ['b', 'fail', 'FORBIDDEN'],
      ['c', 'skipped', null],
      ['d', 'pass', null],
    ]);
    expect(ran).toEqual(['a', 'b', 'd']);
    expect(out[1]!.remedy).toBe('FORBIDDEN');
    expect(typeof out[0]!.ms).toBe('number');
  });

  it('runs capabilities side by side after the sign-in, and skips them all when the sign-in failed', async () => {
    const cap = (id: string, status: 'pass' | 'fail') => ({ id, independent: true, dependsOn: ['sign_in'], run: () => ({ status, code: status === 'fail' ? 'FORBIDDEN' : null }) });
    const ok = await runStages([{ id: 'sign_in', run: () => ({ status: 'pass' as const }) }, cap('capability:mail_read', 'fail'), cap('capability:calendar_read', 'pass')], opts());
    expect(ok.map((s) => s.status)).toEqual(['pass', 'fail', 'pass']);
    const refused = await runStages([{ id: 'sign_in', run: () => ({ status: 'fail' as const, code: 'UNAUTHORIZED' }) }, cap('capability:mail_read', 'pass')], opts());
    expect(refused.map((s) => s.status)).toEqual(['fail', 'skipped']);
    const before = await runStages([{ id: 'sign_in', run: () => ({ status: 'pass' as const }) }, cap('capability:mail_read', 'pass')], { ...opts(), failedBefore: true });
    expect(before.map((s) => s.status)).toEqual(['skipped', 'skipped']);
  });

  it('fails a stage that throws with a closed code, never its message, and one that outlives its deadline as TIMEOUT', async () => {
    const out = await runStages(
      [
        { id: 'a', independent: true, run: () => Promise.reject(new Error('person.a@example.test refused token MARKER')) },
        { id: 'b', independent: true, run: (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) },
        { id: 'c', independent: true, run: () => new Promise(() => undefined) },
      ],
      opts(),
    );
    expect(out.map((s) => [s.id, s.status, s.code])).toEqual([
      ['a', 'fail', 'UNAVAILABLE'],
      ['b', 'fail', 'TIMEOUT'],
      ['c', 'fail', 'TIMEOUT'],
    ]);
    expect(JSON.stringify(out)).not.toContain('person.a');
  });

  it('stops at the report deadline: the running stage fails and the rest are skipped with the abort code', async () => {
    const report = new AbortController();
    setTimeout(() => report.abort(), 30);
    const out = await runStages(
      [
        { id: 'slow', run: () => new Promise(() => undefined) },
        { id: 'next', independent: true, run: () => ({ status: 'pass' as const }) },
      ],
      { ...opts(report.signal), stageTimeoutMs: 5_000 },
    );
    expect(out.map((s) => [s.id, s.status, s.code])).toEqual([
      ['slow', 'fail', 'DEADLINE_EXCEEDED'],
      ['next', 'skipped', 'DEADLINE_EXCEEDED'],
    ]);
  });
});

describe('a connection error as a stage', () => {
  it('maps each typed failure to a closed code, with the reconnect reason as the remedy', () => {
    expect(outcomeOfError(new ConnectionError('CONNECTION_NEEDS_RECONNECT', 'x', { label: 'Work', reason: 'GRANT_REVOKED' }))).toEqual({ status: 'fail', code: 'CONNECTION_NEEDS_RECONNECT', remedy: 'GRANT_REVOKED' });
    expect(outcomeOfError(new ConnectionError('CONNECTION_NEEDS_RECONNECT', 'x', { reason: 'something_else' })).remedy).toBe('CONNECTION_NEEDS_RECONNECT');
    expect(outcomeOfError(new ConnectionError('CONNECTION_UNAVAILABLE', 'x', { reason: 'unavailable' })).code).toBe('UNAVAILABLE');
    expect(outcomeOfError(new ConnectionError('CONNECTION_UNAVAILABLE', 'x', { reason: 'app_refused' })).code).toBe('APP_REFUSED');
    expect(outcomeOfError(new ConnectionError('CONNECTION_UNAVAILABLE', 'x', { reason: 'invalid_request' })).code).toBe('UNAVAILABLE');
    expect(outcomeOfError(new ConnectionError('CONNECTION_UNAVAILABLE', 'x', { reason: 'timeout' })).code).toBe('TIMEOUT');
    expect(outcomeOfError(new ConnectionError('CONNECTION_UNAVAILABLE', 'x', { reason: 'refresh_wait_timeout' })).code).toBe('TIMEOUT');
    expect(outcomeOfError(new ConnectionError('CONNECTION_MCP_AUTH_REQUIRED', 'x', { oauth: true })).code).toBe('AUTH_REFUSED');
    expect(outcomeOfError(new ConnectionError('CONNECTION_MCP_PROTOCOL', 'x')).code).toBe('MCP_PROTOCOL');
    expect(outcomeOfError(new ConnectionError('CONNECTION_MCP_URL_REFUSED', 'x', { reason: 'private_target' })).code).toBe('PRIVATE_TARGET');
    expect(outcomeOfError(new ConnectionError('CONNECTION_PROVIDER_UNAVAILABLE', 'x', { reason: 'disabled' })).code).toBe('PROVIDER_DISABLED');
    expect(outcomeOfError(new ConnectionError('CONNECTION_PAUSED', 'x')).code).toBe('CONNECTION_PAUSED');
    expect(outcomeOfError(new Error('person.a@example.test')).code).toBe('UNAVAILABLE');
  });
});

describe('the remedy table (packages/shared/diagnostics.json)', () => {
  it('has an entry for every code a stage can return', () => {
    const registry = new DiagnosticsRegistry();
    const stageRunnerCodes = ['UNAVAILABLE', 'TIMEOUT', 'ABORTED', 'DEADLINE_EXCEEDED', 'UNKNOWN'];
    const codes = [...CONNECTION_DIAGNOSTIC_CODES, ...RECONNECT_REASONS, ...stageRunnerCodes, ...registry.codes(), ...MCP_DIAGNOSTIC_CODES];
    // Every code an adapter's probe answers today (the Test dialog shows them too).
    codes.push('UNAUTHORIZED', 'FORBIDDEN', 'RATE_LIMITED', 'API_DISABLED', 'NO_MAILBOX', 'NOT_FOUND', 'FAILED');
    expect(codes.filter((c) => !REMEDY_CODES.has(c))).toEqual([]);
  });

  it('has a well-formed entry for every code, in plain words', () => {
    for (const [code, e] of Object.entries(DIAGNOSTIC_REMEDIES)) {
      expect([code, CODE_PATTERN.test(code)]).toEqual([code, true]);
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.remedy.length).toBeGreaterThan(10);
      expect(['owner', 'admin']).toContain(e.who);
      if (e.link !== undefined) expect(['settings', 'admin', 'provider_console']).toContain(e.link);
    }
  });
});
