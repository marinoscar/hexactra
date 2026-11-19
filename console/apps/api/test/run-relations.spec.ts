// What a run owns, read from the composed Prisma schema (#421): deleting a run
// must leave nothing behind that points at it. Every foreign key to `Run`
// cascades (or, for the one listed in `SET_NULL_RUN_KEYS`, is cleared), and a column that holds a run id WITHOUT a foreign key is listed
// here, because the delete (tasks/run-delete.service.ts) has to clear it by hand.
import { join } from 'node:path';
import { effectiveOnDelete, readSchemaDatamodel } from '@marinoscar/platform-api/testing';

/** Run-id columns with no foreign key, each cleared by `RunDeleteService`. Adding one means handling it there. */
const PLAIN_RUN_ID_COLUMNS = ['ApprovalRule.lastUsedRunId', 'ApprovalRuleUse.runId', 'McpActivity.runId', 'Memory.sourceRunId', 'SecretsActivity.runId', 'TaskSchedule.lastRunId'];

/**
 * Foreign keys to Run that are ON DELETE SET NULL on purpose: the row outlives
 * the run with no pointer left. A chat keeps a result message's text after its
 * run is deleted by hand or by retention (#483).
 */
const SET_NULL_RUN_KEYS = ['ChatMessage.run'];

describe('relations to Run', () => {
  const models = readSchemaDatamodel(join(__dirname, '..', 'prisma', 'schema'));
  /** Relation fields that hold a foreign key (the other side of a relation has no `fields`). */
  const foreignKeys = models.flatMap((m) => m.fields.filter((f) => (f.relation?.fields.length ?? 0) > 0).map((f) => ({ model: m.name, field: f })));

  it('every foreign key to Run is ON DELETE CASCADE, or SET NULL where the row is meant to outlive the run', () => {
    const toRun = foreignKeys.filter((fk) => fk.field.type === 'Run');
    // The ones known today; a new one appears here and must cascade too.
    expect(toRun.map((fk) => `${fk.model}.${fk.field.name}`).sort()).toEqual(['ChatMessage.run', 'Question.run', 'RunDelivery.run', 'RunGuidance.run', 'RunStep.run']);
    for (const fk of toRun) {
      const field = `${fk.model}.${fk.field.name}`;
      expect({ field, onDelete: effectiveOnDelete(fk.field) }).toEqual({ field, onDelete: SET_NULL_RUN_KEYS.includes(field) ? 'SetNull' : 'Cascade' });
    }
  });

  it('a run id held without a foreign key is one the delete clears', () => {
    const fkColumns = new Set(foreignKeys.flatMap((fk) => fk.field.relation!.fields.map((c) => `${fk.model}.${c}`)));
    const plain = models.flatMap((m) => m.fields.filter((f) => /runId$/i.test(f.name) && !fkColumns.has(`${m.name}.${f.name}`)).map((f) => `${m.name}.${f.name}`));
    expect(plain.sort()).toEqual(PLAIN_RUN_ID_COLUMNS);
  });
});
