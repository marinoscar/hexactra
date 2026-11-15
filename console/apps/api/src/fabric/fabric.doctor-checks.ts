import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DoctorCheckRegistry, type DoctorCheck, type DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';

import { FabricClient, FabricError } from './fabric.client';

export const FABRIC_SETTINGS_PATH = '/admin/settings/fabric';
const CONFIGURE = 'Set the fabric URL and an hxs_ service token at Administration → Fabric connection.';

function message(e: unknown): string {
  return e instanceof FabricError ? e.message : e instanceof Error ? e.message : String(e);
}

@Injectable()
abstract class FabricCheck implements DoctorCheck, OnModuleInit {
  abstract readonly id: string;
  abstract readonly label: string;
  readonly category = 'fabric';
  readonly settingsPath = FABRIC_SETTINGS_PATH;

  constructor(
    protected readonly registry: DoctorCheckRegistry,
    protected readonly fabric: FabricClient,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  abstract probe(): Promise<DoctorCheckOutcome>;

  /** Every check: not configured is a failure with the fix; never throws. */
  async run(): Promise<DoctorCheckOutcome> {
    try {
      if (!(await this.fabric.config())) {
        return { status: 'fail', detail: 'The fabric connection is not configured.', remedy: CONFIGURE };
      }
      return await this.probe();
    } catch (e) {
      return { status: 'fail', detail: 'The check could not run.', error: message(e), remedy: CONFIGURE };
    }
  }
}

/** `fabric.reachable`: the control plane answers `GET /v1/health`. */
@Injectable()
export class FabricReachableCheck extends FabricCheck {
  readonly id = 'fabric.reachable';
  readonly label = 'Fabric control plane reachable';

  async probe(): Promise<DoctorCheckOutcome> {
    const started = Date.now();
    try {
      const h = await this.fabric.health();
      const ms = Date.now() - started;
      return { status: 'pass', detail: `Fabric ${h.version} answered in ${ms} ms.`, data: { version: h.version, latencyMs: ms } };
    } catch (e) {
      return {
        status: 'fail',
        detail: 'The fabric control plane does not answer.',
        error: message(e),
        remedy: 'Check the fabric URL and that hexactra-control runs and is reachable from the console (same Docker network or Tailscale).',
      };
    }
  }
}

/** `fabric.token`: the service token is accepted. */
@Injectable()
export class FabricTokenCheck extends FabricCheck {
  readonly id = 'fabric.token';
  readonly label = 'Fabric service token';

  async probe(): Promise<DoctorCheckOutcome> {
    try {
      await this.fabric.hosts();
      return { status: 'pass', detail: 'The fabric accepts the service token.' };
    } catch (e) {
      if (e instanceof FabricError && e.kind === 'unauthorized') {
        return {
          status: 'fail',
          detail: 'The fabric refuses the service token.',
          error: e.message,
          remedy: 'Create a service token on the fabric (POST /v1/admin/service-tokens with the operator token) and save it at Administration → Fabric connection.',
        };
      }
      return { status: 'skip', detail: 'Not evaluated: the fabric is unreachable (see fabric.reachable).', error: message(e) };
    }
  }
}

/** `fabric.hosts`: at least one host is online. */
@Injectable()
export class FabricHostsCheck extends FabricCheck {
  readonly id = 'fabric.hosts';
  readonly label = 'Browser hosts online';

  async probe(): Promise<DoctorCheckOutcome> {
    let hosts;
    try {
      hosts = await this.fabric.hosts();
    } catch (e) {
      return { status: 'skip', detail: 'Not evaluated: the host list could not be read.', error: message(e) };
    }
    const online = hosts.filter((h) => h.online);
    const data = { hosts: hosts.length, online: online.length, draining: online.filter((h) => h.draining).length };
    if (online.length === 0) {
      return {
        status: 'warn',
        detail: hosts.length ? `None of ${hosts.length} host(s) is online.` : 'No host is enrolled.',
        remedy: 'Start hexactra-agent on a host, or enroll one from the Fleet page.',
        data,
      };
    }
    return { status: 'pass', detail: `${online.length} of ${hosts.length} host(s) online.`, data };
  }
}

/** `fabric.events`: the event stream answers as server-sent events. */
@Injectable()
export class FabricEventsCheck extends FabricCheck {
  readonly id = 'fabric.events';
  readonly label = 'Fabric event stream';

  async probe(): Promise<DoctorCheckOutcome> {
    try {
      await this.fabric.probeEvents();
      return { status: 'pass', detail: 'GET /v1/events streams.' };
    } catch (e) {
      return {
        status: 'fail',
        detail: 'The fabric event stream is unavailable.',
        error: message(e),
        remedy: 'Upgrade hexactra-control to a version with GET /v1/events, and make sure no proxy buffers it.',
      };
    }
  }
}

export const FABRIC_DOCTOR_CHECKS = [FabricReachableCheck, FabricTokenCheck, FabricHostsCheck, FabricEventsCheck];
