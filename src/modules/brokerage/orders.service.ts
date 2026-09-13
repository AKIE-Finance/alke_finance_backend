import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  Instrument,
  IntegrationTier,
  Market,
  MarketPartner,
  Order,
  OrderSide,
  OrderStatus,
  OrderType,
  PartnerAgreementStatus,
  PendingApproval,
  Prisma,
  RecurringPlan,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EventBus } from '../../common/events/event-bus.service';
import { D, ZERO, roundMoney, toApi } from '../../common/money';
import { APPROVALS_PORT, ApprovalsPort } from '../approvals/approvals.types';
import { PolicyService } from '../policy/policy.service';
import { PlaceOrderDto } from './dto/place-order.dto';
import { ReviewOrderDto } from './dto/review-order.dto';
import { CreateRecurringPlanDto, UpdateRecurringPlanDto } from './dto/recurring-plan.dto';
import { FEES_PORT, FeesPort, OrderFeeLine } from './ports';
import { feeTotal, feesToJson } from './fees-json';
import { OrderLedgerService } from './order-ledger.service';
import { BatchesService } from './batches.service';
import { assertTransition, canTransition, isFinal } from './order-state';
import { sessionsForValidity } from './trading-days';
import { SYSTEM_ACTOR } from './brokerage.keys';

export interface OrderQuote {
  currency: string;
  estimatedPrice: Prisma.Decimal;
  estimatedTotal: Prisma.Decimal;
  fees: OrderFeeLine[];
  feeTotal: Prisma.Decimal;
  /** Cash reserved for a BUY (total + fees); for a SELL the estimated gross. */
  maxAmount: Prisma.Decimal;
}

export type OrderWithRelations = Order & { instrument: Instrument; market: Market; partner: MarketPartner | null };

export interface OrderListFilter {
  marketId?: string;
  status?: OrderStatus;
  batchId?: string;
  userId?: string;
  limit?: number;
}

const instrumentInclude = { instrument: true, market: true, partner: true } as const;

/**
 * Moteur d'ordres (blueprint §4.3). Un ordre réel réserve les espèces (ou les
 * titres) au moment du dépôt, part dans un lot ORD (BatchesService), et suit la
 * machine à états d'order-state.ts. Un ordre simulé (paper trading, réservé aux
 * comptes démo — D15) ne touche jamais le grand livre ni les positions.
 */
@Injectable()
export class OrdersService implements OnModuleInit {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly orderLedger: OrderLedgerService,
    private readonly batches: BatchesService,
    private readonly events: EventBus,
    @Inject(FEES_PORT) private readonly fees: FeesPort,
    @Inject(APPROVALS_PORT) private readonly approvals: ApprovalsPort,
  ) {}

  onModuleInit(): void {
    this.approvals.registerExecutor('ORDER_REVIEW', (approval) => this.applyReview(approval));
  }

  // ------------------------------------------------------------------ quote

  async quote(instrument: Instrument, side: OrderSide, quantity: Prisma.Decimal): Promise<OrderQuote> {
    if (instrument.lastPrice == null) throw new BadRequestException('Valeur indisponible ou sans cours de référence.');
    const currency = instrument.currency;
    const estimatedPrice = D(instrument.lastPrice);
    const estimatedTotal = roundMoney(quantity.times(estimatedPrice), currency);
    const fees = await this.fees.computeOrderFees(instrument.marketId, estimatedTotal, currency);
    const total = feeTotal(fees);
    const maxAmount = side === OrderSide.BUY ? estimatedTotal.plus(total) : estimatedTotal;
    return { currency, estimatedPrice, estimatedTotal, fees, feeTotal: total, maxAmount };
  }

  private parseDto(dto: PlaceOrderDto): { quantity: Prisma.Decimal; validity: string } {
    if ((dto.orderType ?? OrderType.MARKET) !== OrderType.MARKET) {
      throw new BadRequestException('Seuls les ordres au marché (MARKET) sont disponibles en v1.0.');
    }
    const quantity = D(dto.quantity);
    if (!quantity.isFinite() || !quantity.greaterThan(0)) throw new BadRequestException('La quantité doit être strictement positive.');
    return { quantity, validity: dto.validity ?? 'DAY' };
  }

  private async loadInstrument(instrumentId: string): Promise<Instrument & { market: Market }> {
    const instrument = await this.prisma.instrument.findUnique({ where: { id: instrumentId }, include: { market: true } });
    if (!instrument) throw new NotFoundException('Valeur introuvable.');
    return instrument;
  }

  /** Same checks and figures as placeOrder, without writing anything. */
  async preview(userId: string, dto: PlaceOrderDto) {
    const { quantity, validity } = this.parseDto(dto);
    const instrument = await this.loadInstrument(dto.instrumentId);
    const market = instrument.market;
    const simulated = this.policy.isSimulated(market);
    const trade = await this.policy.canTrade(userId, market.id);
    const q = await this.quote(instrument, dto.side, quantity);
    const sessions = sessionsForValidity(validity, new Date(), market.timezone, market.cutoffTime);
    const placement = trade.allow
      ? await this.policy.canPlaceOrder(userId, { ...q, side: dto.side, quantity, instrumentId: instrument.id, simulated })
      : trade;
    return {
      instrumentId: instrument.id,
      symbol: instrument.symbol,
      side: dto.side,
      quantity: quantity.toFixed(),
      currency: q.currency,
      simulated,
      estimatedPrice: toApi(q.estimatedPrice),
      estimatedTotal: toApi(q.estimatedTotal),
      fees: q.fees.map((f) => ({ code: f.code, label: f.label, amount: toApi(f.amount) })),
      feeTotal: toApi(q.feeTotal),
      maxAmount: toApi(q.maxAmount),
      validity,
      expiresAfterSessions: sessions,
      allowed: trade.allow && placement.allow && sessions !== null,
      reason: !trade.allow ? trade.reason : !placement.allow ? placement.reason : sessions === null ? 'Validité invalide ou déjà échue.' : undefined,
    };
  }

  // ------------------------------------------------------------------ place

  async placeOrder(userId: string, dto: PlaceOrderDto): Promise<OrderWithRelations> {
    const { quantity, validity } = this.parseDto(dto);
    const instrument = await this.loadInstrument(dto.instrumentId);
    const market = instrument.market;
    const now = new Date();

    const sessions = sessionsForValidity(validity, now, market.timezone, market.cutoffTime);
    if (sessions === null) throw new BadRequestException('Validité invalide ou déjà échue (DAY ou GTD:YYYYMMDD).');

    const trade = await this.policy.canTrade(userId, market.id);
    if (!trade.allow) throw new ForbiddenException(trade.reason);

    const simulated = this.policy.isSimulated(market);
    const q = await this.quote(instrument, dto.side, quantity);
    const check = await this.policy.canPlaceOrder(userId, { ...q, side: dto.side, quantity, instrumentId: instrument.id, simulated });
    if (!check.allow) throw new BadRequestException(check.reason);

    let partner: MarketPartner | null = null;
    if (!simulated) {
      partner = await this.prisma.marketPartner.findFirst({
        where: { marketId: market.id, agreementStatus: PartnerAgreementStatus.ACTIVE },
        orderBy: { createdAt: 'asc' },
      });
      if (!partner) throw new ServiceUnavailableException('Aucun partenaire SDB actif pour ce marché.');
    }

    const courtage = q.fees.filter((f) => f.code === 'COURTAGE_SDB').reduce((acc, f) => acc.plus(f.amount), ZERO);
    const data: Prisma.OrderUncheckedCreateInput = {
      userId,
      instrumentId: instrument.id,
      marketId: market.id,
      partnerId: partner?.id ?? null,
      side: dto.side,
      orderType: OrderType.MARKET,
      quantity,
      estimatedPrice: q.estimatedPrice,
      estimatedTotal: q.estimatedTotal,
      maxAmount: q.maxAmount,
      brokerageFee: courtage,
      feesJson: feesToJson(q.fees),
      executionTier: partner?.integrationTier ?? IntegrationTier.TIER0_SIMULATED,
      simulated,
      validity,
      expiresAfterSessions: sessions,
      submittedAt: now,
    };
    if (simulated) {
      Object.assign(data, {
        status: OrderStatus.EXECUTED,
        filledQuantity: quantity,
        avgExecutedPrice: q.estimatedPrice,
        executedAt: now,
        sdbRef: 'SIM-PAPER',
      });
    }

    const order = await this.prisma.$transaction(async (tx) => {
      const created = await tx.order.create({ data, include: instrumentInclude });
      if (simulated) return created;
      if (dto.side === OrderSide.BUY) {
        await this.orderLedger.reserveCash(created, q.currency, tx);
      } else {
        const ok = await this.orderLedger.reserveShares(userId, instrument.id, quantity, tx);
        if (!ok) throw new BadRequestException('Quantité insuffisante en portefeuille pour cette vente.');
      }
      return tx.order.findUniqueOrThrow({ where: { id: created.id }, include: instrumentInclude });
    });

    await this.events.publish('OrderCreated', {
      entityType: 'Order',
      entityId: order.id,
      actor: userId,
      payload: this.eventPayload(order),
    });
    if (simulated) {
      await this.events.publish('OrderExecuted', {
        entityType: 'Order',
        entityId: order.id,
        actor: SYSTEM_ACTOR,
        payload: { ...this.eventPayload(order), simulated: true },
      });
    }
    return order;
  }

  // ----------------------------------------------------------------- cancel

  async cancel(userId: string, orderId: string): Promise<OrderWithRelations> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: instrumentInclude });
    if (!order || order.userId !== userId) throw new NotFoundException('Ordre introuvable.');
    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException('Seul un ordre en attente (non transmis) peut être annulé.');
    }
    const cancelled = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.order.updateMany({
        where: { id: orderId, status: OrderStatus.PENDING },
        data: { status: OrderStatus.CANCELLED, cancelledAt: new Date() },
      });
      if (count !== 1) throw new BadRequestException('Cet ordre a déjà été transmis et ne peut plus être annulé.');
      await this.orderLedger.releaseRemaining(order, order.instrument.currency, tx, userId, 'annulation');
      return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: instrumentInclude });
    });
    await this.events.publish('OrderCancelled', {
      entityType: 'Order',
      entityId: orderId,
      actor: userId,
      payload: this.eventPayload(cancelled),
    });
    return cancelled;
  }

  // ------------------------------------------------------------------ reads

  listMine(userId: string, limit = 50): Promise<OrderWithRelations[]> {
    return this.prisma.order.findMany({
      where: { userId },
      include: instrumentInclude,
      orderBy: { submittedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  async getForUser(userId: string, orderId: string, isStaff = false) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { ...instrumentInclude, executions: { orderBy: { executedAt: 'asc' } } },
    });
    if (!order || (!isStaff && order.userId !== userId)) throw new NotFoundException('Ordre introuvable.');
    return order;
  }

  listAll(filter: OrderListFilter): Promise<OrderWithRelations[]> {
    return this.prisma.order.findMany({
      where: {
        ...(filter.marketId ? { marketId: filter.marketId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.batchId ? { batchId: filter.batchId } : {}),
        ...(filter.userId ? { userId: filter.userId } : {}),
      },
      include: instrumentInclude,
      orderBy: { submittedAt: 'desc' },
      take: Math.min(Math.max(filter.limit ?? 200, 1), 1000),
    });
  }

  // ----------------------------------------------------------------- review

  /** Back-office correction: validated now, applied by `applyReview` once a second approver agrees. */
  async requestReview(actorId: string, orderId: string, dto: ReviewOrderDto): Promise<PendingApproval> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Ordre introuvable.');
    if (isFinal(order.status)) throw new BadRequestException(`L’ordre est dans l’état final ${order.status} : aucune correction possible.`);
    if (!canTransition(order.status, dto.status)) {
      throw new BadRequestException(`Transition ${order.status} → ${dto.status} interdite.`);
    }
    if ((dto.status === OrderStatus.EXECUTED || dto.status === OrderStatus.PARTIALLY_EXECUTED) && (dto.executedPrice == null || dto.executedQuantity == null)) {
      throw new BadRequestException('Une exécution manuelle requiert executedPrice et executedQuantity.');
    }
    return this.approvals.request({
      actionType: 'ORDER_REVIEW',
      entityType: 'Order',
      entityId: orderId,
      makerId: actorId,
      reason: dto.reason,
      payload: {
        status: dto.status,
        executedPrice: dto.executedPrice ?? null,
        executedQuantity: dto.executedQuantity ?? null,
        sdbRef: dto.sdbRef ?? null,
        reason: dto.reason,
      },
    });
  }

  /** ORDER_REVIEW executor: applies the requested transition through the state machine. */
  async applyReview(approval: PendingApproval): Promise<Order> {
    const payload = (approval.payload ?? {}) as Record<string, unknown>;
    const orderId = approval.entityId;
    if (!orderId) throw new BadRequestException('Approbation sans ordre cible.');
    const target = String(payload.status ?? '') as OrderStatus;
    if (!Object.values(OrderStatus).includes(target)) throw new BadRequestException(`Statut cible inconnu : ${String(payload.status)}.`);
    const reason = typeof payload.reason === 'string' ? payload.reason : approval.reason;
    const actorId = approval.checkerId ?? approval.makerId;

    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: instrumentInclude });
    if (!order) throw new NotFoundException('Ordre introuvable.');
    if (isFinal(order.status)) throw new BadRequestException(`L’ordre est déjà dans l’état final ${order.status}.`);
    assertTransition(order.status, target);

    if (target === OrderStatus.EXECUTED || target === OrderStatus.PARTIALLY_EXECUTED) {
      const qty = payload.executedQuantity;
      const price = payload.executedPrice;
      if (qty == null || price == null) throw new BadRequestException('Exécution manuelle sans quantité ou prix.');
      const executedAt = new Date();
      const q = D(String(qty));
      const gross = roundMoney(q.times(D(String(price))), order.instrument.currency);
      await this.batches.applyExecution(
        order,
        {
          order_id: order.id,
          sdb_ref: typeof payload.sdbRef === 'string' && payload.sdbRef ? payload.sdbRef : `manual:${approval.id}`,
          executed_qty: q.toFixed(),
          price: D(String(price)).toFixed(),
          gross_amount: gross.toFixed(),
          courtage: '0',
          taxes: '0',
          net_amount: gross.toFixed(),
          settlement_date: '',
          executed_at: executedAt.toISOString(),
          status: target === OrderStatus.EXECUTED ? 'FILLED' : 'PARTIAL',
        },
        null,
        actorId,
        'ADMIN',
        `manual:${approval.id}`,
      );
      return this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.order.updateMany({
        where: { id: orderId, status: order.status },
        data: {
          status: target,
          rejectionReason: target === OrderStatus.REJECTED || target === OrderStatus.ADJUSTED ? reason : undefined,
          sdbRef: typeof payload.sdbRef === 'string' && payload.sdbRef ? payload.sdbRef : undefined,
          transmittedAt: target === OrderStatus.TRANSMITTED ? new Date() : undefined,
          acknowledgedAt: target === OrderStatus.ACKNOWLEDGED ? new Date() : undefined,
          cancelledAt: target === OrderStatus.CANCELLED ? new Date() : undefined,
          expiredAt: target === OrderStatus.EXPIRED ? new Date() : undefined,
        },
      });
      if (count !== 1) throw new BadRequestException('L’ordre a changé d’état entre la demande et l’approbation.');
      if (isFinal(target)) {
        await this.orderLedger.releaseRemaining(order, order.instrument.currency, tx, actorId, `correction ${target}`);
      }
      return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: instrumentInclude });
    });

    const eventName =
      target === OrderStatus.REJECTED
        ? 'OrderRejected'
        : target === OrderStatus.CANCELLED
          ? 'OrderCancelled'
          : target === OrderStatus.EXPIRED
            ? 'OrderExpired'
            : target === OrderStatus.ACKNOWLEDGED
              ? 'OrderAcknowledged'
              : target === OrderStatus.TRANSMITTED
                ? 'OrderTransmitted'
                : 'OrderAdjusted';
    await this.events.publish(eventName, {
      entityType: 'Order',
      entityId: orderId,
      actor: actorId,
      payload: { ...this.eventPayload(updated), approvalId: approval.id, reason },
    });
    return updated;
  }

  // -------------------------------------------------------- recurring plans

  async createRecurringPlan(userId: string, dto: CreateRecurringPlanDto): Promise<RecurringPlan> {
    const instrument = await this.loadInstrument(dto.instrumentId);
    const amount = D(dto.amount);
    if (!amount.greaterThan(0)) throw new BadRequestException('Le montant doit être strictement positif.');
    const currency = dto.currency.toUpperCase();
    if (currency !== instrument.currency) {
      throw new BadRequestException(`Cette valeur est cotée en ${instrument.currency}.`);
    }
    const nextRunAt = new Date();
    nextRunAt.setUTCDate(nextRunAt.getUTCDate() + (dto.frequency === 'WEEKLY' ? 7 : 30));
    return this.prisma.recurringPlan.create({
      data: { userId, instrumentId: instrument.id, amount: roundMoney(amount, currency), currency, frequency: dto.frequency, nextRunAt },
    });
  }

  listRecurringPlans(userId: string) {
    return this.prisma.recurringPlan.findMany({
      where: { userId },
      include: { instrument: { select: { id: true, symbol: true, name: true, currency: true, lastPrice: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateRecurringPlan(userId: string, id: string, dto: UpdateRecurringPlanDto): Promise<RecurringPlan> {
    const plan = await this.prisma.recurringPlan.findUnique({ where: { id } });
    if (!plan || plan.userId !== userId) throw new NotFoundException('Plan introuvable.');
    return this.prisma.recurringPlan.update({ where: { id }, data: { active: dto.active ?? plan.active } });
  }

  // ------------------------------------------------------------------ utils

  private eventPayload(order: Order): Record<string, unknown> {
    return {
      userId: order.userId,
      instrumentId: order.instrumentId,
      marketId: order.marketId,
      partnerId: order.partnerId,
      side: order.side,
      status: order.status,
      quantity: toApi(order.quantity),
      filledQuantity: toApi(order.filledQuantity),
      estimatedPrice: toApi(order.estimatedPrice),
      maxAmount: toApi(order.maxAmount),
      simulated: order.simulated,
      reserveTxnId: order.reserveTxnId,
      sdbRef: order.sdbRef,
    };
  }
}
