import { BadRequestException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import {
  LedgerAccountKind,
  LedgerOwnerType,
  PaymentDirection,
  PaymentIntentState,
  PaymentProvider,
  SupportedCountry,
} from '@prisma/client';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { EventsModule } from '../src/common/events/events.module';
import { EventBus } from '../src/common/events/event-bus.service';
import { DomainEvent } from '../src/common/events/domain-events';
import { CommonModule } from '../src/common/common.module';
import { LedgerModule } from '../src/modules/ledger/ledger.module';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { ConfigValuesModule } from '../src/modules/config/config-values.module';
import { ConfigValuesService } from '../src/modules/config/config-values.service';
import { FeesModule } from '../src/modules/fees/fees.module';
import { PaymentsModule } from '../src/modules/payments/payments.module';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { resetDatabase } from './helpers/db';

describe('Payments (simulated mode, service layer)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let payments: PaymentsService;
  let ledger: LedgerService;
  let configValues: ConfigValuesService;
  const published: DomainEvent[] = [];
  let userId: string;
  let adminId: string;

  beforeAll(async () => {
    process.env.PAYMENTS_MODE = 'simulated';
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        EventsModule,
        CommonModule,
        LedgerModule,
        ConfigValuesModule,
        FeesModule,
        PaymentsModule,
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    payments = moduleRef.get(PaymentsService);
    ledger = moduleRef.get(LedgerService);
    configValues = moduleRef.get(ConfigValuesService);
    moduleRef.get(EventBus).subscribe('*', (e) => {
      published.push(e);
    });
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    configValues.invalidate();
    published.length = 0;
    const user = await prisma.user.create({
      data: {
        fullName: 'Test Pilote',
        email: 'pilote@alke.test',
        phone: '+237690000001',
        passwordHash: 'x',
        country: SupportedCountry.CMR,
        referralCode: 'PILOTE1',
      },
    });
    userId = user.id;
    const admin = await prisma.user.create({
      data: {
        fullName: 'Admin Test',
        email: 'admin@alke.test',
        phone: '+237690000002',
        passwordHash: 'x',
        country: SupportedCountry.CMR,
        referralCode: 'ADMIN1',
        role: 'ADMIN',
      },
    });
    adminId = admin.id;
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  const availableXaf = () =>
    ledger.balance({ ownerType: LedgerOwnerType.USER, ownerId: userId, currency: 'XAF', kind: LedgerAccountKind.AVAILABLE });

  it('credits a simulated deposit exactly once, even when confirmDeposit is called twice', async () => {
    const { intent } = await payments.createDeposit(userId, { amount: '25000', currency: 'XAF', provider: PaymentProvider.MTN_MOMO, msisdn: '237690000001' });
    expect(intent.state).toBe(PaymentIntentState.PAID);
    expect(intent.reference).toBe(intent.id);
    expect(intent.ledgerTxnId).toBeTruthy();
    expect(intent.confirmedAt).toBeInstanceOf(Date);
    expect((await availableXaf()).toString()).toBe('25000');

    const again = await payments.confirmDeposit(intent.id, 'PAYMENT_WEBHOOK');
    expect(again.ledgerTxnId).toBe(intent.ledgerTxnId);
    const third = await payments.adminRecheck(adminId, intent.id);
    expect(third.state).toBe(PaymentIntentState.PAID);

    expect((await availableXaf()).toString()).toBe('25000');
    expect(await prisma.ledgerTxn.count()).toBe(1);
    expect(await prisma.ledgerTxn.findUnique({ where: { idempotencyKey: `deposit:${intent.id}` } })).not.toBeNull();
    expect(published.filter((e) => e.name === 'DepositConfirmed')).toHaveLength(1);
    expect(published.some((e) => e.name === 'DepositCreated')).toBe(true);

    const wallet = await payments.wallet(userId);
    expect(wallet.balances.find((b) => b.currency === 'XAF')?.available).toBe('25000');
    expect(wallet.pendingIntents).toHaveLength(0);
  });

  it('marks a failing amount FAILED and writes no ledger entry', async () => {
    const { intent } = await payments.createDeposit(userId, { amount: '13', currency: 'XAF', provider: PaymentProvider.MTN_MOMO });
    expect(intent.state).toBe(PaymentIntentState.FAILED);
    expect(intent.failureReason).toBeTruthy();
    expect(await prisma.ledgerTxn.count()).toBe(0);
    expect(await prisma.ledgerEntry.count()).toBe(0);
    expect((await availableXaf()).toString()).toBe('0');
    expect(published.filter((e) => e.name === 'DepositFailed')).toHaveLength(1);

    // A later "confirm" (replayed callback) stays a no-op.
    const still = await payments.confirmDeposit(intent.id, 'PAYMENT_WEBHOOK');
    expect(still.state).toBe(PaymentIntentState.FAILED);
    expect(await prisma.ledgerTxn.count()).toBe(0);
  });

  it('rejects non-positive and non-integer XAF amounts and unsupported flows', async () => {
    await expect(payments.createDeposit(userId, { amount: '0', currency: 'XAF', provider: PaymentProvider.MTN_MOMO })).rejects.toBeInstanceOf(BadRequestException);
    await expect(payments.createDeposit(userId, { amount: '-5', currency: 'XAF', provider: PaymentProvider.MTN_MOMO })).rejects.toBeInstanceOf(BadRequestException);
    await expect(payments.createDeposit(userId, { amount: '100.5', currency: 'XAF', provider: PaymentProvider.MTN_MOMO })).rejects.toThrow(/entier/);
    await expect(payments.createDeposit(userId, { amount: 'abc', currency: 'XAF', provider: PaymentProvider.MTN_MOMO })).rejects.toBeInstanceOf(BadRequestException);
    expect(await prisma.paymentIntent.count()).toBe(0);
    // Two decimals are fine in EUR.
    const { intent } = await payments.createDeposit(userId, { amount: '10.50', currency: 'EUR', provider: PaymentProvider.CINETPAY });
    expect(intent.state).toBe(PaymentIntentState.PAID);
  });

  it('reserves funds on withdrawal (available ↓, withdrawable ↑) then pays out in simulated mode', async () => {
    await payments.createDeposit(userId, { amount: '50000', currency: 'XAF', provider: PaymentProvider.MTN_MOMO });

    const intent = await payments.requestWithdrawal(userId, { amount: '20000', currency: 'XAF', msisdn: '237690000001', provider: PaymentProvider.MTN_MOMO });
    expect(intent.direction).toBe(PaymentDirection.OUT);
    expect(intent.state).toBe(PaymentIntentState.PAID); // simulated mode pays at once
    expect(intent.providerRef).toBe(`SIM-${intent.reference}`);

    const reserve = await prisma.ledgerTxn.findUnique({ where: { idempotencyKey: `withdraw-reserve:${intent.id}` } });
    const payout = await prisma.ledgerTxn.findUnique({ where: { idempotencyKey: `withdraw:${intent.id}` } });
    expect(reserve).not.toBeNull();
    expect(payout).not.toBeNull();
    expect(intent.ledgerTxnId).toBe(payout?.id);

    const b = await ledger.userBalances(userId, 'XAF');
    expect(b.available.toString()).toBe('30000');
    expect(b.withdrawable.toString()).toBe('0');
    expect((await ledger.mirrorTotal('XAF')).toString()).toBe('30000');
    const names = published.map((e) => e.name);
    expect(names).toContain('WithdrawalRequested');
    expect(names).toContain('WithdrawalPaid');

    // Insufficient balance is refused by the ledger, and the intent is FAILED.
    await expect(
      payments.requestWithdrawal(userId, { amount: '40000', currency: 'XAF', msisdn: '237690000001', provider: PaymentProvider.MTN_MOMO }),
    ).rejects.toThrow('Solde insuffisant.');
    const failed = await prisma.paymentIntent.findFirst({ where: { userId, direction: PaymentDirection.OUT, state: PaymentIntentState.FAILED } });
    expect(failed?.failureReason).toBe('Solde insuffisant.');
    expect((await ledger.userBalances(userId, 'XAF')).available.toString()).toBe('30000');
    expect((await ledger.verifyInvariants()).ok).toBe(true);
  });

  it('keeps a withdrawal PENDING until the SDB confirms, and releases on failure (non-simulated path)', async () => {
    await payments.createDeposit(userId, { amount: '10000', currency: 'XAF', provider: PaymentProvider.MTN_MOMO });
    // Emulate the WDR path: reserve exactly as requestWithdrawal does, without the simulated payout.
    const registry = payments['providers'];
    const spy = jest.spyOn(registry, 'simulatedMode', 'get').mockReturnValue(false);
    const pending = await payments.requestWithdrawal(userId, { amount: '4000', currency: 'XAF', msisdn: '237690000001', provider: PaymentProvider.MTN_MOMO });
    spy.mockRestore();

    expect(pending.state).toBe(PaymentIntentState.PENDING);
    let b = await ledger.userBalances(userId, 'XAF');
    expect(b.available.toString()).toBe('6000');
    expect(b.withdrawable.toString()).toBe('4000');

    const released = await payments.failWithdrawal(pending.id, 'Rejet SDB', adminId);
    expect(released.state).toBe(PaymentIntentState.FAILED);
    b = await ledger.userBalances(userId, 'XAF');
    expect(b.available.toString()).toBe('10000');
    expect(b.withdrawable.toString()).toBe('0');
    await expect(payments.markWithdrawalPaid(pending.id, 'CSH-1', 'CSH_FILE')).rejects.toBeInstanceOf(BadRequestException);

    // And the happy path through the CSH confirmation.
    const spy2 = jest.spyOn(registry, 'simulatedMode', 'get').mockReturnValue(false);
    const second = await payments.requestWithdrawal(userId, { amount: '2500', currency: 'XAF', msisdn: '237690000001', provider: PaymentProvider.MTN_MOMO });
    spy2.mockRestore();
    const paid = await payments.markWithdrawalPaid(second.id, 'CSH-2', 'CSH_FILE');
    expect(paid.state).toBe(PaymentIntentState.PAID);
    expect(paid.providerRef).toBe('CSH-2');
    b = await ledger.userBalances(userId, 'XAF');
    expect(b.available.toString()).toBe('7500');
    expect(b.withdrawable.toString()).toBe('0');
    expect((await payments.markWithdrawalPaid(second.id, 'CSH-2', 'CSH_FILE')).ledgerTxnId).toBe(paid.ledgerTxnId);
    expect(await prisma.ledgerTxn.count({ where: { idempotencyKey: `withdraw:${second.id}` } })).toBe(1);
  });

  it('enforces the pilot deposit cap from ConfigValues on PAID XAF deposits', async () => {
    await configValues.set('pilot.deposit_cap_xaf', 100000, adminId, 'admin-2');
    await payments.createDeposit(userId, { amount: '60000', currency: 'XAF', provider: PaymentProvider.MTN_MOMO });
    await expect(
      payments.createDeposit(userId, { amount: '60000', currency: 'XAF', provider: PaymentProvider.MTN_MOMO }),
    ).rejects.toThrow(/Plafond de dépôt/);
    // Exactly reaching the cap is allowed; failed intents do not count.
    await payments.createDeposit(userId, { amount: '13', currency: 'XAF', provider: PaymentProvider.MTN_MOMO });
    await payments.createDeposit(userId, { amount: '40000', currency: 'XAF', provider: PaymentProvider.MTN_MOMO });
    expect((await availableXaf()).toString()).toBe('100000');
    // Other currencies are not capped by this key.
    await expect(payments.createDeposit(userId, { amount: '500', currency: 'EUR', provider: PaymentProvider.CINETPAY })).resolves.toBeDefined();
  });

  it('expiry job: expires stale open intents after a last status query for PENDING ones', async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    const base = { userId, direction: PaymentDirection.IN, provider: PaymentProvider.MTN_MOMO, currency: 'XAF' };
    const created = await prisma.paymentIntent.create({ data: { ...base, reference: 'r-created', amount: 1000, state: PaymentIntentState.CREATED, expiresAt: past } });
    const pendingPaid = await prisma.paymentIntent.create({ data: { ...base, reference: 'r-pending-ok', amount: 2000, state: PaymentIntentState.PENDING, expiresAt: past } });
    const pendingFailed = await prisma.paymentIntent.create({ data: { ...base, reference: 'r-pending-ko', amount: 13, state: PaymentIntentState.PENDING, expiresAt: past } });
    const fresh = await prisma.paymentIntent.create({ data: { ...base, reference: 'r-fresh', amount: 3000, state: PaymentIntentState.PENDING, expiresAt: future } });
    const out = await prisma.paymentIntent.create({ data: { ...base, direction: PaymentDirection.OUT, reference: 'r-out', amount: 500, state: PaymentIntentState.PENDING, expiresAt: past } });

    const result = await payments.expireStaleIntents();
    expect(result).toEqual({ expired: 1, settled: 2 });

    const states = Object.fromEntries(
      (await prisma.paymentIntent.findMany({ where: { id: { in: [created.id, pendingPaid.id, pendingFailed.id, fresh.id, out.id] } } })).map((i) => [i.reference, i.state]),
    );
    expect(states).toEqual({
      'r-created': PaymentIntentState.EXPIRED,
      'r-pending-ok': PaymentIntentState.PAID,
      'r-pending-ko': PaymentIntentState.FAILED,
      'r-fresh': PaymentIntentState.PENDING,
      'r-out': PaymentIntentState.PENDING,
    });
    expect((await availableXaf()).toString()).toBe('2000');
    expect(published.filter((e) => e.name === 'DepositExpired').map((e) => e.entityId)).toEqual([created.id]);

    // Idempotent: a second run changes nothing.
    expect(await payments.expireStaleIntents()).toEqual({ expired: 0, settled: 0 });
  });

  it('forceComplete (maker-checker executor) credits without provider confirmation and records the approval', async () => {
    const intent = await prisma.paymentIntent.create({
      data: { userId, direction: PaymentDirection.IN, provider: PaymentProvider.ORANGE_MONEY, currency: 'XAF', reference: 'r-force', amount: 13, state: PaymentIntentState.PENDING, expiresAt: new Date() },
    });
    const paid = await payments.forceComplete(intent.id, adminId, 'approval-42');
    expect(paid.state).toBe(PaymentIntentState.PAID);
    const txn = await prisma.ledgerTxn.findUniqueOrThrow({ where: { idempotencyKey: `deposit:${intent.id}` } });
    expect(txn.source).toBe('ADMIN');
    expect(txn.actorId).toBe(adminId);
    expect(txn.metadata).toMatchObject({ approvalId: 'approval-42', forced: true });
    expect((await availableXaf()).toString()).toBe('13');
    expect(await prisma.auditLog.count({ where: { action: 'PAYMENT_FORCE_COMPLETED', entityId: intent.id } })).toBe(1);
  });
});
