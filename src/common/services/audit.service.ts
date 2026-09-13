import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { DomainEvent } from '../events/domain-events';

/**
 * Journal d'audit — CDC module 9.4, blueprint v3.2 §4.12 : append-only et
 * chaîné par hash. Chaque ligne porte `prevHash` (hash de la ligne précédente
 * par `seq`) et `hash = sha256(prevHash|canonicalJson)`. Toute modification
 * ou suppression d'une ligne casse la vérification (`verifyChain`).
 *
 * L'écriture est sérialisée par un verrou consultatif Postgres (transaction)
 * pour que deux écrivains concurrents ne lisent pas le même « dernier hash ».
 */

export type AuditActorType = 'USER' | 'ADMIN' | 'SYSTEM' | 'SDB_FILE' | 'PROVIDER';

export interface AuditLogParams {
  actorUserId?: string | null;
  actorRole?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
}

export interface AuditContext {
  actorRole?: string | null;
  actorType?: AuditActorType;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export interface AuditChainVerification {
  ok: boolean;
  checked: number;
  brokenAtSeq?: number;
}

type CanonicalRow = {
  actorUserId: string | null;
  actorRole: string | null;
  actorType: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeJson: unknown;
  afterJson: unknown;
  ipAddress: string | null;
  correlationId: string | null;
  createdAt: Date;
};

const ADVISORY_LOCK_KEY = 42;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADMIN_ROLES = new Set(['ADMIN', 'SUPPORT', 'COMPLIANCE']);

/** JSON.stringify with recursively sorted object keys (stable across writers/readers). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const src = value as Record<string, unknown>;
    return Object.keys(src)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        if (src[key] !== undefined) acc[key] = sortKeys(src[key]);
        return acc;
      }, {});
  }
  return value;
}

/** Makes an arbitrary value storable in a Json column (BigInt → string, Decimal/Date → their JSON form). */
function toJsonValue(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  if (text === undefined) return undefined;
  return JSON.parse(text) as Prisma.InputJsonValue;
}

export function computeAuditHash(prevHash: string | null, row: CanonicalRow): string {
  const canonical = canonicalJson({
    actorUserId: row.actorUserId ?? null,
    actorRole: row.actorRole ?? null,
    actorType: row.actorType,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    beforeJson: row.beforeJson ?? null,
    afterJson: row.afterJson ?? null,
    ipAddress: row.ipAddress ?? null,
    correlationId: row.correlationId ?? null,
    createdAt: row.createdAt.toISOString(),
  });
  return createHash('sha256').update(`${prevHash ?? ''}|${canonical}`).digest('hex');
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private prisma: PrismaService) {}

  async log(params: AuditLogParams, context: AuditContext = {}) {
    const actorUserId = params.actorUserId ?? null;
    const actorRole = params.actorRole ?? context.actorRole ?? (await this.resolveActorRole(actorUserId));
    const actorType: AuditActorType =
      context.actorType ?? (actorUserId ? (actorRole && ADMIN_ROLES.has(actorRole) ? 'ADMIN' : 'USER') : 'SYSTEM');

    return this.append({
      actorUserId,
      actorRole,
      actorType,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      beforeJson: toJsonValue(params.before),
      afterJson: toJsonValue(params.after),
      ipAddress: params.ipAddress ?? context.ipAddress ?? null,
      correlationId: context.correlationId ?? null,
    });
  }

  /** Event-bus subscriber: one audit row per domain event (wired in CommonModule). */
  async recordEvent(event: DomainEvent) {
    const actor = event.actor ?? 'SYSTEM';
    let actorType: AuditActorType = 'USER';
    if (actor === 'SYSTEM') actorType = 'SYSTEM';
    else if (actor === 'SDB_FILE') actorType = 'SDB_FILE';
    else if (actor.startsWith('PROVIDER:')) actorType = 'PROVIDER';

    const actorUserId = UUID_RE.test(actor) ? actor : null;
    const actorRole = await this.resolveActorRole(actorUserId);
    if (actorType === 'USER' && actorRole && ADMIN_ROLES.has(actorRole)) actorType = 'ADMIN';

    return this.append({
      actorUserId,
      actorRole,
      actorType,
      action: event.name,
      entityType: event.entityType,
      entityId: event.entityId,
      beforeJson: undefined,
      afterJson: toJsonValue(event.payload),
      ipAddress: null,
      correlationId: event.correlationId ?? null,
    });
  }

  /** The actor's role is read from the User row when the caller did not pass it (legacy `log` callers). */
  private async resolveActorRole(actorUserId: string | null): Promise<string | null> {
    if (!actorUserId || !UUID_RE.test(actorUserId)) return null;
    const user = await this.prisma.user.findUnique({ where: { id: actorUserId }, select: { role: true } });
    return user?.role ?? null;
  }

  private async append(row: Omit<CanonicalRow, 'createdAt' | 'beforeJson' | 'afterJson'> & {
    beforeJson: Prisma.InputJsonValue | undefined;
    afterJson: Prisma.InputJsonValue | undefined;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`;
      const last = await tx.auditLog.findFirst({ orderBy: { seq: 'desc' }, select: { hash: true } });
      const prevHash = last?.hash ?? null;
      const createdAt = new Date();
      const hash = computeAuditHash(prevHash, { ...row, createdAt });
      return tx.auditLog.create({
        data: {
          actorUserId: row.actorUserId,
          actorRole: row.actorRole,
          actorType: row.actorType,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          beforeJson: row.beforeJson,
          afterJson: row.afterJson,
          ipAddress: row.ipAddress,
          correlationId: row.correlationId,
          prevHash,
          hash,
          createdAt,
        },
      });
    });
  }

  /**
   * Recomputes every hash from `fromSeq` (default: the first row) and checks
   * each `prevHash` against its predecessor. Stops at the first broken row.
   */
  async verifyChain(fromSeq?: number): Promise<AuditChainVerification> {
    const start = fromSeq ?? 1;
    let expectedPrev: string | null = null;
    if (start > 1) {
      const before = await this.prisma.auditLog.findFirst({
        where: { seq: { lt: BigInt(start) } },
        orderBy: { seq: 'desc' },
        select: { hash: true },
      });
      expectedPrev = before?.hash ?? null;
    }

    const PAGE = 500;
    let cursor = BigInt(start);
    let checked = 0;
    for (;;) {
      const rows = await this.prisma.auditLog.findMany({
        where: { seq: { gte: cursor } },
        orderBy: { seq: 'asc' },
        take: PAGE,
      });
      if (rows.length === 0) break;
      for (const r of rows) {
        const recomputed = computeAuditHash(r.prevHash, {
          actorUserId: r.actorUserId,
          actorRole: r.actorRole,
          actorType: r.actorType,
          action: r.action,
          entityType: r.entityType,
          entityId: r.entityId,
          beforeJson: r.beforeJson,
          afterJson: r.afterJson,
          ipAddress: r.ipAddress,
          correlationId: r.correlationId,
          createdAt: r.createdAt,
        });
        if (r.prevHash !== expectedPrev || recomputed !== r.hash) {
          this.logger.error(`audit chain broken at seq ${r.seq.toString()}`);
          return { ok: false, checked, brokenAtSeq: Number(r.seq) };
        }
        expectedPrev = r.hash;
        checked++;
      }
      if (rows.length < PAGE) break;
      cursor = rows[rows.length - 1].seq + BigInt(1);
    }
    return { ok: true, checked };
  }
}
