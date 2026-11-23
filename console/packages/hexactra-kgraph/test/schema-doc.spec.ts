// docs/schema.md is generated from the zod schemas. This fails when it is stale: run `npm run docs:schema -w @marinoscar/hexactra-kgraph`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schemaMarkdown } from '../src/schema/doc';

describe('docs/schema.md', () => {
  it('is up to date with src/schema (regenerate with `npm run docs:schema -w @marinoscar/hexactra-kgraph`)', () => {
    expect(readFileSync(join(__dirname, '..', 'docs', 'schema.md'), 'utf8')).toBe(schemaMarkdown());
  });

  it('documents every node type, edge type and step kind', () => {
    const doc = schemaMarkdown();
    for (const word of ['ProcedureVersion', 'SecretRef', 'version_of', 'transition', 'foreach', 'branch', 'judge', 'result_shape', 'view_digest']) expect(doc).toContain(word);
  });
});
