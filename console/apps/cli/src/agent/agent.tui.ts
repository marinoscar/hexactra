import type { TuiScreenRegistration } from '@marinoscar/platform-cli/tui';

/** The Agent screen (this machine as a browser host), loaded only when opened. */
export const agentScreen: TuiScreenRegistration = {
  route: 'agent',
  label: 'Agent: this machine as a browser host (dashboard, install, logs, doctor)',
  order: 16,
  load: async () => (await import('./agent.screen.js')).AgentScreen,
};
