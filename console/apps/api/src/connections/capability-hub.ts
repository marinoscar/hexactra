// The provider-neutral front door of the capability interfaces (E39.3, #601). `hub.mail(ctx)`, `hub.calendar(ctx)` and
// `hub.documents(ctx)` return objects bound to one connection; the provider is resolved from the connection (a Google account
// gets the Google adapter, a Microsoft one the Microsoft adapter). Every method call goes through the same steps, so no adapter
// and no caller can skip one:
//
//   1. the caller's signal is checked;
//   2. the connection is read NOW (its status, switches and grants may have changed since the caller chose it): paused and
//      needs-reconnect accounts fail with their typed error;
//   3. the capability gate: a capability that is off is CAPABILITY_OFF, one the provider did not grant is PERMISSION_MISSING.
//      Both happen BEFORE any network request;
//   4. the arguments are validated against the method's schema (INVALID_INPUT, with paths and never values) and checked against
//      the limits;
//   5. the adapter runs with the validated arguments;
//   6. its result is validated against the result schema (no provider type or extra field gets out), the output limits are
//      applied (`truncated`), and the use is recorded;
//   7. any failure becomes a `CapabilityError`: the token service's `ConnectionError` is translated, an unknown exception is a
//      PROVIDER_ERROR with no message copied.
//
// It has no Nest or Prisma dependency: `ConnectionCapabilities` (connection-capabilities.service.ts) wires the database lookup,
// and tests build one over `InMemoryConnections` (connections/testing/).
import type { z } from 'zod';

import {
  CAPABILITY_METHODS,
  CapabilityError,
  capabilitiesNeeded,
  checkInputLimits,
  limitResult,
  resolveLimits,
  type CalendarCapability,
  type CapabilityContext,
  type CapabilityLimits,
  type CapabilityProvider,
  type CapabilityService,
  type ConnectionContext,
  type DocumentsCapability,
  type MailCapability,
  type MethodSpec,
} from './capabilities';
import type { CapabilityProviderRegistry } from './capability-provider.registry';
import type { Capability, ConnectionProviderId } from './connections.constants';
import { ConnectionError } from './connections.errors';

/** The connection as the hub needs it: what the owner switched on and what the provider granted. */
export interface CapabilityConnection {
  id: string;
  userId: string;
  provider: ConnectionProviderId;
  label: string;
  accountEmail: string;
  /** The switches that are on. */
  capabilities: Capability[];
  /** What the provider granted. */
  granted: Capability[];
  status: 'active' | 'paused' | 'needs_reconnect' | 'revoked';
  statusReason: string | null;
}

export interface CapabilityHubDeps {
  /** The connection for this caller, or null (also when it is another user's). */
  lookup(ctx: ConnectionContext): Promise<CapabilityConnection | null>;
  providers: CapabilityProviderRegistry;
  /** Records a successful use ("last used" on the page). */
  markUsed?(userId: string, connectionId: string): Promise<void>;
  limits?: Partial<CapabilityLimits>;
}

const issuePaths = (error: z.ZodError): string[] => [...new Set(error.issues.map((i) => i.path.join('.') || '(root)'))].slice(0, 20);

/** Whatever an adapter or the token service threw, as the one error callers handle. Never copies a message. */
export function toCapabilityError(e: unknown, ctx: { signal?: AbortSignal }): CapabilityError {
  if (e instanceof CapabilityError) return e;
  if (e instanceof ConnectionError) {
    const label = typeof e.details?.label === 'string' ? e.details.label : undefined;
    switch (e.code) {
      case 'CONNECTION_NEEDS_RECONNECT':
        return new CapabilityError('CONNECTION_NEEDS_RECONNECT', { label, reason: typeof e.details?.reason === 'string' ? e.details.reason : undefined });
      case 'CONNECTION_PAUSED':
        return new CapabilityError('CONNECTION_PAUSED', { label });
      case 'CONNECTION_NOT_FOUND':
        return new CapabilityError('CONNECTION_NOT_FOUND');
      case 'CONNECTION_UNAVAILABLE':
        return new CapabilityError('PROVIDER_ERROR', { status: 503, reason: typeof e.details?.reason === 'string' ? e.details.reason : 'unavailable' });
      default:
        return new CapabilityError('PROVIDER_ERROR', { status: 0, reason: e.code });
    }
  }
  if (ctx.signal?.aborted || (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError'))) return new CapabilityError('ABORTED');
  return new CapabilityError('PROVIDER_ERROR', { status: 0 });
}

export class CapabilityHub {
  readonly limits: CapabilityLimits;

  constructor(private readonly deps: CapabilityHubDeps) {
    this.limits = resolveLimits(deps.limits);
  }

  mail(ctx: ConnectionContext): MailCapability {
    return this.bind<MailCapability>('mail', ctx);
  }

  calendar(ctx: ConnectionContext): CalendarCapability {
    return this.bind<CalendarCapability>('calendar', ctx);
  }

  documents(ctx: ConnectionContext): DocumentsCapability {
    return this.bind<DocumentsCapability>('documents', ctx);
  }

  private bind<T>(service: CapabilityService, ctx: ConnectionContext): T {
    const out: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(CAPABILITY_METHODS[service] as Record<string, MethodSpec>)) {
      out[name] = (...args: unknown[]) => this.call(service, name, spec, ctx, args);
    }
    return out as T;
  }

  private async call(service: CapabilityService, method: string, spec: MethodSpec, ctx: ConnectionContext, args: unknown[]): Promise<unknown> {
    try {
      if (ctx.signal?.aborted) throw new CapabilityError('ABORTED');
      const conn = await this.deps.lookup(ctx);
      if (!conn) throw new CapabilityError('CONNECTION_NOT_FOUND');
      if (conn.status === 'paused') throw new CapabilityError('CONNECTION_PAUSED', { label: conn.label });
      if (conn.status !== 'active') throw new CapabilityError('CONNECTION_NEEDS_RECONNECT', { label: conn.label, reason: conn.statusReason ?? 'NEEDS_RECONNECT' });

      // The gate, before any request: the switches first (the owner's decision), then the grants (the provider's).
      const needed = capabilitiesNeeded(spec, args);
      for (const capability of needed) if (!conn.capabilities.includes(capability)) throw new CapabilityError('CAPABILITY_OFF', { capability, label: conn.label });
      for (const capability of needed) if (!conn.granted.includes(capability)) throw new CapabilityError('PERMISSION_MISSING', { capability, label: conn.label, reason: 'SCOPE' });

      const parsed = spec.args.safeParse(args);
      if (!parsed.success) throw new CapabilityError('INVALID_INPUT', { issues: issuePaths(parsed.error) });
      checkInputLimits(service, method, parsed.data, this.limits);

      const provider: CapabilityProvider | undefined = this.deps.providers.get(conn.provider);
      const cctx: CapabilityContext = { ...ctx, limits: this.limits, connection: { provider: conn.provider, label: conn.label, accountEmail: conn.accountEmail, capabilities: conn.capabilities } };
      const impl = provider?.[service]?.(cctx) as Record<string, (...a: unknown[]) => Promise<unknown>> | undefined;
      const fn = impl?.[method];
      if (!fn) throw new CapabilityError('NOT_SUPPORTED', { reason: provider ? 'OPERATION' : 'PROVIDER' });

      const raw = await fn.apply(impl, parsed.data);
      const checked = spec.result.safeParse(raw);
      if (!checked.success) throw new CapabilityError('PROVIDER_ERROR', { status: 502, reason: 'BAD_RESPONSE' });
      const result = limitResult(service, method, checked.data, this.limits);
      await this.deps.markUsed?.(ctx.userId, ctx.connectionId).catch(() => undefined);
      return result;
    } catch (e) {
      throw toCapabilityError(e, ctx);
    }
  }
}
