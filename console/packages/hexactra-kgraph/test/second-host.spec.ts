// A second, minimal host (E46.8): no harness, no browser, no database — a key-value "app" with three tools. It binds the ports by hand and
// runs a procedure. Proof the core embeds anywhere.
import { executeProcedure, type KgraphPorts, noopTelemetry, procedureVersionSchema, validateVersion, type Tool } from '../src';

const TOOLS: Tool[] = [
  { name: 'kv_get', family: 'kv', commits: false },
  { name: 'kv_put', family: 'kv', commits: true },
  { name: 'kv_list', family: 'kv', commits: false },
];

function kvHost() {
  const data = new Map<string, string>([['greeting', 'hello'], ['name', 'Ada']]);
  const ports: KgraphPorts = {
    store: { getProcedure: async () => null, findProcedureForTask: async () => null, listProcedures: async () => [], putProcedure: async () => undefined, getVersion: async () => null, listVersions: async () => [], putVersion: async () => undefined, setVersionState: async () => false, recordEvidence: async () => ({ successes: 0, failures: 0, repairs: 0, lastSuccessAt: null, lastFailureAt: null }), deleteAll: async () => 0 },
    tools: {
      invoke: async ({ tool, args }) => {
        const a = args as Record<string, string>;
        if (tool === 'kv_get') return { ok: data.has(a.key!), text: data.get(a.key!) ?? '', value: { value: data.get(a.key!) }, digest: 'g', refused: false, stopped: false, paused: false };
        if (tool === 'kv_put') {
          data.set(a.key!, a.value!);
          return { ok: true, text: 'stored', value: { stored: true }, digest: 'p', refused: false, stopped: false, paused: false };
        }
        return { ok: true, text: JSON.stringify([...data.keys()]), digest: 'l', refused: false, stopped: false, paused: false };
      },
    },
    probe: { location: async () => null, viewDigest: async () => null, elementPresent: async () => null },
    judge: { judge: async () => ({ ok: false }) },
    clock: { now: () => new Date('2026-01-01T00:00:00Z'), sleep: async () => undefined },
    ids: { next: (p) => `${p}1` },
    telemetry: noopTelemetry,
  };
  return { ports, data };
}

it('a host with no harness and no browser runs a procedure', async () => {
  const version = procedureVersionSchema.parse({
    id: 'v1',
    procedure: 'p1',
    number: 1,
    state: 'active',
    changeClass: 'initial',
    sourceRun: null,
    parent: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    entry: 'g',
    steps: [
      { id: 'g', kind: 'call', label: 'read the name', tool: 'kv_get', args: { key: { kind: 'literal', value: 'name' } }, checks: [{ kind: 'result_shape', step: 'g', ok: true, fields: ['value'] }] },
      { id: 'p', kind: 'call', label: 'store a greeting', tool: 'kv_put', commitClass: true, args: { key: { kind: 'parameter', parameter: 'target' }, value: { kind: 'output', step: 'g', path: 'value' } } },
    ],
    edges: [{ type: 'then', from: 'g', to: 'p' }],
    parameters: [{ id: 'target', name: 'Target key' }],
  });
  expect(validateVersion(version, { tools: TOOLS })).toEqual([]);
  const { ports, data } = kvHost();
  const intents: string[] = [];
  const report = await executeProcedure(version, { target: 'copy' }, ports, { goal: 'Copy the name', onCommitIntent: async (s) => void intents.push(s.id) });
  expect(report.status).toBe('completed');
  expect(data.get('copy')).toBe('Ada');
  expect(intents).toEqual(['p']);
  expect(report.judgeCalls).toBe(0);
});
