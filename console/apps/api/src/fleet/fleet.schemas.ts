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
  profiles: { name: string; running: boolean }[];
  lastSeen: string;
}

/** What enrolling a host returns: shown once, never stored by the console. */
export interface FleetEnrollment {
  enrollmentToken: string;
  expiresAt: string | null;
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
