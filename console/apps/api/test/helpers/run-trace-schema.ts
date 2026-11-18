// The JSON Schema of the run trace file (#542), as packages/sdk ships it, and
// a validator of the shipped file. Shared by run-trace-export.spec.ts (the
// schema is current) and run-export.db.spec.ts (a real export validates).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { z } from 'zod';

import { runTraceSchema } from '../../src/tasks/run-trace.schemas';

export const RUN_TRACE_JSON_SCHEMA = resolve(__dirname, '../../../../packages/sdk/run-trace.schema.json');

/** The JSON Schema of the file, generated from its zod schema. */
export function runTraceJsonSchema(): Record<string, unknown> {
  return {
    $id: 'urn:hexactra:run-trace:1',
    title: 'Hexactra run trace',
    ...(z.toJSONSchema(runTraceSchema, { io: 'output', unrepresentable: 'any' }) as Record<string, unknown>),
  };
}

/** A validator of the shipped schema file. */
export function runTraceValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(JSON.parse(readFileSync(RUN_TRACE_JSON_SCHEMA, 'utf8')) as object);
}
