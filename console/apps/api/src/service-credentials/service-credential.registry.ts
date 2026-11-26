// What may be stored as a service credential (E50.2, #972). A feature registers its references in `onModuleInit`; a write for an
// unregistered reference, or to a tier the registration does not name, is refused. `validate` checks the shape of a value only
// (length, characters) and never calls out: whether the service accepts the key is the feature's own test.
import { Injectable } from '@nestjs/common';

import { CREDENTIAL_TIERS, isServiceCredentialRef, storedName, type CredentialTier, type ServiceCredentialRef } from './service-credential.port';

/** A closed reason a value's shape is refused: lower-case snake case (`too_short`, `bad_characters`), never text from the value. */
export type ServiceCredentialProblem = string;

export const SERVICE_CREDENTIAL_PROBLEM_PATTERN = /^[a-z][a-z_]{0,39}$/;

export interface ServiceCredentialRegistration {
  ref: ServiceCredentialRef;
  /** What the owner sees: "Brave Search API key". */
  label: string;
  /** The tiers a key may be stored in; at least one. */
  tiers: readonly CredentialTier[];
  /** `null` when the value's shape is acceptable, else a closed reason. Never echoes the value. */
  validate(value: string): ServiceCredentialProblem | null;
}

/** A shape check most API keys pass: 8 to 512 printable ASCII characters, no spaces. */
export function apiKeyShape(value: string): ServiceCredentialProblem | null {
  if (value.length < 8) return 'too_short';
  if (value.length > 512) return 'too_long';
  if (!/^[\x21-\x7e]+$/.test(value)) return 'bad_characters';
  return null;
}

@Injectable()
export class ServiceCredentialRegistry {
  private readonly entries = new Map<string, ServiceCredentialRegistration>();

  /** Registers a reference. Throws on a malformed one or a duplicate (a programming error, which must fail at boot). */
  register(reg: ServiceCredentialRegistration): void {
    if (!isServiceCredentialRef(reg.ref)) throw new Error(`Service credential reference "${storedName(reg.ref)}" is malformed: service and name match ${String(/^[a-z][a-z0-9_]{0,39}$/)}`);
    if (!reg.label.trim()) throw new Error(`Service credential "${storedName(reg.ref)}" needs a label`);
    if (reg.tiers.length === 0 || reg.tiers.some((t) => !CREDENTIAL_TIERS.includes(t)) || new Set(reg.tiers).size !== reg.tiers.length) {
      throw new Error(`Service credential "${storedName(reg.ref)}" names no tier, an unknown tier or a tier twice`);
    }
    const key = storedName(reg.ref);
    if (this.entries.has(key)) throw new Error(`Service credential "${key}" is already registered`);
    this.entries.set(key, { ...reg, ref: { service: reg.ref.service, name: reg.ref.name }, tiers: CREDENTIAL_TIERS.filter((t) => reg.tiers.includes(t)) });
  }

  get(ref: ServiceCredentialRef): ServiceCredentialRegistration | null {
    if (!isServiceCredentialRef(ref)) return null;
    return this.entries.get(storedName(ref)) ?? null;
  }

  /** Every registration, ordered by service then name. */
  list(): ServiceCredentialRegistration[] {
    return [...this.entries.values()].sort((a, b) => storedName(a.ref).localeCompare(storedName(b.ref)));
  }

  /** The registered services: the bounded values of the `service` metric label. */
  services(): Set<string> {
    return new Set([...this.entries.values()].map((e) => e.ref.service));
  }
}
