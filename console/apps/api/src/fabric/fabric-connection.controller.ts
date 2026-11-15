import { Body, Controller, Delete, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CredentialsService } from '@marinoscar/platform-api/credentials';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';

import { FabricClient, FabricError } from './fabric.client';
import { FABRIC_CREDENTIAL_PURPOSE, FABRIC_TOKEN_NAME, FABRIC_URL_NAME } from './fabric.credentials';
import { PutFabricConnectionDto, type FabricConnectionTest, type FabricConnectionView } from './fabric.schemas';

const PURPOSE = FABRIC_CREDENTIAL_PURPOSE.purpose;

/**
 * `/api/fabric/connection`: the Hexactra Fabric control plane this console
 * drives (URL plus an `hxs_` service token). The token is write-only: reads
 * return its hint and last change, never the value.
 */
@ApiTags('Fabric')
@Controller('fabric/connection')
export class FabricConnectionController {
  constructor(
    private readonly credentials: CredentialsService,
    private readonly fabric: FabricClient,
  ) {}

  @Get()
  @Auth({ permissions: ['fabric_config:read'] })
  async get(): Promise<FabricConnectionView> {
    const [url, token] = await Promise.all([
      this.credentials.getSecret(PURPOSE, FABRIC_URL_NAME),
      this.credentials.describe(PURPOSE, FABRIC_TOKEN_NAME),
    ]);
    return {
      configured: Boolean(url && token),
      url,
      token: token ? { hint: token.hint, updatedAt: token.updatedAt.toISOString() } : null,
    };
  }

  @Put()
  @Auth({ permissions: ['fabric_config:write'] })
  async put(@CurrentUser('id') userId: string, @Body() body: PutFabricConnectionDto): Promise<FabricConnectionView> {
    await this.credentials.setSecret(PURPOSE, FABRIC_URL_NAME, body.url.replace(/\/+$/, ''), {
      label: 'Fabric URL',
      updatedByUserId: userId,
    });
    if (body.token) {
      await this.credentials.setSecret(PURPOSE, FABRIC_TOKEN_NAME, body.token, {
        label: 'Fabric service token',
        updatedByUserId: userId,
      });
    }
    this.fabric.invalidate();
    return this.get();
  }

  @Delete()
  @HttpCode(204)
  @Auth({ permissions: ['fabric_config:write'] })
  async remove(): Promise<void> {
    await this.credentials.deleteSecret(PURPOSE, FABRIC_TOKEN_NAME);
    await this.credentials.deleteSecret(PURPOSE, FABRIC_URL_NAME);
    this.fabric.invalidate();
  }

  /** Probe the stored connection (health, then an authenticated host list). */
  @Post('test')
  @HttpCode(200)
  @Auth({ permissions: ['fabric_config:read'] })
  async test(): Promise<FabricConnectionTest> {
    const out: FabricConnectionTest = {
      reachable: false,
      authenticated: false,
      version: null,
      latencyMs: null,
      hosts: 0,
      onlineHosts: 0,
      error: null,
    };
    try {
      const started = Date.now();
      const health = await this.fabric.health();
      out.reachable = true;
      out.latencyMs = Date.now() - started;
      out.version = health.version ?? null;
      const hosts = await this.fabric.hosts();
      out.authenticated = true;
      out.hosts = hosts.length;
      out.onlineHosts = hosts.filter((h) => h.online).length;
    } catch (e) {
      out.error = e instanceof FabricError ? e.message : 'Unexpected error';
    }
    return out;
  }
}
