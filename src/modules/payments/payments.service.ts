import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  LedgerAccountKind,
  LedgerOwnerType,
  LedgerTxnType,
  PaymentDirection,
  PaymentIntent,
  PaymentIntentState,
  PaymentProvider,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { EventBus } from '../../common/events/event-bus.service';
import { AuditService } from '../../common/services/audit.service';
import { D, ZERO, decimalsFor, roundMoney, toApi } from '../../common/money';
import { LedgerService } from '../ledger/ledger.service';
import { LedgerAccountRef, LedgerKeys, UserStatementLine } from '../ledger/ledger.types';
import { ConfigValuesService } from '../config/config-values.service';
import { CONFIG_DEFAULTS, CONFIG_KEYS } from '../config/config-keys';
import { PaymentProviderRegistry } from './providers/provider-registry';
import { StatusResult } from './providers/payment-provider.port';
import { CreateDepositDto } from './dto/create-deposit.dto';
import { RequestWithdrawalDto } from './dto/request-withdrawal.dto';

/** Where a confirmation came from — stored as LedgerTxn.source and event actor. */
export type ConfirmationSource = 'PAYMENT_WEBHOOK' | 'PROVIDER_SYNC' | 'ADMIN_RECHECK' | 'JOB' | 'SIMULATED' | 'CSH_FILE' | 'ADMIN';

export interface DepositResult {
  intent: PaymentIntent;
  /** Hosted checkout URL when the provider uses one (CinetPay). */
  paymentUrl?: string;
}

export interface WalletBalance {
  currency: string;
  available: string | null;
  reserved: string | null;
  settling: string | null;
  withdrawable: string | null;
  total: string | null;
}

type StatementApiLine = Omit<UserStatementLine, 'amount'> & { amount: string | null };

const OPEN_STATES: PaymentIntentState[] = [PaymentIntentState.CREATED, PaymentIntentState.PENDING];

function userAccount(userId: string, currency: string, kind: LedgerAccountKind): LedgerAccountRef {
  return { ownerType: LedgerOwnerType.USER, ownerId: userId, currency, kind };
}

function providerClearing(provider: PaymentProvider, currency: string): LedgerAccountRef {
  return { ownerType: LedgerOwnerType.PROVIDER, ownerId: provider, currency, kind: LedgerAccountKind.CLEARING };
}

function providerLabel(provider: PaymentProvider): string {
  const labels: Record<PaymentProvider, string> = {
    MTN_MOMO: 'MTN Mobile Money',
    ORANGE_MONEY: 'Orange Money',
    CINETPAY: 'CinetPay',
    PAYDUNYA: 'PayDunya',
    BANK_TRANSFER: 'virement bancaire',
    SIMULATED: 'simulation',
  };
  return labels[provider];
}

/**
 * Cycle de vie des intentions de paiement (blueprint §3.2, §4.8).
 *
 * Règle d'or : un callback n'est jamais cru. Avant tout crédit, le statut est
 * relu chez le fournisseur ; seul un statut PAID déclenche l'écriture DEPOSIT
 * (idempotente sur `deposit:<intentId>`, donc rejouable sans double crédit).
 *
 * Retraits (A2) : ALKÉ n'exécute pas les décaissements. La demande réserve les
 * fonds (AVAILABLE → WITHDRAWABLE) ; le lot WDR de la SDB et la ligne CSH de
 * confirmation (module brokerage/reconciliation) appellent `markWithdrawalPaid`
 * ou `failWithdrawal`. En mode simulé le paiement est immédiat.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly configValues: ConfigValuesService,
    private readonly providers: PaymentProviderRegistry,
    private readonly events: EventBus,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------- deposits

  async createDeposit(userId: string, dto: CreateDepositDto): Promise<DepositResult> {
    const currency = dto.currency.toUpperCase();
    const amount = this.parseAmount(dto.amount, currency);
    await this.enforceDepositCap(userId, amount, currency);

    const ttlMinutes = await this.configValues.get<number>(
      CONFIG_KEYS.paymentIntentTtlMinutes,
      CONFIG_DEFAULTS[CONFIG_KEYS.paymentIntentTtlMinutes],
    );
    const id = randomUUID();
    let intent = await this.prisma.paymentIntent.create({
      data: {
        id,
        reference: id,
        userId,
        direction: PaymentDirection.IN,
        provider: dto.provider,
        amount,
        currency,
        msisdn: dto.msisdn ?? null,
        state: PaymentIntentState.CREATED,
        expiresAt: new Date(Date.now() + Number(ttlMinutes) * 60_000),
      },
    });
    await this.events.publish('DepositCreated', {
      entityType: 'PaymentIntent',
      entityId: intent.id,
      actor: userId,
      payload: { amount: toApi(amount), currency, provider: dto.provider },
    });

    const adapter = this.providers.for(intent);
    let paymentUrl: string | undefined;
    try {
      const result = await adapter.requestCollection(intent);
      paymentUrl = result.paymentUrl;
      intent = await this.prisma.paymentIntent.update({
        where: { id: intent.id },
        data: {
          providerRef: result.providerRef ?? intent.providerRef,
          providerStatus: `REQUESTED:${result.status}`,
          state: result.status === 'FAILED' ? PaymentIntentState.FAILED : PaymentIntentState.PENDING,
          failureReason: result.status === 'FAILED' ? 'Paiement refusé par le fournisseur.' : null,
        },
      });
      if (result.status === 'FAILED') {
        await this.publishFailed(intent, 'PROVIDER_SYNC');
      } else if (result.status === 'PAID') {
        intent = await this.confirmDeposit(intent.id, 'PROVIDER_SYNC');
      }
    } catch (err) {
      // The request may or may not have reached the provider: keep the intent
      // open so the webhook, an admin recheck or the expiry job settles it.
      this.logger.warn(`requestCollection ${intent.id} failed: ${(err as Error).message}`);
      intent = await this.prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { state: PaymentIntentState.PENDING, providerStatus: 'REQUEST_ERROR' },
      });
    }
    return { intent, paymentUrl };
  }

  /**
   * Re-reads the provider status and, only when PAID, credits the user once.
   * Safe to call any number of times, from any source.
   */
  async confirmDeposit(intentId: string, source: ConfirmationSource): Promise<PaymentIntent> {
    const intent = await this.getIntent(intentId);
    if (intent.direction !== PaymentDirection.IN) {
      throw new BadRequestException('Cette intention n’est pas un dépôt.');
    }
    if (intent.state === PaymentIntentState.PAID) return intent;
    if (intent.state === PaymentIntentState.FAILED || intent.state === PaymentIntentState.CANCELLED) return intent;

    let status: StatusResult;
    try {
      status = await this.providers.for(intent).queryStatus(intent);
    } catch (err) {
      this.logger.warn(`queryStatus ${intent.id} failed: ${(err as Error).message}`);
      return intent;
    }

    const statusPatch = {
      providerStatus: status.providerStatus ?? status.status,
      providerRef: status.providerRef ?? intent.providerRef,
    };

    if (status.status === 'PAID') {
      return this.creditDeposit(intent, source, statusPatch, {});
    }
    if (status.status === 'FAILED') {
      const failed = await this.prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { ...statusPatch, state: PaymentIntentState.FAILED, failureReason: status.reason ?? 'Paiement refusé par le fournisseur.' },
      });
      await this.publishFailed(failed, source);
      return failed;
    }
    return this.prisma.paymentIntent.update({ where: { id: intent.id }, data: statusPatch });
  }

  /**
   * Maker-checker executor for PAYMENT_FORCE_COMPLETE (approvals module):
   * credits a deposit — or pays a withdrawal — without provider confirmation.
   */
  async forceComplete(intentId: string, actorId: string, approvalId: string): Promise<PaymentIntent> {
    const intent = await this.getIntent(intentId);
    if (intent.state === PaymentIntentState.PAID) return intent;
    if (intent.state === PaymentIntentState.CANCELLED) {
      throw new BadRequestException('Cette intention a été annulée.');
    }
    let result: PaymentIntent;
    if (intent.direction === PaymentDirection.IN) {
      result = await this.creditDeposit(intent, 'ADMIN', { providerStatus: 'FORCED' }, { approvalId, forced: true }, actorId);
    } else {
      if (intent.state !== PaymentIntentState.PENDING) {
        throw new BadRequestException('Seul un retrait en attente peut être forcé.');
      }
      result = await this.markWithdrawalPaid(intent.id, `approval:${approvalId}`, 'ADMIN', { approvalId, forced: true }, actorId);
    }
    await this.audit.log({
      actorUserId: actorId, actorRole: 'ADMIN', action: 'PAYMENT_FORCE_COMPLETED',
      entityType: 'PaymentIntent', entityId: intent.id, before: intent, after: { ...result, approvalId },
    });
    return result;
  }

  private async creditDeposit(
    intent: PaymentIntent,
    source: ConfirmationSource,
    statusPatch: { providerStatus?: string; providerRef?: string | null },
    metadata: Record<string, string | boolean>,
    actorId?: string,
  ): Promise<PaymentIntent> {
    // Ledger first (idempotent, race-safe on its own), then the intent: a
    // crash in between is healed by the next confirm — same key, same txn.
    const txn = await this.ledger.post({
      type: LedgerTxnType.DEPOSIT,
      idempotencyKey: LedgerKeys.deposit(intent.id),
      currency: intent.currency,
      source,
      actorId: actorId ?? null,
      refType: 'PaymentIntent',
      refId: intent.id,
      externalReference: statusPatch.providerRef ?? intent.providerRef ?? undefined,
      description: `Dépôt ${providerLabel(intent.provider)}`,
      metadata: { provider: intent.provider, ...metadata },
      entries: [
        { account: userAccount(intent.userId, intent.currency, LedgerAccountKind.AVAILABLE), amount: intent.amount },
        { account: providerClearing(intent.provider, intent.currency), amount: intent.amount.negated() },
      ],
    });
    const paid = await this.prisma.paymentIntent.update({
      where: { id: intent.id },
      data: {
        ...statusPatch,
        state: PaymentIntentState.PAID,
        confirmedAt: intent.confirmedAt ?? new Date(),
        ledgerTxnId: txn.id,
        failureReason: null,
      },
    });
    await this.events.publish('DepositConfirmed', {
      entityType: 'PaymentIntent',
      entityId: paid.id,
      actor: actorId ?? this.actorFor(source, intent.provider),
      payload: { userId: paid.userId, amount: toApi(paid.amount), currency: paid.currency, provider: paid.provider, ledgerTxnId: txn.id, source, ...metadata },
    });
    return paid;
  }

  // -------------------------------------------------------------- webhooks

  /** Stores the raw payload on the matching intent and returns it (null when unmatched). */
  async recordWebhook(provider: PaymentProvider, reference: string | undefined, payload: unknown): Promise<PaymentIntent | null> {
    if (!reference) return null;
    const intent = await this.prisma.paymentIntent.findFirst({
      where: { OR: [{ reference }, { providerRef: reference }] },
    });
    if (!intent) return null;
    return this.prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { webhookPayload: (payload ?? {}) as Prisma.InputJsonValue, providerStatus: `CALLBACK:${provider}` },
    });
  }

  // ---------------------------------------------------------------- expiry

  /**
   * Marks open deposit intents past `expiresAt` as EXPIRED, after one last
   * status query for those already sent to the provider. Withdrawal intents
   * are never expired here: their settlement is driven by the WDR/CSH cycle.
   */
  async expireStaleIntents(now: Date = new Date()): Promise<{ expired: number; settled: number }> {
    const stale = await this.prisma.paymentIntent.findMany({
      where: { direction: PaymentDirection.IN, state: { in: OPEN_STATES }, expiresAt: { lt: now } },
      orderBy: { expiresAt: 'asc' },
      take: 200,
    });
    let expired = 0;
    let settled = 0;
    for (const intent of stale) {
      let current = intent;
      if (intent.state === PaymentIntentState.PENDING) {
        try {
          current = await this.confirmDeposit(intent.id, 'JOB');
        } catch (err) {
          this.logger.warn(`final status check ${intent.id} failed: ${(err as Error).message}`);
        }
      }
      if (!OPEN_STATES.includes(current.state)) {
        settled++;
        continue;
      }
      const result = await this.prisma.paymentIntent.updateMany({
        where: { id: intent.id, state: { in: OPEN_STATES } },
        data: { state: PaymentIntentState.EXPIRED, failureReason: 'Délai de paiement dépassé.' },
      });
      if (result.count === 0) continue;
      expired++;
      await this.events.publish('DepositExpired', {
        entityType: 'PaymentIntent',
        entityId: intent.id,
        actor: 'SYSTEM',
        payload: { userId: intent.userId, amount: toApi(intent.amount), currency: intent.currency, provider: intent.provider },
      });
    }
    return { expired, settled };
  }

  // ----------------------------------------------------------- withdrawals

  async requestWithdrawal(userId: string, dto: RequestWithdrawalDto): Promise<PaymentIntent> {
    const currency = dto.currency.toUpperCase();
    const amount = this.parseAmount(dto.amount, currency);
    await this.enforceWithdrawalCap(userId, amount, currency);
    const ttlDays = await this.configValues.get<number>(
      CONFIG_KEYS.withdrawalIntentTtlDays,
      CONFIG_DEFAULTS[CONFIG_KEYS.withdrawalIntentTtlDays],
    );

    const id = randomUUID();
    const created = await this.prisma.paymentIntent.create({
      data: {
        id,
        reference: id,
        userId,
        direction: PaymentDirection.OUT,
        provider: dto.provider,
        amount,
        currency,
        msisdn: dto.msisdn,
        state: PaymentIntentState.CREATED,
        expiresAt: new Date(Date.now() + Number(ttlDays) * 86_400_000),
      },
    });

    // The balance check IS the ledger's non-negative rule on AVAILABLE.
    try {
      await this.ledger.post({
        type: LedgerTxnType.RESERVE,
        idempotencyKey: LedgerKeys.withdrawReserve(created.id),
        currency,
        source: 'USER',
        actorId: userId,
        refType: 'PaymentIntent',
        refId: created.id,
        description: `Réservation retrait ${providerLabel(dto.provider)}`,
        entries: [
          { account: userAccount(userId, currency, LedgerAccountKind.AVAILABLE), amount: amount.negated() },
          { account: userAccount(userId, currency, LedgerAccountKind.WITHDRAWABLE), amount },
        ],
      });
    } catch (err) {
      await this.prisma.paymentIntent.update({
        where: { id: created.id },
        data: { state: PaymentIntentState.FAILED, failureReason: (err as Error).message },
      });
      throw err;
    }

    let intent = await this.prisma.paymentIntent.update({
      where: { id: created.id },
      data: { state: PaymentIntentState.PENDING },
    });
    await this.events.publish('WithdrawalRequested', {
      entityType: 'PaymentIntent',
      entityId: intent.id,
      actor: userId,
      payload: { userId, amount: toApi(amount), currency, provider: dto.provider, msisdn: dto.msisdn },
    });

    if (this.providers.simulatedMode) {
      intent = await this.markWithdrawalPaid(intent.id, `SIM-${intent.reference}`, 'SIMULATED');
    }
    return intent;
  }

  /** Called by brokerage/reconciliation when the SDB's CSH line confirms the payout. */
  async markWithdrawalPaid(
    intentId: string,
    externalRef: string,
    source: ConfirmationSource,
    metadata: Record<string, string | boolean> = {},
    actorId?: string,
  ): Promise<PaymentIntent> {
    const intent = await this.getIntent(intentId);
    if (intent.direction !== PaymentDirection.OUT) throw new BadRequestException('Cette intention n’est pas un retrait.');
    if (intent.state === PaymentIntentState.PAID) return intent;
    if (intent.state !== PaymentIntentState.PENDING) {
      throw new BadRequestException(`Retrait dans l’état ${intent.state} : paiement impossible.`);
    }
    const txn = await this.ledger.post({
      type: LedgerTxnType.WITHDRAWAL,
      idempotencyKey: LedgerKeys.withdraw(intent.id),
      currency: intent.currency,
      source,
      actorId: actorId ?? null,
      refType: 'PaymentIntent',
      refId: intent.id,
      externalReference: externalRef,
      description: `Retrait ${providerLabel(intent.provider)}`,
      metadata: { provider: intent.provider, ...metadata },
      entries: [
        { account: userAccount(intent.userId, intent.currency, LedgerAccountKind.WITHDRAWABLE), amount: intent.amount.negated() },
        { account: providerClearing(intent.provider, intent.currency), amount: intent.amount },
      ],
    });
    const paid = await this.prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { state: PaymentIntentState.PAID, confirmedAt: new Date(), providerRef: externalRef, providerStatus: source, ledgerTxnId: txn.id },
    });
    await this.events.publish('WithdrawalPaid', {
      entityType: 'PaymentIntent',
      entityId: paid.id,
      actor: actorId ?? this.actorFor(source, intent.provider),
      payload: { userId: paid.userId, amount: toApi(paid.amount), currency: paid.currency, provider: paid.provider, externalRef, ledgerTxnId: txn.id, ...metadata },
    });
    return paid;
  }

  /** Releases the reserved funds (WITHDRAWABLE → AVAILABLE) and fails the intent. */
  async failWithdrawal(intentId: string, reason: string, actorId?: string): Promise<PaymentIntent> {
    const intent = await this.getIntent(intentId);
    if (intent.direction !== PaymentDirection.OUT) throw new BadRequestException('Cette intention n’est pas un retrait.');
    if (intent.state === PaymentIntentState.FAILED || intent.state === PaymentIntentState.CANCELLED) return intent;
    if (intent.state !== PaymentIntentState.PENDING) {
      throw new BadRequestException(`Retrait dans l’état ${intent.state} : annulation impossible.`);
    }
    await this.ledger.post({
      type: LedgerTxnType.RELEASE,
      idempotencyKey: LedgerKeys.withdrawRelease(intent.id),
      currency: intent.currency,
      source: actorId ? 'ADMIN' : 'JOB',
      actorId: actorId ?? null,
      refType: 'PaymentIntent',
      refId: intent.id,
      description: `Retrait annulé : ${reason}`,
      entries: [
        { account: userAccount(intent.userId, intent.currency, LedgerAccountKind.WITHDRAWABLE), amount: intent.amount.negated() },
        { account: userAccount(intent.userId, intent.currency, LedgerAccountKind.AVAILABLE), amount: intent.amount },
      ],
    });
    const failed = await this.prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { state: PaymentIntentState.FAILED, failureReason: reason },
    });
    await this.events.publish('WithdrawalFailed', {
      entityType: 'PaymentIntent',
      entityId: failed.id,
      actor: actorId ?? 'SYSTEM',
      payload: { userId: failed.userId, amount: toApi(failed.amount), currency: failed.currency, reason },
    });
    return failed;
  }

  // ---------------------------------------------------------------- reads

  async wallet(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { displayCurrency: true } });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    const currencies = new Set([user.displayCurrency, ...(await this.ledger.userCurrencies(userId))]);
    const balances: WalletBalance[] = [];
    for (const currency of currencies) {
      const b = await this.ledger.userBalances(userId, currency);
      balances.push({
        currency,
        available: toApi(b.available),
        reserved: toApi(b.reserved),
        settling: toApi(b.settling),
        withdrawable: toApi(b.withdrawable),
        total: toApi(b.available.plus(b.reserved).plus(b.settling).plus(b.withdrawable)),
      });
    }
    const pending = await this.prisma.paymentIntent.findMany({
      where: { userId, state: { in: OPEN_STATES } },
      orderBy: { createdAt: 'desc' },
    });
    return { balances, pendingIntents: pending.map(PaymentsService.intentToApi) };
  }

  async getIntentForUser(userId: string, intentId: string): Promise<PaymentIntent> {
    const intent = await this.prisma.paymentIntent.findFirst({ where: { id: intentId, userId } });
    if (!intent) throw new NotFoundException('Opération introuvable.');
    return intent;
  }

  listIntents(userId: string, direction?: PaymentDirection, limit = 50) {
    return this.prisma.paymentIntent.findMany({
      where: { userId, ...(direction ? { direction } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  async transactions(userId: string, currency?: string, limit = 50) {
    const currencies = currency ? [currency.toUpperCase()] : await this.ledger.userCurrencies(userId);
    const ledger: StatementApiLine[] = [];
    for (const c of currencies) {
      for (const line of await this.ledger.userStatement(userId, c, limit)) {
        ledger.push({ ...line, amount: toApi(line.amount) });
      }
    }
    ledger.sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime());
    const intents = await this.prisma.paymentIntent.findMany({
      where: { userId, ...(currency ? { currency: currency.toUpperCase() } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return { ledger: ledger.slice(0, limit), intents: intents.map(PaymentsService.intentToApi) };
  }

  // ----------------------------------------------------------------- admin

  adminListPending() {
    return this.prisma.paymentIntent.findMany({
      where: { state: { in: OPEN_STATES } },
      include: { user: { select: { id: true, fullName: true, email: true, phone: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Back-office listing (blueprint §4.20): every intent, optionally filtered by state and direction. */
  adminListIntents(filter: { state?: PaymentIntentState; direction?: PaymentDirection }, limit = 200) {
    return this.prisma.paymentIntent.findMany({
      where: { ...(filter.state && { state: filter.state }), ...(filter.direction && { direction: filter.direction }) },
      include: { user: { select: { id: true, fullName: true, email: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /** Re-queries the provider (deposits). Withdrawals are settled by the CSH file, never by a recheck. */
  async adminRecheck(actorId: string, intentId: string): Promise<PaymentIntent> {
    const before = await this.getIntent(intentId);
    if (before.direction !== PaymentDirection.IN) {
      throw new BadRequestException('Un retrait est confirmé par le relevé de la SDB, pas par une revérification.');
    }
    const after = await this.confirmDeposit(intentId, 'ADMIN_RECHECK');
    await this.audit.log({
      actorUserId: actorId, actorRole: 'ADMIN', action: 'PAYMENT_INTENT_RECHECKED',
      entityType: 'PaymentIntent', entityId: intentId, before, after,
    });
    return after;
  }

  // --------------------------------------------------------------- helpers

  static intentToApi(intent: PaymentIntent) {
    return { ...intent, amount: toApi(intent.amount), webhookPayload: undefined };
  }

  async getIntent(intentId: string): Promise<PaymentIntent> {
    const intent = await this.prisma.paymentIntent.findUnique({ where: { id: intentId } });
    if (!intent) throw new NotFoundException('Opération introuvable.');
    return intent;
  }

  private parseAmount(raw: string | number, currency: string): Prisma.Decimal {
    let amount: Prisma.Decimal;
    try {
      amount = D(typeof raw === 'string' ? raw.trim() : raw);
    } catch {
      throw new BadRequestException('Le montant doit être un nombre.');
    }
    if (!amount.isFinite() || !amount.greaterThan(0)) {
      throw new BadRequestException('Le montant doit être strictement positif.');
    }
    if (!roundMoney(amount, currency).equals(amount)) {
      throw new BadRequestException(
        decimalsFor(currency) === 0
          ? `Le montant en ${currency} doit être un nombre entier.`
          : `Le montant en ${currency} ne peut pas avoir plus de ${decimalsFor(currency)} décimales.`,
      );
    }
    return amount;
  }

  private async enforceDepositCap(userId: string, amount: Prisma.Decimal, currency: string): Promise<void> {
    if (currency !== 'XAF') return;
    const cap = D(await this.configValues.get<number>(CONFIG_KEYS.pilotDepositCapXaf, CONFIG_DEFAULTS[CONFIG_KEYS.pilotDepositCapXaf]));
    const agg = await this.prisma.paymentIntent.aggregate({
      where: { userId, direction: PaymentDirection.IN, currency, state: PaymentIntentState.PAID },
      _sum: { amount: true },
    });
    if ((agg._sum.amount ?? ZERO).plus(amount).greaterThan(cap)) {
      throw new BadRequestException(`Plafond de dépôt du pilote atteint (${cap.toFixed()} XAF au total).`);
    }
  }

  private async enforceWithdrawalCap(userId: string, amount: Prisma.Decimal, currency: string): Promise<void> {
    if (currency !== 'XAF') return;
    const cap = D(await this.configValues.get<number>(CONFIG_KEYS.withdrawalDailyCapXaf, CONFIG_DEFAULTS[CONFIG_KEYS.withdrawalDailyCapXaf]));
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const agg = await this.prisma.paymentIntent.aggregate({
      where: {
        userId, direction: PaymentDirection.OUT, currency,
        state: { in: [PaymentIntentState.PENDING, PaymentIntentState.PAID] },
        createdAt: { gte: startOfDay },
      },
      _sum: { amount: true },
    });
    if ((agg._sum.amount ?? ZERO).plus(amount).greaterThan(cap)) {
      throw new BadRequestException(`Plafond de retrait journalier atteint (${cap.toFixed()} XAF).`);
    }
  }

  private actorFor(source: ConfirmationSource, provider: PaymentProvider): string {
    return source === 'PAYMENT_WEBHOOK' || source === 'PROVIDER_SYNC' ? `PROVIDER:${provider}` : 'SYSTEM';
  }

  private async publishFailed(intent: PaymentIntent, source: ConfirmationSource): Promise<void> {
    await this.events.publish('DepositFailed', {
      entityType: 'PaymentIntent',
      entityId: intent.id,
      actor: this.actorFor(source, intent.provider),
      payload: { userId: intent.userId, amount: toApi(intent.amount), currency: intent.currency, provider: intent.provider, reason: intent.failureReason },
    });
  }
}
