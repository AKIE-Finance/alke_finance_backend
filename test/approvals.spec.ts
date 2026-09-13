import { ForbiddenException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { ApprovalState, MarketStatus, UserRole } from '@prisma/client';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { EventsModule } from '../src/common/events/events.module';
import { EventBus } from '../src/common/events/event-bus.service';
import { DomainEvent } from '../src/common/events/domain-events';
import { CommonModule } from '../src/common/common.module';
import { LedgerModule } from '../src/modules/ledger/ledger.module';
import { ConfigValuesModule } from '../src/modules/config/config-values.module';
import { ConfigValuesService } from '../src/modules/config/config-values.service';
import { ApprovalsModule } from '../src/modules/approvals/approvals.module';
import { ApprovalsService } from '../src/modules/approvals/approvals.service';
import { StorageModule } from '../src/modules/storage/storage.module';
import { UsersModule } from '../src/modules/users/users.module';
import { UsersService } from '../src/modules/users/users.service';
import { resetDatabase } from './helpers/db';
import { createMarket, createUser } from './helpers/brokerage-fixtures';

describe('Approvals — maker-checker (blueprint §4.17)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let approvals: ApprovalsService;
  let users: UsersService;
  let configValues: ConfigValuesService;
  const published: DomainEvent[] = [];
  let adminId: string;
  let complianceId: string;
  let supportId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        EventsModule,
        CommonModule,
        LedgerModule,
        ConfigValuesModule,
        StorageModule,
        ApprovalsModule,
        UsersModule,
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    approvals = moduleRef.get(ApprovalsService);
    users = moduleRef.get(UsersService);
    configValues = moduleRef.get(ConfigValuesService);
    moduleRef.get(EventBus).subscribe('*', (e) => {
      published.push(e);
    });
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    configValues.invalidate();
    published.length = 0;
    adminId = (await createUser(prisma, { role: UserRole.ADMIN })).id;
    complianceId = (await createUser(prisma, { role: UserRole.COMPLIANCE })).id;
    supportId = (await createUser(prisma, { role: UserRole.SUPPORT })).id;
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('refuses a maker validating their own request (403) and a non-staff checker (403)', async () => {
    const market = await createMarket(prisma, { liveTrading: false });
    const approval = await approvals.request({
      actionType: 'LIVE_TRADING_TOGGLE', entityType: 'Market', entityId: market.id,
      payload: { marketId: market.id, liveTrading: true }, reason: 'Ouverture BVMAC', makerId: adminId,
    });
    expect(approval.state).toBe(ApprovalState.PENDING);
    expect(published.map((e) => e.name)).toContain('ApprovalRequested');

    await expect(approvals.approve(approval.id, adminId)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(approvals.approve(approval.id, supportId)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(approvals.reject(approval.id, adminId, 'non')).rejects.toBeInstanceOf(ForbiddenException);
    const still = await prisma.pendingApproval.findUniqueOrThrow({ where: { id: approval.id } });
    expect(still.state).toBe(ApprovalState.PENDING);
    expect((await prisma.market.findUniqueOrThrow({ where: { id: market.id } })).liveTrading).toBe(false);

    // Requests without a reason are refused up-front.
    await expect(
      approvals.request({ actionType: 'LIVE_TRADING_TOGGLE', payload: { marketId: market.id, liveTrading: true }, reason: '  ', makerId: adminId }),
    ).rejects.toThrow('motif');
  });

  it('LIVE_TRADING_TOGGLE: a second approver flips Market.liveTrading and the request ends EXECUTED', async () => {
    const market = await createMarket(prisma, { liveTrading: false });
    const approval = await approvals.request({
      actionType: 'LIVE_TRADING_TOGGLE', entityType: 'Market', entityId: market.id,
      payload: { marketId: market.id, liveTrading: true }, reason: 'Convention SDB signée', makerId: adminId,
    });
    const done = await approvals.approve(approval.id, complianceId, 'OK');
    expect(done.state).toBe(ApprovalState.EXECUTED);
    expect(done.checkerId).toBe(complianceId);
    expect(done.executedAt).not.toBeNull();
    expect(done.error).toBeNull();

    const after = await prisma.market.findUniqueOrThrow({ where: { id: market.id } });
    expect(after.liveTrading).toBe(true);
    expect(after.status).toBe(MarketStatus.LIVE);

    const names = published.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['ApprovalRequested', 'ApprovalDecided', 'MarketLiveTradingChanged', 'ApprovalExecuted']));
    const actions = (await prisma.auditLog.findMany({ orderBy: { seq: 'asc' } })).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['APPROVAL_REQUESTED', 'APPROVAL_APPROVED', 'MARKET_LIVE_TRADING_CHANGED', 'APPROVAL_EXECUTED']));

    // A decided request cannot be approved twice.
    await expect(approvals.approve(approval.id, complianceId)).rejects.toThrow('déjà été traitée');
  });

  it('an executor that throws leaves the request FAILED with the error, never a 500', async () => {
    const missing = await approvals.request({
      actionType: 'LIVE_TRADING_TOGGLE', payload: { marketId: '00000000-0000-0000-0000-000000000000', liveTrading: true },
      reason: 'Marché fantôme', makerId: adminId,
    });
    const failed = await approvals.approve(missing.id, complianceId);
    expect(failed.state).toBe(ApprovalState.FAILED);
    expect(failed.error).toBe('Marché introuvable.');

    approvals.registerExecutor('INSTRUMENT_ACTIVATION', async () => {
      throw new Error('boum');
    });
    const boom = await approvals.request({ actionType: 'INSTRUMENT_ACTIVATION', payload: { instrumentId: 'x' }, reason: 'Test', makerId: adminId });
    const result = await approvals.approve(boom.id, complianceId);
    expect(result.state).toBe(ApprovalState.FAILED);
    expect(result.error).toBe('boum');

    // No executor at all is also a FAILED, not a crash.
    const orphan = await approvals.request({ actionType: 'WITHDRAWAL_OVERRIDE', payload: { intentId: 'x' }, reason: 'Test', makerId: adminId });
    const orphanResult = await approvals.approve(orphan.id, complianceId);
    expect(orphanResult.state).toBe(ApprovalState.FAILED);
    expect(orphanResult.error).toContain('Aucun exécuteur');

    const audit = await prisma.auditLog.findMany({ where: { action: 'APPROVAL_FAILED' } });
    expect(audit).toHaveLength(3);
    const executed = published.filter((e) => e.name === 'ApprovalExecuted');
    expect(executed.every((e) => e.payload.state === ApprovalState.FAILED)).toBe(true);
  });

  it('CONFIG_CHANGE closes the current ConfigValue row and inserts the new one', async () => {
    const previous = await prisma.configValue.create({ data: { key: 'pilot.order_cap_xaf', value: 250000, effectiveFrom: new Date(Date.now() - 60_000) } });
    expect(await configValues.get<number>('pilot.order_cap_xaf')).toBe(250000);

    const approval = await approvals.request({
      actionType: 'CONFIG_CHANGE', entityType: 'ConfigValue', entityId: 'pilot.order_cap_xaf',
      payload: { key: 'pilot.order_cap_xaf', value: 400000 }, reason: 'Relèvement du plafond pilote', makerId: adminId,
    });
    const done = await approvals.approve(approval.id, complianceId);
    expect(done.state).toBe(ApprovalState.EXECUTED);

    const rows = await prisma.configValue.findMany({ where: { key: 'pilot.order_cap_xaf' }, orderBy: { effectiveFrom: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(previous.id);
    expect(rows[0].effectiveTo).not.toBeNull();
    expect(rows[1].value).toBe(400000);
    expect(rows[1].effectiveTo).toBeNull();
    expect(rows[1].createdById).toBe(adminId);
    expect(rows[1].approvedById).toBe(complianceId);
    expect(await configValues.get<number>('pilot.order_cap_xaf')).toBe(400000);
    expect(published.map((e) => e.name)).toContain('ConfigChanged');

    // Rejection path: nothing changes, note is mandatory.
    const second = await approvals.request({ actionType: 'CONFIG_CHANGE', payload: { key: 'pilot.order_cap_xaf', value: 1 }, reason: 'Erreur', makerId: adminId });
    await expect(approvals.reject(second.id, complianceId, '')).rejects.toThrow('motif');
    const rejected = await approvals.reject(second.id, complianceId, 'Valeur absurde');
    expect(rejected.state).toBe(ApprovalState.REJECTED);
    expect(await prisma.configValue.count({ where: { key: 'pilot.order_cap_xaf' } })).toBe(2);
  });

  it('USER_UNBLOCK: blocking is immediate, unblocking waits for a second approver', async () => {
    const target = await createUser(prisma);
    const blocked = await users.setBlocked(adminId, target.id, { isBlocked: true, blockedReason: 'Fraude suspectée' });
    expect(blocked.pendingApproval).toBeNull();
    expect(blocked.user).not.toHaveProperty('passwordHash');
    const afterBlock = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(afterBlock.isBlocked).toBe(true);
    expect(afterBlock.blockedReason).toBe('Fraude suspectée');
    expect(afterBlock.tokenVersion).toBe(1); // sessions revoked
    expect(await prisma.auditLog.count({ where: { action: 'USER_BLOCKED', entityId: target.id } })).toBe(1);

    const unblock = await users.setBlocked(adminId, target.id, { isBlocked: false, blockedReason: 'Vérification terminée' });
    expect(unblock.user).toBeNull();
    expect(unblock.pendingApproval?.actionType).toBe('USER_UNBLOCK');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).isBlocked).toBe(true);

    const done = await approvals.approve(unblock.pendingApproval!.id, complianceId);
    expect(done.state).toBe(ApprovalState.EXECUTED);
    const afterUnblock = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(afterUnblock.isBlocked).toBe(false);
    expect(afterUnblock.blockedReason).toBeNull();
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'USER_UNBLOCKED', entityId: target.id } });
    expect(audit.actorUserId).toBe(complianceId);

    await expect(users.setBlocked(adminId, target.id, { isBlocked: false })).rejects.toThrow('n’est pas bloqué');
  });
});
