// The object keys of a run recording (epic #755): `run-recordings/<userId>/<runId>/part-NNNNN.hxr` while it records, then
// `run-recordings/<userId>/<runId>/recording.webm`. Built with `buildObjectKey`, never by hand.
import { buildObjectKey } from '@marinoscar/platform-api/storage';

export const RECORDING_FILE = 'recording.webm';
export const RECORDING_CONTENT_TYPE = 'video/webm';
export const PART_CONTENT_TYPE = 'application/x-hexactra-recording';

export function partKey(userId: string, runId: string, n: number): string {
  return buildObjectKey('run-recordings', { userId }, runId, `part-${String(n).padStart(5, '0')}.hxr`);
}

export function recordingKey(userId: string, runId: string): string {
  return buildObjectKey('run-recordings', { userId }, runId, RECORDING_FILE);
}

/** Every key a recording may have: its parts (0 … partCount-1) and the finished file. */
export function recordingKeys(r: { userId: string; runId: string; partCount: number; objectKey: string | null }): string[] {
  const keys = Array.from({ length: r.partCount }, (_, n) => partKey(r.userId, r.runId, n));
  return r.objectKey ? [...keys, r.objectKey] : keys;
}
