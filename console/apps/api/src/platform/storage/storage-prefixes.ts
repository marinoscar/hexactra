// The app's object-storage key prefixes. Declare every prefix a writer of this
// app uses, or `npm run storage:purge` (and the factory reset) leaves its
// objects in the bucket. A prefix is lowercase segments with exactly one
// trailing `/`, and must not overlap another registered prefix.
import type { StorageKeyPrefixDef } from '@marinoscar/platform-api/storage';

/**
 * The minimal example: where files attached to a note would live,
 * `note-attachments/<userId>/...`. Build a key with `buildObjectKey`, never by
 * hand. Delete it with the sample feature.
 */
export const NOTE_ATTACHMENTS_KEY_PREFIX: StorageKeyPrefixDef = {
  id: 'note-attachments',
  prefix: 'note-attachments/',
  owner: 'notes',
  scope: 'user',
  description: 'Files attached to a note, under note-attachments/<userId>/',
};

/** The masked trace screenshots of a run (#541), `runs/<userId>/<runId>/<seq>-<moment>.jpg`. Removed with the run. */
export const RUN_TRACE_KEY_PREFIX: StorageKeyPrefixDef = {
  id: 'run-traces',
  prefix: 'runs/',
  owner: 'runs',
  scope: 'user',
  description: 'Masked screenshots of the key moments of a run, under runs/<userId>/<runId>/',
};

/**
 * The video recordings of runs (epic #755), `run-recordings/<userId>/<runId>/part-NNNNN.hxr` while recording, then
 * `run-recordings/<userId>/<runId>/recording.webm`. NOT masked. Removed with the run and by the recordings retention job.
 */
export const RUN_RECORDING_KEY_PREFIX: StorageKeyPrefixDef = {
  id: 'run-recordings',
  prefix: 'run-recordings/',
  owner: 'recordings',
  scope: 'user',
  description: 'Video recordings of runs the owner chose to record (not masked), under run-recordings/<userId>/<runId>/',
};

/** Every prefix this app adds. Append here. */
export const APP_STORAGE_KEY_PREFIXES: readonly StorageKeyPrefixDef[] = [NOTE_ATTACHMENTS_KEY_PREFIX, RUN_TRACE_KEY_PREFIX, RUN_RECORDING_KEY_PREFIX];
