import type { TuiScreenRegistration } from '@marinoscar/platform-cli/tui';

/** The Fleet screen, loaded only when opened. */
export const fleetScreen: TuiScreenRegistration = {
  route: 'fleet',
  label: 'Fleet: hosts and profiles',
  order: 15,
  load: async () => (await import('./fleet.screen.js')).FleetScreen,
};
