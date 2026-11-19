// The interface contract suite (test/support/capability-contract.ts) run UNCHANGED against every provider with its fake:
// the in-memory double, Google and Microsoft (a work or school account and a personal one).
import type { ConnectionContext } from '../src/connections/capabilities';
import { CapabilityHub } from '../src/connections/capability-hub';
import { CapabilityProviderRegistry } from '../src/connections/capability-provider.registry';
import { CAPABILITIES } from '../src/connections/connections.constants';
import { GoogleCapabilityProvider } from '../src/connections/google/google.provider';
import { GoogleHttp, type TokenSource } from '../src/connections/google/google-http';
import { FakeGoogle, type FakeGoogleAccount } from '../src/connections/google/testing';
import { InMemoryConnections, createTestCapabilities } from '../src/connections/testing';
import { createHarness } from './microsoft/harness';
import { describeCapabilityContract, type ContractAccount, type ContractWorld } from './support/capability-contract';

const ctxOf = (id: string, userId: string) => (signal?: AbortSignal): ConnectionContext => ({ connectionId: id, userId, signal });

describeCapabilityContract('in-memory double', () => {
  const t = createTestCapabilities({ provider: 'google' });
  const account = (label: string): ContractAccount => {
    const row = t.connections.add({ capabilities: [...CAPABILITIES], label });
    const fake = t.fake.account(row.id);
    return {
      ctx: ctxOf(row.id, row.userId),
      seedMessage: (m) => void fake.addMessage({ subject: m.subject, text: m.text }),
      sentCount: () => fake.sent.length,
      invitationsSent: () => 0,
    };
  };
  return { hub: t.hub, column: 'google', a: account('A'), b: account('B'), requestCount: () => t.fake.calls.length };
});

describeCapabilityContract('Microsoft work or school account', () => microsoftWorld('work'));
describeCapabilityContract('Microsoft personal account', () => microsoftWorld('personal'));

function microsoftWorld(kind: 'work' | 'personal'): ContractWorld {
  const h = createHarness();
  const account = (email: string): ContractAccount => {
    const fakeAccount = h.addAccount({ email, kind });
    const c = h.connect(fakeAccount, undefined, email);
    return {
      ctx: c.ctx,
      seedMessage: (m) => void fakeAccount.addMessage({ subject: m.subject, text: m.text }),
      sentCount: () => fakeAccount.sent.length,
      invitationsSent: () => fakeAccount.invitations.length,
    };
  };
  return { hub: h.hub, column: kind === 'work' ? 'microsoft_work' : 'microsoft_personal', a: account('person-a@example.test'), b: account('person-b@example.test'), requestCount: () => h.fake.requests.length };
}

describeCapabilityContract('Google', () => {
  const fake = new FakeGoogle();
  const accountOf = new Map<string, FakeGoogleAccount>();
  const tokens: TokenSource = { getAccessToken: async (id) => accountOf.get(id)!.accessToken };
  const registry = new CapabilityProviderRegistry();
  registry.register(new GoogleCapabilityProvider(new GoogleHttp(fake, undefined, { sleep: async () => undefined, random: () => 0.5 }), tokens));
  const connections = new InMemoryConnections();
  const hub = new CapabilityHub({ lookup: connections.lookup, providers: registry });
  const account = (email: string): ContractAccount => {
    const g = fake.addAccount({ email });
    const row = connections.add({ capabilities: [...CAPABILITIES], label: email, accountEmail: email });
    accountOf.set(row.id, g);
    return {
      ctx: ctxOf(row.id, row.userId),
      seedMessage: (m) => void g.addMessage({ subject: m.subject, text: m.text }),
      sentCount: () => g.sent.length,
      invitationsSent: () => 0,
    };
  };
  return { hub, column: 'google', a: account('person-a@example.test'), b: account('person-b@example.test'), requestCount: () => fake.requests.length };
});
