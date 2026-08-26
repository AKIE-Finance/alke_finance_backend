import { Injectable } from '@nestjs/common';
import { FeeType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/services/audit.service';
import { UpsertFeeDto } from './dto/upsert-fee.dto';

/**
 * Grille tarifaire — Module 9.5 du CDC ("Configuration de la grille
 * tarifaire : frais de courtage par marche, frais de change").
 */
@Injectable()
export class FeesService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  list(marketId?: string) {
    return this.prisma.feeSchedule.findMany({
      where: { isActive: true, ...(marketId && { marketId }) },
      include: { market: true },
      orderBy: { feeType: 'asc' },
    });
  }

  async create(adminId: string, dto: UpsertFeeDto) {
    const fee = await this.prisma.feeSchedule.create({ data: dto as any });
    await this.audit.log({
      actorUserId: adminId, actorRole: 'ADMIN', action: 'FEE_SCHEDULE_CREATED',
      entityType: 'FeeSchedule', entityId: fee.id, after: fee,
    });
    return fee;
  }

  async deactivate(adminId: string, id: string) {
    const before = await this.prisma.feeSchedule.findUnique({ where: { id } });
    const after = await this.prisma.feeSchedule.update({ where: { id }, data: { isActive: false } });
    await this.audit.log({
      actorUserId: adminId, actorRole: 'ADMIN', action: 'FEE_SCHEDULE_DEACTIVATED',
      entityType: 'FeeSchedule', entityId: id, before, after,
    });
    return after;
  }

  /** Resout le taux de courtage applicable a un marche (ou le taux global a defaut). */
  async computeBrokerageFee(marketId: string, amount: number): Promise<number> {
    const specific = await this.prisma.feeSchedule.findFirst({
      where: { marketId, feeType: FeeType.BROKERAGE, isActive: true },
      orderBy: { effectiveFrom: 'desc' },
    });
    const schedule = specific ?? (await this.prisma.feeSchedule.findFirst({
      where: { marketId: null, feeType: FeeType.BROKERAGE, isActive: true },
      orderBy: { effectiveFrom: 'desc' },
    }));
    if (!schedule) return 0;

    let fee = schedule.isPercentage ? (amount * Number(schedule.value)) / 100 : Number(schedule.value);
    if (schedule.minAmount && fee < Number(schedule.minAmount)) fee = Number(schedule.minAmount);
    if (schedule.maxAmount && fee > Number(schedule.maxAmount)) fee = Number(schedule.maxAmount);
    return Math.round(fee * 100) / 100;
  }
}
