// What the owner hears about their AI apps (#464). Registered in the
// notification manifest (src/platform/notifications/notification.manifest.ts).
//
//   app.connected    an app was connected (a new OAuth grant): its scopes in
//                    words and "Not you? Disconnect". Mandatory: a new key to
//                    the account is a security notice. The platform's
//                    `mandatory` flag is per event, not per payload, so it is
//                    mandatory for every connection, not only for high-risk
//                    scopes.
//   app.scope_added  a step-up added a high-risk scope (drive the browser,
//                    JavaScript, the desktop, policies). Mandatory.
//   app.first_run    the first run an app started after it was connected. Off by default.
import type { BrowserNotificationTemplate, NotificationRegistration } from '@marinoscar/platform-api/notifications';

import { isSliceEnabled } from '../platform/slices/manifest';

/** Event keys. Permanent. */
export const APP_CONNECTED_EVENT = 'app.connected';
export const APP_SCOPE_ADDED_EVENT = 'app.scope_added';
export const APP_FIRST_RUN_EVENT = 'app.first_run';

const PUSH = isSliceEnabled('android-app') ? (['push', 'android_app'] as const) : (['push'] as const);

const str = (d: unknown, k: string) => (typeof (d as Record<string, unknown>)?.[k] === 'string' ? String((d as Record<string, unknown>)[k]) : '');
const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The app's page in the console: where "Disconnect" is. */
export function appLink(clientId: string): string {
  return clientId ? `/settings/ai-apps/${encodeURIComponent(clientId)}` : '/settings/ai-apps';
}

export const appConnectedTemplate: BrowserNotificationTemplate = (d) => ({
  title: `${str(d, 'appName') || 'An AI app'} was connected to your Hexactra account`,
  body: trim(`It may: ${str(d, 'scopes') || 'see your runs'}. Not you? Disconnect it.`, 180),
  link: appLink(str(d, 'clientId')),
});

export const appScopeAddedTemplate: BrowserNotificationTemplate = (d) => ({
  title: `${str(d, 'appName') || 'An AI app'} can now do more`,
  body: trim(`You allowed it to: ${str(d, 'added') || 'more'}. Not you? Disconnect it.`, 180),
  link: appLink(str(d, 'clientId')),
});

export const appFirstRunTemplate: BrowserNotificationTemplate = (d) => ({
  title: `${str(d, 'appName') || 'An AI app'} started a run`,
  body: trim(str(d, 'goal') || 'Open it to follow it.', 180),
  link: str(d, 'runId') ? `/runs/${encodeURIComponent(str(d, 'runId'))}` : '/runs',
});

export const CONNECTED_APPS_NOTIFICATIONS: readonly NotificationRegistration[] = [
  {
    event: {
      key: APP_CONNECTED_EVENT,
      label: 'An AI app was connected',
      description: 'ChatGPT, Claude or another AI app was connected to your account. Always sent: it is how you notice a connection you did not make.',
      channels: ['browser', ...PUSH],
      defaultEnabled: true,
      mandatory: true,
    },
    browserTemplate: appConnectedTemplate,
  },
  {
    event: {
      key: APP_SCOPE_ADDED_EVENT,
      label: 'An AI app can do more',
      description: 'A connected AI app was allowed to drive your browser, run JavaScript, control the desktop or change agent policies. Always sent.',
      channels: ['browser', ...PUSH],
      defaultEnabled: true,
      mandatory: true,
    },
    browserTemplate: appScopeAddedTemplate,
  },
  {
    event: {
      key: APP_FIRST_RUN_EVENT,
      label: 'An AI app started its first run',
      description: 'The first run a connected AI app starts after it was connected.',
      channels: ['browser', ...PUSH],
      defaultEnabled: false,
    },
    browserTemplate: appFirstRunTemplate,
  },
];
