// The in-memory store passes the host conformance kit a real binding (the console's Prisma store) also runs.
import { InMemoryProcedureStore, runStoreConformance } from '../src/testing';

runStoreConformance({
  name: 'in-memory',
  open: async () => ({ store: new InMemoryProcedureStore(), owners: ['owner-a', 'owner-b'], task: async (_owner: string, key: string) => key, close: async () => undefined }),
});
