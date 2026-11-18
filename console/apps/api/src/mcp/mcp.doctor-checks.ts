// The Doctor checks of external AI apps (#465), next to the fabric's
// (src/fabric/fabric.doctor-checks.ts). Read-only, as the Doctor requires: no
// write, no audit row, no job. The probes go to the console's own public URL
// (APP_URL) without a credential, exactly as a stranger on the internet would.
//
//   mcp.endpoint             fail: POST /api/mcp without a token is not a 401 whose challenge's metadata URL answers
//   mcp.public_reachability  warn: OAuth is on but APP_URL is not a public https address
//   mcp.exposure             warn: an admin route answers 200 without a credential through the public URL
//   mcp.kill_switch          pass: the state of the two switches (the Doctor has no `info` status)
//   mcp.high_risk_grants     warn: grants hold browser:evaluate, desktop:control or policies:write
//   mcp.trust_proxy          warn: TRUST_PROXY=false while APP_URL is public https (every caller shares one per-address bucket)
import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DoctorCheckRegistry, type DoctorCheck, type DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';
import { OAuthServerSettingsReader } from '@marinoscar/platform-api/identity';

import { describeTrustProxy, parseTrustProxy } from '../config/trust-proxy';
import { PrismaService } from '../prisma/prisma.service';
import { HIGH_RISK_GRANT_SCOPES, grantCounts } from './mcp-admin.controller';
import { McpSettingsReader } from './mcp-settings.reader';
import { MCP_PATH } from './mcp.path';
import { isPrivateHost, isPublicHttpsUrl } from './mcp.public-url';

/** The admin page of external AI apps. */
export const MCP_SETTINGS_PATH = '/admin/settings/ai-app-limits';
/** Where the runbook is (shown in remedies). */
export const PUBLIC_EXPOSURE_RUNBOOK = 'console/docs/runbooks/public-exposure.md';
const PROBE_TIMEOUT_MS = 4_000;

/** Routes that must never answer 200 without a credential through the public URL. */
export const EXPOSURE_PROBES = ['/api/system-settings', '/api/admin/about', '/api/admin/oauth/clients', '/api/users', '/api/fleet/hosts', '/api/runs', '/api/admin/mcp/status'] as const;

type Fetch = typeof globalThis.fetch;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

@Injectable()
abstract class McpCheck implements DoctorCheck, OnModuleInit {
  abstract readonly id: string;
  abstract readonly label: string;
  readonly category = 'mcp';
  readonly settingsPath = MCP_SETTINGS_PATH;
  readonly timeoutMs = 15_000;
  /** The HTTP client of the probes; tests replace it. */
  fetchImpl: Fetch = (...a) => globalThis.fetch(...a);

  constructor(
    protected readonly registry: DoctorCheckRegistry,
    protected readonly config: ConfigService,
    @Optional() protected readonly oauth?: OAuthServerSettingsReader,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  protected appUrl(): string {
    return (this.config.get<string>('appUrl') ?? process.env.APP_URL ?? '').replace(/\/+$/, '');
  }

  protected async oauthOn(): Promise<boolean> {
    try {
      return (await this.oauth?.read())?.enabled === true;
    } catch {
      return false;
    }
  }

  protected async probe(url: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(url, { redirect: 'manual', ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  }

  abstract check(): Promise<DoctorCheckOutcome>;

  async run(): Promise<DoctorCheckOutcome> {
    try {
      return await this.check();
    } catch (e) {
      return { status: 'fail', detail: 'The check could not run.', error: message(e), remedy: `See ${PUBLIC_EXPOSURE_RUNBOOK}.` };
    }
  }
}

/** The metadata URL of a `WWW-Authenticate: Bearer resource_metadata="..."` challenge. */
export function resourceMetadataUrl(challenge: string | null): string | null {
  const m = /resource_metadata="([^"]+)"/i.exec(challenge ?? '');
  return m ? m[1]! : null;
}

/** `mcp.endpoint`: the MCP endpoint answers an anonymous call with the OAuth challenge, and the challenge's document answers. */
@Injectable()
export class McpEndpointCheck extends McpCheck {
  readonly id = 'mcp.endpoint';
  readonly label = 'MCP endpoint challenge';

  async check(): Promise<DoctorCheckOutcome> {
    if (!(await this.oauthOn())) return { status: 'skip', detail: 'The OAuth server is off: AI apps cannot sign in, so there is no challenge to check.' };
    const url = `${this.appUrl()}${MCP_PATH}`;
    const remedy = `Make the proxy pass /api/mcp and /.well-known/oauth-* to the API unchanged (${PUBLIC_EXPOSURE_RUNBOOK}).`;
    let res: Response;
    try {
      res = await this.probe(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
    } catch (e) {
      return { status: 'fail', detail: `${url} did not answer.`, error: message(e), remedy };
    }
    if (res.status !== 401) return { status: 'fail', detail: `POST ${url} without a token answered ${res.status}, not 401.`, remedy, data: { status: res.status } };
    const meta = resourceMetadataUrl(res.headers.get('www-authenticate'));
    if (!meta) return { status: 'fail', detail: 'The 401 carries no WWW-Authenticate challenge with a resource_metadata URL.', remedy, data: { status: 401 } };
    try {
      const doc = await this.probe(meta, { headers: { accept: 'application/json' } });
      if (doc.status !== 200) return { status: 'fail', detail: `The challenge's metadata document (${meta}) answered ${doc.status}.`, remedy, data: { metadataStatus: doc.status } };
    } catch (e) {
      return { status: 'fail', detail: `The challenge's metadata document (${meta}) did not answer.`, error: message(e), remedy };
    }
    return { status: 'pass', detail: 'An anonymous call gets the 401 challenge, and its metadata document answers.' };
  }
}

/** `mcp.public_reachability`: OAuth is on, so APP_URL should be a public https address. */
@Injectable()
export class McpPublicReachabilityCheck extends McpCheck {
  readonly id = 'mcp.public_reachability';
  readonly label = 'Console reachable by hosted AI apps';

  async check(): Promise<DoctorCheckOutcome> {
    if (!(await this.oauthOn())) return { status: 'skip', detail: 'The OAuth server is off: no hosted AI app needs to reach the console.' };
    const appUrl = this.appUrl();
    if (isPublicHttpsUrl(appUrl)) return { status: 'pass', detail: 'APP_URL is a public https address.' };
    return {
      status: 'warn',
      detail: 'OAuth is on, but APP_URL is not a public https address: ChatGPT and Claude call from their own servers and cannot reach it.',
      remedy: `Put the console on a public HTTPS address (a VPS, a tunnel, or a public proxy for the MCP and OAuth paths only) and set APP_URL to it: ${PUBLIC_EXPOSURE_RUNBOOK}.`,
      data: { https: appUrl.startsWith('https://') },
    };
  }
}

/** `mcp.exposure`: through the public URL, admin routes refuse a caller without a credential. */
@Injectable()
export class McpExposureCheck extends McpCheck {
  readonly id = 'mcp.exposure';
  readonly label = 'Only the documented paths are public';

  async check(): Promise<DoctorCheckOutcome> {
    const appUrl = this.appUrl();
    let host = '';
    try {
      host = new URL(appUrl).hostname;
    } catch {
      return { status: 'skip', detail: 'APP_URL is not set.' };
    }
    if (isPrivateHost(host)) return { status: 'skip', detail: 'APP_URL is a private address: nothing is exposed to the internet.' };
    const open: string[] = [];
    let answered = 0;
    for (const path of EXPOSURE_PROBES) {
      try {
        const res = await this.probe(`${appUrl}${path}`, { headers: { accept: 'application/json' } });
        answered++;
        if (res.status >= 200 && res.status < 300) open.push(path);
      } catch {
        // Unreachable is not exposed.
      }
    }
    if (answered === 0) return { status: 'skip', detail: 'The public URL did not answer from here.' };
    if (open.length) {
      return {
        status: 'warn',
        detail: `Answered without a credential through the public URL: ${open.join(', ')}.`,
        remedy: `Something in front of the API answers for it (a cache or a misrouted proxy). Route only the documented public paths and turn off caching of /api/*: ${PUBLIC_EXPOSURE_RUNBOOK}.`,
        data: { open: open.length },
      };
    }
    return { status: 'pass', detail: `${answered} admin routes refuse a caller without a credential through the public URL.`, data: { probed: answered } };
  }
}

/** `mcp.kill_switch`: the state of the two switches (always `pass`: it informs). */
@Injectable()
export class McpKillSwitchCheck extends McpCheck {
  readonly id = 'mcp.kill_switch';
  readonly label = 'External AI apps switches';

  constructor(registry: DoctorCheckRegistry, config: ConfigService, private readonly settings: McpSettingsReader, @Optional() oauth?: OAuthServerSettingsReader) {
    super(registry, config, oauth);
  }

  async check(): Promise<DoctorCheckOutcome> {
    const s = await this.settings.read();
    const on = (b: boolean) => (b ? 'on' : 'off');
    return {
      status: 'pass',
      detail: `Apps signed in with OAuth: ${on(s.externalAppsEnabled)}. Personal access tokens over MCP: ${on(s.patMcpEnabled)}.`,
      data: { externalAppsEnabled: s.externalAppsEnabled, patMcpEnabled: s.patMcpEnabled },
    };
  }
}

/** `mcp.high_risk_grants`: how many grants hold the scopes that reach furthest. */
@Injectable()
export class McpHighRiskGrantsCheck extends McpCheck {
  readonly id = 'mcp.high_risk_grants';
  readonly label = 'High-risk AI app grants';

  constructor(registry: DoctorCheckRegistry, config: ConfigService, private readonly prisma: PrismaService, @Optional() oauth?: OAuthServerSettingsReader) {
    super(registry, config, oauth);
  }

  async check(): Promise<DoctorCheckOutcome> {
    const c = await grantCounts(this.prisma);
    if (c.highRiskGrants === 0) return { status: 'pass', detail: `${c.connectedApps} connected app(s); none holds ${HIGH_RISK_GRANT_SCOPES.join(', ')}.`, data: c };
    return {
      status: 'warn',
      detail: `${c.highRiskGrants} of ${c.connectedApps} connected app(s) may run JavaScript, control the desktop or change agent policies (${HIGH_RISK_GRANT_SCOPES.join(', ')}).`,
      remedy: 'Review them in Administration → External AI apps and disconnect what is not needed; each user sees theirs in Settings → AI apps.',
      data: c,
    };
  }
}

/**
 * `mcp.trust_proxy`: which proxies the API trusts for the caller's address
 * (`TRUST_PROXY`, read at boot, #530). The API always sits behind the stack's
 * nginx, so with the variable `false` every caller reaches the API from
 * nginx's address and the per-address limits (unauthenticated MCP answers, the
 * OAuth server's authorize and register) count everyone in one bucket. That
 * matters once the console is public: warn then; otherwise report the setting.
 */
@Injectable()
export class McpTrustProxyCheck extends McpCheck {
  readonly id = 'mcp.trust_proxy';
  readonly label = 'Caller addresses behind the proxy';
  /** The raw variable; tests replace it. */
  readEnv: () => string | undefined = () => process.env.TRUST_PROXY;

  async check(): Promise<DoctorCheckOutcome> {
    const setting = parseTrustProxy(this.readEnv());
    const effective = describeTrustProxy(setting);
    if (setting !== false) return { status: 'pass', detail: `Trusted proxies: ${effective}. The per-address limits count each caller apart.`, data: { trustProxy: setting } };
    if (!isPublicHttpsUrl(this.appUrl())) {
      return { status: 'pass', detail: `TRUST_PROXY is false: the per-address limits count every caller as the stack's nginx. APP_URL is not a public https address, so few callers share that bucket.`, data: { trustProxy: false } };
    }
    return {
      status: 'warn',
      detail: 'TRUST_PROXY is false while the console is public: every caller reaches the API from the address of the stack\'s nginx, so the per-address limits (unauthenticated MCP answers, the OAuth server\'s authorize and register) share one bucket, and one noisy caller can lock everyone out of them.',
      remedy: `Remove TRUST_PROXY from infra/compose/.env (the default trusts loopback and private ranges) or set it to the address of the stack's nginx, then restart the API (${PUBLIC_EXPOSURE_RUNBOOK}, section 4).`,
      data: { trustProxy: false },
    };
  }
}

export const MCP_DOCTOR_CHECKS = [McpEndpointCheck, McpPublicReachabilityCheck, McpExposureCheck, McpKillSwitchCheck, McpHighRiskGrantsCheck, McpTrustProxyCheck];
