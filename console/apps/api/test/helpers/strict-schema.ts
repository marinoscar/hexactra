// OpenAI's strict function calling accepts a narrow subset of JSON Schema. A tool sent with `strict: true` (the platform's default) that
// leaves it is refused with 400 `invalid_function_parameters`, and the refusal takes the WHOLE model call down (#675: every chat message).
// This is the subset, as a check on the JSON Schema `z.toJSONSchema` makes of a tool's parameters.
import { z } from 'zod';

type Schema = Record<string, unknown> & { type?: unknown; properties?: Record<string, Schema>; required?: string[]; items?: Schema; anyOf?: Schema[] };

const NOT_IN_STRICT = ['propertyNames', 'patternProperties', 'oneOf', 'allOf', 'not', 'if', 'then', 'else', 'dependentSchemas', 'default'] as const;

/** What in `schema` strict mode would refuse, one line each (empty: accepted). */
export function strictViolations(tool: string, schema: Schema, path = ''): string[] {
  const here = `${tool}${path || ' (top level)'}`;
  const out: string[] = [];
  const isObject = schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'));
  if (isObject) {
    if (schema.additionalProperties !== false) out.push(`${here}: an object must set additionalProperties: false (a free-form record or map does not)`);
    const keys = Object.keys(schema.properties ?? {});
    // An object with no properties needs no list: observe_elements, go_back and tabs have always been sent this way and accepted.
    if (keys.length > 0 && !Array.isArray(schema.required)) out.push(`${here}: an object needs a "required" list`);
    for (const k of keys) if (!(schema.required ?? []).includes(k)) out.push(`${here}.${k}: every property must be required (optional ones are nullable)`);
    for (const k of keys) out.push(...strictViolations(tool, schema.properties![k]!, `${path}.${k}`));
  }
  for (const kw of NOT_IN_STRICT) if (kw in schema) out.push(`${here}: keyword "${kw}" is not accepted`);
  if (schema.type === 'array') {
    if (!schema.items) out.push(`${here}: an array needs items`);
    else out.push(...strictViolations(tool, schema.items, `${path}[]`));
  }
  for (const alt of schema.anyOf ?? []) out.push(...strictViolations(tool, alt, `${path}|`));
  return out;
}

/** The tool's parameters as the JSON Schema the provider receives. */
export function jsonSchemaOf(parameters: unknown): Schema {
  const { $schema: _doc, ...rest } = z.toJSONSchema(parameters as z.ZodType, { unrepresentable: 'throw' }) as Schema;
  return rest;
}
