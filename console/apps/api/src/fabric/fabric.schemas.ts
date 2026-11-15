import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** An http(s) base URL without credentials, query or fragment. */
export const fabricUrlSchema = z
  .string()
  .trim()
  .max(2_000)
  .url()
  .refine((v) => {
    if (!URL.canParse(v)) return false;
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && !u.search && !u.hash;
  }, 'Use an http(s) URL without credentials, query or fragment');

/** `PUT /api/fabric/connection`. A blank token keeps the stored one. */
export const putFabricConnectionSchema = z.object({
  url: fabricUrlSchema,
  token: z.string().trim().max(512).optional(),
});
export class PutFabricConnectionDto extends createZodDto(putFabricConnectionSchema) {}

/** What `GET /api/fabric/connection` returns (never the token itself). */
export interface FabricConnectionView {
  configured: boolean;
  url: string | null;
  token: { hint: string | null; updatedAt: string } | null;
}

/** What `POST /api/fabric/connection/test` returns. */
export interface FabricConnectionTest {
  reachable: boolean;
  authenticated: boolean;
  version: string | null;
  latencyMs: number | null;
  hosts: number;
  onlineHosts: number;
  error: string | null;
}
