// The capability matrix (E39.4, #602): the table in docs/connections.md is generated from the code and a test fails when they differ,
// every method has a row, and what the matrix says about Microsoft is what the adapter does.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CAPABILITY_METHODS } from '../src/connections/capabilities';
import { CAPABILITY_MATRIX, COLUMNS_OF_PROVIDER, MATRIX_COLUMNS, matrixMarkdown, matrixRows } from '../src/connections/capability-matrix';

const DOC = join(__dirname, '..', '..', '..', 'docs', 'connections.md');
const START = '<!-- capability-matrix:start -->';
const END = '<!-- capability-matrix:end -->';

describe('the capability matrix', () => {
  it('has a row for every method of the three interfaces, and no other', () => {
    const methods = Object.entries(CAPABILITY_METHODS).flatMap(([service, ms]) => Object.keys(ms).map((m) => `${service}.${m}`));
    expect(Object.keys(CAPABILITY_MATRIX).sort()).toEqual(methods.sort());
    expect(matrixRows()).toHaveLength(methods.length);
  });

  it('says for each method and column: supported, limited with a note, or not supported with the reason', () => {
    for (const [method, cols] of Object.entries(CAPABILITY_MATRIX)) {
      expect(Object.keys(cols).sort()).toEqual([...MATRIX_COLUMNS].sort());
      for (const [col, cell] of Object.entries(cols)) {
        expect(['supported', 'limited', 'unsupported']).toContain(cell.support);
        if (cell.support !== 'supported') expect({ method, col, note: Boolean(cell.note) }).toEqual({ method, col, note: true });
      }
    }
  });

  it('tags each row with the effect and capability of its method', () => {
    const row = (m: string) => matrixRows().find((r) => r.method === m)!;
    expect(row('mail.send')).toMatchObject({ service: 'mail', effect: 'write', capability: 'mail_send' });
    expect(row('mail.createDraft')).toMatchObject({ effect: 'write', capability: 'mail_modify' });
    expect(row('documents.readSheet')).toMatchObject({ effect: 'read', capability: 'docs_read' });
  });

  it('keeps to the provider columns when asked for one provider (what GET /api/connections/providers returns)', () => {
    for (const r of matrixRows(COLUMNS_OF_PROVIDER.google)) expect(Object.keys(r.support)).toEqual(['google']);
    for (const r of matrixRows(COLUMNS_OF_PROVIDER.microsoft)) expect(Object.keys(r.support)).toEqual(['microsoft_work', 'microsoft_personal']);
  });

  it('is the table in docs/connections.md: they cannot disagree (UPDATE_CAPABILITY_MATRIX_DOC=1 rewrites the doc)', () => {
    const doc = readFileSync(DOC, 'utf8');
    const from = doc.indexOf(START);
    const to = doc.indexOf(END);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const generated = `${START}\n${matrixMarkdown()}\n${END}`;
    if (process.env.UPDATE_CAPABILITY_MATRIX_DOC === '1') {
      writeFileSync(DOC, doc.slice(0, from) + generated + doc.slice(to + END.length));
      return;
    }
    expect(doc.slice(from, to + END.length)).toBe(generated);
  });
});
