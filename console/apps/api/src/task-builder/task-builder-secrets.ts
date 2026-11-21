// What the task builder never records (E42.3): a value that looks like a secret is dropped from a spec change
// before it is merged, and the model is told so. A heuristic on top of the instructions, not a guarantee.
import { maskText } from '@app/shared/sensitive-patterns';

import type { TaskBuilderSpecPatch } from './task-builder.spec.schema';

/** The patterns that are a secret in a task spec. An email or a phone number is a fine default; a card, an IBAN or a token is not. */
const SECRET_HITS = ['token', 'iban', 'card', 'ssn', 'routing', 'account'] as const;
/** A parameter whose name says it is a secret never keeps a default. */
const SECRET_NAME = /\b(password|passcode|passphrase|pin|otp|one[- ]time|cvv|cvc|security code|verification code|2fa|mfa)\b/i;

function looksSecret(text: string): boolean {
  const { hits } = maskText(text);
  return SECRET_HITS.some((k) => hits[k] > 0);
}

/**
 * The patch with every secret-looking string removed, and what was removed (in words for the model). Strings
 * are checked wherever they are in the patch; a parameter named like a secret loses its default.
 */
export function scrubSecrets(patch: TaskBuilderSpecPatch): { patch: TaskBuilderSpecPatch; dropped: string[] } {
  const dropped: string[] = [];
  const walk = (value: unknown, path: string): unknown => {
    if (typeof value === 'string') {
      if (looksSecret(value)) {
        dropped.push(path);
        return undefined;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`)).filter((v) => v !== undefined);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        const w = walk(v, path ? `${path}.${k}` : k);
        if (w !== undefined) out[k] = w;
      }
      return out;
    }
    return value;
  };
  const clean = walk(patch, '') as Record<string, unknown>;
  if (Array.isArray(clean.parameters)) {
    clean.parameters = (clean.parameters as Record<string, unknown>[]).map((p, i) => {
      if (typeof p.name === 'string' && SECRET_NAME.test(p.name) && (p.default !== undefined || p.memory !== undefined)) {
        dropped.push(`parameters[${i}].default`);
        const { default: _d, memory: _m, attribute: _a, ...rest } = p;
        return rest;
      }
      return p;
    });
  }
  // A string that held a secret in a list item left a gap: drop the items the schema would refuse (no name, no label).
  for (const key of ['parameters', 'outputs', 'accounts', 'schedules'] as const) {
    const list = clean[key];
    if (Array.isArray(list)) clean[key] = list.filter((item) => item && typeof item === 'object' && Object.keys(item).length > 0);
  }
  return { patch: clean as TaskBuilderSpecPatch, dropped };
}
