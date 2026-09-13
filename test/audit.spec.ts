import { SupportedCountry, UserRole } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { EventBus } from '../src/common/events/event-bus.service';
import { AuditService, canonicalJson, computeAuditHash } from '../src/common/services/audit.service';
import { resetDatabase } from './helpers/db';

describe('AuditService (hash chain)', () => {
  const prisma = new PrismaService();
  const audit = new AuditService(prisma);
  let adminId: string;

  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const admin = await prisma.user.create({
      data: {
        fullName: 'Admin Audit', email: 'audit-admin@alke.test', phone: '+237690000020', passwordHash: 'x',
        country: SupportedCountry.CMR, referralCode: 'AUDIT1', role: UserRole.ADMIN,
      },
    });
    adminId = admin.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('canonical JSON is key-order independent and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [3, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('chains rows by prevHash/hash, resolves actor role, and verifies clean', async () => {
    const r1 = await audit.log({ actorUserId: adminId, action: 'MARKET_UPDATED', entityType: 'Market', entityId: 'm-1', before: { status: 'A' }, after: { status: 'B' } });
    const r2 = await audit.log({ action: 'JOB_RUN', entityType: 'Job', entityId: 'nightly' }, { correlationId: 'corr-1' });
    const r3 = await audit.log({ actorUserId: adminId, actorRole: 'COMPLIANCE', action: 'CASE_OPENED', entityType: 'ComplianceCase', entityId: 'c-1', after: { amount: 10n } });

    expect(r1.prevHash).toBeNull();
    expect(r2.prevHash).toBe(r1.hash);
    expect(r3.prevHash).toBe(r2.hash);
    expect(r1.actorRole).toBe('ADMIN'); // lu depuis User.role
    expect(r1.actorType).toBe('ADMIN');
    expect(r2.actorType).toBe('SYSTEM');
    expect(r2.correlationId).toBe('corr-1');
    expect(r3.actorRole).toBe('COMPLIANCE'); // explicite, prime sur la base
    expect(r3.afterJson).toEqual({ amount: '10' });

    const result = await audit.verifyChain();
    expect(result).toEqual({ ok: true, checked: 3 });
  });

  it('writes one row per domain event with the right actorType', async () => {
    const events = new EventBus();
    events.subscribe('*', async (e) => {
      await audit.recordEvent(e);
    });
    await events.publish('UserLoggedIn', { entityType: 'User', entityId: adminId, actor: adminId, payload: { ip: '127.0.0.1' } });
    await events.publish('BatchSent', { entityType: 'OrderBatch', entityId: 'b-1', actor: 'SYSTEM', payload: {} });
    await events.publish('BatchAcknowledged', { entityType: 'OrderBatch', entityId: 'b-1', actor: 'SDB_FILE', payload: { file: 'ACK.csv' } });
    await events.publish('DepositConfirmed', { entityType: 'PaymentIntent', entityId: 'pi-1', actor: 'PROVIDER:MTN_MOMO', payload: {} });

    const rows = await prisma.auditLog.findMany({ orderBy: { seq: 'asc' } });
    expect(rows.map((r) => [r.action, r.actorType, r.actorUserId])).toEqual([
      ['UserLoggedIn', 'ADMIN', adminId],
      ['BatchSent', 'SYSTEM', null],
      ['BatchAcknowledged', 'SDB_FILE', null],
      ['DepositConfirmed', 'PROVIDER', null],
    ]);
    expect(rows[0].correlationId).toBeTruthy();
    expect((await audit.verifyChain()).ok).toBe(true);
  });

  it('detects tampering: a raw UPDATE breaks the chain at that seq', async () => {
    await audit.log({ action: 'A', entityType: 'T', entityId: '1' });
    const target = await audit.log({ action: 'B', entityType: 'T', entityId: '2', after: { v: 1 } });
    await audit.log({ action: 'C', entityType: 'T', entityId: '3' });
    await audit.log({ action: 'D', entityType: 'T', entityId: '4' });
    expect((await audit.verifyChain()).ok).toBe(true);

    await prisma.$executeRaw`UPDATE "AuditLog" SET "afterJson" = '{"v":2}'::jsonb WHERE "seq" = ${target.seq}`;
    const broken = await audit.verifyChain();
    expect(broken.ok).toBe(false);
    expect(broken.brokenAtSeq).toBe(Number(target.seq));
    expect(broken.checked).toBe(Number(target.seq) - 1);

    // Restoring the value repairs the chain; re-hashing the row alone would not (prevHash of the next row).
    await prisma.$executeRaw`UPDATE "AuditLog" SET "afterJson" = '{"v":1}'::jsonb WHERE "seq" = ${target.seq}`;
    expect((await audit.verifyChain()).ok).toBe(true);
    const forged = computeAuditHash(target.prevHash, {
      actorUserId: null, actorRole: null, actorType: 'SYSTEM', action: 'B', entityType: 'T', entityId: '2',
      beforeJson: null, afterJson: { v: 2 }, ipAddress: null, correlationId: null, createdAt: target.createdAt,
    });
    await prisma.$executeRaw`UPDATE "AuditLog" SET "afterJson" = '{"v":2}'::jsonb, "hash" = ${forged} WHERE "seq" = ${target.seq}`;
    const next = await audit.verifyChain();
    expect(next.ok).toBe(false);
    expect(next.brokenAtSeq).toBe(Number(target.seq) + 1);

    // Deleting a row is also detected.
    await prisma.$executeRaw`UPDATE "AuditLog" SET "afterJson" = '{"v":1}'::jsonb, "hash" = ${target.hash} WHERE "seq" = ${target.seq}`;
    await prisma.$executeRaw`DELETE FROM "AuditLog" WHERE "seq" = ${target.seq}`;
    expect((await audit.verifyChain()).ok).toBe(false);
  });

  it('verifyChain(fromSeq) checks a suffix against its predecessor', async () => {
    for (let i = 0; i < 5; i++) await audit.log({ action: `E${i}`, entityType: 'T', entityId: String(i) });
    expect(await audit.verifyChain(3)).toEqual({ ok: true, checked: 3 });
  });
});
