import { Injectable, Logger } from '@nestjs/common';

/** Something that uses a connection: a task, a delivery, a trigger. Named so the owner can see what a removal affects. */
export interface ConnectionUsage {
  kind: string;
  id: string;
  name: string;
}

/**
 * A feature that references connections (deliveries E39.6, agent tools E39.7, triggers E39.8) registers a source, so that
 * removing a connection lists what uses it (the Disconnect dialog) and clears the references (those tasks show "connection
 * removed"). Nothing registers one yet in E39.2: the registry is the seam.
 */
export interface ConnectionUsageSource {
  readonly kind: string;
  list(userId: string, connectionId: string): Promise<ConnectionUsage[]>;
  clear(userId: string, connectionId: string): Promise<void>;
}

@Injectable()
export class ConnectionUsageRegistry {
  private readonly log = new Logger(ConnectionUsageRegistry.name);
  private readonly sources = new Map<string, ConnectionUsageSource>();

  register(source: ConnectionUsageSource): void {
    this.sources.set(source.kind, source);
  }

  unregister(kind: string): void {
    this.sources.delete(kind);
  }

  async list(userId: string, connectionId: string): Promise<ConnectionUsage[]> {
    const out: ConnectionUsage[] = [];
    for (const s of this.sources.values()) {
      try {
        out.push(...(await s.list(userId, connectionId)));
      } catch (e) {
        this.log.warn(`connection usage ${s.kind} could not be listed (${e instanceof Error ? e.name : 'error'})`);
      }
    }
    return out;
  }

  /** Clears every reference. A source that fails is reported and does not stop the removal (the references then point at nothing and show "connection removed"). */
  async clear(userId: string, connectionId: string): Promise<void> {
    for (const s of this.sources.values()) {
      try {
        await s.clear(userId, connectionId);
      } catch (e) {
        this.log.warn(`connection usage ${s.kind} could not be cleared (${e instanceof Error ? e.name : 'error'})`);
      }
    }
  }
}
