// The named values of a proposed memory, as the model sends them: a list of name/value pairs.
//
// A free-form object (`z.record`) is JSON Schema `additionalProperties: {…}` with `propertyNames`, which OpenAI's strict function calling does
// not accept: it answered 400 `invalid_function_parameters` on `tools[3].parameters` to EVERY chat message (#675). A list of pairs is plain
// closed objects in an array, which strict mode accepts, and is how `run_task` already passes its inputs. The memory service still takes the
// record: `attributesFromPairs` turns one into the other.
import { z } from 'zod';

import { MAX_ATTRIBUTES, MAX_ATTRIBUTE_KEY, MAX_ATTRIBUTE_VALUE } from './memories.schemas';

export const attributePairs = z
  .array(z.object({ name: z.string().min(1).max(MAX_ATTRIBUTE_KEY), value: z.string().min(1).max(MAX_ATTRIBUTE_VALUE) }))
  .max(MAX_ATTRIBUTES);

/** The pairs as the record the memory service takes: names and values trimmed, a blank one dropped, a repeated name keeps its last value. */
export function attributesFromPairs(pairs: readonly { name: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, value } of pairs) {
    const n = name.trim();
    const v = value.trim();
    if (n && v) out[n] = v;
  }
  return out;
}
