// OpenTelemetry bootstrap: the FIRST import of `main.ts`. Auto-instrumentation
// can only patch modules required AFTER `sdk.start()`, so nothing that loads
// Nest may come before this file. The bootstrap itself is
// `@marinoscar/platform-api/otel-core/sdk`, a Nest-free entry.
//
//   telemetry slice off, or OTEL_ENABLED !== 'true'   installs nothing; every instrument and span is the API's no-op
//   both on                                           OTLP/HTTP traces, metrics (every 60 s) and logs to
//                                                     OTEL_EXPORTER_OTLP_ENDPOINT, each behind the runtime gate,
//                                                     which starts CLOSED: nothing is exported until an administrator
//                                                     turns collection on at /admin/settings/telemetry
//
// Reads the slice list from `@app/shared` (plain CommonJS over `slices.json`),
// which loads nothing the auto-instrumentation patches.
import { APP_SLUG, ENABLED_SLICES } from '@app/shared';
import { DEFAULT_IGNORED_INCOMING_PATHS, initializeOtel, resolveServiceName, resolveTelemetryInstanceId } from '@marinoscar/platform-api/otel-core/sdk';

import { BENCHMARK_SITE_PATH_PREFIX } from './benchmark/site/site.paths';
import { CONNECTION_CALLBACK_PATH_PREFIX } from './connections/connections.paths';
import { VAULT_CALLBACK_PATH } from './secrets/secrets.paths';

export const sdk = ENABLED_SLICES.includes('telemetry')
  ? initializeOtel({
      serviceName: resolveServiceName(`${APP_SLUG}-api`),
      // The Vault and Connections OAuth callbacks carry `?code=&state=` in their URL: no span is made for them (E37.2, E39.2).
      // Nor for the benchmark challenge site, whose trial token is in the path of every page (E44.2).
      ignoreIncomingPaths: [...DEFAULT_IGNORED_INCOMING_PATHS, VAULT_CALLBACK_PATH, CONNECTION_CALLBACK_PATH_PREFIX, BENCHMARK_SITE_PATH_PREFIX],
      // The instance id the gate stamps until the telemetry settings are read: the app's slug.
      instanceId: resolveTelemetryInstanceId(null, APP_SLUG),
    })
  : null;
