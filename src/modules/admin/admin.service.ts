import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** Statistiques et pilotage - Module 9.6 du CDC. */
@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) {}

  async stats() {
    const [
      totalUsers,
      verifiedUsers,
      pendingKyc,
      totalOrders,
      simulatedOrders,
      transmittedOrders,
      executedOrders,
      openTickets,
      marketsByStatus,
      partnersByStatus,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { kycStatus: 'VERIFIED' } }),
      this.prisma.user.count({ where: { kycStatus: { in: ['PENDING', 'IN_REVIEW'] } } }),
      this.prisma.order.count(),
      this.prisma.order.count({ where: { executionTier: 'TIER0_SIMULATED' } }),
      this.prisma.order.count({ where: { status: 'TRANSMITTED' } }),
      this.prisma.order.count({ where: { status: { in: ['EXECUTED', 'PARTIALLY_EXECUTED'] } } }),
      this.prisma.supportTicket.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
      this.prisma.market.groupBy({ by: ['status'], _count: true }),
      this.prisma.marketPartner.groupBy({ by: ['agreementStatus'], _count: true }),
    ]);

    const kycConversionRate = totalUsers === 0 ? 0 : Math.round((verifiedUsers / totalUsers) * 10000) / 100;

    return {
      users: { total: totalUsers, verified: verifiedUsers, pendingKyc, kycConversionRate },
      orders: { total: totalOrders, simulated: simulatedOrders, transmitted: transmittedOrders, executed: executedOrders },
      support: { openTickets },
      markets: marketsByStatus,
      partnersPipeline: partnersByStatus,
    };
  }

  auditLog(entityType?: string, take = 100) {
    return this.prisma.auditLog.findMany({
      where: entityType ? { entityType } : undefined,
      include: { actor: { select: { fullName: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }
}
