// An in-memory host for the conformance suite: the fakes behind the levers `runHarnessHostConformance` needs. It proves the suite itself, and is the
// shortest example of what a host's `open()` does. A real host binds a database, a signal and a question broker instead.
import type { HarnessMemory } from '../types';
import type { RunStorePort } from '../ports';
import type { HarnessHost, HostedJob, HostedRun } from './conformance';
import { FakeControl, FakeQuestions, FakeRunStore } from './fakes';

/** The conditional writes of a store: a job that no longer holds the run writes nothing and answers false (E38.3). */
const GUARDED = new Set<PropertyKey>(['checkpoint', 'commitStep', 'saveMemory', 'openIntent']);

export function fakeHarnessHost(): HarnessHost {
  return {
    name: 'in-memory fakes',
    async open(): Promise<HostedRun> {
      const data = new FakeRunStore();
      const lease = { holder: 'job-1' };
      const controls: FakeControl[] = [];
      const answered = new Set<string>();
      let jobs = 0;

      const bind = (): HostedJob => {
        const token = `job-${++jobs}`;
        lease.holder = token;
        const store = new Proxy(data, {
          get(target, prop) {
            if (prop === 'holdsRun') return async () => lease.holder === token;
            const value = Reflect.get(target, prop, target);
            if (typeof value !== 'function') return value;
            if (GUARDED.has(prop)) return async (...args: unknown[]) => (lease.holder === token ? value.apply(target, args) : false);
            return value.bind(target);
          },
        }) as unknown as RunStorePort;
        const control = new FakeControl();
        controls.push(control);
        return { store, control, questions: new FakeQuestions() };
      };

      const first = bind();
      return {
        job: first,
        claimAgain: async () => bind(),
        pressStop: async () => {
          for (const c of controls) c.requested = true;
        },
        answer: async (handoffId) => {
          if (answered.has(handoffId)) return false;
          answered.add(handoffId);
          return true;
        },
        readMemory: async (): Promise<HarnessMemory | null> => data.memory,
        close: async () => undefined,
      };
    },
  };
}
