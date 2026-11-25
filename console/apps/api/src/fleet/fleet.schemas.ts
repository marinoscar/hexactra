import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { fabricUrlSchema } from '../fabric/fabric.schemas';

/** A fabric profile name: 1-32 of a-z, 0-9, '-', '_' (starting with a letter or digit). */
export const profileNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'Use 1-32 lowercase letters, digits, - and _');

export const createEnrollmentSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  /** The fabric URL as the new host reaches it, when it differs from the console's. */
  agentUrl: fabricUrlSchema.optional(),
  ttlMinutes: z.number().int().min(1).max(24 * 60).optional(),
});
export class CreateEnrollmentDto extends createZodDto(createEnrollmentSchema) {}

export const drainSchema = z.object({ enabled: z.boolean() });
export class DrainDto extends createZodDto(drainSchema) {}

export const createProfileSchema = z.object({ name: profileNameSchema });

/** `POST /api/fleet/hosts/:id/profiles/:name/show`: an https page to open (default: the Google sign-in). */
export const showProfileSchema = z.object({
  url: z.string().url().max(2048).refine((u) => /^https?:\/\//.test(u), 'url must be http(s)').optional(),
});
export class ShowProfileDto extends createZodDto(showProfileSchema) {}
export class CreateProfileDto extends createZodDto(createProfileSchema) {}

/** A host as the console shows it. */
export interface FleetHost {
  id: string;
  name: string;
  version: string;
  online: boolean;
  browserConnected: boolean;
  /** Launch mode: the host starts browsers itself and can manage profiles. */
  onDemand: boolean;
  draining: boolean;
  viewerUrl: string | null;
  /** unattended, attended or container; null for agents older than #336. */
  mode: 'unattended' | 'attended' | 'container' | null;
  /** The host can share its desktop through the fabric. */
  desktop: boolean;
  profiles: FleetProfile[];
  lastSeen: string;
}

/** A profile's identity sign-in state (E48, docs/decisions/profile-signin-health.md). */
export type FleetSigninState = 'signed_in' | 'signed_out' | 'expired' | 'unknown';

/** An account a profile is signed in to. The email is shown in full to `fleet:read`; never logged, traced or given to MCP. */
export interface FleetProfileAccount {
  provider: string;
  email: string;
  state: FleetSigninState;
}

/** A browser profile on a host, with its sign-in status. */
export interface FleetProfile {
  name: string;
  running: boolean;
  signin: FleetSigninState;
  accounts: FleetProfileAccount[];
  checkedAt: string | null;
}

/** What enrolling a host returns: shown once, never stored by the console. */
export interface FleetEnrollment {
  enrollmentToken: string;
  expiresAt: string | null;
  /** The fabric URL the new host uses (`<APP_URL>/fabric` for the bundled fabric). */
  agentUrl: string;
  command: string;
}

/** A host command's outcome. */
export interface FleetCommandResult {
  id: string;
  kind: string;
  profile: string | null;
  state: string;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

/**
 * `POST /api/fleet/hosts/:id/profiles/:name/signin` (E48.4). `keepLease`: when the session ends, keep the takeover lease and the
 * desktop session for the next profile on the same host (a "Fix sign-ins" queue, E48.6); the queue then starts the next profile's
 * sign-in, which adopts the lease the person already holds, and the last one is started without it (or the lease is released with
 * `DELETE /api/fleet/hosts/:id/takeover/:leaseId`).
 */
export const startProfileSigninSchema = z.object({ keepLease: z.boolean().optional() }).strict();
export class StartProfileSigninDto extends createZodDto(startProfileSigninSchema) {}

/** `POST /api/fleet/signin-sessions/:id/cancel`. `keepLease` overrides the session's own choice (a queue skipping a profile). */
export const cancelProfileSigninSchema = z.object({ keepLease: z.boolean().optional() }).strict();
export class CancelProfileSigninDto extends createZodDto(cancelProfileSigninSchema) {}

export type ProfileSigninStatus = 'started' | 'completed' | 'abandoned';

/**
 * A guided sign-in as its page polls it. `email` is read live from the host's profile status (shown to the person who started
 * it, who holds `fleet:desktop`); the console never stores, logs or traces it.
 */
export interface ProfileSigninView {
  id: string;
  hostId: string;
  profile: string;
  status: ProfileSigninStatus;
  /** While started: `waiting` for the person, or `saving` (the browser was closed; waiting for the offline check). Null once ended. */
  phase: 'waiting' | 'saving' | null;
  /** The takeover lease the session holds (null once released). */
  leaseId: string | null;
  keepLease: boolean;
  /** The profile's sign-in state now (unknown when the host could not be read). */
  signin: FleetSigninState;
  /** The signed-in account, while the profile reads signed in. */
  email: string | null;
  /** The state the profile was left in when the session completed. */
  resultState: FleetSigninState | null;
  /** Why an abandoned session ended. */
  endReason: 'cancelled' | 'timeout' | 'profile_gone' | 'replaced' | null;
  startedAt: string;
  /** When an unfinished session is abandoned. */
  expiresAt: string;
  endedAt: string | null;
}
