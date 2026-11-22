// E46.17 (#791): a review is answered only by the owner in a signed-in browser session; no MCP tool reaches it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { procedureVersionSchema } from '@marinoscar/hexactra-kgraph';

import { KgraphReviewsService } from '../src/kgraph/reviews.service';
import { usableVersion } from '../src/runner/host/kgraph/replay';

describe('answering a review', () => {
  const service = new KgraphReviewsService({} as never, {} as never);
  it.each(['pat', 'oauth', 'node', undefined, null])('refuses a %s credential before reading anything', async (kind) => {
    await expect(service.answer('u1', 'r1', true, kind as never)).rejects.toMatchObject({ status: 403 });
  });
  it('no MCP tool names a Knowledge Graph review', () => {
    const tools = readFileSync(join(__dirname, '..', 'src', 'mcp', 'mcp.tools.ts'), 'utf8');
    expect(tools).not.toMatch(/kgraph|kg_review|reviews\/.*answer/i);
  });
});

describe('usableVersion (E46.17)', () => {
  const v = (id: string, state: string, changeClass = 'initial', parent: string | null = null) =>
    procedureVersionSchema.parse({ id, procedure: 'p', number: 1, state, changeClass, sourceRun: null, parent, createdAt: '2026-01-01T00:00:00.000Z', entry: 's', steps: [{ id: 's', kind: 'check', label: 'x' }] });
  it('a structural repair of the active version is replayed next (its verification run)', () => {
    expect(usableVersion([v('r', 'candidate', 'structural', 'a'), v('a', 'active')])?.id).toBe('r');
  });
  it('a sensitive repair is never chosen until approved; the active version keeps running', () => {
    expect(usableVersion([v('r', 'candidate', 'sensitive', 'a'), v('a', 'active')])?.id).toBe('a');
    expect(usableVersion([v('r', 'candidate', 'sensitive', 'a'), v('a', 'active')], new Set(['r']))?.id).toBe('r');
    expect(usableVersion([v('r', 'candidate', 'sensitive', null)])).toBeNull();
  });
});
