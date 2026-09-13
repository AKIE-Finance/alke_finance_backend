import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AlertSeverity, AlertSource, Execution, OrderSide, OrderStatus, SettlementState } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EventBus } from '../../common/events/event-bus.service';
import { D, ZERO, toApi } from '../../common/money';
import { SYSTEM_ACTOR } from './brokerage.keys';
import { MARKET_TZ } from './connectors/csv';
import { OrderLedgerService } from './order-ledger.service';
import { calendarDay } from './trading-days';

/**
 * Règlement-livraison (blueprint §4.15). Une exécution est réglée à sa
 * settlementDate (J+settlementDays) : les titres achetés passent de « en
 * attente » à « réglés », le produit d'une vente passe de SETTLING à AVAILABLE.
 * Un échec de livraison annule le FILL (REVERSAL), restaure l'ordre et la
 * position, et ouvre une alerte conformité.
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(private readonly prisma: PrismaService, private readonly orderLedger: OrderLedgerService, private readonly events: EventBus) {}

  @Cron('0 18 * * 1-5', { timeZone: MARKET_TZ })
  async settleDueJob(): Promise<void> {
    const settled = await this.settleDue();
    if (settled.length) this.logger.log(`${settled.length} exécution(s) réglée(s).`);
  }

  /** Settles every UNSETTLED/SETTLING execution whose settlement date is on or before `date`. */
  async settleDue(date: Date = new Date(), actorId: string = SYSTEM_ACTOR): Promise<string[]> {
    const dueDay = calendarDay(date, MARKET_TZ);
    const due = await this.prisma.execution.findMany({
      where: {
        settlementState: { in: [SettlementState.UNSETTLED, SettlementState.SETTLING] },
        OR: [{ settlementDate: { lte: dueDay } }, { settlementDate: null, executedAt: { lte: new Date(dueDay.getTime() - 3 * 86_400_000) } }],
      },
      include: { order: { include: { instrument: true } } },
      orderBy: { executedAt: 'asc' },
    });
    const settled: string[] = [];
    for (const execution of due) {
      const { order } = execution;
      const currency = order.instrument.currency;
      const qty = D(execution.quantity);
      const result = await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.execution.updateMany({
          where: { id: execution.id, settlementState: { in: [SettlementState.UNSETTLED, SettlementState.SETTLING] } },
          data: { settlementState: SettlementState.SETTLING },
        });
        if (count !== 1) return null;
        let settlementTxnId: string | null = null;
        if (!order.simulated) {
          if (order.side === OrderSide.BUY) {
            await this.orderLedger.settleBuyShares(order, qty, tx);
          } else {
            settlementTxnId = await this.orderLedger.postSellSettlement(order, execution, currency, tx, actorId);
            await this.orderLedger.settleSellShares(order, qty, tx);
          }
        }
        return tx.execution.update({
          where: { id: execution.id },
          data: { settlementState: SettlementState.SETTLED, settledAt: new Date(), settlementTxnId },
        });
      });
      if (!result) continue;
      settled.push(result.id);
      await this.events.publish('SettlementConfirmed', {
        entityType: 'Execution',
        entityId: result.id,
        actor: actorId,
        payload: {
          orderId: order.id,
          userId: order.userId,
          side: order.side,
          quantity: toApi(qty),
          netAmount: toApi(execution.netAmount),
          currency,
          settlementTxnId: result.settlementTxnId,
        },
      });
    }
    return settled;
  }

  /**
   * Delivery failure: reverses the FILL, hands the cash back, rewinds the order
   * counters and the position, and raises a HIGH compliance alert.
   */
  async failSettlement(executionId: string, reason: string, actorId: string): Promise<Execution> {
    const execution = await this.prisma.execution.findUnique({ where: { id: executionId }, include: { order: { include: { instrument: true } } } });
    if (!execution) throw new NotFoundException('Exécution introuvable.');
    if (execution.settlementState === SettlementState.SETTLED) throw new BadRequestException('Cette exécution est déjà réglée.');
    if (execution.settlementState === SettlementState.FAILED) return execution;
    if (!reason?.trim()) throw new BadRequestException('Un motif est requis.');
    const { order } = execution;
    const currency = order.instrument.currency;
    const qty = D(execution.quantity);

    const failed = await this.prisma.$transaction(async (tx) => {
      await this.orderLedger.reverseFill(order, execution, currency, reason, actorId, tx);
      const updated = await tx.execution.update({
        where: { id: executionId },
        data: { settlementState: SettlementState.FAILED, settlementTxnId: null },
      });

      // Order counters: recompute from the executions that still stand.
      const standing = await tx.execution.findMany({ where: { orderId: order.id, settlementState: { not: SettlementState.FAILED } } });
      const filled = standing.reduce((acc, e) => acc.plus(e.quantity), ZERO);
      const cost = standing.reduce((acc, e) => acc.plus(D(e.quantity).times(e.price)), ZERO);
      await tx.order.update({
        where: { id: order.id },
        data: {
          filledQuantity: filled,
          avgExecutedPrice: filled.isZero() ? null : cost.dividedBy(filled).toDecimalPlaces(4),
          status: OrderStatus.ADJUSTED,
          rejectionReason: `Échec de règlement : ${reason}`,
        },
      });

      // Position: undo the pending shares of a BUY; free the reserved shares of a SELL.
      if (!order.simulated) {
        if (order.side === OrderSide.BUY) {
          await tx.$executeRaw`
            UPDATE "Position" SET "pendingQuantity" = GREATEST("pendingQuantity" - ${qty}, 0), "updatedAt" = NOW()
            WHERE "userId" = ${order.userId} AND "instrumentId" = ${order.instrumentId}`;
        } else {
          await this.orderLedger.unreserveShares(order.userId, order.instrumentId, qty, tx);
        }
      }

      await tx.complianceAlert.create({
        data: {
          source: AlertSource.SETTLEMENT_FAILURE,
          severity: AlertSeverity.HIGH,
          userId: order.userId,
          entityType: 'Execution',
          entityId: executionId,
          summary: `Échec de règlement-livraison sur l’ordre ${order.id} : ${reason}`,
          details: { orderId: order.id, quantity: toApi(qty), netAmount: toApi(execution.netAmount), currency, actorId },
        },
      });
      return updated;
    });

    await this.events.publish('SettlementFailed', {
      entityType: 'Execution',
      entityId: executionId,
      actor: actorId,
      payload: { orderId: order.id, userId: order.userId, reason, fillTxnId: execution.fillTxnId, quantity: toApi(qty), currency },
    });
    return failed;
  }
}
