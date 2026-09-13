import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import {
  AlertSeverity,
  AlertSource,
  BatchState,
  PaymentDirection,
  PaymentIntent,
  PaymentIntentState,
  PendingApproval,
  Prisma,
  ReconciliationItem,
  ReconciliationSource,
  ReconciliationState,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EventBus } from '../../common/events/event-bus.service';
import { D, ZERO, roundMoney, toApi } from '../../common/money';
import { APPROVALS_PORT, ApprovalsPort } from '../approvals/approvals.types';
import { LEDGER_PORT, LedgerPort } from '../ledger/ledger.types';
import { PolicyService } from '../policy/policy.service';
import { CshLine } from '../brokerage/connectors/connector.types';
import { WITHDRAWAL_SETTLEMENT_PORT, WithdrawalSettlementPort } from '../brokerage/ports';
import { isoDate } from '../brokerage/trading-days';
import { UpdateReconciliationDto } from './dto/reconciliation.dto';

export const RECONCILIATION_CONFIG_KEYS = { materialityXaf: 'reconciliation.materiality_xaf' } as const;
export const DEFAULT_MATERIALITY_XAF = 1000;
const SDB_FILE_ACTOR = 'SDB_FILE';
const MARKET_TZ = 'Africa/Douala';

export interface ReconciliationRun {
  partnerId: string;
  date: string;
  lines: number;
  matched: string[];
  withdrawalsPaid: string[];
  items: string[];
  mirror: { ledgerTotal: string; closingBalance: string | null; difference: string | null; materiality: string; alert: boolean };
}

export interface FinancialMetrics {
  mirrorMismatchXaf: string;
  openReconciliationItems: number;
  oldestPendingWithdrawalHours: number | null;
  ackLatencyMinutesLast: number | null;
}

/**
 * Rapprochement quotidien (blueprint §4.16) : chaque ligne du relevé espèces
 * de la SDB (CSH) doit correspondre à une intention de paiement ; le total
 * miroir du grand livre (AVAILABLE + RESERVED + SETTLING des clients) doit
 * égaler le solde de clôture à la matérialité près. Tout écart devient un
 * ReconciliationItem OPEN à traiter par la conformité ; un abandon (WRITTEN_OFF)
 * passe par le maker-checker (RECON_WRITE_OFF).
 */
@Injectable()
export class ReconciliationService implements OnModuleInit {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBus,
    private readonly policy: PolicyService,
    @Inject(LEDGER_PORT) private readonly ledger: LedgerPort,
    @Inject(APPROVALS_PORT) private readonly approvals: ApprovalsPort,
    @Inject(WITHDRAWAL_SETTLEMENT_PORT) private readonly withdrawals: WithdrawalSettlementPort,
  ) {}

  onModuleInit(): void {
    this.approvals.registerExecutor('RECON_WRITE_OFF', (approval) => this.applyWriteOff(approval));
  }

  async materiality(): Promise<Prisma.Decimal> {
    const raw = await this.policy.configValue<number | string>(RECONCILIATION_CONFIG_KEYS.materialityXaf);
    return D(raw ?? DEFAULT_MATERIALITY_XAF);
  }

  // --------------------------------------------------------------- runDaily

  async runDaily(partnerId: string, lines: CshLine[], actorId: string = SDB_FILE_ACTOR, at: Date = new Date()): Promise<ReconciliationRun> {
    const partner = await this.prisma.marketPartner.findUnique({ where: { id: partnerId }, include: { market: true } });
    if (!partner) throw new NotFoundException('Partenaire introuvable.');
    const currency = partner.market.currency;
    const date = isoDate(at, MARKET_TZ);
    const run: ReconciliationRun = {
      partnerId,
      date,
      lines: lines.length,
      matched: [],
      withdrawalsPaid: [],
      items: [],
      mirror: { ledgerTotal: '0', closingBalance: null, difference: null, materiality: '0', alert: false },
    };

    for (const line of lines) {
      const amount = roundMoney(D(line.amount).abs(), currency);
      const intent = await this.findIntent(line, currency);
      const occurredAt = this.parseDate(line.date);
      if (!intent) {
        run.items.push(await this.openItem(line, amount, currency, occurredAt, 'Référence inconnue : aucune intention de paiement correspondante.', null, actorId));
        continue;
      }
      if (!D(intent.amount).equals(amount)) {
        run.items.push(
          await this.openItem(
            line,
            amount,
            currency,
            occurredAt,
            `Montant différent : relevé ${amount.toFixed()} ${currency}, intention ${D(intent.amount).toFixed()} ${intent.currency}.`,
            intent,
            actorId,
          ),
        );
        continue;
      }
      if (line.direction === 'IN') {
        if (intent.state === PaymentIntentState.PAID) {
          run.matched.push(intent.id);
          await this.closeMatchedItem(line, intent);
        } else {
          run.items.push(await this.openItem(line, amount, currency, occurredAt, `Dépôt présent au relevé mais intention dans l’état ${intent.state}.`, intent, actorId));
        }
      } else if (intent.state === PaymentIntentState.PENDING) {
        try {
          await this.withdrawals.markWithdrawalPaid(intent.id, line.reference, 'CSH_FILE');
          run.withdrawalsPaid.push(intent.id);
        } catch (err) {
          run.items.push(await this.openItem(line, amount, currency, occurredAt, `Confirmation du retrait impossible : ${(err as Error).message}`, intent, actorId));
        }
      } else if (intent.state === PaymentIntentState.PAID) {
        run.matched.push(intent.id);
        await this.closeMatchedItem(line, intent);
      } else {
        run.items.push(await this.openItem(line, amount, currency, occurredAt, `Retrait présent au relevé mais intention dans l’état ${intent.state}.`, intent, actorId));
      }
    }

    run.mirror = await this.mirrorCheck(partnerId, currency, lines.length ? lines[lines.length - 1].balance : null, date, actorId);
    return run;
  }

  private async findIntent(line: CshLine, currency: string): Promise<PaymentIntent | null> {
    const direction = line.direction === 'IN' ? PaymentDirection.IN : PaymentDirection.OUT;
    const ref = line.reference.trim();
    if (!ref) return null;
    return this.prisma.paymentIntent.findFirst({
      where: { direction, currency, OR: [{ reference: ref }, { id: ref }, { providerRef: ref }] },
      orderBy: { createdAt: 'desc' },
    });
  }

  private externalRef(line: CshLine): string {
    return `${line.direction}:${line.reference.trim()}`;
  }

  private async openItem(
    line: CshLine,
    amount: Prisma.Decimal,
    currency: string,
    occurredAt: Date | null,
    reason: string,
    intent: PaymentIntent | null,
    actorId: string,
  ): Promise<string> {
    const externalRef = this.externalRef(line);
    const where = { source_externalRef: { source: ReconciliationSource.SDB_STATEMENT, externalRef } };
    const existing = await this.prisma.reconciliationItem.findUnique({ where });
    if (existing) {
      if (existing.state === ReconciliationState.OPEN && existing.reason !== reason) {
        await this.prisma.reconciliationItem.update({ where, data: { reason, rawLine: this.rawLine(line) } });
      }
      return existing.id;
    }
    const item = await this.prisma.reconciliationItem.create({
      data: {
        source: ReconciliationSource.SDB_STATEMENT,
        externalRef,
        amount: line.direction === 'OUT' ? amount.negated() : amount,
        currency,
        occurredAt,
        rawLine: this.rawLine(line),
        matchedTxnId: intent?.ledgerTxnId ?? null,
        ownerId: intent?.userId ?? null,
        reason,
      },
    });
    await this.events.publish('ReconciliationMismatchDetected', {
      entityType: 'ReconciliationItem',
      entityId: item.id,
      actor: actorId,
      payload: { externalRef, amount: toApi(item.amount), currency, reason, intentId: intent?.id ?? null, userId: intent?.userId ?? null },
    });
    return item.id;
  }

  /** A line that now matches closes any OPEN item a previous statement had raised for it. */
  private async closeMatchedItem(line: CshLine, intent: PaymentIntent): Promise<void> {
    await this.prisma.reconciliationItem.updateMany({
      where: { source: ReconciliationSource.SDB_STATEMENT, externalRef: this.externalRef(line), state: { in: [ReconciliationState.OPEN, ReconciliationState.INVESTIGATING] } },
      data: { state: ReconciliationState.RESOLVED, resolvedAt: new Date(), matchedTxnId: intent.ledgerTxnId, reason: 'Rapproché automatiquement par un relevé ultérieur.' },
    });
  }

  private rawLine(line: CshLine): string {
    return [line.date, line.reference, line.direction, line.amount, line.balance].join(';');
  }

  private parseDate(raw: string): Date | null {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // ------------------------------------------------------------------ mirror

  private async mirrorCheck(partnerId: string, currency: string, closing: string | null, date: string, actorId: string): Promise<ReconciliationRun['mirror']> {
    const [ledgerTotal, materiality] = await Promise.all([this.ledger.mirrorTotal(currency), this.materiality()]);
    const result: ReconciliationRun['mirror'] = {
      ledgerTotal: ledgerTotal.toFixed(),
      closingBalance: closing,
      difference: null,
      materiality: materiality.toFixed(),
      alert: false,
    };
    if (closing === null) return result;
    const difference = ledgerTotal.minus(D(closing));
    result.difference = difference.toFixed();
    if (difference.abs().lessThanOrEqualTo(materiality)) return result;

    result.alert = true;
    const externalRef = `mirror:${partnerId}:${date}`;
    const where = { source_externalRef: { source: ReconciliationSource.SDB_STATEMENT, externalRef } };
    const reason = `Écart miroir ${difference.toFixed()} ${currency} (grand livre ${ledgerTotal.toFixed()}, relevé SDB ${D(closing).toFixed()}) au-delà de la matérialité ${materiality.toFixed()}.`;
    const existing = await this.prisma.reconciliationItem.findUnique({ where });
    let itemId: string;
    if (existing) {
      await this.prisma.reconciliationItem.update({ where, data: { amount: difference, reason } });
      itemId = existing.id;
    } else {
      const item = await this.prisma.reconciliationItem.create({
        data: { source: ReconciliationSource.SDB_STATEMENT, externalRef, amount: difference, currency, occurredAt: new Date(`${date}T00:00:00Z`), reason, ownerId: partnerId },
      });
      itemId = item.id;
      await this.prisma.complianceAlert.create({
        data: {
          source: AlertSource.RECONCILIATION,
          severity: AlertSeverity.HIGH,
          entityType: 'ReconciliationItem',
          entityId: item.id,
          summary: reason,
          details: { partnerId, date, currency, ledgerTotal: ledgerTotal.toFixed(), closingBalance: closing, difference: difference.toFixed() },
        },
      });
      await this.events.publish('ComplianceAlertRaised', {
        entityType: 'ReconciliationItem',
        entityId: item.id,
        actor: actorId,
        payload: { source: AlertSource.RECONCILIATION, severity: AlertSeverity.HIGH, partnerId, difference: difference.toFixed(), currency },
      });
    }
    await this.events.publish('ReconciliationMismatchDetected', {
      entityType: 'ReconciliationItem',
      entityId: itemId,
      actor: actorId,
      payload: { externalRef, amount: difference.toFixed(), currency, reason, mirror: true, partnerId },
    });
    return result;
  }

  /** Mirror principle snapshot per currency, with the open mirror items. */
  async mirror() {
    const currencies = await this.prisma.ledgerAccount.findMany({ distinct: ['currency'], select: { currency: true }, orderBy: { currency: 'asc' } });
    const materiality = await this.materiality();
    const totals = await Promise.all(
      currencies.map(async ({ currency }) => ({ currency, ledgerTotal: (await this.ledger.mirrorTotal(currency)).toFixed() })),
    );
    const openMirrorItems = await this.prisma.reconciliationItem.findMany({
      where: { externalRef: { startsWith: 'mirror:' }, state: { in: [ReconciliationState.OPEN, ReconciliationState.INVESTIGATING] } },
      orderBy: { createdAt: 'desc' },
    });
    return { materiality: materiality.toFixed(), totals, openMirrorItems };
  }

  // ------------------------------------------------------------------- queue

  list(state?: ReconciliationState): Promise<ReconciliationItem[]> {
    return this.prisma.reconciliationItem.findMany({
      where: state ? { state } : { state: { in: [ReconciliationState.OPEN, ReconciliationState.INVESTIGATING] } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  }

  async update(id: string, dto: UpdateReconciliationDto, actorId: string): Promise<ReconciliationItem> {
    const item = await this.prisma.reconciliationItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Écart introuvable.');
    if (item.state === ReconciliationState.WRITTEN_OFF || item.state === ReconciliationState.RESOLVED) {
      throw new BadRequestException(`Écart déjà clos (${item.state}).`);
    }
    if (dto.state !== ReconciliationState.INVESTIGATING && dto.state !== ReconciliationState.RESOLVED) {
      throw new BadRequestException('Seuls les états INVESTIGATING et RESOLVED sont accessibles directement ; l’abandon passe par le maker-checker.');
    }
    if (dto.matchedTxnId) {
      const txn = await this.prisma.ledgerTxn.findUnique({ where: { id: dto.matchedTxnId } });
      if (!txn) throw new BadRequestException('Transaction du grand livre introuvable.');
    }
    const updated = await this.prisma.reconciliationItem.update({
      where: { id },
      data: {
        state: dto.state,
        reason: dto.reason,
        matchedTxnId: dto.matchedTxnId ?? item.matchedTxnId,
        resolvedAt: dto.state === ReconciliationState.RESOLVED ? new Date() : null,
      },
    });
    if (dto.state === ReconciliationState.RESOLVED) {
      await this.events.publish('ReconciliationResolved', {
        entityType: 'ReconciliationItem',
        entityId: id,
        actor: actorId,
        payload: { externalRef: item.externalRef, amount: toApi(item.amount), currency: item.currency, reason: dto.reason, matchedTxnId: updated.matchedTxnId },
      });
    }
    return updated;
  }

  async requestWriteOff(id: string, reason: string, makerId: string): Promise<PendingApproval> {
    const item = await this.prisma.reconciliationItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Écart introuvable.');
    if (item.state === ReconciliationState.WRITTEN_OFF || item.state === ReconciliationState.RESOLVED) {
      throw new BadRequestException(`Écart déjà clos (${item.state}).`);
    }
    return this.approvals.request({
      actionType: 'RECON_WRITE_OFF',
      entityType: 'ReconciliationItem',
      entityId: id,
      makerId,
      reason,
      payload: { itemId: id, amount: toApi(item.amount), currency: item.currency, externalRef: item.externalRef },
    });
  }

  async applyWriteOff(approval: PendingApproval): Promise<ReconciliationItem> {
    const id = approval.entityId;
    if (!id) throw new BadRequestException('Approbation sans écart cible.');
    const item = await this.prisma.reconciliationItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Écart introuvable.');
    if (item.state === ReconciliationState.WRITTEN_OFF) return item;
    if (item.state === ReconciliationState.RESOLVED) throw new BadRequestException('Écart déjà résolu.');
    const updated = await this.prisma.reconciliationItem.update({
      where: { id },
      data: { state: ReconciliationState.WRITTEN_OFF, resolvedAt: new Date(), reason: `Abandonné : ${approval.reason}` },
    });
    await this.events.publish('ReconciliationResolved', {
      entityType: 'ReconciliationItem',
      entityId: id,
      actor: approval.checkerId ?? approval.makerId,
      payload: { externalRef: item.externalRef, amount: toApi(item.amount), currency: item.currency, writtenOff: true, approvalId: approval.id },
    });
    return updated;
  }

  // ----------------------------------------------------------------- metrics

  async metrics(now: Date = new Date()): Promise<FinancialMetrics> {
    const [mirrorItems, openCount, oldestWithdrawal, lastAck] = await Promise.all([
      this.prisma.reconciliationItem.findMany({
        where: { externalRef: { startsWith: 'mirror:' }, state: { in: [ReconciliationState.OPEN, ReconciliationState.INVESTIGATING] }, currency: 'XAF' },
        select: { amount: true },
      }),
      this.prisma.reconciliationItem.count({ where: { state: { in: [ReconciliationState.OPEN, ReconciliationState.INVESTIGATING] } } }),
      this.prisma.paymentIntent.findFirst({
        where: { direction: PaymentDirection.OUT, state: PaymentIntentState.PENDING },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      this.prisma.orderBatch.findFirst({
        where: { state: { in: [BatchState.ACKED, BatchState.PROCESSED] }, ackAt: { not: null } },
        orderBy: { ackAt: 'desc' },
        select: { ackAt: true, sentAt: true, createdAt: true },
      }),
    ]);
    const mirrorMismatch = mirrorItems.reduce((acc, i) => acc.plus(D(i.amount).abs()), ZERO);
    const ackLatency = lastAck?.ackAt ? Math.round((lastAck.ackAt.getTime() - (lastAck.sentAt ?? lastAck.createdAt).getTime()) / 60_000) : null;
    return {
      mirrorMismatchXaf: mirrorMismatch.toFixed(),
      openReconciliationItems: openCount,
      oldestPendingWithdrawalHours: oldestWithdrawal ? Math.round(((now.getTime() - oldestWithdrawal.createdAt.getTime()) / 3_600_000) * 10) / 10 : null,
      ackLatencyMinutesLast: ackLatency,
    };
  }
}
