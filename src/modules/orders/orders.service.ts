import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  IntegrationTier,
  OrderSide,
  OrderStatus,
  OrderType,
  PartnerAgreementStatus,
  WalletTransactionStatus,
  WalletTransactionType,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/services/audit.service';
import { FeesService } from '../fees/fees.service';
import { WalletService } from '../wallet/wallet.service';
import { PlaceOrderDto } from './dto/place-order.dto';
import { ReviewOrderDto } from './dto/review-order.dto';
import { CreateRecurringPlanDto, UpdateRecurringPlanDto } from './dto/recurring-plan.dto';

/**
 * Moteur d'ordres multi-marche (Module 4 du CDC + Guide ALKE-BOURSE
 * 2026-001/002). Chaque ordre porte un marche (BVMAC/BRVM/INTL/...) qui
 * determine automatiquement le partenaire (SDB/SGI) competent et le palier
 * d'integration atteint :
 *
 *   Palier 0 (TIER0_SIMULATED) - aucun partenaire ACTIVE sur ce marche :
 *     l'ordre est simule et execute immediatement, comme le comportement
 *     deja en place cote app mobile (Future.delayed). C'est le mode par
 *     defaut de tout marche tant qu'aucun partenariat n'est signe.
 *
 *   Palier 1+ (TIER1_FILE et au-dela) - un partenaire ACTIVE existe :
 *     l'ordre passe en TRANSMITTED et attend une reconciliation manuelle
 *     cote back-office (Module 9.3) via reviewOrder(), a l'image du canal
 *     fichier/e-mail securise decrit dans le guide bourse.
 *
 * Consequence de securite directement issue du guide (section 11,
 * "Exercice illegal") : aucun ordre ne peut jamais s'executer reellement
 * sur un marche dont aucun partenaire n'est ACTIVE - le repli simule reste
 * la seule voie possible dans ce cas.
 */
@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private fees: FeesService,
    private wallet: WalletService,
  ) {}

  async placeOrder(userId: string, dto: PlaceOrderDto) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.kycStatus !== 'VERIFIED') {
      throw new ForbiddenException("Votre dossier KYC doit etre valide avant de pouvoir passer un ordre.");
    }

    const instrument = await this.prisma.instrument.findUnique({
      where: { id: dto.instrumentId },
      include: { market: true },
    });
    if (!instrument || !instrument.lastPrice) {
      throw new NotFoundException("Valeur introuvable ou sans cours disponible.");
    }

    const estimatedPrice = dto.orderType === OrderType.LIMIT && dto.limitPrice ? dto.limitPrice : Number(instrument.lastPrice);
    const estimatedTotal = Math.round(dto.quantity * estimatedPrice * 100) / 100;
    const brokerageFee = await this.fees.computeBrokerageFee(instrument.marketId, estimatedTotal);

    // Resolution du partenaire competent pour ce marche (coeur du moteur multi-marche).
    const activePartner = await this.prisma.marketPartner.findFirst({
      where: { marketId: instrument.marketId, agreementStatus: PartnerAgreementStatus.ACTIVE },
      orderBy: { updatedAt: 'desc' },
    });
    const executionTier = activePartner ? activePartner.integrationTier : IntegrationTier.TIER0_SIMULATED;

    if (dto.side === OrderSide.BUY) {
      const account = await this.wallet.getOrCreateAccount(userId, instrument.currency);
      const totalDue = estimatedTotal + brokerageFee;
      if (Number(account.balance) < totalDue) {
        throw new BadRequestException(
          `Solde ${instrument.currency} insuffisant (disponible : ${account.balance}, requis : ${totalDue}).`,
        );
      }
    } else {
      const position = await this.prisma.position.findUnique({
        where: { userId_instrumentId: { userId, instrumentId: instrument.id } },
      });
      if (!position || Number(position.quantity) < dto.quantity) {
        throw new BadRequestException('Quantite insuffisante en portefeuille pour cette vente.');
      }
    }

    const order = await this.prisma.order.create({
      data: {
        userId,
        instrumentId: instrument.id,
        marketId: instrument.marketId,
        partnerId: activePartner?.id,
        side: dto.side,
        orderType: dto.orderType ?? OrderType.MARKET,
        quantity: dto.quantity,
        limitPrice: dto.limitPrice,
        estimatedPrice,
        estimatedTotal,
        brokerageFee,
        executionTier,
        status: OrderStatus.PENDING,
      },
    });

    if (dto.side === OrderSide.BUY) {
      const account = await this.wallet.getOrCreateAccount(userId, instrument.currency);
      await this.prisma.$transaction([
        this.prisma.account.update({ where: { id: account.id }, data: { balance: { decrement: estimatedTotal + brokerageFee } } }),
        this.prisma.walletTransaction.create({
          data: { accountId: account.id, type: WalletTransactionType.ORDER_DEBIT, amount: estimatedTotal, status: WalletTransactionStatus.COMPLETED, completedAt: new Date(), note: `Ordre ${order.id}` },
        }),
        this.prisma.walletTransaction.create({
          data: { accountId: account.id, type: WalletTransactionType.FEE, amount: brokerageFee, status: WalletTransactionStatus.COMPLETED, completedAt: new Date(), note: `Frais de courtage - ordre ${order.id}` },
        }),
      ]);
    }

    if (executionTier === IntegrationTier.TIER0_SIMULATED) {
      return this.executeOrder(order.id, estimatedPrice);
    }

    return this.prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.TRANSMITTED, transmittedAt: new Date() },
    });
  }

  /** Execution (simulee ou confirmee par un partenaire) : met a jour la position et credite en cas de vente. */
  private async executeOrder(orderId: string, executedPrice: number) {
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { instrument: true } });

    const existingPosition = await this.prisma.position.findUnique({
      where: { userId_instrumentId: { userId: order.userId, instrumentId: order.instrumentId } },
    });

    if (order.side === OrderSide.BUY) {
      const newQty = Number(existingPosition?.quantity ?? 0) + Number(order.quantity);
      const newAvgCost =
        (Number(existingPosition?.quantity ?? 0) * Number(existingPosition?.avgCost ?? 0) + Number(order.quantity) * executedPrice) /
        newQty;
      await this.prisma.position.upsert({
        where: { userId_instrumentId: { userId: order.userId, instrumentId: order.instrumentId } },
        create: { userId: order.userId, instrumentId: order.instrumentId, quantity: order.quantity, avgCost: executedPrice, currency: order.instrument.currency },
        update: { quantity: newQty, avgCost: newAvgCost },
      });
    } else {
      const remaining = Number(existingPosition?.quantity ?? 0) - Number(order.quantity);
      if (remaining <= 0) {
        await this.prisma.position.delete({ where: { userId_instrumentId: { userId: order.userId, instrumentId: order.instrumentId } } }).catch(() => undefined);
      } else {
        await this.prisma.position.update({
          where: { userId_instrumentId: { userId: order.userId, instrumentId: order.instrumentId } },
          data: { quantity: remaining },
        });
      }
      const proceeds = Math.round(Number(order.quantity) * executedPrice * 100) / 100;
      const account = await this.wallet.getOrCreateAccount(order.userId, order.instrument.currency);
      await this.prisma.$transaction([
        this.prisma.account.update({ where: { id: account.id }, data: { balance: { increment: proceeds - Number(order.brokerageFee) } } }),
        this.prisma.walletTransaction.create({
          data: { accountId: account.id, type: WalletTransactionType.ORDER_CREDIT, amount: proceeds, status: WalletTransactionStatus.COMPLETED, completedAt: new Date(), note: `Vente - ordre ${order.id}` },
        }),
      ]);
    }

    return this.prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.EXECUTED, executedAt: new Date(), executedPrice },
    });
  }

  listMine(userId: string) {
    return this.prisma.order.findMany({
      where: { userId },
      include: { instrument: true, market: true, partner: true },
      orderBy: { submittedAt: 'desc' },
    });
  }

  // ------------------------------------------------------- Back-office (9.3)
  listAll(params: { marketId?: string; status?: OrderStatus }) {
    return this.prisma.order.findMany({
      where: { ...(params.marketId && { marketId: params.marketId }), ...(params.status && { status: params.status }) },
      include: {
        instrument: true,
        market: true,
        partner: true,
        user: { select: { id: true, fullName: true, email: true } },
      },
      orderBy: { submittedAt: 'desc' },
    });
  }

  async reviewOrder(adminId: string, orderId: string, dto: ReviewOrderDto) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Ordre introuvable.');
    if (order.status === OrderStatus.EXECUTED || order.status === OrderStatus.REJECTED) {
      throw new BadRequestException('Cet ordre est deja dans un etat final.');
    }

    let result;
    if (dto.status === OrderStatus.EXECUTED || dto.status === OrderStatus.PARTIALLY_EXECUTED) {
      result = await this.executeOrder(orderId, dto.executedPrice ?? Number(order.estimatedPrice));
      result = await this.prisma.order.update({
        where: { id: orderId },
        data: { status: dto.status, partnerReference: dto.partnerReference },
      });
    } else if (dto.status === OrderStatus.REJECTED || dto.status === OrderStatus.CANCELLED) {
      // Remboursement des fonds reserves pour un achat annule/rejete.
      if (order.side === OrderSide.BUY) {
        const instrument = await this.prisma.instrument.findUniqueOrThrow({ where: { id: order.instrumentId } });
        const account = await this.wallet.getOrCreateAccount(order.userId, instrument.currency);
        await this.prisma.account.update({
          where: { id: account.id },
          data: { balance: { increment: Number(order.estimatedTotal) + Number(order.brokerageFee) } },
        });
        await this.prisma.walletTransaction.create({
          data: { accountId: account.id, type: WalletTransactionType.FEE, amount: 0, status: WalletTransactionStatus.CANCELLED, note: `Remboursement ordre ${order.id} (${dto.status})` },
        });
      }
      result = await this.prisma.order.update({
        where: { id: orderId },
        data: { status: dto.status, rejectionReason: dto.rejectionReason, partnerReference: dto.partnerReference },
      });
    } else {
      result = await this.prisma.order.update({
        where: { id: orderId },
        data: { status: dto.status, partnerReference: dto.partnerReference },
      });
    }

    await this.audit.log({
      actorUserId: adminId, actorRole: 'ADMIN', action: 'ORDER_STATUS_CHANGED',
      entityType: 'Order', entityId: orderId, before: { status: order.status }, after: { status: dto.status },
    });

    return result;
  }

  /** Genere un export CSV des ordres TRANSMITTED d'un marche - le "fichier
   * structure et securise" du Palier 1 (Guide ALKE-BOURSE section 8). */
  async exportTransmittedOrders(marketId: string): Promise<string> {
    const orders = await this.prisma.order.findMany({
      where: { marketId, status: OrderStatus.TRANSMITTED },
      include: { instrument: true, user: { select: { fullName: true, email: true } } },
      orderBy: { transmittedAt: 'asc' },
    });
    const header = 'order_id;date_transmission;client;email;symbole;sens;quantite;prix_estime;montant_estime\n';
    const rows = orders
      .map((o) =>
        [
          o.id,
          o.transmittedAt?.toISOString() ?? '',
          o.user.fullName,
          o.user.email,
          o.instrument.symbol,
          o.side,
          o.quantity.toString(),
          o.estimatedPrice.toString(),
          o.estimatedTotal.toString(),
        ].join(';'),
      )
      .join('\n');
    return header + rows;
  }

  // ---------------------------------------------------------- Recurring plans
  createRecurringPlan(userId: string, dto: CreateRecurringPlanDto) {
    const nextRunAt = new Date();
    nextRunAt.setDate(nextRunAt.getDate() + (dto.frequency === 'WEEKLY' ? 7 : 30));
    return this.prisma.recurringPlan.create({ data: { ...dto, userId, nextRunAt } });
  }

  listRecurringPlans(userId: string) {
    return this.prisma.recurringPlan.findMany({ where: { userId }, include: { instrument: true } });
  }

  updateRecurringPlan(userId: string, id: string, dto: UpdateRecurringPlanDto) {
    return this.prisma.recurringPlan.updateMany({ where: { id, userId }, data: dto });
  }
}
