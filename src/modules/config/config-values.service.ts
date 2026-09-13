import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigValue, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EventBus } from '../../common/events/event-bus.service';

/**
 * Seuils versionnés (blueprint §4.18) : plafonds pilote, cut-offs, TTL, SLA…
 * Une valeur est la ligne dont effectiveFrom <= now et (effectiveTo null ou
 * futur), la plus récente gagnant. Cache mémoire de 30 s.
 *
 * `set()` n'est PAS exposé en HTTP ici : la modification passe par le
 * maker-checker (action CONFIG_CHANGE, module approvals), dont l'exécuteur
 * appelle `set(key, value, makerId, checkerId)`.
 */
@Injectable()
export class ConfigValuesService {
  static readonly CACHE_TTL_MS = 30_000;

  private readonly cache = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(private readonly prisma: PrismaService, private readonly events: EventBus) {}

  async get<T>(key: string): Promise<T | undefined>;
  async get<T>(key: string, fallback: T): Promise<T>;
  async get<T>(key: string, fallback?: T): Promise<T | undefined> {
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      return (cached.value === undefined ? fallback : cached.value) as T | undefined;
    }
    const row = await this.current(key, new Date(now));
    const value = row ? (row.value as unknown) : undefined;
    this.cache.set(key, { value, expiresAt: now + ConfigValuesService.CACHE_TTL_MS });
    return (value === undefined ? fallback : value) as T | undefined;
  }

  /** Current effective row for a key, or null. */
  current(key: string, at: Date = new Date()): Promise<ConfigValue | null> {
    return this.prisma.configValue.findFirst({
      where: {
        key,
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      orderBy: { effectiveFrom: 'desc' },
    });
  }

  /** Closes the current row (effectiveTo = now) and inserts the new value. */
  async set(key: string, value: Prisma.InputJsonValue, actorId: string | null, approvedById?: string | null): Promise<ConfigValue> {
    const now = new Date();
    const previous = await this.current(key, now);
    const created = await this.prisma.$transaction(async (db) => {
      await db.configValue.updateMany({
        where: { key, effectiveTo: null, effectiveFrom: { lte: now } },
        data: { effectiveTo: now },
      });
      return db.configValue.create({
        data: { key, value, effectiveFrom: now, createdById: actorId, approvedById: approvedById ?? null },
      });
    });
    this.cache.delete(key);
    await this.events.publish('ConfigChanged', {
      entityType: 'ConfigValue',
      entityId: created.id,
      actor: actorId ?? 'SYSTEM',
      payload: { key, before: previous?.value ?? null, after: value, approvedById: approvedById ?? null },
    });
    return created;
  }

  /** Every key with its currently effective value. */
  async list(): Promise<ConfigValue[]> {
    const now = new Date();
    const rows = await this.prisma.configValue.findMany({
      where: { effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
      orderBy: [{ key: 'asc' }, { effectiveFrom: 'desc' }],
    });
    const seen = new Set<string>();
    return rows.filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)));
  }

  /** Full version history of one key, newest first. */
  async history(key: string): Promise<ConfigValue[]> {
    const rows = await this.prisma.configValue.findMany({ where: { key }, orderBy: { effectiveFrom: 'desc' } });
    if (rows.length === 0) throw new NotFoundException(`Paramètre inconnu : ${key}.`);
    return rows;
  }

  /** Drops the in-memory cache (tests, or after a bulk import). */
  invalidate(key?: string): void {
    if (key) this.cache.delete(key);
    else this.cache.clear();
  }
}
