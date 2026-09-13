import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { LedgerTxnType, MarketStatus, PendingApproval } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EventBus } from '../../common/events/event-bus.service';
import { AuditService } from '../../common/services/audit.service';
import { D } from '../../common/money';
import { LEDGER_PORT, LedgerPort } from '../ledger/ledger.types';
import { ConfigValuesService } from '../config/config-values.service';
import { PaymentsService } from '../payments/payments.service';
import { ApprovalsService } from './approvals.service';
import {
  readConfigChange,
  readFeeChange,
  readLedgerAdjust,
  readLedgerReversal,
  readLiveTradingToggle,
  readPaymentForceComplete,
} from './approvals.payloads';

/** Minimal shape the PAYMENT_FORCE_COMPLETE executor needs (PaymentsService satisfies it). */
export interface PaymentForceCompletePort {
  forceComplete(intentId: string, actorId: string, approvalId: string): Promise<unknown>;
}

/**
 * Exécuteurs des actions sensibles transverses (blueprint §4.17) :
 * interrupteur légal d'un marché, ajustements/contre-passations du grand
 * livre, paramètres versionnés, grille tarifaire, forçage d'un paiement.
 * Les exécuteurs USER_UNBLOCK et COMPLIANCE_DECISION sont enregistrés par
 * les modules users et compliance qui possèdent ces tables.
 */
@Injectable()
export class ApprovalsExecutors implements OnModuleInit {
  private readonly logger = new Logger(ApprovalsExecutors.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
    private readonly config: ConfigValuesService,
    private readonly moduleRef: ModuleRef,
    @Inject(LEDGER_PORT) private readonly ledger: LedgerPort,
  ) {}

  onModuleInit(): void {
    this.approvals.registerExecutor('LIVE_TRADING_TOGGLE', (a) => this.liveTradingToggle(a));
    this.approvals.registerExecutor('LEDGER_ADJUST', (a) => this.ledgerAdjust(a));
    this.approvals.registerExecutor('LEDGER_REVERSAL', (a) => this.ledgerReversal(a));
    this.approvals.registerExecutor('CONFIG_CHANGE', (a) => this.configChange(a));
    this.approvals.registerExecutor('FEE_CHANGE', (a) => this.feeChange(a));
    this.approvals.registerExecutor('PAYMENT_FORCE_COMPLETE', (a) => this.paymentForceComplete(a));
  }

  private checkerOf(approval: PendingApproval): string {
    return approval.checkerId ?? approval.makerId;
  }

  async liveTradingToggle(approval: PendingApproval) {
    const { marketId, liveTrading } = readLiveTradingToggle(approval.payload);
    const before = await this.prisma.market.findUnique({ where: { id: marketId } });
    if (!before) throw new Error('Marché introuvable.');
    const after = await this.prisma.market.update({
      where: { id: marketId },
      data: { liveTrading, status: liveTrading ? MarketStatus.LIVE : MarketStatus.PARTNER_IN_PROGRESS },
    });
    await this.audit.log({
      actorUserId: this.checkerOf(approval),
      action: 'MARKET_LIVE_TRADING_CHANGED',
      entityType: 'Market',
      entityId: marketId,
      before: { liveTrading: before.liveTrading, status: before.status },
      after: { liveTrading: after.liveTrading, status: after.status, approvalId: approval.id },
    });
    await this.events.publish('MarketLiveTradingChanged', {
      entityType: 'Market',
      entityId: marketId,
      actor: this.checkerOf(approval),
      payload: { marketId, code: after.code, liveTrading, status: after.status, approvalId: approval.id, makerId: approval.makerId },
    });
    return after;
  }

  async ledgerAdjust(approval: PendingApproval) {
    const { currency, entries, description } = readLedgerAdjust(approval.payload);
    return this.ledger.post({
      type: LedgerTxnType.ADJUST,
      idempotencyKey: `adjust:${approval.id}`,
      currency,
      source: 'ADMIN',
      actorId: this.checkerOf(approval),
      refType: 'PendingApproval',
      refId: approval.id,
      description,
      metadata: { approvalId: approval.id, makerId: approval.makerId, checkerId: approval.checkerId },
      entries: entries.map((e) => ({ account: { ...e.account, currency }, amount: D(e.amount) })),
    });
  }

  async ledgerReversal(approval: PendingApproval) {
    const { txnId, reason } = readLedgerReversal(approval.payload);
    return this.ledger.reverse(txnId, reason, this.checkerOf(approval));
  }

  async configChange(approval: PendingApproval) {
    const { key, value } = readConfigChange(approval.payload);
    return this.config.set(key, value, approval.makerId, approval.checkerId);
  }

  async feeChange(approval: PendingApproval) {
    const p = readFeeChange(approval.payload);
    const value = D(p.value);
    if (value.isNegative()) throw new Error('La valeur d’un frais ne peut pas être négative.');
    if (p.isPercentage && value.greaterThan(100)) throw new Error('Un pourcentage ne peut pas dépasser 100.');
    const now = new Date();
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.feeSchedule.updateMany({
        where: { feeType: p.feeType, marketId: p.marketId, isActive: true },
        data: { isActive: false, effectiveTo: now },
      });
      return tx.feeSchedule.create({
        data: {
          marketId: p.marketId,
          feeType: p.feeType,
          isPercentage: p.isPercentage,
          value,
          minAmount: p.minAmount == null ? null : D(p.minAmount),
          maxAmount: p.maxAmount == null ? null : D(p.maxAmount),
          label: p.label,
          effectiveFrom: now,
          isActive: true,
        },
      });
    });
    await this.audit.log({
      actorUserId: this.checkerOf(approval),
      action: 'FEE_SCHEDULE_CHANGED',
      entityType: 'FeeSchedule',
      entityId: created.id,
      after: { ...created, value: created.value.toFixed(), approvalId: approval.id },
    });
    await this.events.publish('FeeCharged', {
      entityType: 'FeeSchedule',
      entityId: created.id,
      actor: this.checkerOf(approval),
      payload: { kind: 'SCHEDULE_CHANGED', feeType: p.feeType, marketId: p.marketId, value: p.value, approvalId: approval.id },
    });
    return created;
  }

  async paymentForceComplete(approval: PendingApproval) {
    const { intentId } = readPaymentForceComplete(approval.payload);
    const payments = this.resolvePayments();
    if (!payments) throw new Error('Le module paiements n’est pas chargé : forçage impossible.');
    return payments.forceComplete(intentId, this.checkerOf(approval), approval.id);
  }

  /** PaymentsModule is not global; resolve lazily so this module does not import it. */
  private resolvePayments(): PaymentForceCompletePort | null {
    try {
      const svc = this.moduleRef.get<PaymentForceCompletePort>(PaymentsService, { strict: false });
      return svc && typeof svc.forceComplete === 'function' ? svc : null;
    } catch (err) {
      this.logger.warn(`PaymentsService indisponible : ${(err as Error).message}`);
      return null;
    }
  }
}

