// Install and uninstall by mode, shared by `hexactra agent install|uninstall`
// and the TUI's wizards (#374), so both run exactly the same steps.
import { installAgent, installUnattended, uninstallAgent, uninstallUnattended, agentStatusInstalled, type AgentDeps, type UnattendedOptions } from './agent.js';
import type { InstallChoice } from './dependencies.js';
import { readUnattended } from './unattended.js';

/**
 * Installs what `choice` names. `both` installs the unattended node first,
 * then an attended host for the person's own Chrome. Returns one "done" line
 * per part.
 */
export async function installChoice(d: AgentDeps, choice: InstallChoice, o: UnattendedOptions): Promise<string[]> {
  const done: string[] = [];
  if (choice === 'unattended' || choice === 'both') {
    d.log('Installing an unattended node on this machine');
    const u = await installUnattended(d, o);
    done.push(`"${u.name}" is an unattended node. Open its desktop from Fleet to sign in to its profiles.`);
    if (choice === 'unattended') return done;
  }
  d.log('Installing the Hexactra agent on this machine');
  const s = await installAgent(d, { ...o, attended: choice === 'attended' || choice === 'both' ? true : o.attended });
  done.push(`"${s.name}" is a browser host. Create profiles for it on the Fleet page or with \`hexactra fleet profile create\`.`);
  return done;
}

/** What an uninstall removes. */
export type UninstallTarget = 'agent' | 'node' | 'both';

/** What is installed here that an uninstall can remove. */
export function uninstallTargets(d: Pick<AgentDeps, 'paths'>): UninstallTarget[] {
  const agent = agentStatusInstalled(d as AgentDeps);
  const node = !!readUnattended(d.paths.agentDir);
  return [...(agent ? (['agent'] as const) : []), ...(node ? (['node'] as const) : []), ...(agent && node ? (['both'] as const) : [])];
}

/** Removes the agent, the unattended node, or both. */
export async function uninstallTarget(
  d: AgentDeps,
  target: UninstallTarget,
  o: { keepHost?: boolean; purgeProfiles?: boolean; interactiveSudo?: boolean },
): Promise<void> {
  if (target === 'agent' || target === 'both') await uninstallAgent(d, o);
  if (target === 'node' || target === 'both') await uninstallUnattended(d, o);
}
