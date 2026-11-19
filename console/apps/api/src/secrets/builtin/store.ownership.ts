// Ownership of the built-in store's tables (E37.5, #594).
//
// The tables are the Vault domain schema (`@marinoscar/vault-db`) plus `secrets_store_data_keys`. They exist in
// every deployment (the schema is composed statically), so these registrations are UNCONDITIONAL and import nothing
// of the Vault packages: with the slice off no Vault package code is loaded. `test/secrets-store.spec.ts` checks the
// model lists below against `@marinoscar/vault-api/core` so a package upgrade that adds a table fails a test here.
//
// DIFFERENCE FROM VAULT (deliberate): in Vault a secret survives its creator. In the console a user's secrets are
// DELETED with them. The schema's foreign key is Vault's (`created_by_id ... ON DELETE SET NULL`, a generated
// fragment we never edit), so the registry says `purge: 'detach'` (the conformance suite requires the policy to match
// the foreign key) while the user-data purge, which deletes every row that has an `ownerField` for the categories it
// runs (`saved-logins`, see user-data.manifest.ts), removes the secrets and, by cascade, their versions. A user row
// removed by some other path (a plain delete) would leave ownerless ciphertext whose data key is gone with the user:
// the store's maintenance job sweeps such rows (`SecretsStoreMaintenance`).
import type { ModelOwnershipDef, UserOwnedModelDef } from '@marinoscar/platform-api/core';

export type StoreModelName =
  | 'Secret'
  | 'SecretVersion'
  | 'SecretType'
  | 'SecretAttachment'
  | 'SecretsStoreDataKey'
  | 'MediaFolder'
  | 'MediaFolderFile'
  | 'BackupRun'
  | 'BackupSchedule'
  | 'AgentCardGrant'
  | 'AgentCardGrantRequest'
  | 'AgentCardRelease';

export const STORE_USER_OWNED_MODELS: readonly UserOwnedModelDef<StoreModelName>[] = [
  {
    model: 'Secret',
    ownerField: 'createdById',
    ownerRelation: 'createdBy',
    purge: 'detach',
    export: 'exclude',
    rationale: "A saved login belongs to the user who created it. The user-data purge deletes it with them (unlike Vault, where a secret survives its creator); the foreign key itself is Vault's SET NULL, hence 'detach' here and a sweep of ownerless rows. Values are ciphertext under the owner's data key and never leave in an export.",
  },
  {
    model: 'SecretVersion',
    actorFields: ['createdById'],
    purge: 'detach',
    export: 'exclude',
    rationale: 'An immutable ciphertext version: records who wrote it, removed with its secret (cascade), never exported.',
  },
  {
    model: 'SecretType',
    ownerField: 'createdById',
    ownerRelation: 'createdBy',
    purge: 'detach',
    export: 'exclude',
    rationale: 'Shared configuration: system types have no author; a custom type survives its author (created_by_id set null). Not used in the console beyond the Credential type.',
  },
  {
    model: 'SecretsStoreDataKey',
    ownerField: 'userId',
    purge: 'delete',
    export: 'exclude',
    rationale: "The owner's data key, wrapped under the deployment's store key. Deleted with the user (their secrets go with it); never exported: it is key material.",
  },
  // Tables of Vault slices that are not mounted in the console (media, backups, card grants). They exist because the
  // schema is Vault's; nothing writes them, but a row that ever referenced a user must still be purged.
  { model: 'MediaFolder', ownerField: 'userId', purge: 'delete', export: 'exclude', rationale: 'Vault media folders are not mounted in the console; any row is deleted with its user.' },
  { model: 'BackupRun', ownerField: 'ownerId', ownerRelation: 'owner', actorFields: ['triggeredById'], purge: 'delete', export: 'exclude', rationale: 'Vault backups are not mounted in the console; any row is deleted with its user.' },
  { model: 'BackupSchedule', actorFields: ['updatedById'], purge: 'detach', export: 'exclude', rationale: 'Vault backups are not mounted in the console; the singleton records an administrator.' },
  { model: 'AgentCardGrant', ownerField: 'userId', ownerRelation: 'user', purge: 'delete', export: 'exclude', rationale: 'Card grants (Vault cards) are not mounted in the console; any row is deleted with its user.' },
  { model: 'AgentCardGrantRequest', ownerField: 'userId', ownerRelation: 'user', purge: 'delete', export: 'exclude', rationale: 'Card grant requests are not mounted in the console; any row is deleted with its user.' },
];

export const STORE_MODEL_OWNERSHIP: readonly ModelOwnershipDef<StoreModelName>[] = [
  { model: 'Secret', kind: 'user', rationale: 'A saved login belongs to the user who created it.' },
  { model: 'SecretVersion', kind: 'user', rationale: "A version belongs to its secret, and so to the secret's owner." },
  { model: 'SecretAttachment', kind: 'user', rationale: "An attachment belongs to its secret version (attachments are not mounted in the console)." },
  { model: 'SecretType', kind: 'system', rationale: 'Shared secret-type definitions: system types are code-seeded.' },
  { model: 'SecretsStoreDataKey', kind: 'user', rationale: "One owner's wrapped data key." },
  { model: 'MediaFolder', kind: 'user', rationale: 'Not mounted in the console.' },
  { model: 'MediaFolderFile', kind: 'system', orgReference: 'orgId', rationale: 'Side table placing a storage object in a folder; org_id is half of the composite key to storage_objects. Not mounted in the console.' },
  { model: 'BackupSchedule', kind: 'system', rationale: 'Not mounted in the console.' },
  { model: 'BackupRun', kind: 'user', rationale: 'Not mounted in the console.' },
  { model: 'AgentCardGrant', kind: 'user', rationale: 'Not mounted in the console.' },
  { model: 'AgentCardGrantRequest', kind: 'user', rationale: 'Not mounted in the console.' },
  { model: 'AgentCardRelease', kind: 'user', rationale: 'Not mounted in the console.' },
];
