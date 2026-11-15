// The Web Push service worker (the notifications slice). Built from this file
// by `vite.config.ts` into /sw.js and registered by the notifications slice's
// `setup()`; it exists only while the slice is enabled.
//
// It does exactly what a push needs and nothing else: show the notification the
// API pushed (ALWAYS: a push that shows nothing makes Chrome print "updated in
// the background"), hand a click to an open page or open one with the
// notification's id in `?n=`, and resubscribe when the browser rotates the
// subscription. It never calls the API (it holds no token) and never caches the
// app: add precaching here (workbox) if you want an offline shell.
//
// Import the handlers from `/service-worker`, never from the `/headless` barrel:
// the barrel pulls React in, which a worker cannot load.
import {
  handleNotificationClick,
  handlePushEvent,
  handlePushSubscriptionChange,
  type NotificationsClickEvent,
  type NotificationsExtendableEvent,
  type NotificationsPushEvent,
  type NotificationsPushSubscriptionChangeEvent,
  type NotificationsServiceWorkerScope,
} from '@marinoscar/platform-web/notifications/service-worker';

import { handleActionClick, withRunRenotify, type ActionClickEvent, type ActionScope } from './notificationActions';

/** The members of the worker's global scope this file uses beyond the handlers'. */
type WorkerScope = NotificationsServiceWorkerScope & {
  skipWaiting(): Promise<void>;
  readonly clients: NotificationsServiceWorkerScope['clients'] & { claim(): Promise<void> };
};

const scope = self as unknown as WorkerScope;

// A new worker takes over at once, so a fixed handler reaches every open tab.
scope.addEventListener('install', () => void scope.skipWaiting());
scope.addEventListener('activate', (event: NotificationsExtendableEvent) => event.waitUntil(scope.clients.claim()));

// PNGs: Android (the app's delegated notifications and Chrome) ignores SVG
// icons. The badge is a white glyph on transparency, as Android draws it.
const ICONS = { icon: '/icons/icon-192.png', badge: '/icons/badge-96.png' };

// The platform's three listeners, with one addition on click: the buttons of a
// "needs you" notification (Stop run, Approve, Remind me in 15 min) act without opening the app
// (./notificationActions.ts); every other click opens the notification's link.
scope.addEventListener('notificationclick', (event: NotificationsClickEvent) => {
  if (handleActionClick(scope as unknown as ActionScope, event as unknown as ActionClickEvent, fetch, ICONS)) return;
  handleNotificationClick(scope, event);
});
// A pushed notification that replaces one of the same run alerts again (renotify).
const pushScope = withRunRenotify(scope);
scope.addEventListener('push', (event: NotificationsPushEvent) => event.waitUntil(handlePushEvent(pushScope, event, ICONS)));
scope.addEventListener('pushsubscriptionchange', (event: NotificationsPushSubscriptionChangeEvent) => event.waitUntil(handlePushSubscriptionChange(scope, event)));
