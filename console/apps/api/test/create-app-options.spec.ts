// The rule for `createApp`'s API reference (#1043): the db tier may leave it out, a deployment never can.
import { buildsApiReference } from '../src/create-app-options';

describe('buildsApiReference', () => {
  it('builds the reference by default', () => {
    expect(buildsApiReference({}, {})).toBe(true);
    expect(buildsApiReference({}, { NODE_ENV: 'test' })).toBe(true);
  });

  it('leaves it out in a test run that set HEXACTRA_TEST_SKIP_DOCS=1', () => {
    expect(buildsApiReference({}, { NODE_ENV: 'test', HEXACTRA_TEST_SKIP_DOCS: '1' })).toBe(false);
  });

  it('ignores the switch outside a test run', () => {
    for (const NODE_ENV of ['production', 'development', undefined]) {
      expect(buildsApiReference({}, { NODE_ENV, HEXACTRA_TEST_SKIP_DOCS: '1' })).toBe(true);
    }
  });

  it('follows an explicit choice over the switch', () => {
    expect(buildsApiReference({ docs: true }, { NODE_ENV: 'test', HEXACTRA_TEST_SKIP_DOCS: '1' })).toBe(true);
    expect(buildsApiReference({ docs: false }, { NODE_ENV: 'production' })).toBe(false);
  });

  it('is what the db tier runs under', () => {
    // test/db-tier-jobs.setup.ts sets the switch for every spec file; Jest sets NODE_ENV.
    expect(buildsApiReference({})).toBe(false);
  });
});
