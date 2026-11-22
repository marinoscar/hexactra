// The testing kit (`@marinoscar/hexactra-kgraph/testing`): in-memory fakes of every port, a scripted tool invoker, builders and the host
// conformance kit.
export * from './fakes';
export * from './builders';
export { runStoreConformance, type StoreHost } from './conformance';

import type { KgraphPorts } from '../ports';
import { FakeClock, FakeJudge, FakeStateProbe, InMemoryProcedureStore, RecordingTelemetry, ScriptedToolInvoker, SequentialIds } from './fakes';

/** Every port as a fake, ready to use. */
export function fakePorts(): KgraphPorts & { store: InMemoryProcedureStore; tools: ScriptedToolInvoker; probe: FakeStateProbe; judge: FakeJudge; clock: FakeClock; ids: SequentialIds; telemetry: RecordingTelemetry } {
  return { store: new InMemoryProcedureStore(), tools: new ScriptedToolInvoker(), probe: new FakeStateProbe(), judge: new FakeJudge(), clock: new FakeClock(), ids: new SequentialIds(), telemetry: new RecordingTelemetry() };
}
