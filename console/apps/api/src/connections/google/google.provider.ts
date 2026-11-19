import type { CalendarCapability, CapabilityContext, CapabilityProvider, DocumentsCapability, MailCapability } from '../capabilities';
import { GoogleCalendar } from './google-calendar';
import { GoogleDocuments } from './google-docs';
import { GoogleHttp, type TokenSource } from './google-http';
import { GoogleMail } from './gmail';

/** Google's implementation of the neutral capability interfaces: Gmail, Calendar, and Drive, Docs and Sheets. */
export class GoogleCapabilityProvider implements CapabilityProvider {
  readonly provider = 'google' as const;

  constructor(
    private readonly http: GoogleHttp,
    private readonly tokens: TokenSource,
  ) {}

  mail(ctx: CapabilityContext): MailCapability {
    return new GoogleMail(ctx, this.http, this.tokens);
  }

  calendar(ctx: CapabilityContext): CalendarCapability {
    return new GoogleCalendar(ctx, this.http, this.tokens);
  }

  documents(ctx: CapabilityContext): DocumentsCapability {
    return new GoogleDocuments(ctx, this.http, this.tokens);
  }
}
