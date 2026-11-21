// The deployment-wide benchmark settings (E44, epic #738), system settings namespace `benchmark` (Administrator,
// `system_settings:write`; the API and the CLI set them, the page arrives with the benchmark pages):
//   siteBaseUrl          where a node's browser reaches the challenge site. Empty: the console's public URL plus `/benchmark`.
//   defaultTrials        attempts per challenge and policy when a benchmark does not say (3)
//   defaultCapUsd        the spend cap of a benchmark that does not set one, in USD (5)
//   trialTimeoutMinutes  how long one trial may take before it is closed as timed out (15)
// Registered before `SettingsModule.forRoot()` composes the request bodies (the import in src/platform/platform.ts). Readers use
// `SystemSettingsService.getNamespace('benchmark')`: the stored value, salvaged field by field, or the defaults.
import { registerSystemSettingsNamespaces, type SystemSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

export const BENCHMARK_LIMITS = { maxTrials: 10, maxCapUsd: 1000, maxTrialTimeoutMinutes: 120 } as const;

function isSiteBaseUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
}

/** Empty, or an absolute http(s) URL with no query, fragment or credentials. A trailing slash is dropped. */
const siteBaseUrlSchema = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === '' || isSiteBaseUrl(v), { message: 'Must be empty or an http(s) URL without a query, a fragment or credentials' })
  .transform((v) => v.replace(/\/+$/, ''));

/** The stored document: every value present. */
export const benchmarkSettingsSchema = z.object({
  siteBaseUrl: siteBaseUrlSchema,
  defaultTrials: z.number().int().min(1).max(BENCHMARK_LIMITS.maxTrials),
  defaultCapUsd: z.number().positive().max(BENCHMARK_LIMITS.maxCapUsd),
  trialTimeoutMinutes: z.number().int().min(1).max(BENCHMARK_LIMITS.maxTrialTimeoutMinutes),
});
export type BenchmarkSettings = z.infer<typeof benchmarkSettingsSchema>;
/** A write: any subset. */
export const benchmarkSettingsPatchSchema = benchmarkSettingsSchema.partial();
type BenchmarkSettingsPatch = z.infer<typeof benchmarkSettingsPatchSchema>;

export const DEFAULT_BENCHMARK_SETTINGS: BenchmarkSettings = { siteBaseUrl: '', defaultTrials: 3, defaultCapUsd: 5, trialTimeoutMinutes: 15 };

/** A stored or patched value over the defaults. */
export function resolveBenchmarkSettings(v: BenchmarkSettingsPatch | null | undefined): BenchmarkSettings {
  return {
    siteBaseUrl: v?.siteBaseUrl ?? DEFAULT_BENCHMARK_SETTINGS.siteBaseUrl,
    defaultTrials: v?.defaultTrials ?? DEFAULT_BENCHMARK_SETTINGS.defaultTrials,
    defaultCapUsd: v?.defaultCapUsd ?? DEFAULT_BENCHMARK_SETTINGS.defaultCapUsd,
    trialTimeoutMinutes: v?.trialTimeoutMinutes ?? DEFAULT_BENCHMARK_SETTINGS.trialTimeoutMinutes,
  };
}

/**
 * The base URL of the challenge site, without a trailing slash: the setting, or the console's public URL plus `/benchmark` (the nginx
 * overlay). A trial's pages are under `<base>/t/<token>/`.
 */
export function benchmarkSiteBaseUrl(settings: Pick<BenchmarkSettings, 'siteBaseUrl'>, consolePublicUrl: string): string {
  return settings.siteBaseUrl || `${consolePublicUrl.replace(/\/+$/, '')}/benchmark`;
}

export const BENCHMARK_SYSTEM_SETTINGS = {
  key: 'benchmark',
  description: "Benchmarks: the challenge site's base URL (empty: the console's public URL plus /benchmark), the default trials per challenge and policy, the default spend cap (USD) and the time one trial may take (minutes).",
  storedSchema: benchmarkSettingsSchema,
  patchSchema: benchmarkSettingsPatchSchema,
  putSchema: benchmarkSettingsSchema,
  wirePatchSchema: benchmarkSettingsPatchSchema,
  responseSchema: benchmarkSettingsSchema,
  defaults: { ...DEFAULT_BENCHMARK_SETTINGS },
  requiredOnPut: false,
  // The platform calls every namespace's merge on every settings write: no patch for this one is the current value.
  merge: (current, patch) => resolveBenchmarkSettings({ ...(current as BenchmarkSettingsPatch | undefined), ...(patch as BenchmarkSettingsPatch | undefined) }),
} satisfies SystemSettingsNamespace<'benchmark', BenchmarkSettings, BenchmarkSettingsPatch>;

registerSystemSettingsNamespaces([BENCHMARK_SYSTEM_SETTINGS as unknown as SystemSettingsNamespace]);

// Types `SystemSettingsService.getNamespace('benchmark')` as `BenchmarkSettings`.
declare module '@marinoscar/platform-api/settings' {
  interface SystemSettingsNamespaces {
    benchmark: BenchmarkSettings;
  }
}
