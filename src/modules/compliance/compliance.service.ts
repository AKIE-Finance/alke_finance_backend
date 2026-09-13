import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AlertSeverity,
  AlertSource,
  AlertStatus,
  ComplianceAlert,
  ComplianceCase,
  ComplianceCaseState,
  KycStatus,
  PendingApproval,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EventBus } from '../../common/events/event-bus.service';
import { DomainEvent } from '../../common/events/domain-events';
import { AuditService } from '../../common/services/audit.service';
import { ConfigValuesService } from '../config/config-values.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { KycService } from '../kyc/kyc.service';
import { COMPLIANCE_DECISIONS, ComplianceDecisionCode, OpenComplianceCaseDto } from './dto/compliance.dto';

export interface RaiseAlertInput {
  source: AlertSource;
  severity: AlertSeverity;
  summary: string;
  userId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  details?: Prisma.InputJsonValue;
}

export const COMPLIANCE_CONFIG_KEYS = { largeTransactionXaf: 'compliance.large_transaction_xaf' } as const;
export const COMPLIANCE_DEFAULTS = { largeTransactionXaf: 5_000_000 } as const;

const CASE_INCLUDE = {
  subject: { select: { id: true, fullName: true, email: true, phone: true, country: true, kycStatus: true, isBlocked: true } },
  alerts: true,
  notes: { orderBy: { createdAt: 'asc' as const } },
  decisions: { orderBy: { decidedAt: 'asc' as const } },
} satisfies Prisma.ComplianceCaseInclude;

const DECISION_STATE: Partial<Record<ComplianceDecisionCode, ComplianceCaseState>> = {
  CLEARED: ComplianceCaseState.CLEARED,
  REPORTED: ComplianceCaseState.REPORTED,
  REPORTED_TO_ANIF: ComplianceCaseState.REPORTED,
  CLOSED: ComplianceCaseState.CLOSED,
};

const TERMINAL_STATES: readonly ComplianceCaseState[] = [ComplianceCaseState.CLEARED, ComplianceCaseState.REPORTED, ComplianceCaseState.CLOSED];

/**
 * Conformité (blueprint §4.17) : alertes idempotentes, dossiers CC-AAAA-NNNN,
 * notes, décisions sous maker-checker (COMPLIANCE_DECISION).
 */
@Injectable()
export class ComplianceService {
  private readonly logger = new Logger(ComplianceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly config: ConfigValuesService,
    private readonly approvals: ApprovalsService,
    private readonly kyc: KycService,
  ) {}

  // ------------------------------------------------------------------ alerts

  /** Idempotent: one OPEN alert per (source, entityType, entityId). */
  async raiseAlert(input: RaiseAlertInput): Promise<ComplianceAlert> {
    if (input.entityType && input.entityId) {
      const existing = await this.prisma.complianceAlert.findFirst({
        where: { source: input.source, entityType: input.entityType, entityId: input.entityId, status: AlertStatus.OPEN },
      });
      if (existing) return existing;
    }
    const alert = await this.prisma.complianceAlert.create({
      data: {
        source: input.source,
        severity: input.severity,
        summary: input.summary,
        userId: input.userId ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        details: input.details,
      },
    });
    await this.events.publish('ComplianceAlertRaised', {
      entityType: 'ComplianceAlert', entityId: alert.id, actor: 'SYSTEM',
      payload: { source: alert.source, severity: alert.severity, userId: alert.userId, entityType: alert.entityType, entityId: alert.entityId, summary: alert.summary },
    });
    return alert;
  }

  listAlerts(filter: { status?: AlertStatus; severity?: AlertSeverity }) {
    return this.prisma.complianceAlert.findMany({
      where: { ...(filter.status && { status: filter.status }), ...(filter.severity && { severity: filter.severity }) },
      orderBy: [{ createdAt: 'desc' }],
      take: 500,
    });
  }

  countOpenAlerts(): Promise<number> {
    return this.prisma.complianceAlert.count({ where: { status: AlertStatus.OPEN } });
  }

  // ------------------------------------------------------------------- cases

  async openCase(ownerId: string, dto: OpenComplianceCaseDto): Promise<ComplianceCase> {
    if (dto.subjectUserId) {
      const subject = await this.prisma.user.findUnique({ where: { id: dto.subjectUserId }, select: { id: true } });
      if (!subject) throw new NotFoundException('Utilisateur sujet introuvable.');
    }
    const alertIds = dto.alertIds ?? [];
    if (alertIds.length) {
      const found = await this.prisma.complianceAlert.count({ where: { id: { in: alertIds }, status: AlertStatus.OPEN } });
      if (found !== alertIds.length) throw new BadRequestException('Une ou plusieurs alertes sont introuvables ou déjà rattachées.');
    }
    const year = new Date().getFullYear();
    let created: ComplianceCase | null = null;
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      const reference = await this.nextReference(year);
      try {
        created = await this.prisma.$transaction(async (tx) => {
          const c = await tx.complianceCase.create({
            data: { reference, title: dto.title, subjectUserId: dto.subjectUserId ?? null, ownerId, state: ComplianceCaseState.OPEN },
          });
          if (alertIds.length) {
            await tx.complianceAlert.updateMany({ where: { id: { in: alertIds } }, data: { caseId: c.id, status: AlertStatus.ATTACHED } });
          }
          return c;
        });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      }
    }
    if (!created) throw new ConflictException('Impossible d’attribuer une référence de dossier, réessayez.');
    await this.audit.log({
      actorUserId: ownerId, action: 'COMPLIANCE_CASE_OPENED', entityType: 'ComplianceCase', entityId: created.id,
      after: { reference: created.reference, title: created.title, subjectUserId: created.subjectUserId, alertIds },
    });
    await this.events.publish('ComplianceCaseOpened', {
      entityType: 'ComplianceCase', entityId: created.id, actor: ownerId,
      payload: { reference: created.reference, title: created.title, subjectUserId: created.subjectUserId, alertIds },
    });
    return created;
  }

  listCases(state?: ComplianceCaseState) {
    return this.prisma.complianceCase.findMany({
      where: state ? { state } : undefined,
      include: { subject: CASE_INCLUDE.subject, _count: { select: { alerts: true, notes: true, decisions: true } } },
      orderBy: { openedAt: 'desc' },
      take: 500,
    });
  }

  async getCase(id: string) {
    const c = await this.prisma.complianceCase.findUnique({ where: { id }, include: CASE_INCLUDE });
    if (!c) throw new NotFoundException('Dossier de conformité introuvable.');
    return c;
  }

  openCasesForUser(userId: string) {
    return this.prisma.complianceCase.findMany({
      where: { subjectUserId: userId, state: { notIn: [...TERMINAL_STATES] } },
      orderBy: { openedAt: 'desc' },
    });
  }

  async addNote(caseId: string, authorId: string, body: string) {
    const c = await this.getCase(caseId);
    if (TERMINAL_STATES.includes(c.state)) throw new ConflictException('Ce dossier est clos.');
    const note = await this.prisma.complianceNote.create({ data: { caseId, authorId, body: body.trim() } });
    if (c.state === ComplianceCaseState.OPEN) {
      await this.prisma.complianceCase.update({ where: { id: caseId }, data: { state: ComplianceCaseState.UNDER_REVIEW } });
    }
    return note;
  }

  /** Maker step: the decision is applied by `executeDecision` after a second approver. */
  async requestDecision(makerId: string, caseId: string, decision: ComplianceDecisionCode, reason: string, regulatoryReportRef?: string): Promise<PendingApproval> {
    const c = await this.getCase(caseId);
    if (TERMINAL_STATES.includes(c.state)) throw new ConflictException('Ce dossier est déjà clos.');
    if (decision === 'ACCOUNT_BLOCKED' && !c.subjectUserId) {
      throw new BadRequestException('Le dossier n’a pas d’utilisateur sujet à bloquer.');
    }
    return this.approvals.request({
      actionType: 'COMPLIANCE_DECISION',
      entityType: 'ComplianceCase',
      entityId: caseId,
      payload: { caseId, decision, reason, regulatoryReportRef: regulatoryReportRef ?? null, reference: c.reference },
      reason,
      makerId,
    });
  }

  /**
   * Executor for COMPLIANCE_DECISION. Payload: { caseId? , kycCaseId?, decision,
   * reason?, regulatoryReportRef? }. KYC decisions delegate to KycService;
   * case decisions record a ComplianceDecision and move the case.
   */
  async executeDecision(approval: PendingApproval): Promise<unknown> {
    const p = approval.payload;
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Charge utile de la décision invalide.');
    const rec = p as Record<string, unknown>;
    const decision = typeof rec.decision === 'string' ? rec.decision : '';
    const reason = typeof rec.reason === 'string' ? rec.reason : null;
    const deciderId = approval.checkerId ?? approval.makerId;

    if (typeof rec.kycCaseId === 'string') {
      if (decision !== KycStatus.VALIDATED && decision !== KycStatus.REJECTED) {
        throw new Error(`Décision KYC inconnue : ${decision}.`);
      }
      return this.kyc.applyDecision(rec.kycCaseId, decision, reason, deciderId, approval.id);
    }

    if (typeof rec.caseId !== 'string') throw new Error('Champ « caseId » ou « kycCaseId » requis.');
    if (!(COMPLIANCE_DECISIONS as readonly string[]).includes(decision)) throw new Error(`Décision inconnue : ${decision}.`);
    const code = decision as ComplianceDecisionCode;
    const c = await this.getCase(rec.caseId);
    const regulatoryReportRef = typeof rec.regulatoryReportRef === 'string' ? rec.regulatoryReportRef : null;
    const nextState = DECISION_STATE[code];

    await this.prisma.$transaction(async (tx) => {
      await tx.complianceDecision.create({
        data: { caseId: c.id, decision: code, decidedById: deciderId, approvalId: approval.id, regulatoryReportRef },
      });
      if (nextState) {
        await tx.complianceCase.update({
          where: { id: c.id },
          data: { state: nextState, closedAt: TERMINAL_STATES.includes(nextState) ? new Date() : null },
        });
        if (TERMINAL_STATES.includes(nextState)) {
          await tx.complianceAlert.updateMany({
            where: { caseId: c.id, status: AlertStatus.ATTACHED },
            data: { status: code === 'CLEARED' ? AlertStatus.DISMISSED : AlertStatus.ATTACHED },
          });
        }
      } else if (c.state === ComplianceCaseState.OPEN) {
        await tx.complianceCase.update({ where: { id: c.id }, data: { state: ComplianceCaseState.ESCALATED } });
      }
      if (code === 'ACCOUNT_BLOCKED' && c.subjectUserId) {
        await tx.user.update({
          where: { id: c.subjectUserId },
          data: { isBlocked: true, blockedReason: reason ?? `Décision conformité ${c.reference}`, tokenVersion: { increment: 1 } },
        });
      }
    });
    await this.audit.log({
      actorUserId: deciderId, action: 'COMPLIANCE_DECISION', entityType: 'ComplianceCase', entityId: c.id,
      before: { state: c.state },
      after: { decision: code, state: nextState ?? c.state, reason, regulatoryReportRef, approvalId: approval.id, blockedUserId: code === 'ACCOUNT_BLOCKED' ? c.subjectUserId : null },
    });
    return this.getCase(c.id);
  }

  // ------------------------------------------------------------------ export

  /** Monthly regulator-facing extract (alerts + decisions), `month` = YYYY-MM. */
  async exportCsv(month?: string): Promise<string> {
    const m = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : new Date().toISOString().slice(0, 7);
    const from = new Date(`${m}-01T00:00:00.000Z`);
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
    const [alerts, decisions] = await Promise.all([
      this.prisma.complianceAlert.findMany({ where: { createdAt: { gte: from, lt: to } }, include: { case: { select: { reference: true } } }, orderBy: { createdAt: 'asc' } }),
      this.prisma.complianceDecision.findMany({ where: { decidedAt: { gte: from, lt: to } }, include: { case: { select: { reference: true, subjectUserId: true } } }, orderBy: { decidedAt: 'asc' } }),
    ]);
    const header = ['type', 'date', 'reference', 'source_or_decision', 'severity', 'status', 'user_id', 'entity', 'summary', 'regulatory_report_ref'];
    const lines: string[] = [header.join(';')];
    for (const a of alerts) {
      lines.push(['ALERT', a.createdAt.toISOString(), a.case?.reference ?? '', a.source, a.severity, a.status, a.userId ?? '', `${a.entityType ?? ''}:${a.entityId ?? ''}`, a.summary, ''].map(csvCell).join(';'));
    }
    for (const d of decisions) {
      lines.push(['DECISION', d.decidedAt.toISOString(), d.case.reference, d.decision, '', '', d.case.subjectUserId ?? '', `ComplianceCase:${d.caseId}`, `approval:${d.approvalId ?? ''}`, d.regulatoryReportRef ?? ''].map(csvCell).join(';'));
    }
    return lines.join('\n') + '\n';
  }

  // ------------------------------------------------------- event handlers

  async onReconciliationMismatch(event: DomainEvent): Promise<void> {
    await this.raiseAlert({
      source: AlertSource.RECONCILIATION,
      severity: AlertSeverity.HIGH,
      entityType: event.entityType,
      entityId: event.entityId,
      userId: readString(event.payload, 'userId'),
      summary: `Écart de réconciliation ${event.entityType} ${event.entityId}`,
      details: event.payload as Prisma.InputJsonValue,
    });
  }

  async onSettlementFailed(event: DomainEvent): Promise<void> {
    await this.raiseAlert({
      source: AlertSource.SETTLEMENT_FAILURE,
      severity: AlertSeverity.HIGH,
      entityType: event.entityType,
      entityId: event.entityId,
      userId: readString(event.payload, 'userId'),
      summary: `Échec de règlement ${event.entityType} ${event.entityId}`,
      details: event.payload as Prisma.InputJsonValue,
    });
  }

  async onLargeTransaction(event: DomainEvent): Promise<void> {
    let amount = readDecimal(event.payload, 'amount');
    let userId = readString(event.payload, 'userId');
    let currency = readString(event.payload, 'currency');
    if ((!amount || !userId) && event.entityType === 'PaymentIntent') {
      const intent = await this.prisma.paymentIntent.findUnique({ where: { id: event.entityId } });
      if (intent) {
        amount = amount ?? intent.amount;
        userId = userId ?? intent.userId;
        currency = currency ?? intent.currency;
      }
    }
    if (!amount) return;
    const threshold = await this.config.get<number>(COMPLIANCE_CONFIG_KEYS.largeTransactionXaf, COMPLIANCE_DEFAULTS.largeTransactionXaf);
    if (amount.lessThan(threshold)) return;
    await this.raiseAlert({
      source: AlertSource.TRANSACTION_THRESHOLD,
      severity: AlertSeverity.MEDIUM,
      entityType: event.entityType,
      entityId: event.entityId,
      userId,
      summary: `${event.name === 'DepositConfirmed' ? 'Dépôt' : 'Retrait'} de ${amount.toFixed()} ${currency ?? 'XAF'} ≥ seuil ${threshold}`,
      details: { amount: amount.toFixed(), currency, threshold, eventName: event.name },
    });
  }

  async onKycManualReview(event: DomainEvent): Promise<void> {
    const hits = event.payload.hits;
    if (!Array.isArray(hits) || hits.length === 0) return;
    await this.raiseAlert({
      source: AlertSource.KYC_SCREENING,
      severity: AlertSeverity.HIGH,
      entityType: 'KycSubmission',
      entityId: event.entityId,
      userId: readString(event.payload, 'userId'),
      summary: `Criblage KYC positif (${hits.length} correspondance${hits.length > 1 ? 's' : ''})`,
      details: { hits: hits as Prisma.InputJsonValue, reasons: (event.payload.reasons ?? []) as Prisma.InputJsonValue },
    });
  }

  private async nextReference(year: number): Promise<string> {
    const prefix = `CC-${year}-`;
    const last = await this.prisma.complianceCase.findFirst({ where: { reference: { startsWith: prefix } }, orderBy: { reference: 'desc' }, select: { reference: true } });
    const seq = last ? parseInt(last.reference.slice(prefix.length), 10) + 1 : 1;
    return `${prefix}${String(seq).padStart(4, '0')}`;
  }
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === 'string' && v ? v : null;
}

function readDecimal(payload: Record<string, unknown>, key: string): Prisma.Decimal | null {
  const v = payload[key];
  if (v === null || v === undefined || v === '') return null;
  try {
    return new Prisma.Decimal(v as Prisma.Decimal.Value);
  } catch {
    return null;
  }
}

function csvCell(v: string): string {
  return /[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
