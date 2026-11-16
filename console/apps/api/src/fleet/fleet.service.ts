import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { FabricClient, FabricError, type FabricHost } from '../fabric/fabric.client';
import type { FleetCommandResult, FleetEnrollment, FleetHost } from './fleet.schemas';

interface FabricCommandView {
  id: string;
  host_id: string;
  command: { type: string; profile?: string };
  state: string;
  error?: string;
  created_at: string;
  completed_at?: string;
}

type HostCommand =
  | { type: 'create_profile' | 'delete_profile' | 'restart_browser' | 'close_browser'; profile: string }
  | { type: 'drain'; enabled: boolean };

const COMMAND_TIMEOUT_MS = 90_000;

function toHost(h: FabricHost): FleetHost {
  const running = new Set(h.running_profiles ?? []);
  return {
    id: h.id,
    name: h.name,
    version: h.version,
    online: h.online,
    browserConnected: h.browser_connected,
    onDemand: h.on_demand,
    draining: h.draining ?? false,
    viewerUrl: h.viewer_url ?? null,
    mode: h.mode ?? null,
    desktop: h.desktop ?? false,
    profiles: (h.profiles ?? []).map((name) => ({ name, running: running.has(name) })),
    lastSeen: h.last_seen,
  };
}

function toResult(c: FabricCommandView): FleetCommandResult {
  return {
    id: c.id,
    kind: c.command.type,
    profile: c.command.profile ?? null,
    state: c.state,
    error: c.error ?? null,
    createdAt: c.created_at,
    completedAt: c.completed_at ?? null,
  };
}

/** The fabric bundled with the console's stack, as the api container reaches it. */
const BUNDLED_FABRIC_URL = 'http://fabric-control:8787';

/**
 * The fabric URL a NEW host should use. The bundled fabric is private, but its
 * host protocol is published over this deployment's own TLS vhost at
 * `<APP_URL>/fabric` (infra/nginx/app.d/locations/fabric-agents.conf), so a
 * desktop enrolls with no VPN. Any other fabric URL is used as it is.
 */
export function agentUrlFor(fabricUrl: string | undefined, appUrl: string | undefined): string {
  const fabric = (fabricUrl ?? '').replace(/\/+$/, '');
  if (fabric === BUNDLED_FABRIC_URL && appUrl) return `${appUrl.replace(/\/+$/, '')}/fabric`;
  return fabric;
}

/** Quote a value for a POSIX shell command line. */
function shellQuote(v: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * The fleet: hosts and profiles of the fabric, managed through it. Failures
 * keep the fabric's message; the console never retries a mutation.
 */
@Injectable()
export class FleetService {
  private readonly log = new Logger(FleetService.name);

  constructor(private readonly fabric: FabricClient) {}

  /** Maps a fabric failure to the console's HTTP error. */
  private rethrow(e: unknown): never {
    if (!(e instanceof FabricError)) throw e;
    switch (e.kind) {
      case 'not_configured':
        throw new ServiceUnavailableException({ code: 'FABRIC_NOT_CONFIGURED', message: 'The fabric connection is not configured (Administration → Fabric connection).' });
      case 'unreachable':
        throw new BadGatewayException({ code: 'FABRIC_UNREACHABLE', message: e.message });
      case 'unauthorized':
        throw new BadGatewayException({ code: 'FABRIC_UNAUTHORIZED', message: 'The fabric refused the console\'s service token.' });
      default:
        if (e.status === 404) throw new NotFoundException({ code: 'FABRIC_NOT_FOUND', message: e.message });
        if (e.status === 409) throw new ConflictException({ code: 'FABRIC_CONFLICT', message: e.message });
        if (e.status === 400 || e.status === 422) throw new BadRequestException({ code: 'FABRIC_INVALID', message: e.message });
        throw new HttpException({ code: 'FABRIC_ERROR', message: e.message }, 502);
    }
  }

  async hosts(): Promise<FleetHost[]> {
    try {
      return (await this.fabric.hosts()).map(toHost).sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      this.rethrow(e);
    }
  }

  async host(id: string): Promise<FleetHost> {
    const h = (await this.hosts()).find((x) => x.id === id);
    if (!h) throw new NotFoundException({ code: 'HOST_NOT_FOUND', message: 'Host not found' });
    return h;
  }

  /** A single-use enrollment token and the command that uses it. */
  async enroll(input: { name?: string; agentUrl?: string; ttlMinutes?: number }): Promise<FleetEnrollment> {
    try {
      const created = await this.fabric.request<{ enrollment: { expires_at?: string }; enrollment_token: string }>(
        'POST',
        '/v1/admin/hosts/enrollments',
        { body: { name: input.name ?? null, ttl_s: input.ttlMinutes ? input.ttlMinutes * 60 : undefined } },
      );
      const url = input.agentUrl ?? agentUrlFor((await this.fabric.config())?.url, process.env.APP_URL);
      const parts = ['hexactra-agent', 'daemon', '--url', shellQuote(url), '--enrollment-token', created.enrollment_token];
      if (input.name) parts.push('--name', shellQuote(input.name));
      this.log.log('host enrollment created');
      return {
        enrollmentToken: created.enrollment_token,
        expiresAt: created.enrollment.expires_at ?? null,
        agentUrl: url,
        command: parts.join(' '),
      };
    } catch (e) {
      this.rethrow(e);
    }
  }

  async revoke(id: string): Promise<void> {
    try {
      await this.fabric.request('DELETE', `/v1/admin/hosts/${encodeURIComponent(id)}`);
      this.log.log(`host revoked: ${id}`);
    } catch (e) {
      this.rethrow(e);
    }
  }

  /** Run a host command and wait for its outcome; a failed command is a 409 with the host's reason. */
  async command(hostId: string, command: HostCommand): Promise<FleetCommandResult> {
    let view: FabricCommandView;
    try {
      view = await this.fabric.request<FabricCommandView>('POST', `/v1/hosts/${encodeURIComponent(hostId)}/commands`, {
        body: { command, timeout_ms: COMMAND_TIMEOUT_MS },
        timeoutMs: COMMAND_TIMEOUT_MS + 10_000,
      });
    } catch (e) {
      this.rethrow(e);
    }
    const result = toResult(view);
    this.log.log(`host command ${result.kind} on ${hostId}: ${result.state}`);
    if (result.state !== 'succeeded') {
      throw new ConflictException({ code: 'HOST_COMMAND_FAILED', message: result.error ?? `The command ${result.state}`, details: result });
    }
    return result;
  }

  async commands(hostId: string): Promise<FleetCommandResult[]> {
    try {
      const list = await this.fabric.request<{ commands: FabricCommandView[] }>('GET', `/v1/hosts/${encodeURIComponent(hostId)}/commands`);
      return list.commands.map(toResult);
    } catch (e) {
      this.rethrow(e);
    }
  }
}
