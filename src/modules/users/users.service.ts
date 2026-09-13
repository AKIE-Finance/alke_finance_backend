import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ComplianceCaseState, KycStatus, PendingApproval, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/services/audit.service';
import { toApi } from '../../common/money';
import { ApprovalsService } from '../approvals/approvals.service';
import { readUserUnblock } from '../approvals/approvals.payloads';
import { LEDGER_PORT, LedgerPort } from '../ledger/ledger.types';
import { DOCUMENT_STORAGE, DocumentStoragePort } from '../storage/storage.types';
import { BlockUserDto } from './dto/block-user.dto';

export interface UserListParams {
  search?: string;
  kycStatus?: string;
  page?: number;
  pageSize?: number;
}

export interface UserBalanceView {
  currency: string;
  available: string;
  reserved: string;
  settling: string;
  withdrawable: string;
}

const LIST_SELECT = {
  id: true, fullName: true, email: true, phone: true, country: true,
  kycStatus: true, role: true, isBlocked: true, createdAt: true,
} satisfies Prisma.UserSelect;

const OPEN_CASE_STATES: readonly ComplianceCaseState[] = [ComplianceCaseState.OPEN, ComplianceCaseState.UNDER_REVIEW, ComplianceCaseState.ESCALATED];

/** Clamps `page` to ≥ 1 and `pageSize` to 1..100; NaN or undefined fall back to the defaults. */
export function normalizePaging(page?: number, pageSize?: number, defaultSize = 25): { page: number; pageSize: number } {
  const p = Number.isFinite(page) && (page as number) >= 1 ? Math.floor(page as number) : 1;
  const raw = Number.isFinite(pageSize) ? Math.floor(pageSize as number) : defaultSize;
  return { page: p, pageSize: Math.min(100, Math.max(1, raw)) };
}

/**
 * Gestion des utilisateurs (CDC module 9.1, blueprint §4.20). Le blocage
 * s'applique immédiatement (audit) ; le déblocage passe par le maker-checker
 * (USER_UNBLOCK), dont l'exécuteur est enregistré ici.
 */
@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
    @Inject(LEDGER_PORT) private readonly ledger: LedgerPort,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStoragePort,
  ) {}

  onModuleInit(): void {
    this.approvals.registerExecutor('USER_UNBLOCK', (a) => this.executeUnblock(a));
  }

  // -------------------------------------------------------------------- list

  async list(params: UserListParams) {
    const { page, pageSize } = normalizePaging(params.page, params.pageSize);
    const kycStatus = params.kycStatus && (Object.values(KycStatus) as string[]).includes(params.kycStatus) ? (params.kycStatus as KycStatus) : undefined;
    const search = params.search?.trim();
    const where: Prisma.UserWhereInput = {
      ...(kycStatus && { kycStatus }),
      ...(search && {
        OR: [
          { fullName: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search } },
        ],
      }),
    };
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({ where, select: LIST_SELECT, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.user.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  // ------------------------------------------------------------------ detail

  /** Full back-office view. SUPPORT gets the same shape without document URLs and balances. */
  async detail(id: string, viewerRole: UserRole = UserRole.ADMIN) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        kycSubmissions: { orderBy: { createdAt: 'desc' }, take: 5 },
        brokerAccounts: { include: { partner: { select: { id: true, code: true, name: true, market: { select: { code: true, name: true } } } } } },
        orders: { orderBy: { submittedAt: 'desc' }, take: 10, include: { instrument: { select: { id: true, symbol: true, isin: true, name: true, currency: true } } } },
        positions: { include: { instrument: { select: { id: true, symbol: true, name: true, currency: true, lastPrice: true } } } },
        subscription: true,
        complianceCases: { where: { state: { in: [...OPEN_CASE_STATES] } }, orderBy: { openedAt: 'desc' } },
      },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    const { passwordHash: _passwordHash, kycSubmissions, complianceCases, orders, positions, ...safe } = user;
    const full = viewerRole !== UserRole.SUPPORT;

    const kyc = await Promise.all(
      kycSubmissions.map(async (s) => ({
        ...s,
        livenessScore: toApi(s.livenessScore),
        documentFrontUrl: full ? await this.signedUrl(s.documentFrontKey) : null,
        documentBackUrl: full ? await this.signedUrl(s.documentBackKey) : null,
        selfieUrl: full ? await this.signedUrl(s.selfieKey) : null,
      })),
    );

    let balances: UserBalanceView[] | null = null;
    if (full) {
      try {
        const currencies = await this.ledger.userCurrencies(id);
        balances = await Promise.all(
          currencies.map(async (currency) => {
            const b = await this.ledger.userBalances(id, currency);
            return { currency, available: b.available.toFixed(), reserved: b.reserved.toFixed(), settling: b.settling.toFixed(), withdrawable: b.withdrawable.toFixed() };
          }),
        );
      } catch (err) {
        this.logger.warn(`Soldes indisponibles pour ${id} : ${(err as Error).message}`);
        balances = null;
      }
    }

    return {
      ...safe,
      kycSubmissions: kyc,
      orders: orders.map((o) => ({
        ...o,
        quantity: toApi(o.quantity),
        filledQuantity: toApi(o.filledQuantity),
        estimatedPrice: toApi(o.estimatedPrice),
        estimatedTotal: toApi(o.estimatedTotal),
        maxAmount: toApi(o.maxAmount),
        avgExecutedPrice: toApi(o.avgExecutedPrice),
        brokerageFee: toApi(o.brokerageFee),
      })),
      positions: positions.map((p) => ({
        ...p,
        quantity: toApi(p.quantity),
        pendingQuantity: toApi(p.pendingQuantity),
        reservedQuantity: toApi(p.reservedQuantity),
        avgCost: toApi(p.avgCost),
        instrument: { ...p.instrument, lastPrice: toApi(p.instrument.lastPrice) },
      })),
      openComplianceCases: complianceCases,
      balances,
    };
  }

  private async signedUrl(key: string | null): Promise<string | null> {
    if (!key) return null;
    try {
      return await this.storage.getSignedUrl(key);
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------- block

  /** Blocking applies at once (with audit); unblocking is a maker-checker request. */
  async setBlocked(adminId: string, id: string, dto: BlockUserDto): Promise<{ user: Record<string, unknown> | null; pendingApproval: PendingApproval | null }> {
    const before = await this.prisma.user.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Utilisateur introuvable.');
    if (dto.isBlocked) {
      if (before.isBlocked) throw new BadRequestException('Cet utilisateur est déjà bloqué.');
      const after = await this.prisma.user.update({
        where: { id },
        data: { isBlocked: true, blockedReason: dto.blockedReason ?? null, tokenVersion: { increment: 1 } },
      });
      await this.audit.log({
        actorUserId: adminId, actorRole: UserRole.ADMIN,
        action: 'USER_BLOCKED', entityType: 'User', entityId: id,
        before: { isBlocked: before.isBlocked }, after: { isBlocked: true, reason: dto.blockedReason ?? null },
      });
      return { user: this.safe(after), pendingApproval: null };
    }
    if (!before.isBlocked) throw new BadRequestException('Cet utilisateur n’est pas bloqué.');
    const approval = await this.approvals.request({
      actionType: 'USER_UNBLOCK',
      entityType: 'User',
      entityId: id,
      payload: { userId: id, previousReason: before.blockedReason },
      reason: dto.blockedReason?.trim() || `Déblocage de ${before.email}`,
      makerId: adminId,
    });
    return { user: null, pendingApproval: approval };
  }

  /** USER_UNBLOCK executor. */
  async executeUnblock(approval: PendingApproval) {
    const { userId } = readUserUnblock(approval.payload);
    const before = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!before) throw new Error('Utilisateur introuvable.');
    if (!before.isBlocked) return this.safe(before);
    const after = await this.prisma.user.update({ where: { id: userId }, data: { isBlocked: false, blockedReason: null } });
    await this.audit.log({
      actorUserId: approval.checkerId ?? approval.makerId,
      action: 'USER_UNBLOCKED', entityType: 'User', entityId: userId,
      before: { isBlocked: true, reason: before.blockedReason },
      after: { isBlocked: false, approvalId: approval.id, makerId: approval.makerId },
    });
    return this.safe(after);
  }

  private safe<T extends { passwordHash: string }>(user: T): Omit<T, 'passwordHash'> {
    const { passwordHash: _passwordHash, ...rest } = user;
    return rest;
  }
}
