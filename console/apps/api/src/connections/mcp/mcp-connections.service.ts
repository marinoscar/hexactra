// Adding and maintaining MCP server connections (E39.9, #606). A connection is `provider: mcp`; its address and the KIND of sign-in are
// in `config`, its secrets in the credential store. Adding a server tests it first (initialise and list the tools with the sign-in given)
// and stores nothing unless it answered: a server that cannot be reached, answers in another protocol or wants a different sign-in leaves
// no connection, no secret and no tool behind. Every tool starts `off`.
import { Injectable, Logger } from '@nestjs/common';
import type { Connection } from '@prisma/client';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { MAX_CONNECTIONS_PER_USER, MAX_LABEL_LENGTH } from '../connections.constants';
import { ConnectionError } from '../connections.errors';
import { CONNECTION_AUDIT, ConnectionEvents } from '../connections.events';
import { uniqueLabel } from '../connection-labels';
import { McpClientError } from './mcp-client';
import { McpCatalogService, type McpCatalog } from './mcp-catalog.service';
import { readMcpConfig, type McpConfig } from './mcp-config';
import { McpConnector, disabledError, toConnectionError } from './mcp-connector.service';
import { McpOAuthService } from './mcp-oauth.service';
import { McpSecretStore } from './mcp-secrets';
import { accountIdOf, hostLabel } from './mcp-account';
import { normalizeMcpUrl, urlError, McpUrlError } from './mcp-url';
import type { StartResult } from '../connection-flow.service';
import { ConnectionTokenStore } from '../connection-token.store';

export type McpAuthInput =
  | { kind: 'none' }
  | { kind: 'bearer'; token: string }
  | { kind: 'header'; header: string; value: string }
  | { kind: 'oauth'; clientId?: string | null; clientSecret?: string | null };

export interface AddMcpInput {
  url: string;
  label?: string | null;
  auth: McpAuthInput;
  returnTo?: string | null;
}

export type AddMcpResult = { connection: Connection; catalog: McpCatalog; consent: null } | { connection: null; catalog: null; consent: StartResult };

@Injectable()
export class McpConnectionsService {
  private readonly log = new Logger(McpConnectionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connector: McpConnector,
    private readonly catalog: McpCatalogService,
    private readonly oauth: McpOAuthService,
    private readonly secrets: McpSecretStore,
    private readonly tokens: ConnectionTokenStore,
    private readonly events: ConnectionEvents,
  ) {}

  private url(raw: string): string {
    try {
      return normalizeMcpUrl(raw);
    } catch (e) {
      if (e instanceof McpUrlError) throw new ConnectionError('CONNECTION_MCP_URL_REFUSED', e.message, { reason: e.code });
      throw e;
    }
  }

  /** The static headers an auth input gives (nothing for `none` and `oauth`). */
  private staticHeaders(auth: McpAuthInput): Record<string, string> {
    if (auth.kind === 'bearer') return { authorization: `Bearer ${auth.token}` };
    if (auth.kind === 'header') return { [auth.header.toLowerCase()]: auth.value };
    return {};
  }

  async add(userId: string, input: AddMcpInput): Promise<AddMcpResult> {
    if (!(await this.connector.enabled())) throw disabledError();
    const url = this.url(input.url);
    await this.connector.checkAddress(url);
    const accountId = accountIdOf(url);
    const mine = await this.prisma.connection.findMany({ where: { userId }, select: { label: true, provider: true, accountId: true } });
    if (mine.length >= MAX_CONNECTIONS_PER_USER) throw new ConnectionError('CONNECTION_LIMIT', 'You already have the most connections allowed: remove one first.');
    if (mine.some((c) => c.provider === 'mcp' && c.accountId === accountId)) throw new ConnectionError('CONNECTION_MCP_EXISTS', 'You already have a connection to this server.');
    const wanted = input.label?.trim();
    if (wanted && mine.some((c) => c.label.toLowerCase() === wanted.toLowerCase())) throw new ConnectionError('CONNECTION_LABEL_TAKEN', 'You already have a connection with this name.');

    if (input.auth.kind === 'oauth') {
      const consent = await this.oauth.start(userId, { url, label: wanted, clientId: input.auth.clientId, clientSecret: input.auth.clientSecret, returnTo: input.returnTo });
      return { connection: null, catalog: null, consent };
    }

    // Test it first: nothing is stored unless the server answered with the sign-in given.
    const headers = this.staticHeaders(input.auth);
    const client = await this.connector.openWith(url, async () => headers).catch((e: unknown) => {
      throw toConnectionError(e);
    });
    let listed;
    try {
      listed = await client.listTools();
    } catch (e) {
      throw toConnectionError(e);
    } finally {
      await client.close();
    }
    const label = uniqueLabel((wanted || hostLabel(url)).slice(0, MAX_LABEL_LENGTH), mine.map((c) => c.label));
    const config: McpConfig = { url, auth: input.auth.kind === 'header' ? { kind: 'header', header: input.auth.header } : { kind: input.auth.kind } };
    let row: Connection;
    try {
      row = await this.prisma.connection.create({ data: { userId, provider: 'mcp', accountId, accountEmail: new URL(url).hostname.slice(0, 300), accountName: client.serverInfo.name?.slice(0, 200) ?? null, label, capabilities: [], grantedScopes: [], status: 'active', config: config as Prisma.InputJsonValue } });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new ConnectionError('CONNECTION_MCP_EXISTS', 'You already have a connection to this server.');
      throw e;
    }
    try {
      if (input.auth.kind === 'bearer') await this.secrets.setSecret(userId, row.id, input.auth.token);
      if (input.auth.kind === 'header') await this.secrets.setSecret(userId, row.id, input.auth.value);
      await this.catalog.storeFirst(row, config, listed.tools, { name: client.serverInfo.name, version: client.serverInfo.version, instructions: client.serverInfo.instructions, protocolVersion: client.protocolVersion });
    } catch (e) {
      await this.secrets.clear(userId, row.id).catch(() => undefined);
      await this.prisma.connection.deleteMany({ where: { id: row.id } });
      throw e;
    }
    await this.events.audit(userId, CONNECTION_AUDIT.mcpAdded, row.id, { provider: 'mcp', auth: input.auth.kind, tools: listed.tools.length });
    this.events.count('mcp', 'connected');
    const fresh = (await this.prisma.connection.findFirst({ where: { id: row.id } })) ?? row;
    return { connection: fresh, catalog: await this.catalog.list(userId, row.id), consent: null };
  }

  /**
   * Gives a connection a new sign-in: a new token or header value (tested first), or, for OAuth, a new consent. How a connection that
   * `needs_reconnect` (the server refused its sign-in) comes back.
   */
  async reconnect(userId: string, id: string, auth: McpAuthInput, returnTo?: string | null): Promise<{ connection: Connection; consent: StartResult | null }> {
    if (!(await this.connector.enabled())) throw disabledError();
    const row = await this.connector.mine(userId, id);
    if (!row) throw new ConnectionError('CONNECTION_NOT_FOUND', 'Connection not found');
    const cfg = readMcpConfig(row.config);
    if (!cfg) throw new ConnectionError('CONNECTION_UNAVAILABLE', 'This is not an MCP connection.', { reason: 'config' });
    if (auth.kind === 'oauth') {
      const consent = await this.oauth.start(userId, { url: cfg.url, label: row.label, clientId: auth.clientId, clientSecret: auth.clientSecret, returnTo, connectionId: row.id });
      return { connection: row, consent };
    }
    const headers = this.staticHeaders(auth);
    const client = await this.connector.openWith(cfg.url, async () => headers).catch((e: unknown) => {
      throw toConnectionError(e, row.label);
    });
    await client.close();
    if (auth.kind === 'bearer') await this.secrets.setSecret(userId, row.id, auth.token);
    if (auth.kind === 'header') await this.secrets.setSecret(userId, row.id, auth.value);
    const next: McpConfig = { ...cfg, auth: auth.kind === 'header' ? { kind: 'header', header: auth.header } : { kind: auth.kind } };
    const updated = await this.prisma.connection.update({ where: { id: row.id }, data: { config: next as Prisma.InputJsonValue, status: 'active', statusReason: null, reconnectNotifiedAt: null } });
    await this.events.audit(userId, CONNECTION_AUDIT.updated, row.id, { provider: 'mcp', auth: auth.kind, change: 'reconnected' });
    this.events.count('mcp', 'reconnected');
    return { connection: updated, consent: null };
  }

  /** `POST /connections/:id/test` for a server: it answers `initialize`, and its tools list. Nothing is stored or changed. */
  async test(userId: string, row: Connection): Promise<void> {
    const { client } = await this.connector.open(row).catch((e: unknown) => {
      throw toConnectionError(e, row.label);
    });
    try {
      await client.listTools();
    } catch (e) {
      if (e instanceof McpClientError && e.kind === 'auth') await this.prisma.connection.updateMany({ where: { id: row.id, status: 'active' }, data: { statusReason: 'AUTH_REFUSED' } });
      throw toConnectionError(e, row.label);
    } finally {
      await client.close();
    }
    this.events.count('mcp', 'tested');
  }

  /** Before a connection is removed: the OAuth grant is revoked (best effort) and every secret kept for it is deleted. Returns whether the revocation is confirmed. */
  async beforeRemove(row: Connection): Promise<boolean> {
    const revoked = await this.oauth.revoke(row).catch(() => false);
    await this.secrets.clear(row.userId, row.id).catch((e: unknown) => this.log.warn(`MCP secrets could not be deleted (${e instanceof Error ? e.name : 'error'})`));
    await this.tokens.clearTokens(row.userId, row.id).catch(() => undefined);
    return revoked;
  }
}

export { urlError };
