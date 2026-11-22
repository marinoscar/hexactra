// E46.23 (#797): the transfer file holds no secret, no id, no evidence; an untrusted file is refused with typed errors.
import { exportFile, FORMAT_VERSION, readTransferFile, TRANSFER_LIMITS } from '../src/transfer';
import { aVersion, call, lit, secret } from '../src/testing';

const MARKERS = { card: '4111 1111 1111 1111', token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', user: '7e1f0c2a-1111-4222-8333-944455556666', conn: 'conn-secret-id-9911' };
const version = aVersion([call('c1', 'navigate', { url: lit('https://shop.example.com/') }), call('c2', 'type_text', { selector: lit('#card'), text: lit(MARKERS.card) }), call('c3', 'type_text', { selector: lit('#pw'), text: secret('ref-77') }), call('c4', 'type_text', { selector: lit('#k'), text: lit(MARKERS.token) })], {
  id: `v-${MARKERS.user}`,
  procedure: `p-${MARKERS.user}`,
  sourceRun: `run-${MARKERS.user}`,
  accounts: [{ id: 'a1', connectionId: MARKERS.conn, provider: 'google' }],
  secretRefs: [{ id: 'ref-77', kind: 'login', label: 'Shop login' }],
});

describe('export', () => {
  const file = exportFile([{ task: { name: 'Buy pens', goal: 'Buy blue pens', parameters: [], outputs: [] }, version: { ...version, evidence: { successes: 9, failures: 1, repairs: 0, lastSuccessAt: null, lastFailureAt: null } } }], new Date('2026-11-22T00:00:00Z'));
  const text = JSON.stringify(file);
  it('holds none of the markers, no ids, no evidence', () => {
    for (const m of Object.values(MARKERS)) expect(text).not.toContain(m);
    expect(text).not.toMatch(/ref-77|successes|sourceRun|"procedure"/);
  });
  it('keeps labels and placeholders, and turns a secret-looking literal into a sensitive parameter', () => {
    const v = file.procedures[0]!.version;
    expect(v.accounts).toEqual([{ id: 'account-1', connectionId: 'account-1', provider: 'google' }]);
    expect(v.secretRefs).toEqual([{ id: 'login-1', kind: 'login', label: 'Shop login' }]);
    expect(v.parameters.filter((p) => p.sensitive).map((p) => p.id)).toEqual(['p:import-1', 'p:import-2']);
    expect(file).toMatchObject({ kind: 'hexactra.kgraph', formatVersion: FORMAT_VERSION });
    expect(readTransferFile(text).ok).toBe(true);
  });
});

describe('import reading', () => {
  it('refuses a malformed file, an unknown format version and an over-limit file with typed errors', () => {
    expect(readTransferFile('{not json')).toMatchObject({ ok: false, error: { code: 'malformed' } });
    expect(readTransferFile({ kind: 'something.else' })).toMatchObject({ ok: false, error: { code: 'malformed' } });
    expect(readTransferFile({ kind: 'hexactra.kgraph', formatVersion: 99, procedures: [] })).toMatchObject({ ok: false, error: { code: 'unknown_format_version' } });
    expect(readTransferFile('x'.repeat(TRANSFER_LIMITS.bytes + 1))).toMatchObject({ ok: false, error: { code: 'too_large' } });
    expect(readTransferFile({ kind: 'hexactra.kgraph', formatVersion: 1, exportedAt: 'x', procedures: Array.from({ length: 51 }, () => ({})) })).toMatchObject({ ok: false, error: { code: 'too_many_procedures' } });
  });
});
