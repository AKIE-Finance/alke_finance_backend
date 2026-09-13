import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AlertSource, ApprovalState, PaymentDirection, PaymentIntentState, PaymentProvider, ReconciliationState, UserRole } from '@prisma/client';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { EventsModule } from '../src/common/events/events.module';
import { EventBus } from '../src/common/events/event-bus.service';
import { DomainEvent } from '../src/common/events/domain-events';
import { CommonModule } from '../src/common/common.module';
import { LedgerModule } from '../src/modules/ledger/ledger.module';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { ConfigValuesModule } from '../src/modules/config/config-values.module';
import { PolicyModule } from '../src/modules/policy/policy.module';
import { ApprovalsModule } from '../src/modules/approvals/approvals.module';
import { ApprovalsService } from '../src/modules/approvals/approvals.service';
import { FeesModule } from '../src/modules/fees/fees.module';
import { PaymentsModule } from '../src/modules/payments/payments.module';
import { ReconciliationModule } from '../src/modules/reconciliation/reconciliation.module';
import { ReconciliationService } from '../src/modules/reconciliation/reconciliation.service';
import { CshLine } from '../src/modules/brokerage/connectors/connector.types';
import { resetDatabase } from './helpers/db';
import { createMarket, createPartner, createUser, fund, setConfig } from './helpers/brokerage-fixtures';

describe('Reconciliation (blueprint §4.16)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let reconciliation: ReconciliationService;
  let approvals: ApprovalsService;
  const published: DomainEvent[] = [];
  let partnerId: string;
  let userId: string;

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
        PolicyModule,
        ApprovalsModule,
        FeesModule,
        PaymentsModule,
        ReconciliationModule,
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    ledger = moduleRef.get(LedgerService);
    reconciliation = moduleRef.get(ReconciliationService);
    approvals = moduleRef.get(ApprovalsService);
    moduleRef.get(EventBus).subscribe('*', (e) => {
      published.push(e);
    });
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    published.length = 0;
    const market = await createMarket(prisma);
    partnerId = (await createPartner(prisma, market.id)).id;
    userId = (await createUser(prisma)).id;
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  /** A confirmed deposit: PAID intent whose ledger txn credited the user's AVAILABLE account. */
  async function paidDeposit(reference: string, amount: string) {
    const txn = await fund(ledger, userId, amount, 'XAF', `deposit:${reference}`);
    return prisma.paymentIntent.create({
      data: {
        userId, direction: PaymentDirection.IN, provider: PaymentProvider.SIMULATED, amount, currency: 'XAF', reference,
        state: PaymentIntentState.PAID, confirmedAt: new Date(), ledgerTxnId: txn.id, expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
  }

  const cshLine = (reference: string, amount: string, balance: string, direction: 'IN' | 'OUT' = 'IN'): CshLine => ({
    date: '2026-09-04', reference, direction, amount, balance,
  });

  it('a statement line matching a PAID deposit is reconciled without any item', async () => {
    const intent = await paidDeposit('DEP-1', '25000');
    const run = await reconciliation.runDaily(partnerId, [cshLine('DEP-1', '25000', '25000')]);
    expect(run.lines).toBe(1);
    expect(run.matched).toEqual([intent.id]);
    expect(run.items).toEqual([]);
    expect(run.mirror).toMatchObject({ ledgerTotal: '25000', closingBalance: '25000', difference: '0', materiality: '1000', alert: false });
    expect(await prisma.reconciliationItem.count()).toBe(0);
    expect(await prisma.complianceAlert.count()).toBe(0);
    expect(published.some((e) => e.name === 'ReconciliationMismatchDetected')).toBe(false);
    expect(run.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('an unknown reference opens one OPEN item (idempotent across re-runs) and raises the mismatch event', async () => {
    await paidDeposit('DEP-1', '25000');
    const run = await reconciliation.runDaily(partnerId, [cshLine('GHOST-9', '5000', '25000')]);
    expect(run.matched).toEqual([]);
    expect(run.items).toHaveLength(1);
    const item = await prisma.reconciliationItem.findUniqueOrThrow({ where: { id: run.items[0] } });
    expect(item).toMatchObject({ state: ReconciliationState.OPEN, externalRef: 'IN:GHOST-9', currency: 'XAF', matchedTxnId: null, ownerId: null });
    expect(item.amount.toFixed()).toBe('5000');
    expect(item.reason).toContain('Référence inconnue');
    expect(item.rawLine).toBe('2026-09-04;GHOST-9;IN;5000;25000');
    expect(published.filter((e) => e.name === 'ReconciliationMismatchDetected')).toHaveLength(1);

    const again = await reconciliation.runDaily(partnerId, [cshLine('GHOST-9', '5000', '25000')]);
    expect(again.items).toEqual([item.id]);
    expect(await prisma.reconciliationItem.count()).toBe(1);
    expect((await reconciliation.list()).map((i) => i.id)).toEqual([item.id]);

    // Direct resolution paths: INVESTIGATING / RESOLVED allowed, WRITTEN_OFF only through maker-checker.
    await expect(reconciliation.update(item.id, { state: ReconciliationState.WRITTEN_OFF, reason: 'abandon' }, userId)).rejects.toThrow('maker-checker');
    const investigating = await reconciliation.update(item.id, { state: ReconciliationState.INVESTIGATING, reason: 'Demande envoyée à la SDB' }, userId);
    expect(investigating.state).toBe(ReconciliationState.INVESTIGATING);
    const admin = await createUser(prisma, { role: UserRole.ADMIN });
    const compliance = await createUser(prisma, { role: UserRole.COMPLIANCE });
    const approval = await reconciliation.requestWriteOff(item.id, 'Frais SDB non documentés', admin.id);
    expect(approval.actionType).toBe('RECON_WRITE_OFF');
    const done = await approvals.approve(approval.id, compliance.id);
    expect(done.state).toBe(ApprovalState.EXECUTED);
    const written = await prisma.reconciliationItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(written.state).toBe(ReconciliationState.WRITTEN_OFF);
    expect(written.reason).toContain('Abandonné');
    expect(published.some((e) => e.name === 'ReconciliationResolved' && e.payload.writtenOff === true)).toBe(true);
  });

  it('an amount mismatch opens an item linked to the intent, its txn and its owner', async () => {
    const intent = await paidDeposit('DEP-2', '25000');
    const run = await reconciliation.runDaily(partnerId, [cshLine('DEP-2', '24000', '24000')]);
    expect(run.matched).toEqual([]);
    expect(run.items).toHaveLength(1);
    const item = await prisma.reconciliationItem.findUniqueOrThrow({ where: { id: run.items[0] } });
    expect(item.reason).toBe('Montant différent : relevé 24000 XAF, intention 25000 XAF.');
    expect(item.amount.toFixed()).toBe('24000');
    expect(item.matchedTxnId).toBe(intent.ledgerTxnId);
    expect(item.ownerId).toBe(userId);
    const event = published.find((e) => e.name === 'ReconciliationMismatchDetected')!;
    expect(event.payload).toMatchObject({ intentId: intent.id, userId, amount: '24000' });

    // Mirror difference of 1000 is within the default materiality: no mirror item.
    expect(run.mirror.alert).toBe(false);
    expect(run.mirror.difference).toBe('1000');

    // A later statement carrying the right amount closes the item automatically.
    const fixed = await reconciliation.runDaily(partnerId, [cshLine('DEP-2', '25000', '25000')]);
    expect(fixed.matched).toEqual([intent.id]);
    const closed = await prisma.reconciliationItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(closed.state).toBe(ReconciliationState.RESOLVED);
    expect(closed.resolvedAt).not.toBeNull();
  });

  it('a mirror gap above materiality creates a mirror item and a RECONCILIATION ComplianceAlert', async () => {
    await paidDeposit('DEP-3', '100000');
    await setConfig(prisma, 'reconciliation.materiality_xaf', 500);
    expect((await reconciliation.materiality()).toFixed()).toBe('500');

    const run = await reconciliation.runDaily(partnerId, [cshLine('DEP-3', '100000', '97000')]);
    expect(run.matched).toHaveLength(1);
    expect(run.items).toEqual([]);
    expect(run.mirror).toMatchObject({ ledgerTotal: '100000', closingBalance: '97000', difference: '3000', materiality: '500', alert: true });

    const mirrorItem = await prisma.reconciliationItem.findUniqueOrThrow({
      where: { source_externalRef: { source: 'SDB_STATEMENT', externalRef: `mirror:${partnerId}:${run.date}` } },
    });
    expect(mirrorItem.amount.toFixed()).toBe('3000');
    expect(mirrorItem.ownerId).toBe(partnerId);
    expect(mirrorItem.reason).toContain('Écart miroir 3000 XAF');
    const alert = await prisma.complianceAlert.findFirstOrThrow({ where: { source: AlertSource.RECONCILIATION } });
    expect(alert.entityType).toBe('ReconciliationItem');
    expect(alert.entityId).toBe(mirrorItem.id);
    expect(alert.severity).toBe('HIGH');
    expect(published.filter((e) => e.name === 'ComplianceAlertRaised')).toHaveLength(1);

    // Same day again: the item is updated, no second alert.
    const rerun = await reconciliation.runDaily(partnerId, [cshLine('DEP-3', '100000', '96000')]);
    expect(rerun.mirror.difference).toBe('4000');
    expect(await prisma.reconciliationItem.count({ where: { externalRef: { startsWith: 'mirror:' } } })).toBe(1);
    expect(await prisma.complianceAlert.count()).toBe(1);
    expect((await prisma.reconciliationItem.findUniqueOrThrow({ where: { id: mirrorItem.id } })).amount.toFixed()).toBe('4000');

    const snapshot = await reconciliation.mirror();
    expect(snapshot.materiality).toBe('500');
    expect(snapshot.totals).toEqual([{ currency: 'XAF', ledgerTotal: '100000' }]);
    expect(snapshot.openMirrorItems.map((i) => i.id)).toEqual([mirrorItem.id]);
    const metrics = await reconciliation.metrics();
    expect(metrics.mirrorMismatchXaf).toBe('4000');
    expect(metrics.openReconciliationItems).toBe(1);
    expect(metrics.oldestPendingWithdrawalHours).toBeNull();
  });
});
