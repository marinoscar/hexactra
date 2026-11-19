// The Microsoft provider (E39.4, #602): the sign-in adapter (`MicrosoftConnectionAdapter`) and the capability implementation
// (`MicrosoftCapabilityProvider`: mail, calendar and documents through Graph), registered by `MicrosoftConnectionsModule`.
import type { CalendarCapability, CapabilityContext, CapabilityProvider, DocumentsCapability, MailCapability } from '../capabilities';
import { GraphClient, type GraphClientOptions } from './graph-client';
import { MicrosoftCalendar } from './microsoft.calendar';
import { MicrosoftDocuments } from './microsoft.documents';
import { MicrosoftFolders, MicrosoftMail, SendDedupe } from './microsoft.mail';

export class MicrosoftCapabilityProvider implements CapabilityProvider {
  readonly provider = 'microsoft' as const;
  private readonly shared: { folders: MicrosoftFolders; dedupe: SendDedupe };

  constructor(
    readonly graph: GraphClient,
    now: () => number = Date.now,
  ) {
    this.shared = { folders: new MicrosoftFolders(now), dedupe: new SendDedupe(now) };
  }

  mail(ctx: CapabilityContext): MailCapability {
    return new MicrosoftMail(this.graph, ctx, this.shared);
  }

  calendar(ctx: CapabilityContext): CalendarCapability {
    return new MicrosoftCalendar(this.graph, ctx);
  }

  documents(ctx: CapabilityContext): DocumentsCapability {
    return new MicrosoftDocuments(this.graph, ctx);
  }
}

export const createMicrosoftCapabilityProvider = (opts: GraphClientOptions & { now?: () => number }): MicrosoftCapabilityProvider => new MicrosoftCapabilityProvider(new GraphClient(opts), opts.now);
