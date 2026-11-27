import { describe, expect, it } from 'vitest';

import { batchLines, csvFields, parseRowsFile, rowLines, type CliBatch } from './batches.js';
import type { CliTaskParameter } from './task-inputs.js';

const params: CliTaskParameter[] = [
  { key: 'recipient', label: 'Recipient', type: 'text', required: true },
  { key: 'message', label: 'Message', type: 'text', required: true },
];

describe('rows file (E51.1)', () => {
  it('reads a JSON array of objects', () => {
    expect(parseRowsFile('[{"Recipient":"Ana","Message":"Hi"},{"recipient":"Luis","message":"Yo","extra":null}]', params)).toEqual([
      { Recipient: 'Ana', Message: 'Hi' },
      { recipient: 'Luis', message: 'Yo' },
    ]);
  });
  it('reads a CSV with a header of labels or keys, quotes and commas inside a field', () => {
    expect(parseRowsFile('Recipient,message\nAna,"Dinner moved to 7, see you"\n"Luis ""L""",Hi\n', params)).toEqual([
      { Recipient: 'Ana', message: 'Dinner moved to 7, see you' },
      { Recipient: 'Luis "L"', message: 'Hi' },
    ]);
    expect(csvFields('a, "b,c" ,d')).toEqual(['a', 'b,c', 'd']);
  });
  it('refuses a header that is no parameter, an empty file, and JSON that is not an array of objects', () => {
    expect(() => parseRowsFile('Recipient,Colour\nAna,red', params)).toThrow('Not a parameter of this task: Colour');
    expect(() => parseRowsFile('  ', params)).toThrow('empty');
    expect(() => parseRowsFile('[1,2]', params)).toThrow('array of objects');
  });
  it('lists the rows for the confirmation, and a batch with each row', () => {
    expect(rowLines([{ Recipient: 'Ana', Message: 'Hi' }])).toEqual(['1. Recipient: Ana · Message: Hi']);
    const b: CliBatch = {
      id: 'b1',
      taskName: 'Send a text',
      status: 'cancelled',
      total: 2,
      stopReason: 'owner_stopped',
      stoppedAtSeq: 1,
      summary: '1 stopped, 1 not started',
      items: [
        { seq: 1, status: 'cancelled', runId: 'r1', values: [{ key: 'recipient', label: 'Recipient', value: 'Ana' }], result: null },
        { seq: 2, status: 'skipped', runId: null, values: [{ key: 'recipient', label: 'Recipient', value: 'Luis' }], result: null },
      ],
    };
    expect(batchLines(b)).toEqual(['batch b1 of "Send a text": cancelled, 1 stopped, 1 not started (stopped by you)', '  1. stopped  run r1  Recipient: Ana', '  2. skipped  Recipient: Luis']);
  });
});
