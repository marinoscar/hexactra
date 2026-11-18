// Who started a run, asked a question or opened a browser session (#464): the
// request's client context. Set in ONE place, from what the server itself
// knows about the request, never from a header or a body a network caller
// sends:
//
//   an `oat_` token        → `mcp`, the OAuth client's id, display name (one
//                            indexed read, cached 60 s) and grant. An `oat_`
//                            token is confined to /api/mcp, so on any REST
//                            route it arrived through the MCP endpoint's
//                            in-process delegation;
//   an in-process MCP call → `mcp`, with the MCP `clientInfo.name` the MCP
//                            endpoint passed along (a personal access token or
//                            session caller: no client id, `verified: false`).
//                            The marker header is honoured ONLY on a request
//                            the platform's `InProcessDelegation` injected (its
//                            socket carries a marker no network peer has);
//   anything else          → the credential kind and the User-Agent family:
//                            the CLI, the Android app, the console, an API
//                            caller, a worker node (`system`).
import { Injectable, Optional } from '@nestjs/common';
import { InProcessDelegation, authCredentialOf, type RequestWithAuthCredential } from '@marinoscar/platform-api/identity';

import { PrismaService } from '../prisma/prisma.service';

/** Where a run came from (`runs.origin`). */
export const RUN_ORIGINS = ['web', 'android', 'cli', 'api', 'mcp', 'schedule', 'system'] as const;
export type RunOrigin = (typeof RUN_ORIGINS)[number];

/** The header the MCP endpoint sets on its in-process sub-requests: the MCP client's own name, URI-encoded. */
export const MCP_CLIENT_HEADER = 'x-hexactra-mcp-client';
/** The longest client name stored (`client_name`). */
export const CLIENT_NAME_MAX = 64;
/** How long a client's display name is cached. */
export const CLIENT_NAME_TTL_MS = 60_000;

/** The client context of one request. */
export interface RequestClient {
  origin: RunOrigin;
  /** `oauth_clients.id` of an OAuth app; null otherwise. */
  clientId: string | null;
  /** The app's display name at the time; null when the caller is not an app. */
  clientName: string | null;
  /** The OAuth grant the app used. */
  grantId: string | null;
  /** True for an OAuth client (the name comes from the client row); false for a self-asserted MCP `clientInfo.name`. */
  verified: boolean;
}

/** A run, question or session not started by an app. */
export function plainClient(origin: RunOrigin): RequestClient {
  return { origin, clientId: null, clientName: null, grantId: null, verified: false };
}

/** The columns a row stores of a client context. */
export function clientColumns(c: RequestClient): { origin: RunOrigin; clientId: string | null; clientName: string | null; grantId: string | null } {
  return { origin: c.origin, clientId: c.clientId, clientName: c.clientName, grantId: c.grantId };
}

/** The friendly names of the hosts of the hosted assistants (the stored name stays the host). */
const KNOWN_HOSTS: Readonly<Record<string, string>> = {
  'chatgpt.com': 'ChatGPT',
  'chat.openai.com': 'ChatGPT',
  'claude.ai': 'Claude',
  'claude.com': 'Claude',
};

/** How an app reads in a sentence: "ChatGPT", "Claude", or its stored name. */
export function friendlyAppName(name: string | null | undefined): string {
  const n = (name ?? '').trim();
  if (!n) return 'An AI app';
  return KNOWN_HOSTS[n.toLowerCase()] ?? n;
}

/**
 * The stored display name of an OAuth client: its host ("chatgpt.com"), which
 * the platform derived from the client id or its redirect URIs; for a client
 * whose redirect URIs are all loopback (Claude Code, a local tool), its own
 * name, since `loopback` names nothing.
 */
export function clientLabel(client: { host: string; name: string }): string {
  const host = client.host.trim().toLowerCase();
  const label = host && host !== 'loopback' ? host : client.name.trim() || 'Local app';
  return label.slice(0, CLIENT_NAME_MAX);
}

/** A self-asserted MCP client name, cleaned: control characters dropped, at most 64 characters. */
export function cleanClientName(raw: string | undefined | null): string | null {
  if (!raw) return null;
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, CLIENT_NAME_MAX);
  return name || null;
}

/** The value of the marker header for a client name. */
export function mcpClientHeaderValue(name: string | undefined): string {
  return encodeURIComponent(cleanClientName(name) ?? '');
}

/** The origin of a direct REST call: its credential kind and User-Agent family. */
export function originOf(kind: string | undefined, userAgent: string | undefined): RunOrigin {
  if (kind === 'node') return 'system';
  const ua = (userAgent ?? '').toLowerCase();
  // `hexactra/1.43.0 (node v24…)`: the platform CLI's client (packages/platform-cli, api-client).
  if (/^hexactra\/\d/.test(ua) || ua.startsWith('hexactra-cli')) return 'cli';
  if (ua.includes('hexactraandroid') || ua.includes('hexactra-android')) return 'android';
  if (kind === 'jwt') return 'web';
  return 'api';
}

type AnyRequest = RequestWithAuthCredential & { headers?: Record<string, unknown>; raw?: { socket?: { remoteAddress?: unknown } } };

function header(req: AnyRequest, name: string): string | undefined {
  const v = req.headers?.[name];
  return Array.isArray(v) ? (v[0] as string | undefined) : typeof v === 'string' ? v : undefined;
}

/** Resolves a request's client context. */
@Injectable()
export class RequestClientService {
  private readonly names = new Map<string, { label: string; at: number }>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly delegation?: InProcessDelegation,
  ) {}

  /** The wall clock; tests replace it. */
  clock: () => number = Date.now;

  /** Whether `req` reached this process through the MCP endpoint's in-process delegation. */
  inProcess(req: AnyRequest): boolean {
    try {
      return this.delegation?.isInProcess(req) ?? false;
    } catch {
      return false;
    }
  }

  async resolve(req: object | undefined): Promise<RequestClient> {
    const r = (req ?? {}) as AnyRequest;
    const credential = authCredentialOf(r);
    if (credential?.kind === 'oauth') {
      return { origin: 'mcp', clientId: credential.clientId, clientName: await this.displayName(credential.clientId), grantId: credential.grantId, verified: true };
    }
    const marker = header(r, MCP_CLIENT_HEADER);
    if (marker !== undefined && this.inProcess(r)) {
      let name: string | null = null;
      try {
        name = cleanClientName(decodeURIComponent(marker));
      } catch {
        name = cleanClientName(marker);
      }
      return { origin: 'mcp', clientId: null, clientName: name, grantId: null, verified: false };
    }
    return plainClient(originOf(credential?.kind, header(r, 'user-agent')));
  }

  /** An OAuth client's stored display name: one read by primary key, cached for a minute. */
  async displayName(clientId: string): Promise<string | null> {
    const now = this.clock();
    const hit = this.names.get(clientId);
    if (hit && now - hit.at < CLIENT_NAME_TTL_MS) return hit.label;
    const row = await this.prisma.oAuthClient.findUnique({ where: { id: clientId }, select: { host: true, name: true } }).catch(() => null);
    if (!row) return hit?.label ?? null;
    const label = clientLabel(row);
    if (this.names.size > 500) this.names.clear();
    this.names.set(clientId, { label, at: now });
    return label;
  }
}
