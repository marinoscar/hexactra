// Arguments are validated against the tool's OWN stored JSON schema before any request (E39.9, #606). The model's tool list carries a zod
// version of the schema (what providers are offered), but zod is lenient about what it cannot express, so the stored schema decides:
// a call whose arguments do not satisfy it is rejected here, with the first problems named, and nothing is sent to the server.
import Ajv2020 from 'ajv/dist/2020';
import type { ValidateFunction } from 'ajv';

const ajv = new Ajv2020({ strict: false, allErrors: true, allowUnionTypes: true, validateFormats: false, coerceTypes: false, useDefaults: false, removeAdditional: false });
const compiled = new Map<string, ValidateFunction | null>();

/** A compiled validator for `schema`, cached by `key` (the tool's hash). Null when the schema is not one this validator can compile. */
function validatorFor(key: string, schema: Record<string, unknown>): ValidateFunction | null {
  if (compiled.has(key)) return compiled.get(key) ?? null;
  let fn: ValidateFunction | null = null;
  try {
    // A `$schema` of another dialect (draft-07 is common) names a meta-schema this instance does not carry: the keywords are the same ones.
    const { $schema: _dialect, $id: _id, ...rest } = schema;
    fn = ajv.compile(rest);
  } catch {
    fn = null;
  }
  if (compiled.size > 500) compiled.clear();
  compiled.set(key, fn);
  return fn;
}

export type ArgsCheck = { ok: true } | { ok: false; issues: string[]; unsupported?: boolean };

/** Whether `args` satisfy the tool's schema. The issues are short (`/path: message`), at most five, and carry no value. */
export function checkArguments(key: string, schema: Record<string, unknown>, args: unknown): ArgsCheck {
  const fn = validatorFor(key, schema);
  if (!fn) return { ok: false, issues: ['the tool\'s schema cannot be checked'], unsupported: true };
  if (fn(args)) return { ok: true };
  const issues = (fn.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || '(arguments)'}: ${e.message ?? 'not valid'}`);
  return { ok: false, issues: issues.length > 0 ? issues : ['not valid'] };
}

/** Whether a schema can be both offered to a model (as zod) and checked here. A tool that cannot is not offered. */
export function schemaUsable(key: string, schema: Record<string, unknown>): boolean {
  return validatorFor(key, schema) !== null;
}
