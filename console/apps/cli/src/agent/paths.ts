import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where `hexactra agent` keeps things on this machine (XDG layout, no root):
 * the agent bundles and Chrome for Testing under the data directory, the host
 * credential where `hexactra-agent` reads it (`$XDG_CONFIG_HOME/hexactra`),
 * and a systemd user unit.
 */
export interface AgentPaths {
  root: string;
  agentDir: string;
  versionsDir: string;
  /** Symlink to the active bundle; the unit runs through it, so an update is a swap and a restart. */
  current: string;
  state: string;
  chromeDir: string;
  profilesDir: string;
  configDir: string;
  credential: string;
  hostIdFile: string;
  unitDir: string;
  unit: string;
}

export const UNIT_NAME = 'hexactra-agent.service';

export function agentPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): AgentPaths {
  const data = env.XDG_DATA_HOME || join(home, '.local', 'share');
  const config = env.XDG_CONFIG_HOME || join(home, '.config');
  const root = join(data, 'hexactra');
  const agentDir = join(root, 'agent');
  const configDir = join(config, 'hexactra');
  const unitDir = join(config, 'systemd', 'user');
  return {
    root,
    agentDir,
    versionsDir: join(agentDir, 'versions'),
    current: join(agentDir, 'current'),
    state: join(agentDir, 'install.json'),
    chromeDir: join(root, 'chrome'),
    profilesDir: join(root, 'profiles'),
    configDir,
    credential: join(configDir, 'host-credential.json'),
    hostIdFile: join(configDir, 'host-id'),
    unitDir,
    unit: join(unitDir, UNIT_NAME),
  };
}
