import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { FeeSchedule, FeeType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/services/audit.service';
import { D, ZERO, percentageFee, roundMoney } from '../../common/money';
import { UpsertFeeDto } from './dto/upsert-fee.dto';
import { FeeLine, ORDER_FEE_TYPES, OrderFeeCode } from './fees.types';

/** The DTO is owned by another agent; effective dates are read if present. */
type UpsertFeeInput = UpsertFeeDto & { effectiveFrom?: string | Date; effectiveTo?: string | Date | null };

/**
 * Grille tarifaire (blueprint §3.2) : chaque frais devient une ligne du grand
 * livre. Le barème actif d'un marché est choisi par type de frais ; à défaut
 * le barème global (marketId null) s'applique.
 */
@Injectable()
export class FeesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  list(marketId?: string) {
    return this.prisma.feeSchedule.findMany({
      where: { isActive: true, ...(marketId ? { OR: [{ marketId }, { marketId: null }] } : {}) },
      include: { market: { select: { id: true, code: true, name: true, currency: true } } },
      orderBy: [{ feeType: 'asc' }, { marketId: 'asc' }, { effectiveFrom: 'desc' }],
    });
  }

  async create(adminId: string, dto: UpsertFeeInput): Promise<FeeSchedule> {
    const value = D(dto.value);
    if (value.isNegative()) throw new BadRequestException('La valeur d’un frais ne peut pas être négative.');
    if (dto.isPercentage && value.greaterThan(100)) {
      throw new BadRequestException('Un pourcentage ne peut pas dépasser 100.');
    }
    if (dto.minAmount != null && dto.maxAmount != null && D(dto.minAmount).greaterThan(dto.maxAmount)) {
      throw new BadRequestException('Le minimum ne peut pas dépasser le maximum.');
    }
    const fee = await this.prisma.feeSchedule.create({
      data: {
        marketId: dto.marketId ?? null,
        feeType: dto.feeType,
        isPercentage: dto.isPercentage,
        value,
        minAmount: dto.minAmount != null ? D(dto.minAmount) : null,
        maxAmount: dto.maxAmount != null ? D(dto.maxAmount) : null,
        label: dto.label,
        effectiveFrom: dto.effectiveFrom ? new Date(dto.effectiveFrom) : new Date(),
        effectiveTo: dto.effectiveTo ? new Date(dto.effectiveTo) : null,
      },
    });
    await this.audit.log({
      actorUserId: adminId, actorRole: 'ADMIN', action: 'FEE_SCHEDULE_CREATED',
      entityType: 'FeeSchedule', entityId: fee.id, after: fee,
    });
    return fee;
  }

  async deactivate(adminId: string, id: string): Promise<FeeSchedule> {
    const before = await this.prisma.feeSchedule.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Barème introuvable.');
    const after = await this.prisma.feeSchedule.update({
      where: { id },
      data: { isActive: false, effectiveTo: before.effectiveTo ?? new Date() },
    });
    await this.audit.log({
      actorUserId: adminId, actorRole: 'ADMIN', action: 'FEE_SCHEDULE_DEACTIVATED',
      entityType: 'FeeSchedule', entityId: id, before, after,
    });
    return after;
  }

  /**
   * Fee lines for an order: COURTAGE_SDB, COMMISSION_ALKE, TAXE — one line per
   * fee type that has an active schedule and a non-zero amount.
   */
  async computeOrderFees(marketId: string, grossAmount: Prisma.Decimal, currency: string): Promise<FeeLine[]> {
    const lines: FeeLine[] = [];
    for (const feeType of ORDER_FEE_TYPES) {
      const line = await this.computeFee(feeType, marketId, grossAmount, currency);
      if (line) lines.push(line);
    }
    return lines;
  }

  /** One fee line (null when no schedule applies or the amount rounds to zero). */
  async computeFee(
    feeType: FeeType,
    marketId: string | null,
    grossAmount: Prisma.Decimal.Value,
    currency: string,
  ): Promise<FeeLine | null> {
    const schedule = await this.activeSchedule(feeType, marketId);
    if (!schedule) return null;
    const amount = FeesService.applySchedule(schedule, D(grossAmount), currency);
    if (amount.lessThanOrEqualTo(0)) return null;
    return { code: schedule.feeType as OrderFeeCode, amount, label: schedule.label, scheduleId: schedule.id };
  }

  /** Active schedule for (feeType, market) at `at`, falling back to the global one. */
  async activeSchedule(feeType: FeeType, marketId: string | null, at: Date = new Date()): Promise<FeeSchedule | null> {
    const window = {
      feeType,
      isActive: true,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    };
    if (marketId) {
      const specific = await this.prisma.feeSchedule.findFirst({
        where: { ...window, marketId },
        orderBy: { effectiveFrom: 'desc' },
      });
      if (specific) return specific;
    }
    return this.prisma.feeSchedule.findFirst({ where: { ...window, marketId: null }, orderBy: { effectiveFrom: 'desc' } });
  }

  static applySchedule(schedule: FeeSchedule, gross: Prisma.Decimal, currency: string): Prisma.Decimal {
    if (schedule.isPercentage) {
      return percentageFee(gross, schedule.value, currency, schedule.minAmount, schedule.maxAmount);
    }
    let fee = D(schedule.value);
    if (schedule.minAmount != null && fee.lessThan(schedule.minAmount)) fee = D(schedule.minAmount);
    if (schedule.maxAmount != null && fee.greaterThan(schedule.maxAmount)) fee = D(schedule.maxAmount);
    return roundMoney(fee, currency);
  }

  static total(lines: FeeLine[]): Prisma.Decimal {
    return lines.reduce((acc, l) => acc.plus(l.amount), ZERO);
  }
}
