import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Execution, LedgerAccountKind, LedgerTxnType, Order, OrderSide, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LEDGER_PORT, LedgerPort } from '../ledger/ledger.types';
import { D, ZERO, roundMoney, sum } from '../../common/money';
import { BrokerageKeys, feeAccount, sdbClearing, userAccount } from './brokerage.keys';
import { feesFromJson } from './fees-json';
import { weightedAvgCost } from './order-state';

/**
 * Money and position primitives shared by placement, batches, expiry,
 * back-office review and settlement. Every ledger txn posted by the brokerage
 * module goes through here so idempotency keys and entry shapes live in one
 * place (blueprint §4.4, ARCHITECTURE.md rule 2).
 *
 * Cash life-cycle of a real BUY (all in the instrument currency):
 *   RESERVE   reserve:<orderId>        AVAILABLE −max          RESERVED +max
 *   FILL      fill:<executionId>       RESERVED −(gross+courtage+taxes+commission)
 *                                      SDB/<partner> CLEARING +gross
 *                                      FEE/COURTAGE_SDB +courtage, FEE/TAXE +taxes, FEE/COMMISSION_ALKE +commission
 *   RELEASE   release:<orderId>        RESERVED −leftover      AVAILABLE +leftover   (once final)
 * Real SELL:
 *   FILL      fill:<executionId>       SDB/<partner> CLEARING −net   SETTLING +net
 *   SETTLEMENT settlement:<executionId> SETTLING −net              AVAILABLE +net
 * Shares of a SELL stay reserved on the Position until settlement.
 */
@Injectable()
export class OrderLedgerService {
  constructor(private readonly prisma: PrismaService, @Inject(LEDGER_PORT) private readonly ledger: LedgerPort) {}

  private currencyOf(order: Order & { instrument?: { currency: string } }, currency?: string): string {
    return currency ?? order.instrument?.currency ?? 'XAF';
  }

  // ----------------------------------------------------------------- reserve

  async reserveCash(order: Order, currency: string, tx: Prisma.TransactionClient): Promise<string> {
    const max = D(order.maxAmount);
    const txn = await this.ledger.post(
      {
        type: LedgerTxnType.RESERVE,
        idempotencyKey: BrokerageKeys.reserve(order.id),
        currency,
        source: 'ORDER',
        actorId: order.userId,
        refType: 'Order',
        refId: order.id,
        description: `Réservation ordre ${order.side} ${order.id}`,
        entries: [
          { account: userAccount(order.userId, currency, LedgerAccountKind.AVAILABLE), amount: max.negated() },
          { account: userAccount(order.userId, currency, LedgerAccountKind.RESERVED), amount: max },
        ],
      },
      tx,
    );
    await tx.order.update({ where: { id: order.id }, data: { reserveTxnId: txn.id } });
    return txn.id;
  }

  /** Reserves `qty` shares for a SELL; false when the user does not hold enough sellable (settled, unreserved) shares. */
  async reserveShares(userId: string, instrumentId: string, qty: Prisma.Decimal, tx: Prisma.TransactionClient): Promise<boolean> {
    const updated = await tx.$executeRaw`
      UPDATE "Position" SET "reservedQuantity" = "reservedQuantity" + ${qty}, "updatedAt" = NOW()
      WHERE "userId" = ${userId} AND "instrumentId" = ${instrumentId}
        AND "quantity" - "reservedQuantity" >= ${qty}`;
    return updated === 1;
  }

  async unreserveShares(userId: string, instrumentId: string, qty: Prisma.Decimal, tx: Prisma.TransactionClient): Promise<void> {
    if (!qty.greaterThan(0)) return;
    await tx.$executeRaw`
      UPDATE "Position" SET "reservedQuantity" = GREATEST("reservedQuantity" - ${qty}, 0), "updatedAt" = NOW()
      WHERE "userId" = ${userId} AND "instrumentId" = ${instrumentId}`;
  }

  // ------------------------------------------------------------------ release

  /** Cash already consumed from the reserve by the order's executions (BUY only). */
  async consumedReserve(order: Order, tx: Prisma.TransactionClient): Promise<Prisma.Decimal> {
    const executions = await tx.execution.findMany({ where: { orderId: order.id, fillTxnId: { not: null }, settlementState: { not: 'FAILED' } } });
    return sum(executions.map((e) => this.buyDebit(order, e)));
  }

  /** What a BUY execution takes from the reserve: gross + SDB courtage + taxes + prorated ALKÉ commission. */
  buyDebit(order: Order, e: Pick<Execution, 'grossAmount' | 'courtage' | 'taxes' | 'quantity'>, currency?: string): Prisma.Decimal {
    return D(e.grossAmount).plus(e.courtage).plus(e.taxes).plus(this.commissionFor(order, e.quantity, currency));
  }

  commissionFor(order: Order, qty: Prisma.Decimal.Value, currency = 'XAF'): Prisma.Decimal {
    const { commission } = feesFromJson(order.feesJson);
    if (commission.isZero()) return ZERO;
    return roundMoney(commission.times(qty).dividedBy(order.quantity), currency);
  }

  /**
   * Releases whatever is left of the BUY reserve (or the unfilled SELL shares).
   * Safe to call several times: the ledger key is `release:<orderId>` and the
   * remaining amount is recomputed from executions.
   */
  async releaseRemaining(order: Order, currency: string, tx: Prisma.TransactionClient, actorId: string | null, reason: string): Promise<void> {
    if (order.simulated) return;
    if (order.side === OrderSide.BUY) {
      if (!order.reserveTxnId) return;
      const consumed = await this.consumedReserve(order, tx);
      const remaining = D(order.maxAmount).minus(consumed);
      if (!remaining.greaterThan(0)) return;
      await this.ledger.post(
        {
          type: LedgerTxnType.RELEASE,
          idempotencyKey: BrokerageKeys.release(order.id),
          currency,
          source: 'ORDER',
          actorId,
          refType: 'Order',
          refId: order.id,
          description: `Libération réserve ordre ${order.id} (${reason})`,
          entries: [
            { account: userAccount(order.userId, currency, LedgerAccountKind.RESERVED), amount: remaining.negated() },
            { account: userAccount(order.userId, currency, LedgerAccountKind.AVAILABLE), amount: remaining },
          ],
        },
        tx,
      );
    } else {
      const unfilled = D(order.quantity).minus(order.filledQuantity);
      await this.unreserveShares(order.userId, order.instrumentId, unfilled, tx);
    }
  }

  // --------------------------------------------------------------------- fill

  async postFill(
    order: Order,
    execution: Execution,
    partnerId: string,
    currency: string,
    tx: Prisma.TransactionClient,
    actorId: string | null,
    source: string,
  ): Promise<string> {
    const gross = D(execution.grossAmount);
    const courtage = D(execution.courtage);
    const taxes = D(execution.taxes);
    const key = BrokerageKeys.fill(execution.id);
    let txnId: string;
    if (order.side === OrderSide.BUY) {
      const commission = this.commissionFor(order, execution.quantity, currency);
      const debit = gross.plus(courtage).plus(taxes).plus(commission);
      const consumedBefore = (await this.consumedReserve(order, tx)).minus(execution.fillTxnId ? this.buyDebit(order, execution, currency) : 0);
      if (consumedBefore.plus(debit).greaterThan(order.maxAmount)) {
        throw new BadRequestException(
          `Exécution ${execution.id} : montant ${debit.toFixed()} supérieur à la réserve restante de l’ordre (${D(order.maxAmount).minus(consumedBefore).toFixed()}).`,
        );
      }
      const entries = [
        { account: userAccount(order.userId, currency, LedgerAccountKind.RESERVED), amount: debit.negated() },
        { account: sdbClearing(partnerId, currency), amount: gross },
      ];
      if (!courtage.isZero()) entries.push({ account: feeAccount('COURTAGE_SDB', currency), amount: courtage });
      if (!taxes.isZero()) entries.push({ account: feeAccount('TAXE', currency), amount: taxes });
      if (!commission.isZero()) entries.push({ account: feeAccount('COMMISSION_ALKE', currency), amount: commission });
      const txn = await this.ledger.post(
        {
          type: LedgerTxnType.FILL,
          idempotencyKey: key,
          currency,
          source,
          actorId,
          refType: 'Execution',
          refId: execution.id,
          externalReference: execution.sdbExecRef ?? undefined,
          description: `Exécution achat ${order.id}`,
          entries,
        },
        tx,
      );
      txnId = txn.id;
    } else {
      const net = D(execution.netAmount);
      const txn = await this.ledger.post(
        {
          type: LedgerTxnType.FILL,
          idempotencyKey: key,
          currency,
          source,
          actorId,
          refType: 'Execution',
          refId: execution.id,
          externalReference: execution.sdbExecRef ?? undefined,
          description: `Exécution vente ${order.id}`,
          entries: [
            { account: sdbClearing(partnerId, currency), amount: net.negated() },
            { account: userAccount(order.userId, currency, LedgerAccountKind.SETTLING), amount: net },
          ],
        },
        tx,
      );
      txnId = txn.id;
    }
    await tx.execution.update({ where: { id: execution.id }, data: { fillTxnId: txnId } });
    return txnId;
  }

  /** BUY fill: shares appear as pending (executed, not yet delivered) at a weighted average cost. */
  async addPendingShares(order: Order, qty: Prisma.Decimal, price: Prisma.Decimal, currency: string, tx: Prisma.TransactionClient): Promise<void> {
    const where = { userId_instrumentId: { userId: order.userId, instrumentId: order.instrumentId } };
    const position = await tx.position.findUnique({ where });
    if (!position) {
      await tx.position.create({
        data: { userId: order.userId, instrumentId: order.instrumentId, quantity: 0, pendingQuantity: qty, reservedQuantity: 0, avgCost: price, currency },
      });
      return;
    }
    const held = D(position.quantity).plus(position.pendingQuantity);
    await tx.position.update({
      where,
      data: { pendingQuantity: D(position.pendingQuantity).plus(qty), avgCost: weightedAvgCost(held, position.avgCost, qty, price) },
    });
  }

  // --------------------------------------------------------------- settlement

  async settleBuyShares(order: Order, qty: Prisma.Decimal, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`
      UPDATE "Position" SET "pendingQuantity" = GREATEST("pendingQuantity" - ${qty}, 0), "quantity" = "quantity" + ${qty}, "updatedAt" = NOW()
      WHERE "userId" = ${order.userId} AND "instrumentId" = ${order.instrumentId}`;
  }

  async settleSellShares(order: Order, qty: Prisma.Decimal, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`
      UPDATE "Position" SET "reservedQuantity" = GREATEST("reservedQuantity" - ${qty}, 0), "quantity" = GREATEST("quantity" - ${qty}, 0), "updatedAt" = NOW()
      WHERE "userId" = ${order.userId} AND "instrumentId" = ${order.instrumentId}`;
  }

  async postSellSettlement(order: Order, execution: Execution, currency: string, tx: Prisma.TransactionClient, actorId: string | null): Promise<string> {
    const net = D(execution.netAmount);
    const txn = await this.ledger.post(
      {
        type: LedgerTxnType.SETTLEMENT,
        idempotencyKey: BrokerageKeys.settlement(execution.id),
        currency,
        source: 'JOB',
        actorId,
        refType: 'Execution',
        refId: execution.id,
        description: `Règlement vente ${order.id}`,
        entries: [
          { account: userAccount(order.userId, currency, LedgerAccountKind.SETTLING), amount: net.negated() },
          { account: userAccount(order.userId, currency, LedgerAccountKind.AVAILABLE), amount: net },
        ],
      },
      tx,
    );
    return txn.id;
  }

  /** Reverses a fill whose delivery failed and, for a BUY, returns the restored reserve to AVAILABLE. */
  async reverseFill(order: Order, execution: Execution, currency: string, reason: string, actorId: string | null, tx: Prisma.TransactionClient): Promise<void> {
    if (!execution.fillTxnId) return;
    await this.ledger.reverse(execution.fillTxnId, reason, actorId, tx);
    if (order.side === OrderSide.BUY) {
      const amount = this.buyDebit(order, execution, currency);
      await this.ledger.post(
        {
          type: LedgerTxnType.RELEASE,
          idempotencyKey: BrokerageKeys.settlementFailRelease(execution.id),
          currency,
          source: 'ADMIN',
          actorId,
          refType: 'Execution',
          refId: execution.id,
          description: `Échec de règlement ${execution.id} : ${reason}`,
          entries: [
            { account: userAccount(order.userId, currency, LedgerAccountKind.RESERVED), amount: amount.negated() },
            { account: userAccount(order.userId, currency, LedgerAccountKind.AVAILABLE), amount },
          ],
        },
        tx,
      );
    }
  }

  balances(userId: string, currency: string) {
    return this.ledger.userBalances(userId, currency);
  }

  currency(order: Order & { instrument?: { currency: string } }, fallback?: string): string {
    return this.currencyOf(order, fallback);
  }
}
