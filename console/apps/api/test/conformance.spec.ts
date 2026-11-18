// The platform's invariants, run against THIS app (`runPlatformConformance`).
// The package owns each scan; the app supplies only its own data. A suite
// that ships with a slice registers when its testing entry is imported, and
// runs only when this file gives it options: the suites of an OPTIONAL slice
// (`packages/shared/slices.json`) get theirs only while that slice is enabled.
import '@marinoscar/platform-api/identity/testing';
import '@marinoscar/platform-api/host/testing';
import '@marinoscar/platform-api/user-data/testing';
import '@marinoscar/platform-api/credentials/testing';
import '@marinoscar/platform-api/storage/testing';
import '@marinoscar/platform-api/email/testing';
import '@marinoscar/platform-api/notifications/testing';
import '@marinoscar/platform-api/sharing/testing';
import '@marinoscar/platform-api/ai/testing';
import '@marinoscar/platform-api/db-backup/testing';
import '@marinoscar/platform-api/exports/testing';
import '@marinoscar/platform-api/onboarding/testing';
import '@marinoscar/platform-api/android-app/testing';
import '@marinoscar/platform-api/telemetry/testing';

import { join } from 'node:path';
import {
  buildPermissionCatalog,
  catalogGrants,
  permissionRegistry,
  roleRegistry,
  userOwnedModelRegistry,
} from '@marinoscar/platform-api/core';
import { IS_PUBLIC_KEY } from '@marinoscar/platform-api/identity';
import { platformPermissionCatalog } from '@marinoscar/platform-api/manifest';
import { readSchemaDatamodel, runPlatformConformance } from '@marinoscar/platform-api/testing';
import { RAW_SQL_INDEXES } from '@marinoscar/platform-db';
import { Prisma } from '@prisma/client';

// Fills the registries: the platform's entries, then the app's.
import '../src/platform/registrations';
import { AppModule } from '../src/app.module';
import { PERMISSION_OPTIONS } from '../src/platform/permissions';
import { ALL_SLICES } from '../src/platform/slices/definitions';
import { isSliceEnabled } from '../src/platform/slices/manifest';

const SOURCE_ROOT = join(__dirname, '..', 'src');
const API_ROOT = join(__dirname, '..');
const WEB_SOURCE_ROOT = join(API_ROOT, '..', 'web', 'src');
const MANIFESTS = [join(API_ROOT, 'package.json'), join(API_ROOT, '..', 'web', 'package.json'), join(API_ROOT, '..', '..', 'package.json')];

/** The suites of the optional slices that are on. */
function sliceSuites() {
  return {
    ...(isSliceEnabled('credentials') ? { credentials: { appOwners: ['notes', 'fabric'] } } : {}),
    ...(isSliceEnabled('storage')
      ? { storage: { requiredPrefixIds: isSliceEnabled('db-backup') ? ['database-backups'] : [] } }
      : {}),
    ...(isSliceEnabled('email')
      ? { email: { samples: { 'org-invitation': { recipientEmail: 'guest@example.test', orgName: 'Org Kappa', roleName: 'viewer' }, 'notes-archived': { count: 2 } } } }
      : {}),
    ...(isSliceEnabled('notifications') ? { notifications: { afterCommitAllowlist: [] } } : {}),
    ...(isSliceEnabled('sharing')
      ? {
          sharing: {
            schemaPath: join(API_ROOT, 'prisma', 'schema'),
            migrationsDir: join(API_ROOT, 'prisma', 'migrations'),
            rootModule: AppModule,
            isPublic: (target: object) => Reflect.getMetadata(IS_PUBLIC_KEY, target) === true,
            groupOwnedModels: {},
            // The committed snapshot of the shareable resource types (platform/sharing/resource-types.ts: the sample `document`).
            // A type id is permanent once grants of it exist.
            resourceTypeIds: ['document'],
          },
        }
      : {}),
    ...(isSliceEnabled('ai')
      ? {
          // The five suites that boot the app (kill switch, RBAC matrix, secret egress, key policy, jobs
          // server-only) run in `ai-conformance.spec.ts`, over a mocked database; the two source scans are here.
          // No provider SDK anywhere in the app or the web (AI rule 1).
          aiNoSdkLeak: {
            apiTrees: [{ name: 'apps/api/src', root: SOURCE_ROOT, minFiles: 20 }],
            webTrees: [{ name: 'apps/web/src', root: WEB_SOURCE_ROOT, minFiles: 5 }],
            noSdkManifests: MANIFESTS,
          },
          aiOrchestrationBoundary: {
            apiSourceRoots: [SOURCE_ROOT],
            webSourceRoots: [WEB_SOURCE_ROOT],
            packageJsonPaths: MANIFESTS,
            allowedRoots: {},
            minApiFiles: 20,
          },
        }
      : {}),
    ...(isSliceEnabled('db-backup') ? { dbBackup: {} } : {}),
    ...(isSliceEnabled('exports')
      ? { exports: { datamodel: Prisma.dmmf.datamodel, permissions: permissionRegistry.list() } }
      : {}),
    ...(isSliceEnabled('onboarding')
      ? { onboarding: { permissions: permissionRegistry.list(), factSamples: { 'notes.noteCount': 0 }, minSteps: 3 } }
      : {}),
    ...(isSliceEnabled('android-app')
      ? { androidApp: { rawSqlIndexNames: RAW_SQL_INDEXES.map((index) => index.name) } }
      : {}),
    // The metric groups are the registry's: the platform's six plus the app's (`activity`), registered by
    // `TelemetryModule.forRoot` when AppModule is imported above. The slice's own cron lives in the package,
    // outside this app's source roots, so `cronSourceRoots` is left out.
    ...(isSliceEnabled('telemetry') ? { telemetry: {} } : {}),
  };
}

runPlatformConformance({
  sourceRoots: [SOURCE_ROOT],
  suites: {
    // Every @Cron only enqueues (CLAUDE.md queue rule 1). No exemption.
    cronEnqueueOnly: { exempt: [], minCronFiles: 1 },
    // Every foreign key to User in the composed schema (the platform's models
    // and the app's fragments) has a registry entry whose purge matches
    // onDelete: the platform's inventory and the app's, as registered.
    userOwnedData: {
      schemaPath: join(__dirname, '..', 'prisma', 'schema'),
      policies: userOwnedModelRegistry.list(),
      // The raw SQL of every slice's code that is in the tree, enabled or not
      // (the scan reads every file under src/), each argued (`ApiSlice.rawSql`).
      rawSqlAllowlist: [
        ...Object.values(ALL_SLICES).flatMap((slice) => slice.rawSql ?? []),
        // The app's own raw SQL, each argued.
        {
          file: 'tasks/runs.query.ts',
          why: 'The runs list (#420) reads the policy summary out of `runs.policy_snapshot` in SQL, so the snapshot never leaves the database, and settles a keyset cursor to the microsecond, which a JavaScript date cannot hold. Both statements are bound to `user_id = <the caller>`.',
        },
        {
          file: 'tasks/run-retention.service.ts',
          why: 'Run retention (#422) ranks a user\'s finished runs per task with a window function (ROW_NUMBER() OVER (PARTITION BY task_id)) to find those beyond the newest N, in one statement shared by the preview and the job. Every value is a bound parameter and the statement is bound to one `user_id`: the caller in the routes, the user being processed in the system job.',
        },
        {
          file: 'tasks/task-summary.service.ts',
          why: 'The task list filters and sorts on facts computed from schedules and runs, and the summaries and statistics aggregate runs per task (FILTER, DISTINCT ON, percentile_cont, days in a time zone): one statement each instead of one per task. Every statement binds the caller\'s `user_id`.',
        },
        {
          file: 'mcp/mcp.rate-limit.pg.ts',
          why: 'The shared rate limiter (#517) counts a hit in one statement so that several API processes never both take the last slot: an INSERT … ON CONFLICT DO UPDATE … WHERE on `rate_limit_windows` re-checks the limit under the row lock, which Prisma\'s upsert cannot express. The table holds bucket names (`grant:<id>`, `unauth:<address>`), no user-owned rows; every value is a bound parameter.',
        },
        {
          file: 'home/home.service.ts',
          why: 'The Home summary (#430) reads each block in one statement: a window count beside the limited rows, a task name joined on the same user, three named fields out of `runs.policy_snapshot` (the snapshot never leaves the database), and the week bucketed by day in a time zone. Every statement binds the caller\'s `user_id` (`owner_user_id` for questions) and joins only rows of that user.',
        },
      ],
      registerIn: 'src/notes/notes.ownership.ts (or your module\'s own *.ownership.ts)',
    },
    // Every route reachable from AppModule declares @Auth() or @Public(), and
    // every permission it names is one the seed writes.
    identity: {
      rootModule: AppModule,
      permissions: permissionRegistry.list(),
      roles: roleRegistry.list(),
      grants: catalogGrants(buildPermissionCatalog()),
      minRoutes: 4,
    },
    // The host core: exactly one APP_GUARD and it is the maintenance guard
    // (no global JWT guard), one PlatformHostCoreModule, the `{ data }`
    // envelope and the exception filter registered once.
    host: { rootModule: AppModule },
    // The OAuth server (#459): the MCP scopes name registered permissions, the `/api/mcp`
    // resource lists only them and owns its prefix alone, an `oat_` token is confined to it
    // and narrowed, session-only routes refuse it, and its 401 carries the challenge.
    oauthServer: {
      rootModule: AppModule,
      permissions: permissionRegistry.list().map((permission) => permission.id),
      secretEgress: { skip: 'it needs a real flow and a database: mcp-oauth.db.spec.ts runs checkOAuthSecretEgress over one' },
    },
    // Every user-owned model has a keep-or-delete decision in src/platform/user-data/user-data.manifest.ts.
    userData: { datamodel: readSchemaDatamodel(join(__dirname, '..', 'prisma', 'schema')) },
    ...sliceSuites(),
  },
});

// What the seed writes (`prisma/seed.ts` composes the catalog from the same
// options) is exactly what the registries hold.
describe('the seeded permission catalog', () => {
  it('equals the registries the app registered', () => {
    expect(platformPermissionCatalog(PERMISSION_OPTIONS)).toEqual(buildPermissionCatalog());
  });
});
