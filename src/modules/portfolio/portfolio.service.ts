import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Instrument, LedgerAccountKind, LedgerOwnerType, OrderSide, Prisma, SettlementState } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LEDGER_PORT, LedgerPort, MIRROR_KINDS } from '../ledger/ledger.types';
import { D, ZERO, roundMoney, toApi } from '../../common/money';

export interface PositionView {
  instrumentId: string;
  symbol: string;
  name: string;
  isin: string | null;
  marketId: string;
  currency: string;
  settledQuantity: string;
  pendingQuantity: string;
  reservedQuantity: string;
  /** settled + pending: what the client economically owns. */
  totalQuantity: string;
  /** settled − reserved: what can be sold now. */
  sellableQuantity: string;
  avgCost: string;
  lastPrice: string | null;
  marketValue: string;
  costBasis: string;
  gain: string;
  gainPct: string;
}

type PositionRow = {
  instrumentId: string;
  quantity: Prisma.Decimal;
  pendingQuantity: Prisma.Decimal;
  reservedQuantity: Prisma.Decimal;
  avgCost: Prisma.Decimal;
  currency: string;
  instrument: Instrument;
};

/**
 * Vue portefeuille (blueprint §4.2) : les espèces viennent du grand livre,
 * les titres des positions dérivées des exécutions. Aucun solde n'est stocké ici.
 */
@Injectable()
export class PortfolioService {
  constructor(private readonly prisma: PrismaService, @Inject(LEDGER_PORT) private readonly ledger: LedgerPort) {}

  private async resolveCurrency(userId: string, currency?: string): Promise<string> {
    if (currency) return currency.toUpperCase();
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { displayCurrency: true } });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    return user.displayCurrency;
  }

  private view(p: PositionRow): PositionView {
    const total = D(p.quantity).plus(p.pendingQuantity);
    const lastPrice = p.instrument.lastPrice != null ? D(p.instrument.lastPrice) : null;
    const marketValue = roundMoney(total.times(lastPrice ?? p.avgCost), p.currency);
    const costBasis = roundMoney(total.times(p.avgCost), p.currency);
    const gain = marketValue.minus(costBasis);
    const gainPct = costBasis.isZero() ? ZERO : gain.dividedBy(costBasis).times(100).toDecimalPlaces(2);
    return {
      instrumentId: p.instrumentId,
      symbol: p.instrument.symbol,
      name: p.instrument.name,
      isin: p.instrument.isin,
      marketId: p.instrument.marketId,
      currency: p.currency,
      settledQuantity: D(p.quantity).toFixed(),
      pendingQuantity: D(p.pendingQuantity).toFixed(),
      reservedQuantity: D(p.reservedQuantity).toFixed(),
      totalQuantity: total.toFixed(),
      sellableQuantity: D(p.quantity).minus(p.reservedQuantity).toFixed(),
      avgCost: D(p.avgCost).toFixed(),
      lastPrice: toApi(lastPrice),
      marketValue: marketValue.toFixed(),
      costBasis: costBasis.toFixed(),
      gain: gain.toFixed(),
      gainPct: gainPct.toFixed(),
    };
  }

  async positions(userId: string, currency?: string): Promise<PositionView[]> {
    const rows = await this.prisma.position.findMany({
      where: { userId, ...(currency ? { currency: currency.toUpperCase() } : {}) },
      include: { instrument: true },
      orderBy: { instrument: { symbol: 'asc' } },
    });
    return rows.filter((r) => !D(r.quantity).plus(r.pendingQuantity).isZero() || !D(r.reservedQuantity).isZero()).map((r) => this.view(r));
  }

  async summary(userId: string, currencyInput?: string) {
    const currency = await this.resolveCurrency(userId, currencyInput);
    const [cash, positions, currencies] = await Promise.all([
      this.ledger.userBalances(userId, currency),
      this.positions(userId, currency),
      this.ledger.userCurrencies(userId),
    ]);
    const invested = positions.reduce((acc, p) => acc.plus(p.marketValue), ZERO);
    const costBasis = positions.reduce((acc, p) => acc.plus(p.costBasis), ZERO);
    const gain = invested.minus(costBasis);
    const totalCash = cash.available.plus(cash.reserved).plus(cash.settling).plus(cash.withdrawable);
    return {
      currency,
      currencies,
      cash: {
        available: cash.available.toFixed(),
        reserved: cash.reserved.toFixed(),
        settling: cash.settling.toFixed(),
        withdrawable: cash.withdrawable.toFixed(),
        total: totalCash.toFixed(),
      },
      positions,
      totals: {
        investedValue: invested.toFixed(),
        costBasis: costBasis.toFixed(),
        gain: gain.toFixed(),
        gainPct: (costBasis.isZero() ? ZERO : gain.dividedBy(costBasis).times(100).toDecimalPlaces(2)).toFixed(),
        wealth: totalCash.plus(invested).toFixed(),
      },
    };
  }

  /**
   * Daily value of the securities over the last `range` days, rebuilt from the
   * executions (quantity held on each day) and the quote history (close of the
   * day, else the last known close, else the current price). Cash is reported
   * at its current level: the series measures the portfolio, not the deposits.
   */
  async performance(userId: string, range = 30, currencyInput?: string) {
    const days = Math.min(Math.max(Math.trunc(range) || 30, 1), 366);
    const currency = await this.resolveCurrency(userId, currencyInput);
    const today = new Date();
    const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const start = new Date(end.getTime() - (days - 1) * 86_400_000);

    const executions = await this.prisma.execution.findMany({
      where: { order: { userId, simulated: false, instrument: { currency } }, settlementState: { not: SettlementState.FAILED } },
      include: { order: { select: { side: true, instrumentId: true } } },
      orderBy: { executedAt: 'asc' },
    });
    const instrumentIds = [...new Set(executions.map((e) => e.order.instrumentId))];
    const [instruments, quotes, cash] = await Promise.all([
      this.prisma.instrument.findMany({ where: { id: { in: instrumentIds } }, select: { id: true, lastPrice: true } }),
      this.prisma.instrumentQuote.findMany({
        where: { instrumentId: { in: instrumentIds }, tradeDate: { lte: end } },
        orderBy: { tradeDate: 'asc' },
        select: { instrumentId: true, tradeDate: true, close: true },
      }),
      this.ledger.userBalances(userId, currency),
    ]);
    const lastPrice = new Map(instruments.map((i) => [i.id, i.lastPrice != null ? D(i.lastPrice) : null]));
    const quotesByInstrument = new Map<string, { date: number; close: Prisma.Decimal }[]>();
    for (const q of quotes) {
      const list = quotesByInstrument.get(q.instrumentId) ?? [];
      list.push({ date: q.tradeDate.getTime(), close: D(q.close) });
      quotesByInstrument.set(q.instrumentId, list);
    }
    const priceAt = (instrumentId: string, day: number): Prisma.Decimal | null => {
      const list = quotesByInstrument.get(instrumentId) ?? [];
      let found: Prisma.Decimal | null = null;
      for (const q of list) {
        if (q.date > day + 86_399_999) break;
        found = q.close;
      }
      return found ?? lastPrice.get(instrumentId) ?? null;
    };

    const cashTotal = cash.available.plus(cash.reserved).plus(cash.settling).plus(cash.withdrawable);
    const points: { date: string; securities: string; cash: string; total: string }[] = [];
    for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) {
      const held = new Map<string, Prisma.Decimal>();
      for (const e of executions) {
        if (e.executedAt.getTime() > t + 86_399_999) break;
        const sign = e.order.side === OrderSide.BUY ? 1 : -1;
        held.set(e.order.instrumentId, (held.get(e.order.instrumentId) ?? ZERO).plus(D(e.quantity).times(sign)));
      }
      let securities = ZERO;
      for (const [instrumentId, qty] of held) {
        const price = priceAt(instrumentId, t);
        if (price) securities = securities.plus(qty.times(price));
      }
      securities = roundMoney(securities, currency);
      points.push({ date: new Date(t).toISOString().slice(0, 10), securities: securities.toFixed(), cash: cashTotal.toFixed(), total: securities.plus(cashTotal).toFixed() });
    }
    const first = D(points[0]?.total ?? 0);
    const last = D(points[points.length - 1]?.total ?? 0);
    return {
      currency,
      range: days,
      from: points[0]?.date ?? null,
      to: points[points.length - 1]?.date ?? null,
      change: last.minus(first).toFixed(),
      changePct: (first.isZero() ? ZERO : last.minus(first).dividedBy(first).times(100).toDecimalPlaces(2)).toFixed(),
      points,
    };
  }

  /** Monthly statement (YYYY-MM): cash movements from the ledger, executions, closing positions. */
  async statement(userId: string, period: string, currencyInput?: string) {
    const m = /^(\d{4})-(\d{2})$/.exec(period);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new BadRequestException('Période attendue au format YYYY-MM.');
    const currency = await this.resolveCurrency(userId, currencyInput);
    const from = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
    const to = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
    if (from.getTime() > Date.now()) throw new BadRequestException('Période future.');

    const [entries, after, executions, positions] = await Promise.all([
      this.prisma.ledgerEntry.findMany({
        where: {
          account: { ownerType: LedgerOwnerType.USER, ownerId: userId, currency, kind: { in: [...MIRROR_KINDS, LedgerAccountKind.WITHDRAWABLE] } },
          txn: { postedAt: { gte: from, lt: to } },
        },
        include: { txn: true, account: { select: { kind: true } } },
        orderBy: { txn: { postedAt: 'asc' } },
      }),
      this.prisma.ledgerEntry.aggregate({
        where: {
          account: { ownerType: LedgerOwnerType.USER, ownerId: userId, currency, kind: { in: [...MIRROR_KINDS, LedgerAccountKind.WITHDRAWABLE] } },
          txn: { postedAt: { gte: to } },
        },
        _sum: { amount: true },
      }),
      this.prisma.execution.findMany({
        where: { order: { userId, instrument: { currency } }, executedAt: { gte: from, lt: to } },
        include: { order: { select: { id: true, side: true, simulated: true, instrument: { select: { symbol: true, isin: true, name: true } } } } },
        orderBy: { executedAt: 'asc' },
      }),
      this.positions(userId, currency),
    ]);
    const balances = await this.ledger.userBalances(userId, currency);
    const current = balances.available.plus(balances.reserved).plus(balances.settling).plus(balances.withdrawable);
    const closing = current.minus(after._sum.amount ?? ZERO);
    const movementTotal = entries.reduce((acc, e) => acc.plus(e.amount), ZERO);
    const opening = closing.minus(movementTotal);

    return {
      period,
      currency,
      generatedAt: new Date().toISOString(),
      cash: {
        opening: opening.toFixed(),
        closing: closing.toFixed(),
        movements: entries.map((e) => ({
          txnId: e.txnId,
          postedAt: e.txn.postedAt,
          type: e.txn.type,
          kind: e.account.kind,
          amount: D(e.amount).toFixed(),
          description: e.txn.description,
          refType: e.txn.refType,
          refId: e.txn.refId,
        })),
      },
      executions: executions.map((e) => ({
        executionId: e.id,
        orderId: e.order.id,
        side: e.order.side,
        simulated: e.order.simulated,
        symbol: e.order.instrument.symbol,
        isin: e.order.instrument.isin,
        quantity: D(e.quantity).toFixed(),
        price: D(e.price).toFixed(),
        grossAmount: D(e.grossAmount).toFixed(),
        courtage: D(e.courtage).toFixed(),
        taxes: D(e.taxes).toFixed(),
        netAmount: D(e.netAmount).toFixed(),
        executedAt: e.executedAt,
        settlementState: e.settlementState,
        settledAt: e.settledAt,
      })),
      positions,
    };
  }
}
