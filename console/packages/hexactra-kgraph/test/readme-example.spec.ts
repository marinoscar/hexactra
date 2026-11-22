// The README's example runs as written.
import { validateVersion } from '../src/validate';
import { aProcedure, aVersion, call, InMemoryProcedureStore, lit, out, TOOLS } from '../src/testing';

it('the README example works', async () => {
  const store = new InMemoryProcedureStore();
  await store.putProcedure(aProcedure({ id: 'proc1', owner: 'me', task: 'daily-report' }));
  const version = aVersion([call('c1', 'mail_search', { q: lit('subject:"daily numbers"') }), call('c2', 'navigate', { url: out('c1', 'items.0.link') }, { sites: ['s1'] })]);
  expect(validateVersion(version, { tools: TOOLS })).toEqual([]);
  await store.putVersion('me', version);
  expect(await store.setVersionState('me', version.id, 'candidate', 'verified')).toBe(true);
  expect((await store.getVersion('me', version.id))?.state).toBe('verified');
});
