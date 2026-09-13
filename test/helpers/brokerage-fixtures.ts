import { randomUUID } from 'crypto';
import {
  ApprovalState,
  BrokerAccountState,
  IntegrationTier,
  KycStatus,
  LedgerAccountKind,
  LedgerOwnerType,
  LedgerTxnType,
  MarketCode,
  MarketStatus,
  PartnerAgreementStatus,
  PartnerType,
  PendingApproval,
  Prisma,
  PrismaClient,
  SupportedCountry,
  UserRole,
} from '@prisma/client';
import { ApprovalActionType, ApprovalExecutor, ApprovalRequestInput, ApprovalsPort } from '../../src/modules/approvals/approvals.types';
import { FeesPort, OrderFeeLine, WithdrawalSettlementPort } from '../../src/modules/brokerage/ports';
import { LedgerPort } from '../../src/modules/ledger/ledger.types';
import { D, roundMoney } from '../../src/common/money';

/** In-memory maker-checker: `approve` runs the registered executor exactly once. */
export class FakeApprovals implements ApprovalsPort {
  readonly executors = new Map<ApprovalActionType, ApprovalExecutor>();
  readonly approvals: PendingApproval[] = [];
  executions = 0;

  registerExecutor(actionType: ApprovalActionType, executor: ApprovalExecutor): void {
    this.executors.set(actionType, executor);
  }

  async request(input: ApprovalRequestInput): Promise<PendingApproval> {
    const approval: PendingApproval = {
      id: randomUUID(),
      actionType: input.actionType,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      payload: input.payload as Prisma.JsonValue,
      reason: input.reason,
      makerId: input.makerId,
      checkerId: null,
      state: ApprovalState.PENDING,
      decisionNote: null,
      decidedAt: null,
      executedAt: null,
      error: null,
      auditLogId: null,
      createdAt: new Date(),
    };
    this.approvals.push(approval);
    return approval;
  }

  async approve(approvalId: string, checkerId: string, note?: string): Promise<PendingApproval> {
    const approval = this.approvals.find((a) => a.id === approvalId);
    if (!approval) throw new Error('approval not found');
    if (approval.state !== ApprovalState.PENDING) return approval;
    approval.state = ApprovalState.APPROVED;
    approval.checkerId = checkerId;
    approval.decisionNote = note ?? null;
    approval.decidedAt = new Date();
    const executor = this.executors.get(approval.actionType as ApprovalActionType);
    if (!executor) {
      approval.state = ApprovalState.FAILED;
      approval.error = 'no executor';
      return approval;
    }
    try {
      this.executions++;
      await executor(approval);
      approval.state = ApprovalState.EXECUTED;
      approval.executedAt = new Date();
    } catch (err) {
      approval.state = ApprovalState.FAILED;
      approval.error = (err as Error).message;
    }
    return approval;
  }

  async reject(approvalId: string, checkerId: string, note: string): Promise<PendingApproval> {
    const approval = this.approvals.find((a) => a.id === approvalId);
    if (!approval) throw new Error('approval not found');
    approval.state = ApprovalState.REJECTED;
    approval.checkerId = checkerId;
    approval.decisionNote = note;
    return approval;
  }

  async listPending(actionType?: ApprovalActionType): Promise<PendingApproval[]> {
    return this.approvals.filter((a) => a.state === ApprovalState.PENDING && (!actionType || a.actionType === actionType));
  }
}

/** Fixed grid: courtage 1 % + taxe 0,5 % of the gross, no ALKÉ commission. */
export class FakeFees implements FeesPort {
  constructor(private readonly courtagePct = 1, private readonly taxePct = 0.5) {}

  async computeOrderFees(_marketId: string, gross: Prisma.Decimal, currency: string): Promise<OrderFeeLine[]> {
    const lines: OrderFeeLine[] = [];
    const courtage = roundMoney(gross.times(this.courtagePct).dividedBy(100), currency);
    const taxe = roundMoney(gross.times(this.taxePct).dividedBy(100), currency);
    if (courtage.greaterThan(0)) lines.push({ code: 'COURTAGE_SDB', amount: courtage, label: 'Courtage SDB' });
    if (taxe.greaterThan(0)) lines.push({ code: 'TAXE', amount: taxe, label: 'Taxe' });
    return lines;
  }
}

export class FakeWithdrawals implements WithdrawalSettlementPort {
  readonly paid: { intentId: string; externalRef: string; source: string }[] = [];
  readonly failed: { intentId: string; reason: string }[] = [];
  async markWithdrawalPaid(intentId: string, externalRef: string, source: string): Promise<void> {
    this.paid.push({ intentId, externalRef, source });
  }
  async failWithdrawal(intentId: string, reason: string): Promise<void> {
    this.failed.push({ intentId, reason });
  }
}

// ---------------------------------------------------------------- seeding

let seq = 0;
const next = (): number => ++seq;

export async function createUser(prisma: PrismaClient, overrides: Partial<{ email: string; role: UserRole; kycStatus: KycStatus; fullName: string }> = {}) {
  const n = next();
  return prisma.user.create({
    data: {
      fullName: overrides.fullName ?? `Client ${n}`,
      email: overrides.email ?? `client${n}@example.test`,
      phone: `+2376000000${String(n).padStart(2, '0')}`,
      passwordHash: 'x',
      country: SupportedCountry.CMR,
      role: overrides.role ?? UserRole.USER,
      kycStatus: overrides.kycStatus ?? KycStatus.VALIDATED,
      referralCode: `REF${n}${randomUUID().slice(0, 6)}`,
    },
  });
}

export async function createMarket(prisma: PrismaClient, overrides: Partial<{ liveTrading: boolean; settlementDays: number }> = {}) {
  return prisma.market.create({
    data: {
      code: MarketCode.BVMAC,
      name: 'BVMAC',
      zone: 'CEMAC',
      currency: 'XAF',
      regulator: 'COSUMAF',
      status: overrides.liveTrading ? MarketStatus.LIVE : MarketStatus.SIMULATED_ONLY,
      liveTrading: overrides.liveTrading ?? true,
      timezone: 'Africa/Douala',
      cutoffTime: '09:30',
      settlementDays: overrides.settlementDays ?? 3,
    },
  });
}

export async function createPartner(prisma: PrismaClient, marketId: string, overrides: Partial<{ code: string; agreementStatus: PartnerAgreementStatus }> = {}) {
  return prisma.marketPartner.create({
    data: {
      marketId,
      code: overrides.code ?? 'SDB1',
      name: 'SDB Test',
      type: PartnerType.SDB,
      agreementStatus: overrides.agreementStatus ?? PartnerAgreementStatus.ACTIVE,
      integrationTier: IntegrationTier.TIER1_FILE,
    },
  });
}

export async function createInstrument(
  prisma: PrismaClient,
  marketId: string,
  overrides: Partial<{ symbol: string; isin: string | null; lastPrice: Prisma.Decimal.Value; lotSize: number }> = {},
) {
  const n = next();
  return prisma.instrument.create({
    data: {
      marketId,
      symbol: overrides.symbol ?? `SYM${n}`,
      isin: overrides.isin === undefined ? `CM000000000${n}` : overrides.isin,
      name: `Valeur ${n}`,
      assetClass: 'STOCK',
      currency: 'XAF',
      lotSize: overrides.lotSize ?? 1,
      lastPrice: D(overrides.lastPrice ?? 5000),
    },
  });
}

export function openBrokerAccount(prisma: PrismaClient, userId: string, partnerId: string, externalAccountNo = 'ACC-0001') {
  return prisma.brokerAccount.create({
    data: { userId, partnerId, externalAccountNo, state: BrokerAccountState.OPEN, openedAt: new Date() },
  });
}

/** Credits the user's AVAILABLE account from a provider clearing account (a confirmed deposit). */
export async function fund(ledger: LedgerPort, userId: string, amount: Prisma.Decimal.Value, currency = 'XAF', key = `deposit:${randomUUID()}`) {
  return ledger.post({
    type: LedgerTxnType.DEPOSIT,
    idempotencyKey: key,
    currency,
    source: 'PAYMENT_WEBHOOK',
    entries: [
      { account: { ownerType: LedgerOwnerType.USER, ownerId: userId, currency, kind: LedgerAccountKind.AVAILABLE }, amount },
      { account: { ownerType: LedgerOwnerType.PROVIDER, ownerId: 'SIMULATED', currency, kind: LedgerAccountKind.CLEARING }, amount: D(amount).negated() },
    ],
  });
}

export async function setConfig(prisma: PrismaClient, key: string, value: Prisma.InputJsonValue) {
  await prisma.configValue.updateMany({ where: { key, effectiveTo: null }, data: { effectiveTo: new Date(Date.now() - 1000) } });
  return prisma.configValue.create({ data: { key, value, effectiveFrom: new Date(Date.now() - 1000) } });
}

export const acct = (ownerType: LedgerOwnerType, ownerId: string, kind: LedgerAccountKind, currency = 'XAF') => ({ ownerType, ownerId, kind, currency });
