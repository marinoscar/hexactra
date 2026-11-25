// The "profile not signed in" warning of a run start (E48.5, #931): the owner learns before the run hits a Google sign-in
// page that the profile it runs in is signed out (or its session expired). Only a warning: it never blocks, delays past
// its short deadline, or changes the run, and nothing here reaches the agent (its context and tools are unchanged).
import { Injectable, Logger } from '@nestjs/common';

import { FabricClient, FabricError } from '../fabric/fabric.client';
import { toHost } from './fleet.service';
import type { FleetHost } from './fleet.schemas';

export const PROFILE_NOT_SIGNED_IN = 'PROFILE_NOT_SIGNED_IN';

/** An additive note on a run start's response; the run itself is unchanged. */
export interface RunStartWarning {
  code: typeof PROFILE_NOT_SIGNED_IN;
  message: string;
  hostId: string;
  profile: string;
}

/** How long a run start waits for the fleet before it answers without a warning. */
export const SIGNIN_WARNING_DEADLINE_MS = 1_500;

const needsSignin = (s: string): boolean => s === 'signed_out' || s === 'expired';

/**
 * The warning for a run on `profile`: on the chosen machine when there is one, else when every available machine
 * that has the profile needs a sign-in (any available machine may take the run). An `unknown` state never warns.
 */
export function profileSigninWarnings(hosts: readonly FleetHost[], hostId: string | null, profile: string): RunStartWarning[] {
  const chosen = hostId ? hosts.find((h) => h.id === hostId) : undefined;
  const candidates = hostId ? (chosen ? [chosen] : []) : hosts.filter((h) => h.online && !h.draining && h.profiles.some((p) => p.name === profile));
  if (candidates.length === 0) return [];
  const states = candidates.map((h) => ({ host: h, p: h.profiles.find((p) => p.name === profile) }));
  if (!states.every((s) => s.p && needsSignin(s.p.signin))) return [];
  const { host, p } = states[0]!;
  const why = p!.signin === 'expired' ? 'its Google session expired' : 'it is signed out of Google';
  return [
    {
      code: PROFILE_NOT_SIGNED_IN,
      // Host and profile names only: the account's email is never in a warning.
      message: `This profile is not signed in to Google: "${profile}" on ${host.name} (${why}). The run starts anyway; a site that needs your Google account will stop at its sign-in page. Sign in from Fleet.`,
      hostId: host.id,
      profile,
    },
  ];
}

/** Reads the fleet for a run start's warning; any failure or a slow fabric gives no warning. */
@Injectable()
export class ProfileSigninWarnings {
  private readonly log = new Logger(ProfileSigninWarnings.name);

  constructor(private readonly fabric: FabricClient) {}

  async forRun(run: { hostId: string | null; profile: string }, deadlineMs = SIGNIN_WARNING_DEADLINE_MS): Promise<RunStartWarning[]> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const hosts = await Promise.race([
        this.fabric.hosts(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), deadlineMs);
          timer.unref?.();
        }),
      ]);
      if (!hosts) return [];
      return profileSigninWarnings(hosts.map(toHost), run.hostId, run.profile);
    } catch (e) {
      if (!(e instanceof FabricError && e.kind === 'not_configured')) this.log.debug(`no sign-in warning: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
