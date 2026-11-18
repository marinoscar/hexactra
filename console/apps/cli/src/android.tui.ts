import { androidTuiScreen } from '@marinoscar/platform-cli/android';
import type { TuiScreenRegistration } from '@marinoscar/platform-cli/tui';

/** The platform's Android screen behind this app's folder check (#478), loaded only when opened. */
export const androidScreen: TuiScreenRegistration = {
  ...androidTuiScreen,
  load: async () => (await import('./android.screen.js')).AndroidGateScreen,
};
