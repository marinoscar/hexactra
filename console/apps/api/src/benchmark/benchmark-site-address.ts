// Where a node's browser reaches the challenge site, and whether it can (E44.3, #741). A check of the settings, never a network call.
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { benchmarkSiteBaseUrl, resolveBenchmarkSettings, type BenchmarkSettings } from './benchmark.settings';

export interface SiteAddress {
  /** Without a trailing slash; a trial's pages are under `<baseUrl>/t/<token>/`. */
  baseUrl: string;
  /** The host a trial run is limited to (its only allowed site). Empty when the address is not a URL. */
  host: string;
  reachable: boolean;
  /** Why a node cannot reach it; null when it can. */
  problem: string | null;
}

const LOOPBACK = /^(localhost|.*\.localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])$/i;

/**
 * The address and whether a node can reach it. The default is the console's public URL plus `/benchmark`: on a deployment that is the
 * console's own name, which every node already reaches. A loopback default (a development build, or `APP_URL` never set) is refused,
 * because a node on another machine would open its own localhost. An administrator who set `benchmark.siteBaseUrl` chose the address
 * deliberately (a node on the same machine, a tunnel), so it is taken as given.
 */
export function siteAddress(settings: Pick<BenchmarkSettings, 'siteBaseUrl'>, consolePublicUrl: string): SiteAddress {
  const baseUrl = benchmarkSiteBaseUrl(settings, consolePublicUrl);
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { baseUrl, host: '', reachable: false, problem: 'The challenge site has no address: set the console\'s public URL (APP_URL) or the system setting benchmark.siteBaseUrl.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { baseUrl, host: '', reachable: false, problem: `The challenge site's address ${baseUrl} is not an http(s) URL.` };
  if (!settings.siteBaseUrl && LOOPBACK.test(url.hostname)) {
    return { baseUrl, host: url.hostname, reachable: false, problem: `The challenge site's address is ${baseUrl}, which a node on another machine cannot reach. Set the console's public URL (APP_URL), or the system setting benchmark.siteBaseUrl to an address the nodes reach.` };
  }
  return { baseUrl, host: url.hostname.toLowerCase(), reachable: true, problem: null };
}

@Injectable()
export class BenchmarkSiteAddress {
  constructor(
    private readonly settings: SystemSettingsService,
    private readonly config: ConfigService,
  ) {}

  async settingsNow(): Promise<BenchmarkSettings> {
    return resolveBenchmarkSettings(await this.settings.getNamespace('benchmark'));
  }

  async read(): Promise<SiteAddress> {
    return siteAddress(await this.settingsNow(), this.config.get<string>('appUrl') ?? '');
  }
}
