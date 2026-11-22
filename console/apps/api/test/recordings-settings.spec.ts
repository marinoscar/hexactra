// E45.3 (#758): the `recordings` system settings namespace: 30 days and 60
// minutes by default, `keepDays: null` keeps recordings indefinitely, and a
// stored value is salvaged field by field.
import { composeDefaultSystemSettings, composePatchSystemSettingsSchema, systemSettingsNamespaceRegistry } from '@marinoscar/platform-api/settings';

import '../src/platform/platform';
import { RECORDINGS_SETTINGS_DEFAULTS, readRecordingsSettings, recordingExpiresAt } from '../src/recordings/recordings.settings';

describe('recordings settings (#758)', () => {
  it('registers the namespace with 30 days and 60 minutes by default', () => {
    expect(systemSettingsNamespaceRegistry.ids()).toContain('recordings');
    expect(composeDefaultSystemSettings()).toMatchObject({ recordings: { keepDays: 30, maxMinutes: 60 } });
  });

  it('accepts a limit or null (keep indefinitely), and refuses a bad value', () => {
    const schema = composePatchSystemSettingsSchema();
    expect(schema.parse({ recordings: { keepDays: 7 } })).toEqual({ recordings: { keepDays: 7 } });
    expect(schema.parse({ recordings: { keepDays: null } })).toEqual({ recordings: { keepDays: null } });
    for (const bad of [{ keepDays: 0 }, { keepDays: 3651 }, { keepDays: 1.5 }, { maxMinutes: 0 }, { maxMinutes: 481 }]) {
      expect(schema.safeParse({ recordings: bad }).success).toBe(false);
    }
  });

  it('merges a patch over the defaults and keeps null', () => {
    const ns = systemSettingsNamespaceRegistry.get('recordings')!;
    expect(ns.merge(undefined, { keepDays: null })).toEqual({ keepDays: null, maxMinutes: 60 });
    expect(ns.merge({ keepDays: null, maxMinutes: 60 }, { maxMinutes: 15 })).toEqual({ keepDays: null, maxMinutes: 15 });
  });

  it('salvages a stored value field by field', () => {
    expect(readRecordingsSettings(undefined)).toEqual(RECORDINGS_SETTINGS_DEFAULTS);
    expect(readRecordingsSettings({ keepDays: null })).toEqual({ keepDays: null, maxMinutes: 60 });
    expect(readRecordingsSettings({ keepDays: 'soon', maxMinutes: 10 })).toEqual({ keepDays: 30, maxMinutes: 10 });
    expect(readRecordingsSettings({ keepDays: 90, maxMinutes: -1 })).toEqual({ keepDays: 90, maxMinutes: 60 });
  });

  it('computes when a recording expires, or never', () => {
    const at = new Date('2026-11-01T00:00:00Z');
    expect(recordingExpiresAt(at, 30)?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(recordingExpiresAt(at, null)).toBeNull();
  });
});
