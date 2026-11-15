import type { TuiScreenRegistration } from '@marinoscar/platform-cli/tui';

/** The Runs screen, loaded only when opened. */
export const runsScreen: TuiScreenRegistration = {
  route: 'runs',
  label: 'Runs: watch browser agents',
  order: 14,
  load: async () => (await import('./runs.screen.js')).RunsScreen,
};
