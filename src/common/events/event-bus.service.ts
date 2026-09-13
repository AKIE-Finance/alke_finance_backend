import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DomainEvent, DomainEventHandler, DomainEventName } from './domain-events';

/**
 * Minimal in-process event bus (blueprint §4.14: no broker at this scale).
 *
 * Semantics: `publish` awaits every handler sequentially and never throws to
 * the publisher — a failing consumer is logged, not allowed to roll back the
 * business transaction that already committed. Handlers that must be atomic
 * with the publisher's write belong inside that transaction, not on the bus.
 */
@Injectable()
export class EventBus {
  private readonly logger = new Logger(EventBus.name);
  private readonly handlers = new Map<DomainEventName | '*', DomainEventHandler[]>();

  subscribe(name: DomainEventName | '*', handler: DomainEventHandler): () => void {
    const list = this.handlers.get(name) ?? [];
    list.push(handler);
    this.handlers.set(name, list);
    return () => {
      const current = this.handlers.get(name) ?? [];
      this.handlers.set(name, current.filter((h) => h !== handler));
    };
  }

  async publish<T extends Record<string, unknown>>(
    name: DomainEventName,
    input: { entityType: string; entityId: string; actor: string; payload: T; correlationId?: string },
  ): Promise<DomainEvent<T>> {
    const event: DomainEvent<T> = {
      name,
      entityType: input.entityType,
      entityId: input.entityId,
      actor: input.actor,
      correlationId: input.correlationId ?? randomUUID(),
      occurredAt: new Date(),
      payload: input.payload,
    };
    const targets = [...(this.handlers.get(name) ?? []), ...(this.handlers.get('*') ?? [])];
    for (const handler of targets) {
      try {
        await handler(event as DomainEvent);
      } catch (err) {
        this.logger.error(`handler for ${name} failed: ${(err as Error).message}`, (err as Error).stack);
      }
    }
    return event;
  }
}
