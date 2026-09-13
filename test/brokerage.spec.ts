import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import {
  ApprovalState,
  BatchState,
  FeeType,
  LedgerAccountKind,
  LedgerOwnerType,
  LedgerTxnType,
  OrderSide,
  OrderStatus,
  SettlementState,
  UserRole,
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
import { PolicyModule } from '../src/modules/policy/policy.module';
import { ApprovalsModule } from '../src/modules/approvals/approvals.module';
import { ApprovalsService } from '../src/modules/approvals/approvals.service';
import { FeesModule } from '../src/modules/fees/fees.module';
import { PaymentsModule } from '../src/modules/payments/payments.module';
import { ReconciliationModule } from '../src/modules/reconciliation/reconciliation.module';
import { BrokerageModule } from '../src/modules/brokerage/brokerage.module';
import { OrdersService } from '../src/modules/brokerage/orders.service';
import { BatchesService } from '../src/modules/brokerage/batches.service';
import { SettlementService } from '../src/modules/brokerage/settlement.service';
import { IOrderConnector, ORDER_CONNECTOR } from '../src/modules/brokerage/connectors/connector.types';
import { sha256 } from '../src/modules/brokerage/connectors/csv';
import { resetDatabase } from './helpers/db';
import { acct, createInstrument, createMarket, createPartner, createUser, fund, openBrokerAccount } from './helpers/brokerage-fixtures';

const DAY = 86_400_000;

describe('Brokerage — order engine (blueprint §4.3, §4.5, §4.15)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let orders: OrdersService;
  let batches: BatchesService;
  let settlement: SettlementService;
  let approvals: ApprovalsService;
  let connector: IOrderConnector;
  const published: DomainEvent[] = [];
  let marketId: string;
  let partnerId: string;
  let userId: string;
  let adminId: string;
  let complianceId: string;
  const originalEnv = { APP_ENV: process.env.APP_ENV, SDB_CONNECTOR: process.env.SDB_CONNECTOR, SIM_PARTIAL_FILLS: process.env.SIM_PARTIAL_FILLS };

  beforeAll(async () => {
    process.env.SDB_CONNECTOR = 'simulated'; // the connector instance stays in-memory for the whole file
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
        BrokerageModule,
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    ledger = moduleRef.get(LedgerService);
    orders = moduleRef.get(OrdersService);
    batches = moduleRef.get(BatchesService);
    settlement = moduleRef.get(SettlementService);
    approvals = moduleRef.get(ApprovalsService);
    connector = moduleRef.get<IOrderConnector>(ORDER_CONNECTOR);
    expect(connector.kind).toBe('simulated');
    moduleRef.get(EventBus).subscribe('*', (e) => {
      published.push(e);
    });
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    published.length = 0;
    // Policy: a LIVE market on a non-simulated connector = real orders (the connector object itself stays simulated).
    process.env.APP_ENV = 'local';
    process.env.SDB_CONNECTOR = 'file';
    delete process.env.SIM_PARTIAL_FILLS;
    const market = await createMarket(prisma, { liveTrading: true, settlementDays: 3 });
    marketId = market.id;
    partnerId = (await createPartner(prisma, market.id)).id;
    for (const [feeType, value, label] of [
      [FeeType.COURTAGE_SDB, '1', 'Courtage SDB'],
      [FeeType.COMMISSION_ALKE, '0.5', 'Commission AlKÉ'],
      [FeeType.TAXE, '0.5', 'Taxe sur transaction'],
    ] as const) {
      await prisma.feeSchedule.create({ data: { feeType, isPercentage: true, value, label, effectiveFrom: new Date(Date.now() - DAY) } });
    }
    const user = await createUser(prisma);
    userId = user.id;
    await openBrokerAccount(prisma, userId, partnerId);
    adminId = (await createUser(prisma, { role: UserRole.ADMIN })).id;
    complianceId = (await createUser(prisma, { role: UserRole.COMPLIANCE })).id;
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await moduleRef.close();
  });

  const balances = () => ledger.userBalances(userId, 'XAF');
  const txnByKey = (idempotencyKey: string) => prisma.ledgerTxn.findUnique({ where: { idempotencyKey }, include: { entries: { include: { account: true } } } });
  const entry = (txn: NonNullable<Awaited<ReturnType<typeof txnByKey>>>, ownerType: LedgerOwnerType, ownerId: string, kind: LedgerAccountKind) =>
    txn.entries.find((e) => e.account.ownerType === ownerType && e.account.ownerId === ownerId && e.account.kind === kind)?.amount.toFixed();
  const names = () => published.map((e) => e.name);

  async function transmit(orderId: string) {
    const batch = await batches.buildBatch(marketId, partnerId, adminId);
    const market = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
    const partner = await prisma.marketPartner.findUniqueOrThrow({ where: { id: partnerId } });
    const ctx = { batch, market, partner, orders: await prisma.order.findMany({ where: { batchId: batch.id } }) };
    return { batch, ctx, order: await prisma.order.findUniqueOrThrow({ where: { id: orderId } }) };
  }

  it('real BUY: reserve → ORD batch → ACK → EXE → fill, leftover release, settlement — exact keys and amounts', async () => {
    await fund(ledger, userId, 1_000_000);
    const instrument = await createInstrument(prisma, marketId, { lastPrice: 5000 });

    const preview = await orders.preview(userId, { instrumentId: instrument.id, side: OrderSide.BUY, quantity: 10 });
    expect(preview).toMatchObject({ allowed: true, simulated: false, estimatedTotal: '50000', feeTotal: '1000', maxAmount: '51000' });

    const order = await orders.placeOrder(userId, { instrumentId: instrument.id, side: OrderSide.BUY, quantity: 10 });
    expect(order.status).toBe(OrderStatus.PENDING);
    expect(order.simulated).toBe(false);
    expect(order.partnerId).toBe(partnerId);
    expect(order.maxAmount.toFixed()).toBe('51000');
    expect(order.brokerageFee.toFixed()).toBe('500');
    const reserve = await txnByKey(`reserve:${order.id}`);
    expect(reserve?.type).toBe(LedgerTxnType.RESERVE);
    expect(reserve?.id).toBe(order.reserveTxnId);
    expect(entry(reserve!, LedgerOwnerType.USER, userId, LedgerAccountKind.AVAILABLE)).toBe('-51000');
    expect(entry(reserve!, LedgerOwnerType.USER, userId, LedgerAccountKind.RESERVED)).toBe('51000');
    let b = await balances();
    expect([b.available.toFixed(), b.reserved.toFixed()]).toEqual(['949000', '51000']);
    // Not enough cash for a second big order.
    await expect(orders.placeOrder(userId, { instrumentId: instrument.id, side: OrderSide.BUY, quantity: 200 })).rejects.toBeInstanceOf(BadRequestException);

    // --- ORD batch (simulated connector auto-marks SENT).
    const { batch, ctx } = await transmit(order.id);
    expect(batch.state).toBe(BatchState.SENT);
    expect(batch.fileName).toMatch(/^ALKE_SDB1_ORD_\d{8}_001\.csv$/);
    expect(batch.lineCount).toBe(1);
    const file = await batches.batchFile(batch.id);
    expect(file.hashMatches).toBe(true);
    expect(batch.fileHash).toBe(sha256(file.content));
    expect(file.content.split('\n')[1]).toContain(`${order.id};ACC-0001;`);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.TRANSMITTED);
    expect(names()).toEqual(expect.arrayContaining(['OrderCreated', 'BatchBuilt', 'OrderTransmitted', 'BatchSent']));

    // --- ACK.
    const ackLines = await connector.pollAck(ctx);
    expect(ackLines).toHaveLength(1);
    const ack = await batches.processAck(batch.id, ackLines);
    expect(ack.accepted).toEqual([order.id]);
    const acked = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(acked.status).toBe(OrderStatus.ACKNOWLEDGED);
    expect(acked.sdbRef).toMatch(/^SIM-\d+$/);
    expect((await prisma.orderBatch.findUniqueOrThrow({ where: { id: batch.id } })).state).toBe(BatchState.ACKED);
    // Replaying the ACK is a no-op.
    expect((await batches.processAck(batch.id, ackLines)).accepted).toEqual([]);

    // --- EXE at a better price than estimated: part of the reserve comes back.
    const exeLine = {
      order_id: order.id, sdb_ref: acked.sdbRef!, executed_qty: '10', price: '4900', gross_amount: '49000', courtage: '490', taxes: '245',
      net_amount: '49735', settlement_date: '', executed_at: '2026-09-04T11:00:00+01:00', status: 'FILLED' as const,
    };
    const exe = await batches.processExecutions(batch.id, [exeLine]);
    expect(exe.executions).toHaveLength(1);
    const execution = await prisma.execution.findUniqueOrThrow({ where: { id: exe.executions[0] } });
    expect(execution.sdbExecRef).toBe(`${acked.sdbRef}:2026-09-04T11:00:00+01:00`);
    expect(execution.settlementState).toBe(SettlementState.UNSETTLED);
    const fill = await txnByKey(`fill:${execution.id}`);
    expect(fill?.type).toBe(LedgerTxnType.FILL);
    expect(fill?.id).toBe(execution.fillTxnId);
    expect(entry(fill!, LedgerOwnerType.USER, userId, LedgerAccountKind.RESERVED)).toBe('-49985'); // 49000 + 490 + 245 + commission 250
    expect(entry(fill!, LedgerOwnerType.SDB, partnerId, LedgerAccountKind.CLEARING)).toBe('49000');
    expect(entry(fill!, LedgerOwnerType.FEE, 'COURTAGE_SDB', LedgerAccountKind.AVAILABLE)).toBe('490');
    expect(entry(fill!, LedgerOwnerType.FEE, 'TAXE', LedgerAccountKind.AVAILABLE)).toBe('245');
    expect(entry(fill!, LedgerOwnerType.FEE, 'COMMISSION_ALKE', LedgerAccountKind.AVAILABLE)).toBe('250');
    const release = await txnByKey(`release:${order.id}`);
    expect(release?.type).toBe(LedgerTxnType.RELEASE);
    expect(entry(release!, LedgerOwnerType.USER, userId, LedgerAccountKind.RESERVED)).toBe('-1015');
    expect(entry(release!, LedgerOwnerType.USER, userId, LedgerAccountKind.AVAILABLE)).toBe('1015');
    b = await balances();
    expect([b.available.toFixed(), b.reserved.toFixed(), b.settling.toFixed()]).toEqual(['950015', '0', '0']);

    const executed = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(executed.status).toBe(OrderStatus.EXECUTED);
    expect(executed.filledQuantity.toFixed()).toBe('10');
    expect(executed.avgExecutedPrice?.toFixed()).toBe('4900');
    const position = await prisma.position.findUniqueOrThrow({ where: { userId_instrumentId: { userId, instrumentId: instrument.id } } });
    expect([position.quantity.toFixed(), position.pendingQuantity.toFixed(), position.avgCost.toFixed()]).toEqual(['0', '10', '4900']);
    expect((await prisma.orderBatch.findUniqueOrThrow({ where: { id: batch.id } })).state).toBe(BatchState.PROCESSED);

    // Replaying the EXE file posts nothing.
    const replay = await batches.processExecutions(batch.id, [exeLine]);
    expect(replay.duplicates).toEqual([execution.id]);
    expect(await prisma.ledgerTxn.count()).toBe(4); // deposit, reserve, fill, release
    expect((await ledger.verifyInvariants()).ok).toBe(true);

    // --- Settlement J+3: pending shares become settled.
    expect(await settlement.settleDue(new Date())).toEqual([]);
    const settled = await settlement.settleDue(new Date(Date.now() + 14 * DAY));
    expect(settled).toEqual([execution.id]);
    const after = await prisma.position.findUniqueOrThrow({ where: { userId_instrumentId: { userId, instrumentId: instrument.id } } });
    expect([after.quantity.toFixed(), after.pendingQuantity.toFixed()]).toEqual(['10', '0']);
    expect((await prisma.execution.findUniqueOrThrow({ where: { id: execution.id } })).settlementState).toBe(SettlementState.SETTLED);
    expect(names()).toEqual(expect.arrayContaining(['OrderAcknowledged', 'OrderExecuted', 'BatchProcessed', 'SettlementConfirmed']));
  });

  it('partial fill (SIM_PARTIAL_FILLS, qty ≥ 100) then expiry releases exactly the unconsumed reserve', async () => {
    await fund(ledger, userId, 1_000_000);
    const instrument = await createInstrument(prisma, marketId, { lastPrice: 1000 });
    const order = await orders.placeOrder(userId, { instrumentId: instrument.id, side: OrderSide.BUY, quantity: 100 });
    expect(order.maxAmount.toFixed()).toBe('102000');

    const { batch, ctx } = await transmit(order.id);
    await batches.processAck(batch.id, await connector.pollAck(ctx));
    process.env.SIM_PARTIAL_FILLS = 'true';
    const exeLines = await connector.pollExecutions({ ...ctx, orders: await prisma.order.findMany({ where: { batchId: batch.id } }) });
    expect(exeLines[0]).toMatchObject({ executed_qty: '50', gross_amount: '50000', courtage: '500', taxes: '250', status: 'PARTIAL' });
    const exe = await batches.processExecutions(batch.id, exeLines);
    const partial = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(partial.status).toBe(OrderStatus.PARTIALLY_EXECUTED);
    expect(partial.filledQuantity.toFixed()).toBe('50');
    const fill = await txnByKey(`fill:${exe.executions[0]}`);
    expect(entry(fill!, LedgerOwnerType.USER, userId, LedgerAccountKind.RESERVED)).toBe('-51000'); // 50000 + 500 + 250 + commission 250
    expect(await txnByKey(`release:${order.id}`)).toBeNull();
    let b = await balances();
    expect([b.available.toFixed(), b.reserved.toFixed()]).toEqual(['898000', '51000']);

    // The session is over and nothing else came: the order expires and the remainder is released.
    expect(await batches.expireStale(partial.transmittedAt!)).toEqual([]);
    const expired = await batches.expireStale(new Date(partial.transmittedAt!.getTime() + 7 * DAY));
    expect(expired).toEqual([order.id]);
    const final = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(final.status).toBe(OrderStatus.EXPIRED);
    expect(final.expiredAt).not.toBeNull();
    const release = await txnByKey(`release:${order.id}`);
    expect(entry(release!, LedgerOwnerType.USER, userId, LedgerAccountKind.RESERVED)).toBe('-51000');
    expect(entry(release!, LedgerOwnerType.USER, userId, LedgerAccountKind.AVAILABLE)).toBe('51000');
    b = await balances();
    expect([b.available.toFixed(), b.reserved.toFixed()]).toEqual(['949000', '0']);
    expect(names()).toEqual(expect.arrayContaining(['OrderPartiallyExecuted', 'OrderExpired']));
    // Expiry is idempotent and a final order refuses further executions.
    expect(await batches.expireStale(new Date(Date.now() + 30 * DAY))).toEqual([]);
    await expect(batches.processExecutions(batch.id, exeLines.map((l) => ({ ...l, executed_at: '2026-09-05T11:00:00+01:00' })))).rejects.toThrow('exécution refusée');
  });

  it('SELL requires a settled position; the sale proceeds move SETTLING → AVAILABLE at settlement', async () => {
    const instrument = await createInstrument(prisma, marketId, { lastPrice: 5000 });
    await expect(orders.placeOrder(userId, { instrumentId: instrument.id, side: OrderSide.SELL, quantity: 10 })).rejects.toThrow('Quantité insuffisante');
    // Pending (unsettled) shares are not sellable either.
    await prisma.position.create({ data: { userId, instrumentId: instrument.id, quantity: 0, pendingQuantity: 10, avgCost: 5000, currency: 'XAF' } });
    await expect(orders.placeOrder(userId, { instrumentId: instrument.id, side: OrderSide.SELL, quantity: 10 })).rejects.toThrow('Quantité insuffisante');
    await prisma.position.update({ where: { userId_instrumentId: { userId, instrumentId: instrument.id } }, data: { quantity: 10, pendingQuantity: 0 } });

    const order = await orders.placeOrder(userId, { instrumentId: instrument.id, side: OrderSide.SELL, quantity: 10 });
    expect(order.status).toBe(OrderStatus.PENDING);
    expect(order.maxAmount.toFixed()).toBe('50000');
    expect(order.reserveTxnId).toBeNull();
    expect(await prisma.ledgerTxn.count()).toBe(0);
    let position = await prisma.position.findUniqueOrThrow({ where: { userId_instrumentId: { userId, instrumentId: instrument.id } } });
    expect(position.reservedQuantity.toFixed()).toBe('10');
    // Everything is reserved: no second sale.
    await expect(orders.placeOrder(userId, { instrumentId: instrument.id, side: OrderSide.SELL, quantity: 1 })).rejects.toThrow('Quantité insuffisante');

    const { batch, ctx } = await transmit(order.id);
    await batches.processAck(batch.id, await connector.pollAck(ctx));
    const exeLines = await connector.pollExecutions({ ...ctx, orders: await prisma.order.findMany({ where: { batchId: batch.id } }) });
    expect(exeLines[0]).toMatchObject({ executed_qty: '10', gross_amount: '50000', courtage: '500', taxes: '250', net_amount: '49250', status: 'FILLED' });
    const exe = await batches.processExecutions(batch.id, exeLines);
    const fill = await txnByKey(`fill:${exe.executions[0]}`);
    expect(entry(fill!, LedgerOwnerType.SDB, partnerId, LedgerAccountKind.CLEARING)).toBe('-49250');
    expect(entry(fill!, LedgerOwnerType.USER, userId, LedgerAccountKind.SETTLING)).toBe('49250');
    let b = await balances();
    expect([b.available.toFixed(), b.settling.toFixed(), b.withdrawable.toFixed()]).toEqual(['0', '49250', '0']);
    expect(await txnByKey(`release:${order.id}`)).toBeNull(); // nothing to release on a SELL
    position = await prisma.position.findUniqueOrThrow({ where: { userId_instrumentId: { userId, instrumentId: instrument.id } } });
    expect([position.quantity.toFixed(), position.reservedQuantity.toFixed()]).toEqual(['10', '10']); // still held until delivery

    const settled = await settlement.settleDue(new Date(Date.now() + 14 * DAY));
    expect(settled).toEqual(exe.executions);
    const settlementTxn = await txnByKey(`settlement:${exe.executions[0]}`);
    expect(settlementTxn?.type).toBe(LedgerTxnType.SETTLEMENT);
    expect(entry(settlementTxn!, LedgerOwnerType.USER, userId, LedgerAccountKind.SETTLING)).toBe('-49250');
    expect(entry(settlementTxn!, LedgerOwnerType.USER, userId, LedgerAccountKind.AVAILABLE)).toBe('49250');
    b = await balances();
    expect([b.available.toFixed(), b.settling.toFixed()]).toEqual(['49250', '0']);
    position = await prisma.position.findUniqueOrThrow({ where: { userId_instrumentId: { userId, instrumentId: instrument.id } } });
    expect([position.quantity.toFixed(), position.reservedQuantity.toFixed()]).toEqual(['0', '0']);
    const confirmed = published.find((e) => e.name === 'SettlementConfirmed')!;
    expect(confirmed.payload).toMatchObject({ side: 'SELL', netAmount: '49250', currency: 'XAF', userId });
    expect((await ledger.verifyInvariants()).ok).toBe(true);
  });

  it('a user can cancel only a PENDING order; the full reserve is released', async () => {
    await fund(ledger, userId, 1_000_000);
    const instrument = await createInstrument(prisma, marketId, { lastPrice: 5000 });
    const first = await orders.placeOrder(userId, { instrumentId: instrument.id, side: OrderSide.BUY, quantity: 10 });
    const other = await createUser(prisma);
    await expect(orders.cancel(other.id, first.id)).rejects.toThrow('Ordre introuvable');
    const cancelled = await orders.cancel(userId, first.id);
    expect(cancelled.status).toBe(OrderStatus.CANCELLED);
    expect(cancelled.cancelledAt).not.toBeNull();
    const release = await txnByKey(`release:${first.id}`);
    expect(entry(release!, LedgerOwnerType.USER, userId, LedgerAccountKind.AVAILABLE)).toBe('51000');
    let b = await balances();
    expect([b.available.toFixed(), b.reserved.toFixed()]).toEqual(['1000000', '0']);
    await expect(orders.cancel(userId, first.id)).rejects.toThrow('en attente');

    const second = await orders.placeOrder(userId, { instrumentId: instrument.id, side: OrderSide.BUY, quantity: 10 });
    await transmit(second.id);
    await expect(orders.cancel(userId, second.id)).rejects.toBeInstanceOf(BadRequestException);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: second.id } })).status).toBe(OrderStatus.TRANSMITTED);
    b = await balances();
    expect(b.reserved.toFixed()).toBe('51000');
    expect(names().filter((n) => n === 'OrderCancelled')).toHaveLength(1);
  });

  it('a market that is not live: 403 for a normal user, simulated paper order (no ledger) for a demo user', async () => {
    await prisma.market.update({ where: { id: marketId }, data: { liveTrading: false, status: 'SIMULATED_ONLY' } });
    const instrument = await createInstrument(prisma, marketId, { lastPrice: 5000 });
    await fund(ledger, userId, 1_000_000);
    const txnsBefore = await prisma.ledgerTxn.count();

    process.env.APP_ENV = 'staging'; // nobody is a demo user unless listed in demo.user_emails
    const preview = await orders.preview(userId, { instrumentId: instrument.id, side: OrderSide.BUY, quantity: 10 });
    expect(preview.allowed).toBe(false);
    expect(preview.simulated).toBe(true);
    expect(preview.reason).toContain('pas encore ouvert aux ordres réels');
    await expect(orders.placeOrder(userId, { instrumentId: instrument.id, side: OrderSide.BUY, quantity: 10 })).rejects.toBeInstanceOf(ForbiddenException);

    process.env.APP_ENV = 'local'; // every account is a demo account on a developer machine (D15)
    const paper = await orders.placeOrder(userId, { instrumentId: instrument.id, side: OrderSide.BUY, quantity: 10 });
    expect(paper.simulated).toBe(true);
    expect(paper.status).toBe(OrderStatus.EXECUTED);
    expect(paper.sdbRef).toBe('SIM-PAPER');
    expect(paper.partnerId).toBeNull();
    expect(paper.reserveTxnId).toBeNull();
    expect(paper.executionTier).toBe('TIER0_SIMULATED');
    expect(await prisma.ledgerTxn.count()).toBe(txnsBefore);
    expect(await prisma.position.count()).toBe(0);
    const b = await balances();
    expect([b.available.toFixed(), b.reserved.toFixed()]).toEqual(['1000000', '0']);
    expect(published.find((e) => e.name === 'OrderExecuted')?.payload.simulated).toBe(true);
    // Simulated orders never enter an ORD batch.
    await expect(batches.buildBatch(marketId, partnerId, adminId)).rejects.toThrow('Aucun ordre en attente');

    // A LIVE market on a simulated connector is still simulated (rule 3 of ARCHITECTURE.md).
    await prisma.market.update({ where: { id: marketId }, data: { liveTrading: true, status: 'LIVE' } });
    process.env.SDB_CONNECTOR = 'simulated';
    expect((await orders.preview(userId, { instrumentId: instrument.id, side: OrderSide.BUY, quantity: 10 })).simulated).toBe(true);
    process.env.SDB_CONNECTOR = 'file';
    expect((await orders.preview(userId, { instrumentId: instrument.id, side: OrderSide.BUY, quantity: 10 })).simulated).toBe(false);
  });

  it('ORDER_REVIEW goes through maker-checker, executes once and refuses a second execution', async () => {
    await fund(ledger, userId, 1_000_000);
    const instrument = await createInstrument(prisma, marketId, { lastPrice: 5000 });
    const order = await orders.placeOrder(userId, { instrumentId: instrument.id, side: OrderSide.BUY, quantity: 10 });
    await transmit(order.id);

    await expect(orders.requestReview(adminId, order.id, { status: OrderStatus.EXECUTED, reason: 'Exécution manuelle' })).rejects.toThrow('executedPrice');
    await expect(orders.requestReview(adminId, order.id, { status: OrderStatus.PENDING, reason: 'Retour arrière' })).rejects.toThrow('interdite');
    const approval = await orders.requestReview(adminId, order.id, { status: OrderStatus.REJECTED, reason: 'Rejet confirmé par téléphone avec la SDB' });
    expect(approval.actionType).toBe('ORDER_REVIEW');
    expect(approval.entityId).toBe(order.id);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.TRANSMITTED);

    await expect(approvals.approve(approval.id, adminId)).rejects.toBeInstanceOf(ForbiddenException);
    const done = await approvals.approve(approval.id, complianceId, 'Confirmé');
    expect(done.state).toBe(ApprovalState.EXECUTED);
    const rejected = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(rejected.status).toBe(OrderStatus.REJECTED);
    expect(rejected.rejectionReason).toBe('Rejet confirmé par téléphone avec la SDB');
    const release = await txnByKey(`release:${order.id}`);
    expect(entry(release!, LedgerOwnerType.USER, userId, LedgerAccountKind.AVAILABLE)).toBe('51000');
    const b = await balances();
    expect([b.available.toFixed(), b.reserved.toFixed()]).toEqual(['1000000', '0']);
    const event = published.find((e) => e.name === 'OrderRejected')!;
    expect(event.payload.approvalId).toBe(approval.id);

    // Second execution attempts are refused at every layer.
    await expect(approvals.approve(approval.id, complianceId)).rejects.toBeInstanceOf(ConflictException);
    await expect(orders.applyReview(done)).rejects.toThrow('état final');
    await expect(orders.requestReview(adminId, order.id, { status: OrderStatus.CANCELLED, reason: 'Encore une fois' })).rejects.toThrow('état final');
    expect(await prisma.ledgerTxn.count({ where: { idempotencyKey: `release:${order.id}` } })).toBe(1);
    expect(await prisma.pendingApproval.count({ where: { entityId: order.id } })).toBe(1);
  });
});
