// The hand-compiled fixture (E46.6, #780): one realistic procedure (search mail → read a value from a page → append a sheet row → send a
// summary) that later tests and the docs' example use. It must stay valid against its own tool catalogue.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { procedureVersionSchema, toolSchema } from '../src/schema';
import { validateVersion } from '../src/validate';

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));
const tools = toolSchema.array().parse(fixture('tools.json'));
const version = fixture('daily-summary.procedure.json');

describe('the daily-summary fixture', () => {
  it('passes validateVersion with its tool catalogue', () => {
    expect(validateVersion(version, { tools })).toEqual([]);
  });

  it('is the four-part job: mail, a value read from a page, a sheet row, a sent summary; the two commits are commit-class', () => {
    const v = procedureVersionSchema.parse(version);
    expect(v.steps.flatMap((s) => (s.kind === 'call' ? [s.tool] : []))).toEqual(['mail_search', 'navigate', 'read_text', 'sheet_append_rows', 'mail_send']);
    expect(v.steps.filter((s) => s.kind === 'extract').map((s) => s.id)).toEqual(['report-link', 'total']);
    expect(v.steps.filter((s) => s.commitClass).map((s) => s.id)).toEqual(['append-row', 'send-summary']);
  });

  it('is refused when a commit step loses its commit class (the catalogue decides)', () => {
    const v = procedureVersionSchema.parse(version);
    const broken = { ...v, steps: v.steps.map((s) => (s.id === 'send-summary' ? { ...s, commitClass: false } : s)) };
    expect(validateVersion(broken, { tools }).map((x) => x.rule)).toEqual(['commit_class']);
  });
});
