// "Can an AI app connect?" (#464): the preflight of the "Connect an AI app"
// guide. It reuses the platform's own Doctor checks `oauth.public_url` and
// `oauth.well_known` (registered in the Doctor's check registry while the OAuth
// server is mounted) by running them directly, so the guide and the admin
// Doctor never disagree. The discovery probe makes network requests (12 s at
// most), so its outcome is cached for a minute.
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DoctorCheckRegistry, type DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';
import { OAuthServerSettingsReader } from '@marinoscar/platform-api/identity';

import { MCP_PATH } from '../mcp/mcp.path';
import type { AppPreflight } from './connected-apps.responses';

/** The admin page of the OAuth server (the platform's `OAUTH_SETTINGS_PATH`). */
export const OAUTH_ADMIN_PATH = '/admin/settings/oauth-clients';
const CACHE_MS = 60_000;

/** The hosts each hosted client's sign-in comes from (Claude's metadata documents and redirect, ChatGPT's redirect). */
export const CLIENT_HOSTS = { chatgpt: ['chatgpt.com'], claude: ['claude.ai'] } as const;

type Status = AppPreflight['checks'][number]['status'];

function statusOf(o: DoctorCheckOutcome | null): Status {
  const s = o?.status as string | undefined;
  return s === 'pass' || s === 'warn' || s === 'fail' || s === 'skip' ? s : 'warn';
}

@Injectable()
export class ConnectedAppsPreflight {
  private readonly log = new Logger(ConnectedAppsPreflight.name);
  private cached: { at: number; publicUrl: DoctorCheckOutcome | null; wellKnown: DoctorCheckOutcome | null } | null = null;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly oauth?: OAuthServerSettingsReader,
    @Optional() private readonly doctor?: DoctorCheckRegistry,
  ) {}

  private async check(id: string): Promise<DoctorCheckOutcome | null> {
    const c = this.doctor?.get(id);
    if (!c) return null;
    try {
      return await c.run();
    } catch (e) {
      this.log.warn(`preflight ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
      return { status: 'warn', detail: 'The check could not run.' } as DoctorCheckOutcome;
    }
  }

  async run(permissions: readonly string[]): Promise<AppPreflight> {
    const admin = permissions.includes('oauth_clients:write');
    const appUrl = (this.config.get<string>('appUrl') ?? process.env.APP_URL ?? '').replace(/\/+$/, '');
    const settings = this.oauth ? await this.oauth.read() : null;
    const enabled = settings?.enabled === true;
    const ask = (what: string) => (admin ? what : `Ask your administrator to ${what.charAt(0).toLowerCase()}${what.slice(1)}`);
    const fix = (text: string) => ({ who: 'admin' as const, path: admin ? OAUTH_ADMIN_PATH : null, text: ask(text) });

    if (enabled && (!this.cached || Date.now() - this.cached.at > CACHE_MS)) {
      const publicUrl = await this.check('oauth.public_url');
      const wellKnown = statusOf(publicUrl) === 'pass' ? await this.check('oauth.well_known') : null;
      this.cached = { at: Date.now(), publicUrl, wellKnown };
    }
    const publicUrl = enabled ? (this.cached?.publicUrl ?? null) : null;
    const wellKnown = enabled ? (this.cached?.wellKnown ?? null) : null;

    const checks: AppPreflight['checks'] = [
      {
        id: 'oauth_enabled',
        status: enabled ? 'pass' : 'fail',
        title: 'Sign-in for AI apps is on',
        detail: enabled ? 'AI apps can ask you to sign in with your Hexactra account.' : 'The OAuth server is off: AI apps cannot sign in.',
        fix: enabled ? null : fix('Turn on the OAuth server in Administration → OAuth clients.'),
      },
      {
        id: 'public_url',
        status: !enabled ? 'skip' : publicUrl ? statusOf(publicUrl) : 'warn',
        title: 'The console is on a public HTTPS address',
        detail: !enabled ? 'Checked once sign-in for AI apps is on.' : (publicUrl?.detail ?? 'The check is not available on this deployment.'),
        fix: enabled && statusOf(publicUrl) !== 'pass' ? fix('Serve the console on a public https:// address (APP_URL) that ChatGPT and Claude can reach.') : null,
      },
      {
        id: 'well_known',
        status: !enabled || !publicUrl || statusOf(publicUrl) !== 'pass' ? 'skip' : wellKnown ? statusOf(wellKnown) : 'warn',
        title: 'The sign-in documents answer from the internet',
        detail: wellKnown?.detail ?? 'Checked once the console is on a public HTTPS address.',
        fix: wellKnown && statusOf(wellKnown) !== 'pass' && statusOf(wellKnown) !== 'skip' ? fix('Make the proxy in front of the console pass /.well-known/oauth-* to the API (Administration → Doctor shows the details).') : null,
      },
    ];

    const allowedHosts = new Set((settings?.allowedClientHosts ?? []).map((h) => h.toLowerCase()));
    const anyHost = settings?.allowAnyClientHost === true;
    const hostsAllowed = (hosts: readonly string[]) => enabled && (anyHost || hosts.every((h) => allowedHosts.has(h)));
    const hostDetail = (name: string, hosts: readonly string[]) =>
      !enabled ? 'Sign-in for AI apps is off.' : hostsAllowed(hosts) ? `${name} may connect.` : ask(`Allow ${hosts.join(' and ')} in Administration → OAuth clients.`);
    const loopback = enabled && settings?.allowLoopbackClients !== false;
    const clients: AppPreflight['clients'] = [
      { id: 'chatgpt', allowed: hostsAllowed(CLIENT_HOSTS.chatgpt), hosts: [...CLIENT_HOSTS.chatgpt], detail: hostDetail('ChatGPT', CLIENT_HOSTS.chatgpt) },
      { id: 'claude', allowed: hostsAllowed(CLIENT_HOSTS.claude), hosts: [...CLIENT_HOSTS.claude], detail: hostDetail('Claude', CLIENT_HOSTS.claude) },
      {
        id: 'claude-code',
        allowed: loopback,
        hosts: ['loopback'],
        detail: !enabled ? 'Sign-in for AI apps is off.' : loopback ? 'Claude Code may connect from your computer.' : ask('Allow loopback clients in Administration → OAuth clients.'),
      },
      { id: 'other', allowed: null, hosts: [], detail: enabled ? "The app's host must be allowed in Administration → OAuth clients, or use a personal access token." : 'Use a personal access token, or turn on sign-in for AI apps.' },
    ];

    return { mcpUrl: `${appUrl}${MCP_PATH}`, admin, ready: checks.every((c) => c.status === 'pass'), checks, clients };
  }

  /** Forget the cached probe (tests). */
  invalidate(): void {
    this.cached = null;
  }
}
