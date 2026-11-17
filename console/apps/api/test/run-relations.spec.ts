// What a run owns, read from the composed Prisma schema (#421): deleting a run
// must leave nothing behind that points at it. Every foreign key to `Run`
// cascades, and a column that holds a run id WITHOUT a foreign key is listed
// here, because the delete (tasks/run-delete.service.ts) has to clear it by hand.
import { join } from 'node:path';
import { effectiveOnDelete, readSchemaDatamodel } from '@marinoscar/platform-api/testing';

/** Run-id columns with no foreign key, each cleared by `RunDeleteService`. Adding one means handling it there. */
const PLAIN_RUN_ID_COLUMNS = ['TaskSchedule.lastRunId'];

describe('relations to Run', () => {
  const models = readSchemaDatamodel(join(__dirname, '..', 'prisma', 'schema'));
  /** Relation fields that hold a foreign key (the other side of a relation has no `fields`). */
  const foreignKeys = models.flatMap((m) => m.fields.filter((f) => (f.relation?.fields.length ?? 0) > 0).map((f) => ({ model: m.name, field: f })));

  it('every foreign key to Run is ON DELETE CASCADE', () => {
    const toRun = foreignKeys.filter((fk) => fk.field.type === 'Run');
    // The ones known today; a new one appears here and must cascade too.
    expect(toRun.map((fk) => `${fk.model}.${fk.field.name}`).sort()).toEqual(['Question.run', 'RunStep.run']);
    for (const fk of toRun) expect({ field: `${fk.model}.${fk.field.name}`, onDelete: effectiveOnDelete(fk.field) }).toEqual({ field: `${fk.model}.${fk.field.name}`, onDelete: 'Cascade' });
  });

  it('a run id held without a foreign key is one the delete clears', () => {
    const fkColumns = new Set(foreignKeys.flatMap((fk) => fk.field.relation!.fields.map((c) => `${fk.model}.${c}`)));
    const plain = models.flatMap((m) => m.fields.filter((f) => /runId$/i.test(f.name) && !fkColumns.has(`${m.name}.${f.name}`)).map((f) => `${m.name}.${f.name}`));
    expect(plain.sort()).toEqual(PLAIN_RUN_ID_COLUMNS);
  });
});
