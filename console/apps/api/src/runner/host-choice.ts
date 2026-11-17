import type { FabricHost } from '../fabric/fabric.client';

/** Where a run's browser session goes (#384). */
export type HostChoice =
  | { kind: 'host'; hostId: string | null; note?: string }
  | { kind: 'fail'; error: string };

/** Why a host cannot take a new run now, or null when it can. */
export function unavailableReason(h: FabricHost | undefined): string | null {
  if (!h) return 'is no longer in the fleet';
  if (h.draining) return 'is disabled';
  if (!h.online) return 'is offline';
  if (!h.browser_connected && !h.on_demand) return 'has no browser connected';
  return null;
}

/**
 * The run's chosen host when it can take the run. Otherwise, with fallback
 * on, no host (the fabric picks an available one, home nodes first) and a
 * note for the run log; with fallback off, a failure naming the host and why.
 * A run without a chosen host lets the fabric pick.
 */
export function chooseHost(hosts: FabricHost[], hostId: string | null, fallback: boolean): HostChoice {
  if (!hostId) return { kind: 'host', hostId: null };
  const h = hosts.find((x) => x.id === hostId);
  const why = unavailableReason(h);
  if (!why) return { kind: 'host', hostId };
  const name = h?.name ?? hostId.slice(0, 8);
  if (fallback) return { kind: 'host', hostId: null, note: `${name} ${why}; running on another available machine.` };
  return { kind: 'fail', error: `${name} ${why}, and this task does not fall back to another machine.` };
}
