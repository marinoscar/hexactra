import type { TuiScreenRegistration } from '@marinoscar/platform-cli/tui';

/** The Inbox screen, loaded only when opened. */
export const inboxScreen: TuiScreenRegistration = {
  route: 'inbox',
  label: 'Inbox: agents waiting for you',
  order: 13,
  load: async () => (await import('./inbox.screen.js')).InboxScreen,
};
