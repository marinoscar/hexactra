// Opening a session with an MCP server on behalf of one of the owner's connections (E39.9, #606): the switch and the administrator's host
// lists (checked before EVERY request, so a change takes effect on the next call and a host that now resolves private is refused at call
// time), the sign-in headers (a stored bearer token or header, or an OAuth access token, refreshed when due), and the translation of a
// protocol failure into the typed errors of Connections. Secrets are read here, at the moment of a request, and nowhere else.
import { Injectable } from '@nestjs/common';
import type { Connection } from '@prisma/client';

import { OutboundHttp } from '../../oauth-client';
import { PrismaService } from '../../prisma/prisma.service';
import { ConnectionApps } from '../connection-apps.service';
import { ConnectionTokensService } from '../connection-tokens.service';
import { ConnectionError } from '../connections.errors';
import type { ResolvedMcpSettings } from '../connections.settings';
import { McpClient, McpClientError, type McpClientOptions } from './mcp-client';
import { readMcpConfig, type McpConfig } from './mcp-config';
import { McpSecretStore } from './mcp-secrets';
import { checkHostLists, urlError, McpUrlError } from './mcp-url';
import { OutboundHttpError } from '../../oauth-client';

/** The ConnectionError an MCP failure becomes: closed codes, never the server's text. */
export function toConnectionError(e: unknown, label?: string): ConnectionError {
  if (e instanceof ConnectionError) return e;
  if (e instanceof McpUrlError) return new ConnectionError('CONNECTION_MCP_URL_REFUSED', e.message, { reason: e.code });
  if (!(e instanceof McpClientError)) return new ConnectionError('CONNECTION_UNAVAILABLE', 'The MCP server could not be used.', { reason: 'error' });
  switch (e.kind) {
    case 'url_refused':
      return new ConnectionError('CONNECTION_MCP_URL_REFUSED', e.message, { reason: e.extra.urlCode ?? 'invalid_url' });
    case 'auth':
      return new ConnectionError('CONNECTION_MCP_AUTH_REQUIRED', 'The MCP server wants a sign-in it did not get.', { oauth: Boolean(e.extra.wwwAuthenticate), ...(label ? { label } : {}) });
    case 'protocol':
      return new ConnectionError('CONNECTION_MCP_PROTOCOL', 'The server did not answer in the MCP protocol this console speaks.');
    default:
      return new ConnectionError('CONNECTION_UNAVAILABLE', 'The MCP server could not be reached or refused the request.', { reason: e.kind });
  }
}

export const disabledError = (): ConnectionError => new ConnectionError('CONNECTION_PROVIDER_UNAVAILABLE', 'MCP servers are switched off on this deployment.', { reason: 'disabled' });

export interface OpenOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

@Injectable()
export class McpConnector {
  constructor(
    private readonly prisma: PrismaService,
    private readonly http: OutboundHttp,
    private readonly apps: ConnectionApps,
    private readonly secrets: McpSecretStore,
    private readonly tokens: ConnectionTokensService,
  ) {}

  /** Whether MCP servers may be used at all on this deployment, as the settings are now. */
  async enabled(): Promise<boolean> {
    return (await this.apps.mcp()).enabled;
  }

  /** The switch (`disabledError` while off) and the lists for a host. Throws `McpUrlError` for a host the lists refuse. */
  async guard(url: string): Promise<ResolvedMcpSettings> {
    const s = await this.apps.mcp();
    if (!s.enabled) throw disabledError();
    checkHostLists(new URL(url).hostname, s);
    return s;
  }

  /** Refuses (typed) an address the shape rules, the lists or the network guard refuse, without sending anything. Used when an address is saved. */
  async checkAddress(url: string): Promise<void> {
    try {
      await this.guard(url);
      await this.http.check(url);
    } catch (e) {
      if (e instanceof OutboundHttpError) throw new ConnectionError('CONNECTION_MCP_URL_REFUSED', urlError(e.code).message, { reason: e.code });
      throw toConnectionError(e);
    }
  }

  /** The sign-in headers of a stored connection. */
  async headers(row: Pick<Connection, 'id' | 'userId'>, cfg: McpConfig): Promise<Record<string, string>> {
    switch (cfg.auth.kind) {
      case 'none':
        return {};
      case 'bearer': {
        const token = await this.secrets.secret(row.userId, row.id);
        if (!token) throw new ConnectionError('CONNECTION_NEEDS_RECONNECT', 'This connection must be connected again.', { reason: 'NO_SECRET' });
        return { authorization: `Bearer ${token}` };
      }
      case 'header': {
        const value = await this.secrets.secret(row.userId, row.id);
        if (!value || !cfg.auth.header) throw new ConnectionError('CONNECTION_NEEDS_RECONNECT', 'This connection must be connected again.', { reason: 'NO_SECRET' });
        return { [cfg.auth.header.toLowerCase()]: value };
      }
      case 'oauth':
        return { authorization: `Bearer ${await this.tokens.getAccessToken(row.id, row.userId)}` };
    }
  }

  /** Opens a session with the server of a stored connection. The caller closes it. */
  async open(row: Connection, opts: OpenOptions = {}): Promise<{ client: McpClient; config: McpConfig }> {
    const config = readMcpConfig(row.config);
    if (row.provider !== 'mcp' || !config) throw new ConnectionError('CONNECTION_UNAVAILABLE', 'This is not an MCP connection.', { reason: 'config' });
    const client = await this.openWith(config.url, () => this.headers(row, config), opts);
    return { client, config };
  }

  /** Opens a session with explicit sign-in headers (adding a server: nothing is stored until it answered). */
  async openWith(url: string, headers: () => Promise<Record<string, string>>, opts: OpenOptions = {}): Promise<McpClient> {
    const options: McpClientOptions = {
      http: this.http,
      url,
      prepare: async () => {
        await this.guard(url);
        return headers();
      },
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    return McpClient.connect(options);
  }

  /** The connection's own row, or null: the caller's. */
  mine(userId: string, id: string): Promise<Connection | null> {
    return this.prisma.connection.findFirst({ where: { id, userId, provider: 'mcp' } });
  }
}
