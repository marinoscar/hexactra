// The host conformance suite, run against the package's own in-memory host: proves the suite passes for a host that behaves, and is the shortest
// example of what a real host does (the console runs it over its database bindings in apps/api/test/agent-host-conformance.db.spec.ts).
import { fakeHarnessHost, runHarnessHostConformance } from '../src/testing';

runHarnessHostConformance(fakeHarnessHost());
