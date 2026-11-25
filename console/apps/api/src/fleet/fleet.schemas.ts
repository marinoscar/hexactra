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
