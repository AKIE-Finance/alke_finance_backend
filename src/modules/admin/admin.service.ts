import { Injectable } from '@nestjs/common';
import { AlertStatus, ApprovalState, KycStatus, PaymentDirection, PaymentIntentState, Prisma, ReconciliationState } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditChainVerification, AuditService } from '../../common/services/audit.service';
import { normalizePaging } from '../users/users.service';

export interface AuditLogFilter {
  entityType?: string;
  action?: string;
  page?: number;
  pageSize?: number;
  from?: string;
  to?: string;
}

const KYC_QUEUE_STATUSES: readonly KycStatus[] = [KycStatus.SUBMITTED, KycStatus.MANUAL_REVIEW];
const OPEN_RECON_STATES: readonly ReconciliationState[] = [ReconciliationState.OPEN, ReconciliationState.INVESTIGATING];

/** Statistiques et pilotage (CDC module 9.6, blueprint §4.20). */
@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async stats() {
    const [usersByKyc, ordersByStatus, paidDeposits, pendingApprovals, openReconciliationItems, kycQueue, openComplianceAlerts, markets] =
      await Promise.all([
        this.prisma.user.groupBy({ by: ['kycStatus'], _count: { _all: true } }),
        this.prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
        this.prisma.paymentIntent.groupBy({
          by: ['currency'],
          where: { direction: PaymentDirection.IN, state: PaymentIntentState.PAID },
          _sum: { amount: true },
          _count: { _all: true },
        }),
        this.prisma.pendingApproval.count({ where: { state: ApprovalState.PENDING } }),
        this.prisma.reconciliationItem.count({ where: { state: { in: [...OPEN_RECON_STATES] } } }),
        this.prisma.kycSubmission.count({ where: { status: { in: [...KYC_QUEUE_STATUSES] } } }),
        this.prisma.complianceAlert.count({ where: { status: AlertStatus.OPEN } }),
        this.prisma.market.findMany({ select: { code: true, liveTrading: true }, orderBy: { code: 'asc' } }),
      ]);

    const byKycStatus: Record<string, number> = Object.fromEntries(Object.values(KycStatus).map((s) => [s, 0]));
    for (const row of usersByKyc) byKycStatus[row.kycStatus] = row._count._all;
    const byStatus: Record<string, number> = {};
    for (const row of ordersByStatus) byStatus[row.status] = row._count._all;
    const paidByCurrency: Record<string, { total: string; count: number }> = {};
    for (const row of paidDeposits) paidByCurrency[row.currency] = { total: (row._sum.amount ?? new Prisma.Decimal(0)).toFixed(), count: row._count._all };

    return {
      users: { total: Object.values(byKycStatus).reduce((a, b) => a + b, 0), byKycStatus },
      orders: { total: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus },
      deposits: { paidByCurrency },
      pendingApprovals,
      openReconciliationItems,
      kycQueue,
      openComplianceAlerts,
      markets: markets.map((m) => ({ code: m.code, liveTrading: m.liveTrading })),
    };
  }

  async auditLog(filter: AuditLogFilter) {
    const { page, pageSize } = normalizePaging(filter.page, filter.pageSize, 50);
    const from = parseDate(filter.from);
    const to = parseDate(filter.to);
    const where: Prisma.AuditLogWhereInput = {
      ...(filter.entityType && { entityType: filter.entityType }),
      ...(filter.action && { action: filter.action }),
      ...((from || to) && { createdAt: { ...(from && { gte: from }), ...(to && { lte: to }) } }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        include: { actor: { select: { fullName: true, email: true } } },
        orderBy: { seq: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items: rows.map((r) => ({ ...r, seq: Number(r.seq) })), total, page, pageSize };
  }

  verifyAuditChain(): Promise<AuditChainVerification> {
    return this.audit.verifyChain();
  }
}

function parseDate(raw?: string): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
