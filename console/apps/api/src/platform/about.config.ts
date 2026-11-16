import { AboutModule, resolveApiVersion } from '@marinoscar/platform-api/host';

import { platformHost } from './host';

/**
 * `GET /api/admin/about` (the host slice's): the API version, the deployment
 * mode, the deploy record `hexactra deploy` leaves on disk and a database
 * liveness fact, plus the app's About contributors (`src/fabric/fabric.about.ts`).
 * Guarded by `system_settings:read`, the permission of the web app's About card.
 */
export const aboutModule = AboutModule.forRoot({
  apiVersion: () => resolveApiVersion(__dirname),
  host: platformHost,
});
