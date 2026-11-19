// The deployment-wide limits of mail triggers, read from the `mailTriggers` system settings (a few seconds' cache). Without the
// settings service (a unit test) the defaults apply.
import { Injectable, Optional } from '@nestjs/common';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { DEFAULT_MAIL_TRIGGER_LIMITS, type MailTriggerLimits } from './mail-triggers.constants';
import { resolveMailTriggerLimits, type MailTriggersSettings } from './mail-triggers.settings';

const CACHE_MS = 5_000;

@Injectable()
export class MailTriggerLimitsService {
  private cached: { at: number; value: MailTriggerLimits } | null = null;
  /** Tests replace the clock and may set `override`. */
  clock: () => number = Date.now;
  override: Partial<MailTriggerLimits> | null = null;

  constructor(@Optional() private readonly settings?: SystemSettingsService) {}

  async get(): Promise<MailTriggerLimits> {
    if (this.override) return { ...DEFAULT_MAIL_TRIGGER_LIMITS, ...this.override };
    const now = this.clock();
    if (this.cached && now - this.cached.at < CACHE_MS) return this.cached.value;
    let value: MailTriggerLimits = { ...DEFAULT_MAIL_TRIGGER_LIMITS };
    try {
      value = resolveMailTriggerLimits((await this.settings?.getNamespace('mailTriggers')) as MailTriggersSettings | null | undefined);
    } catch {
      // A settings read that fails leaves the defaults: triggers keep working within them.
    }
    this.cached = { at: now, value };
    return value;
  }

  invalidate(): void {
    this.cached = null;
  }
}
