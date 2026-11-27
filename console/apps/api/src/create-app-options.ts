// What `createApp` (src/main.ts) can be asked for. Its own file, so a unit test reads the rule without loading the app.
export interface CreateAppOptions {
  /** Build and mount the API reference. Default: yes, except in a test run that set `HEXACTRA_TEST_SKIP_DOCS=1`. */
  docs?: boolean;
}

/**
 * Whether `createApp` builds the API reference. `HEXACTRA_TEST_SKIP_DOCS=1` is read only under `NODE_ENV=test`
 * (Jest sets it), so it can never switch the reference off in a deployment; an explicit `docs` always wins.
 */
export function buildsApiReference(options: CreateAppOptions, env: NodeJS.ProcessEnv = process.env): boolean {
  if (options.docs !== undefined) return options.docs;
  return !(env.NODE_ENV === 'test' && env.HEXACTRA_TEST_SKIP_DOCS === '1');
}
