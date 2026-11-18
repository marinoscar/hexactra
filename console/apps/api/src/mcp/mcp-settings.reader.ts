// The `mcp` system settings as the request path reads them (#465): cached for
// at most five seconds, so the kill switch and the rate limits cost no
// database read per request and a change takes effect within a few seconds
// (the admin page says so). A read that fails keeps the last good value, or
// the defaults: the switch never turns into an outage of the settings store.
import { Injectable, Logger, Optional } from '@nestjs/common';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { resolveMcpSettings, type ResolvedMcpSettings } from './mcp.settings';

/** How stale the cached settings may be. */
export const MCP_SETTINGS_CACHE_MS = 5_000;

@Injectable()
export class McpSettingsReader {
  private readonly log = new Logger(McpSettingsReader.name);
  private cached: { at: number; value: ResolvedMcpSettings } | null = null;
  private inflight: Promise<ResolvedMcpSettings> | null = null;

  constructor(@Optional() private readonly settings?: SystemSettingsService) {}

  /** The wall clock; tests replace it. */
  clock: () => number = Date.now;

  /** The resolved `mcp` namespace, at most `MCP_SETTINGS_CACHE_MS` old. */
  async read(): Promise<ResolvedMcpSettings> {
    const now = this.clock();
    if (this.cached && now - this.cached.at < MCP_SETTINGS_CACHE_MS) return this.cached.value;
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(): Promise<ResolvedMcpSettings> {
    try {
      const v = await this.settings?.getNamespace('mcp');
      const value = resolveMcpSettings(v ?? null);
      this.cached = { at: this.clock(), value };
      return value;
    } catch (e) {
      this.log.warn(`mcp settings could not be read (${e instanceof Error ? e.name : 'error'}); using the last known values`);
      const value = this.cached?.value ?? resolveMcpSettings(null);
      this.cached = { at: this.clock(), value };
      return value;
    }
  }

  /** Forget the cached value (tests, and right after this process changed the settings). */
  invalidate(): void {
    this.cached = null;
  }
}
