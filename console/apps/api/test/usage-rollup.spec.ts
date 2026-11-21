// The rollup windows of the AI usage rollups (#732), pure.
import { ROLLUP_CHUNK_HOURS, ROLLUP_REWIND_HOURS, floorHour, rollupWindows } from '../src/usage/usage-rollup.service';

const H = 3_600_000;
const t = (iso: string) => new Date(iso);

describe('floorHour', () => {
  it('truncates to the start of the UTC hour', () => {
    expect(floorHour(t('2026-11-21T10:59:59.999Z')).toISOString()).toBe('2026-11-21T10:00:00.000Z');
  });
});

describe('rollupWindows', () => {
  const now = t('2026-11-21T10:20:00Z');

  it('rolls nothing when the ledger is empty and nothing was rolled', () => {
    expect(rollupWindows(null, null, now)).toEqual([]);
  });

  it('starts at the hour of the first ledger row and stops before the current hour', () => {
    const w = rollupWindows(null, t('2026-11-21T07:45:00Z'), now);
    expect(w).toEqual([{ from: t('2026-11-21T07:00:00Z'), to: t('2026-11-21T10:00:00Z') }]);
  });

  it(`re-rolls the last ${ROLLUP_REWIND_HOURS} hours before the watermark`, () => {
    const w = rollupWindows(t('2026-11-21T10:00:00Z'), null, now);
    expect(w).toEqual([{ from: new Date(t('2026-11-21T10:00:00Z').getTime() - ROLLUP_REWIND_HOURS * H), to: t('2026-11-21T10:00:00Z') }]);
  });

  it(`splits a backfill into windows of at most ${ROLLUP_CHUNK_HOURS} hours, contiguous`, () => {
    const w = rollupWindows(null, t('2026-10-01T00:30:00Z'), now);
    expect(w.length).toBeGreaterThan(7);
    for (const x of w) expect(x.to.getTime() - x.from.getTime()).toBeLessThanOrEqual(ROLLUP_CHUNK_HOURS * H);
    for (let i = 1; i < w.length; i++) expect(w[i]!.from).toEqual(w[i - 1]!.to);
    expect(w.at(-1)!.to).toEqual(t('2026-11-21T10:00:00Z'));
  });
});
