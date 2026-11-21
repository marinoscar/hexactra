// The built-in store's own routes (E37.5, #594), beside Vault's (`/api/secrets`, `/api/secret-types`, mounted by the
// store module): its status for the owner, and the administrator's key rotation. NOTHING HERE RETURNS A KEY OR A
// SECRET VALUE.
import { Controller, Get, HttpCode, NotFoundException, Post } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { PrismaService } from '../../prisma/prisma.service';
import { SecretsPolicyService } from '../secrets-policy.service';
import { SecretsStoreKeys } from './store.data-keys';
import { SecretsStoreMaintainTask } from './store.maintenance';

const storeStatusSchema = z.object({
  enabled: z.literal(true),
  /** The provider the owner chose: `builtin` or `vault`. */
  provider: z.enum(['vault', 'builtin']),
  /** How many saved logins the owner has, and how many of them are open to the agent. */
  logins: z.number().int(),
  openToAgent: z.number().int(),
});
class StoreStatusResponseDto extends createZodDto(z.object({ data: storeStatusSchema })) {}

const rewrapSchema = z.object({ enqueued: z.literal(true), staleDataKeys: z.number().int(), previousKeyConfigured: z.boolean() });
class RewrapResponseDto extends createZodDto(z.object({ data: rewrapSchema })) {}

@ApiTags('Secrets')
@Controller()
export class SecretsStoreController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: SecretsPolicyService,
    private readonly keys: SecretsStoreKeys,
    private readonly maintain: SecretsStoreMaintainTask,
  ) {}

  @Get('secrets/store/status')
  @ApiDataResponse(StoreStatusResponseDto)
  @Auth({ permissions: ['secrets:read'] })
  @ApiOperation({ summary: 'Status of your built-in secrets store', description: 'Only present when the administrator switched the built-in store on (Administration → Secrets); otherwise 404. Which provider you chose, how many saved logins you have and how many are open to the agent. Never a value or a key.' })
  async status(@CurrentUser('id') userId: string) {
    // Switched off in Administration → Secrets (#711): the deployment does not offer the store, as if it were not mounted.
    if (!(await this.policy.storeEnabled())) throw new NotFoundException({ code: 'SECRETS_STORE_OFF', message: 'The built-in store is not switched on for this deployment.' });
    const [provider, logins, openToAgent] = await Promise.all([
      this.policy.activeProvider(userId),
      this.prisma.secret.count({ where: { createdById: userId } }),
      this.prisma.secret.count({ where: { createdById: userId, agentAccess: 'fill' } }),
    ]);
    return { enabled: true as const, provider, logins, openToAgent };
  }

  @Post('admin/secrets-store/rewrap')
  @HttpCode(202)
  @ApiDataResponse(RewrapResponseDto)
  @Auth({ permissions: ['system_settings:write'] })
  @ApiOperation({ summary: 'Re-wrap every owner’s data key under the current store key', description: 'Step of a store key rotation (docs/secrets.md): queues the upkeep job, which re-wraps data keys still wrapped under SECRETS_STORE_KEY_PREVIOUS. The values themselves are not touched. Returns how many are waiting.' })
  async rewrap() {
    await this.maintain.enqueue();
    return { enqueued: true as const, staleDataKeys: await this.keys.countStale(), previousKeyConfigured: this.keys.ring.previous !== null };
  }
}
