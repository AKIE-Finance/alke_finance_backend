import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  BatchState,
  BatchType,
  BrokerAccountState,
  Execution,
  Instrument,
  Market,
  MarketPartner,
  Order,
  OrderBatch,
  OrderSide,
  OrderStatus,
  PartnerAgreementStatus,
  PaymentDirection,
  PaymentIntentState,
  Prisma,
  SettlementState,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EventBus } from '../../common/events/event-bus.service';
import { D, toApi } from '../../common/money';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { SDB_FILE_ACTOR, SYSTEM_ACTOR } from './brokerage.keys';
import { AckLine, BatchOrderLine, CshLine, ExeLine, IOrderConnector, ORDER_CONNECTOR, WdrLine } from './connectors/connector.types';
import { buildOrdCsv, buildWdrCsv, MARKET_TZ, sha256 } from './connectors/csv';
import { FileConnector } from './connectors/file.connector';
import { OrderLedgerService } from './order-ledger.service';
import { OPEN_AT_SDB, applyFill, assertTransition } from './order-state';
import { SettlementService } from './settlement.service';
import { calendarDay, isExpired } from './trading-days';

export const NO_BROKER_ACCOUNT_REASON = 'Compte-titres SDB non ouvert';

export interface AckSummary {
  batchId: string;
  accepted: string[];
  rejected: string[];
  ignored: string[];
}

export interface ExeSummary {
  batchId: string;
  executions: string[];
  unfilled: string[];
  ignored: string[];
  duplicates: string[];
}

type OrderForFill = Order & { instrument: Instrument };

const dayBounds = (at: Date): { start: Date; end: Date } => {
  const start = calendarDay(at, MARKET_TZ);
  return { start: new Date(start.getTime() - 3_600_000), end: new Date(start.getTime() + 86_400_000 - 3_600_000) };
};

/**
 * Lots ORD / WDR et retours ACK / EXE / CSH (blueprint §4.5). Une ligne EXE
 * devient une Execution (idempotente sur sdbExecRef) et un FILL au grand livre ;
 * une ligne ACK REJECTED libère la réserve ; un ordre sans exécution après ses
 * séances autorisées expire et sa réserve est libérée.
 */
@Injectable()
export class BatchesService {
  private readonly logger = new Logger(BatchesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orderLedger: OrderLedgerService,
    private readonly settlement: SettlementService,
    private readonly reconciliation: ReconciliationService,
    private readonly events: EventBus,
    @Inject(ORDER_CONNECTOR) private readonly connector: IOrderConnector,
  ) {}

  // ------------------------------------------------------------------ build

  async buildBatch(marketId: string, partnerId: string, actorId: string): Promise<OrderBatch> {
    const market = await this.prisma.market.findUnique({ where: { id: marketId } });
    if (!market) throw new NotFoundException('Marché introuvable.');
    const partner = await this.prisma.marketPartner.findUnique({ where: { id: partnerId } });
    if (!partner || partner.marketId !== marketId) throw new NotFoundException('Partenaire introuvable pour ce marché.');
    if (partner.agreementStatus !== PartnerAgreementStatus.ACTIVE) {
      throw new BadRequestException('Le partenaire n’est pas actif : aucun lot ne peut lui être transmis.');
    }

    const pending = await this.prisma.order.findMany({
      where: { marketId, partnerId, status: OrderStatus.PENDING, simulated: false },
      include: { instrument: true, user: { select: { id: true, fullName: true, email: true, phone: true } } },
      orderBy: { submittedAt: 'asc' },
    });

    const lines: BatchOrderLine[] = [];
    const rejected: Order[] = [];
    for (const order of pending) {
      const account = await this.prisma.brokerAccount.findUnique({ where: { userId_partnerId: { userId: order.userId, partnerId } } });
      if (!account || account.state !== BrokerAccountState.OPEN || !account.externalAccountNo) {
        await this.prisma.$transaction(async (tx) => {
          const { count } = await tx.order.updateMany({
            where: { id: order.id, status: OrderStatus.PENDING },
            data: { status: OrderStatus.REJECTED, rejectionReason: NO_BROKER_ACCOUNT_REASON },
          });
          if (count === 1) await this.orderLedger.releaseRemaining(order, order.instrument.currency, tx, actorId, NO_BROKER_ACCOUNT_REASON);
        });
        rejected.push(order);
        continue;
      }
      lines.push({ order, instrument: order.instrument, user: order.user, brokerAccount: { ...account, externalAccountNo: account.externalAccountNo } });
    }
    for (const order of rejected) {
      await this.events.publish('OrderRejected', {
        entityType: 'Order',
        entityId: order.id,
        actor: actorId,
        payload: { userId: order.userId, reason: NO_BROKER_ACCOUNT_REASON, partnerId },
      });
    }
    if (lines.length === 0) throw new BadRequestException('Aucun ordre en attente transmissible pour ce partenaire.');

    const now = new Date();
    const sequence = await this.nextSequence(partnerId, BatchType.ORD, now);
    const fileName = FileConnector.ordFileName(partner, now, sequence);

    const batch = await this.prisma.$transaction(async (tx) => {
      const created = await tx.orderBatch.create({
        data: { marketId, partnerId, type: BatchType.ORD, sequence, cutoffAt: now, fileName, lineCount: lines.length, createdById: actorId },
      });
      for (const line of lines) {
        assertTransition(line.order.status, OrderStatus.TRANSMITTED);
        await tx.order.update({
          where: { id: line.order.id },
          data: { status: OrderStatus.TRANSMITTED, batchId: created.id, transmittedAt: now },
        });
      }
      return created;
    });

    const submitted = await this.connector.submit({ batch, partner, market, lines });
    const autoSent = this.connector.kind === 'simulated';
    const final = await this.prisma.orderBatch.update({
      where: { id: batch.id },
      data: { fileHash: submitted.fileHash, ...(autoSent ? { state: BatchState.SENT, sentAt: new Date() } : {}) },
    });

    await this.events.publish('BatchBuilt', {
      entityType: 'OrderBatch',
      entityId: final.id,
      actor: actorId,
      payload: { marketId, partnerId, fileName, fileHash: final.fileHash, lineCount: lines.length, rejected: rejected.map((o) => o.id) },
    });
    for (const line of lines) {
      await this.events.publish('OrderTransmitted', {
        entityType: 'Order',
        entityId: line.order.id,
        actor: actorId,
        payload: { userId: line.order.userId, batchId: final.id, fileName },
      });
    }
    if (autoSent) await this.publishSent(final, SYSTEM_ACTOR);
    return final;
  }

  private async nextSequence(partnerId: string, type: BatchType, at: Date): Promise<number> {
    const { start, end } = dayBounds(at);
    const count = await this.prisma.orderBatch.count({ where: { partnerId, type, cutoffAt: { gte: start, lt: end } } });
    return count + 1;
  }

  async markSent(batchId: string, actorId: string): Promise<OrderBatch> {
    const batch = await this.getBatch(batchId);
    if (batch.state !== BatchState.BUILT) {
      if (batch.state === BatchState.SENT) return batch;
      throw new BadRequestException(`Lot dans l’état ${batch.state} : impossible de le marquer envoyé.`);
    }
    const sent = await this.prisma.orderBatch.update({ where: { id: batchId }, data: { state: BatchState.SENT, sentAt: new Date() } });
    await this.publishSent(sent, actorId);
    return sent;
  }

  private publishSent(batch: OrderBatch, actor: string) {
    return this.events.publish('BatchSent', {
      entityType: 'OrderBatch',
      entityId: batch.id,
      actor,
      payload: { fileName: batch.fileName, fileHash: batch.fileHash, partnerId: batch.partnerId, sentAt: batch.sentAt },
    });
  }

  // -------------------------------------------------------------------- ack

  async processAck(batchId: string, lines: AckLine[], actorId: string = SDB_FILE_ACTOR): Promise<AckSummary> {
    const batch = await this.getBatch(batchId);
    if (batch.type !== BatchType.ORD) throw new BadRequestException('Un fichier ACK ne concerne qu’un lot ORD.');
    const orders = await this.prisma.order.findMany({ where: { batchId }, include: { instrument: true } });
    const byId = new Map(orders.map((o) => [o.id, o]));
    const summary: AckSummary = { batchId, accepted: [], rejected: [], ignored: [] };

    for (const line of lines) {
      const order = byId.get(line.order_id);
      if (!order) {
        summary.ignored.push(line.order_id);
        continue;
      }
      if (line.status === 'ACCEPTED') {
        if (order.status !== OrderStatus.TRANSMITTED) continue; // already acknowledged or beyond: idempotent
        assertTransition(order.status, OrderStatus.ACKNOWLEDGED);
        await this.prisma.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.ACKNOWLEDGED, sdbRef: line.sdb_ref || null, acknowledgedAt: this.parseDate(line.ack_at) },
        });
        summary.accepted.push(order.id);
        await this.events.publish('OrderAcknowledged', {
          entityType: 'Order',
          entityId: order.id,
          actor: actorId,
          payload: { userId: order.userId, batchId, sdbRef: line.sdb_ref },
        });
      } else {
        if (order.status !== OrderStatus.TRANSMITTED && order.status !== OrderStatus.ACKNOWLEDGED) continue;
        const reason = [line.reject_code, line.reject_text].filter(Boolean).join(' ') || 'Rejeté par la SDB';
        await this.prisma.$transaction(async (tx) => {
          const { count } = await tx.order.updateMany({
            where: { id: order.id, status: order.status },
            data: { status: OrderStatus.REJECTED, rejectionReason: reason, sdbRef: line.sdb_ref || null },
          });
          if (count === 1) await this.orderLedger.releaseRemaining(order, order.instrument.currency, tx, actorId, reason);
        });
        summary.rejected.push(order.id);
        await this.events.publish('OrderRejected', {
          entityType: 'Order',
          entityId: order.id,
          actor: actorId,
          payload: { userId: order.userId, batchId, reason, sdbRef: line.sdb_ref },
        });
      }
    }

    const acked = await this.prisma.orderBatch.update({
      where: { id: batchId },
      data: { state: batch.state === BatchState.PROCESSED ? undefined : BatchState.ACKED, ackAt: batch.ackAt ?? new Date() },
    });
    await this.events.publish('BatchAcknowledged', {
      entityType: 'OrderBatch',
      entityId: batchId,
      actor: actorId,
      payload: { fileName: acked.fileName, accepted: summary.accepted.length, rejected: summary.rejected.length, ignored: summary.ignored.length },
    });
    return summary;
  }

  // -------------------------------------------------------------------- exe

  async processExecutions(batchId: string, lines: ExeLine[], actorId: string = SDB_FILE_ACTOR): Promise<ExeSummary> {
    const batch = await this.getBatch(batchId);
    if (batch.type !== BatchType.ORD) throw new BadRequestException('Un fichier EXE ne concerne qu’un lot ORD.');
    const orders = await this.prisma.order.findMany({ where: { batchId }, include: { instrument: true } });
    const byId = new Map(orders.map((o) => [o.id, o]));
    const summary: ExeSummary = { batchId, executions: [], unfilled: [], ignored: [], duplicates: [] };

    for (const line of lines) {
      const order = byId.get(line.order_id);
      if (!order) {
        summary.ignored.push(line.order_id);
        continue;
      }
      if (line.status === 'UNFILLED') {
        summary.unfilled.push(order.id);
        continue;
      }
      const result = await this.applyExecution(order, line, batchId, actorId, 'EXE_FILE');
      (result.created ? summary.executions : summary.duplicates).push(result.execution.id);
    }

    await this.prisma.orderBatch.update({ where: { id: batchId }, data: { state: BatchState.PROCESSED, processedAt: new Date() } });
    await this.events.publish('BatchProcessed', {
      entityType: 'OrderBatch',
      entityId: batchId,
      actor: actorId,
      payload: { fileName: batch.fileName, executions: summary.executions.length, unfilled: summary.unfilled.length, duplicates: summary.duplicates.length },
    });
    return summary;
  }

  /**
   * Applies one execution line: Execution row, FILL txn, fill counters, position,
   * and the release of the leftover reserve once the order is fully executed.
   * Idempotent on the execution reference (sdb_ref + executed_at, else orderId + executed_at).
   */
  async applyExecution(
    orderInput: OrderForFill,
    line: ExeLine,
    batchId: string | null,
    actorId: string,
    source: string,
    execRef?: string,
  ): Promise<{ execution: Execution; created: boolean }> {
    const sdbExecRef = execRef ?? (line.sdb_ref ? `${line.sdb_ref}:${line.executed_at}` : `${orderInput.id}:${line.executed_at}`);
    const existing = await this.prisma.execution.findUnique({ where: { sdbExecRef } });
    if (existing) return { execution: existing, created: false };

    const currency = orderInput.instrument.currency;
    const qty = D(line.executed_qty);
    const price = D(line.price);
    const executedAt = this.parseDate(line.executed_at);
    const settlementDate = await this.parseSettlementDate(line.settlement_date, executedAt, orderInput.marketId);

    const result = await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderInput.id } });
      if (!OPEN_AT_SDB.has(order.status)) {
        throw new BadRequestException(`Ordre ${order.id} dans l’état ${order.status} : exécution refusée.`);
      }
      if (!order.partnerId) throw new BadRequestException(`Ordre ${order.id} sans partenaire SDB.`);
      const fill = applyFill(order, qty, price);
      assertTransition(order.status, fill.status);

      const execution = await tx.execution.create({
        data: {
          orderId: order.id,
          batchId,
          quantity: qty,
          price,
          grossAmount: D(line.gross_amount),
          courtage: D(line.courtage || 0),
          taxes: D(line.taxes || 0),
          netAmount: D(line.net_amount),
          sdbExecRef,
          executedAt,
          settlementDate,
          settlementState: SettlementState.UNSETTLED,
        },
      });
      if (!order.simulated) {
        await this.orderLedger.postFill(order, execution, order.partnerId, currency, tx, actorId, source);
        if (order.side === OrderSide.BUY) await this.orderLedger.addPendingShares(order, qty, price, currency, tx);
      }
      const updated = await tx.order.update({
        where: { id: order.id },
        data: {
          filledQuantity: fill.filledQuantity,
          avgExecutedPrice: fill.avgExecutedPrice,
          status: fill.status,
          executedAt: fill.status === OrderStatus.EXECUTED ? executedAt : undefined,
          sdbRef: order.sdbRef ?? (line.sdb_ref || undefined),
        },
      });
      if (fill.status === OrderStatus.EXECUTED) {
        await this.orderLedger.releaseRemaining(updated, currency, tx, actorId, 'exécution complète');
      }
      const final = await tx.execution.findUniqueOrThrow({ where: { id: execution.id } });
      return { execution: final, order: updated };
    });

    await this.events.publish(result.order.status === OrderStatus.EXECUTED ? 'OrderExecuted' : 'OrderPartiallyExecuted', {
      entityType: 'Order',
      entityId: result.order.id,
      actor: actorId,
      payload: {
        userId: result.order.userId,
        executionId: result.execution.id,
        quantity: toApi(qty),
        price: toApi(price),
        filledQuantity: toApi(result.order.filledQuantity),
        avgExecutedPrice: toApi(result.order.avgExecutedPrice),
        fillTxnId: result.execution.fillTxnId,
        batchId,
      },
    });
    return { execution: result.execution, created: true };
  }

  // ----------------------------------------------------------------- expiry

  /** Weekdays at the BVMAC session close: orders that outlived their allowed sessions expire and free their reserve. */
  @Cron('0 16 * * 1-5', { timeZone: MARKET_TZ })
  async expireStaleJob(): Promise<void> {
    const expired = await this.expireStale();
    if (expired.length) this.logger.log(`${expired.length} ordre(s) expiré(s).`);
  }

  async expireStale(now: Date = new Date(), actorId: string = SYSTEM_ACTOR): Promise<string[]> {
    const open = await this.prisma.order.findMany({
      where: { status: { in: [...OPEN_AT_SDB] }, simulated: false, transmittedAt: { not: null } },
      include: { instrument: true, market: true },
    });
    const expired: string[] = [];
    for (const order of open) {
      if (!order.transmittedAt) continue;
      if (!isExpired(order.transmittedAt, order.expiresAfterSessions, now, order.market.timezone, order.market.cutoffTime)) continue;
      assertTransition(order.status, OrderStatus.EXPIRED);
      const done = await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.order.updateMany({
          where: { id: order.id, status: order.status },
          data: { status: OrderStatus.EXPIRED, expiredAt: now },
        });
        if (count !== 1) return false;
        await this.orderLedger.releaseRemaining(order, order.instrument.currency, tx, actorId, 'expiration');
        return true;
      });
      if (!done) continue;
      expired.push(order.id);
      await this.events.publish('OrderExpired', {
        entityType: 'Order',
        entityId: order.id,
        actor: actorId,
        payload: { userId: order.userId, filledQuantity: toApi(order.filledQuantity), quantity: toApi(order.quantity), batchId: order.batchId },
      });
    }
    return expired;
  }

  // -------------------------------------------------------------------- wdr

  async buildWdrBatch(partnerId: string, actorId: string): Promise<OrderBatch & { skipped: string[] }> {
    const partner = await this.prisma.marketPartner.findUnique({ where: { id: partnerId }, include: { market: true } });
    if (!partner) throw new NotFoundException('Partenaire introuvable.');
    if (partner.agreementStatus !== PartnerAgreementStatus.ACTIVE) {
      throw new BadRequestException('Le partenaire n’est pas actif : aucun lot ne peut lui être transmis.');
    }
    const intents = await this.prisma.paymentIntent.findMany({
      where: { direction: PaymentDirection.OUT, state: PaymentIntentState.PENDING, batchId: null, currency: partner.market.currency },
      orderBy: { createdAt: 'asc' },
    });
    const lines: WdrLine[] = [];
    const skipped: string[] = [];
    for (const intent of intents) {
      const account = await this.prisma.brokerAccount.findUnique({ where: { userId_partnerId: { userId: intent.userId, partnerId } } });
      if (!account || account.state !== BrokerAccountState.OPEN || !account.externalAccountNo) {
        skipped.push(intent.id);
        continue;
      }
      lines.push({ intent, brokerAccount: { ...account, externalAccountNo: account.externalAccountNo } });
    }
    if (lines.length === 0) throw new BadRequestException('Aucun retrait en attente pour ce partenaire.');

    const now = new Date();
    const sequence = await this.nextSequence(partnerId, BatchType.WDR, now);
    const fileName = FileConnector.wdrFileName(partner, now, sequence);
    const batch = await this.prisma.$transaction(async (tx) => {
      const created = await tx.orderBatch.create({
        data: { marketId: partner.marketId, partnerId, type: BatchType.WDR, sequence, cutoffAt: now, fileName, lineCount: lines.length, createdById: actorId },
      });
      await tx.paymentIntent.updateMany({ where: { id: { in: lines.map((l) => l.intent.id) } }, data: { batchId: created.id } });
      return created;
    });
    const submitted = await this.connector.submitWithdrawals({ batch, partner, market: partner.market, lines });
    const final = await this.prisma.orderBatch.update({ where: { id: batch.id }, data: { fileHash: submitted.fileHash } });
    await this.events.publish('BatchBuilt', {
      entityType: 'OrderBatch',
      entityId: final.id,
      actor: actorId,
      payload: { type: 'WDR', partnerId, fileName, fileHash: final.fileHash, lineCount: lines.length, skipped },
    });
    return { ...final, skipped };
  }

  // -------------------------------------------------------------------- csh

  /** A CSH statement drives both the daily reconciliation and the settlement of due executions. */
  async processStatement(partnerId: string, lines: CshLine[], actorId: string = SDB_FILE_ACTOR, at: Date = new Date()) {
    const reconciliation = await this.reconciliation.runDaily(partnerId, lines, actorId, at);
    const settled = await this.settlement.settleDue(at, actorId);
    return { reconciliation, settled };
  }

  // ------------------------------------------------------------------ reads

  list(filter: { marketId?: string; state?: BatchState; type?: BatchType }) {
    return this.prisma.orderBatch.findMany({
      where: {
        ...(filter.marketId ? { marketId: filter.marketId } : {}),
        ...(filter.state ? { state: filter.state } : {}),
        ...(filter.type ? { type: filter.type } : {}),
      },
      include: { partner: { select: { id: true, code: true, name: true } }, market: { select: { id: true, code: true, currency: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async getBatch(batchId: string): Promise<OrderBatch> {
    const batch = await this.prisma.orderBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new NotFoundException('Lot introuvable.');
    return batch;
  }

  async getBatchDetail(batchId: string) {
    const batch = await this.prisma.orderBatch.findUnique({
      where: { id: batchId },
      include: {
        partner: { select: { id: true, code: true, name: true } },
        market: { select: { id: true, code: true, currency: true } },
        orders: { include: { instrument: { select: { id: true, symbol: true, isin: true, currency: true } }, executions: true }, orderBy: { submittedAt: 'asc' } },
        paymentIntents: true,
      },
    });
    if (!batch) throw new NotFoundException('Lot introuvable.');
    return batch;
  }

  /** Regenerates the file from the database and checks it against the stored hash. */
  async batchFile(batchId: string): Promise<{ fileName: string; content: string; hash: string; hashMatches: boolean }> {
    const batch = await this.getBatch(batchId);
    let content: string;
    if (batch.type === BatchType.ORD) {
      const orders = await this.prisma.order.findMany({
        where: { batchId },
        include: { instrument: true, user: { select: { id: true, fullName: true, email: true, phone: true } } },
        orderBy: { submittedAt: 'asc' },
      });
      const lines: BatchOrderLine[] = [];
      for (const order of orders) {
        const account = await this.prisma.brokerAccount.findUnique({ where: { userId_partnerId: { userId: order.userId, partnerId: batch.partnerId } } });
        lines.push({
          order,
          instrument: order.instrument,
          user: order.user,
          brokerAccount: account
            ? { ...account, externalAccountNo: account.externalAccountNo ?? '' }
            : ({ externalAccountNo: '' } as BatchOrderLine['brokerAccount']),
        });
      }
      content = buildOrdCsv(lines);
    } else {
      const intents = await this.prisma.paymentIntent.findMany({ where: { batchId }, orderBy: { createdAt: 'asc' } });
      const lines: WdrLine[] = [];
      for (const intent of intents) {
        const account = await this.prisma.brokerAccount.findUnique({ where: { userId_partnerId: { userId: intent.userId, partnerId: batch.partnerId } } });
        lines.push({ intent, brokerAccount: account ? { ...account, externalAccountNo: account.externalAccountNo ?? '' } : ({ externalAccountNo: '' } as WdrLine['brokerAccount']) });
      }
      content = buildWdrCsv(lines);
    }
    const hash = sha256(content);
    return { fileName: batch.fileName, content, hash, hashMatches: batch.fileHash === null || batch.fileHash === hash };
  }

  // ------------------------------------------------------------------ utils

  private parseDate(raw: string): Date {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`Date invalide : « ${raw} ».`);
    return d;
  }

  private async parseSettlementDate(raw: string, executedAt: Date, marketId: string): Promise<Date> {
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return new Date(`${raw}T00:00:00Z`);
    const market: Pick<Market, 'settlementDays'> | null = await this.prisma.market.findUnique({ where: { id: marketId }, select: { settlementDays: true } });
    const day = calendarDay(executedAt, MARKET_TZ);
    return new Date(day.getTime() + (market?.settlementDays ?? 3) * 86_400_000);
  }
}
