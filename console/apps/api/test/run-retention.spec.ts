// Run retention (#422): the pure parts of the rule.
import { effectiveRetentionRule, keepsEverything, retentionPreviewQuerySchema, salvageRetentionSettings } from '../src/tasks/run-retention.schemas';

describe('effectiveRetentionRule', () => {
  it('resolves the failed-run limit to keepDays when none is set', () => {
    expect(effectiveRetentionRule({ keepDays: 30, keepPerTask: 5, keepFailedDays: null }, null)).toEqual({ keepDays: 30, keepFailedDays: 30, keepPerTask: 5, capped: false });
    expect(effectiveRetentionRule({ keepDays: 30, keepPerTask: null, keepFailedDays: 60 }, null)).toEqual({ keepDays: 30, keepFailedDays: 60, keepPerTask: null, capped: false });
  });

  it('cuts "forever" and a longer limit down to the ceiling, and leaves a shorter one alone', () => {
    expect(effectiveRetentionRule({ keepDays: null, keepPerTask: null, keepFailedDays: null }, 180)).toEqual({ keepDays: 180, keepFailedDays: 180, keepPerTask: null, capped: true });
    expect(effectiveRetentionRule({ keepDays: 30, keepPerTask: null, keepFailedDays: 365 }, 180)).toEqual({ keepDays: 30, keepFailedDays: 180, keepPerTask: null, capped: true });
    expect(effectiveRetentionRule({ keepDays: 30, keepPerTask: 3, keepFailedDays: null }, 180)).toMatchObject({ keepDays: 30, keepFailedDays: 30, capped: false });
  });

  it('keeps everything only without any limit', () => {
    expect(keepsEverything(effectiveRetentionRule({ keepDays: null, keepPerTask: null, keepFailedDays: null }, null))).toBe(true);
    expect(keepsEverything(effectiveRetentionRule({ keepDays: null, keepPerTask: 1, keepFailedDays: null }, null))).toBe(false);
    expect(keepsEverything(effectiveRetentionRule({ keepDays: null, keepPerTask: null, keepFailedDays: 5 }, null))).toBe(false);
    expect(keepsEverything(effectiveRetentionRule({ keepDays: null, keepPerTask: null, keepFailedDays: null }, 10))).toBe(false);
  });
});

describe('salvageRetentionSettings', () => {
  it('reads an absent namespace as the defaults, never chosen', () => {
    expect(salvageRetentionSettings(undefined)).toEqual({ keepDays: 90, keepPerTask: null, keepFailedDays: null, noticeSentAt: null });
  });

  it('keeps an explicit null (forever) and replaces only the invalid fields', () => {
    expect(salvageRetentionSettings({ keepDays: null, keepPerTask: 'many', keepFailedDays: 400, noticeSentAt: '2026-03-01T03:20:00.000Z' })).toEqual({
      keepDays: null,
      keepPerTask: null,
      keepFailedDays: 400,
      noticeSentAt: '2026-03-01T03:20:00.000Z',
    });
  });
});

describe('the preview query', () => {
  it('reads an empty or absent limit as none, and a number as a number', () => {
    expect(retentionPreviewQuerySchema.parse({ keepDays: '30', keepPerTask: '' })).toEqual({ keepDays: 30, keepPerTask: null, keepFailedDays: null });
  });

  it('refuses a value outside the range', () => {
    for (const bad of [{ keepDays: '0' }, { keepDays: '3651' }, { keepPerTask: '10001' }, { keepFailedDays: 'x' }]) expect(retentionPreviewQuerySchema.safeParse(bad).success).toBe(false);
  });
});
