import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ApprovalState, PendingApproval, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EventBus } from '../../common/events/event-bus.service';
import { AuditService } from '../../common/services/audit.service';
import {
  APPROVAL_ACTIONS,
  ApprovalActionType,
  ApprovalExecutor,
  ApprovalRequestInput,
  ApprovalsPort,
} from './approvals.types';

const CHECKER_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([UserRole.ADMIN, UserRole.COMPLIANCE]);

const APPROVAL_SUMMARY = {
  maker: { select: { id: true, fullName: true, email: true, role: true } },
  checker: { select: { id: true, fullName: true, email: true, role: true } },
} satisfies Prisma.PendingApprovalInclude;

/**
 * Maker-checker (blueprint §4.17). Toute action sensible est d'abord une
 * demande PENDING ; un second utilisateur (ADMIN ou COMPLIANCE, différent du
 * demandeur) la valide, ce qui déclenche l'exécuteur enregistré par le module
 * propriétaire de l'action. Chaque transition est journalisée (AuditService).
 */
@Injectable()
export class ApprovalsService implements ApprovalsPort {
  private readonly logger = new Logger(ApprovalsService.name);
  private readonly executors = new Map<ApprovalActionType, ApprovalExecutor>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
  ) {}

  registerExecutor(actionType: ApprovalActionType, executor: ApprovalExecutor): void {
    if (this.executors.has(actionType)) {
      this.logger.warn(`Exécuteur ${actionType} remplacé.`);
    }
    this.executors.set(actionType, executor);
  }

  hasExecutor(actionType: ApprovalActionType): boolean {
    return this.executors.has(actionType);
  }

  async request(input: ApprovalRequestInput): Promise<PendingApproval> {
    if (!APPROVAL_ACTIONS.includes(input.actionType)) {
      throw new BadRequestException(`Type d'action inconnu : ${String(input.actionType)}.`);
    }
    if (!input.reason || !input.reason.trim()) {
      throw new BadRequestException('Un motif est requis pour toute demande de validation.');
    }
    const approval = await this.prisma.pendingApproval.create({
      data: {
        actionType: input.actionType,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        payload: input.payload,
        reason: input.reason.trim(),
        makerId: input.makerId,
        state: ApprovalState.PENDING,
      },
    });
    const auditRow = await this.audit.log({
      actorUserId: input.makerId,
      action: 'APPROVAL_REQUESTED',
      entityType: 'PendingApproval',
      entityId: approval.id,
      after: { actionType: approval.actionType, entityType: approval.entityType, entityId: approval.entityId, payload: approval.payload, reason: approval.reason },
    });
    await this.linkAudit(approval.id, auditRow);
    await this.events.publish('ApprovalRequested', {
      entityType: 'PendingApproval',
      entityId: approval.id,
      actor: input.makerId,
      payload: {
        approvalId: approval.id,
        actionType: approval.actionType,
        entityType: approval.entityType,
        entityId: approval.entityId,
        reason: approval.reason,
        makerId: approval.makerId,
      },
    });
    return approval;
  }

  async approve(approvalId: string, checkerId: string, note?: string): Promise<PendingApproval> {
    const approval = await this.getOrThrow(approvalId);
    const checker = await this.assertChecker(approval, checkerId);
    if (approval.state !== ApprovalState.PENDING) {
      throw new ConflictException('Cette demande a déjà été traitée.');
    }

    const now = new Date();
    // Claim atomique : deux checkers simultanés ne peuvent pas exécuter deux fois.
    const claimed = await this.prisma.pendingApproval.updateMany({
      where: { id: approvalId, state: ApprovalState.PENDING },
      data: { state: ApprovalState.APPROVED, checkerId, decisionNote: note ?? null, decidedAt: now },
    });
    if (claimed.count === 0) throw new ConflictException('Cette demande a déjà été traitée.');
    const approved = await this.getOrThrow(approvalId);

    await this.audit.log({
      actorUserId: checkerId,
      actorRole: checker.role,
      action: 'APPROVAL_APPROVED',
      entityType: 'PendingApproval',
      entityId: approvalId,
      before: { state: ApprovalState.PENDING },
      after: { state: ApprovalState.APPROVED, note: note ?? null, actionType: approved.actionType },
    });
    await this.events.publish('ApprovalDecided', {
      entityType: 'PendingApproval',
      entityId: approvalId,
      actor: checkerId,
      payload: { approvalId, actionType: approved.actionType, decision: 'APPROVED', makerId: approved.makerId, note: note ?? null },
    });

    const executor = this.executors.get(approved.actionType as ApprovalActionType);
    let final: PendingApproval;
    if (!executor) {
      final = await this.markFailed(approvalId, `Aucun exécuteur enregistré pour l'action ${approved.actionType}.`);
    } else {
      try {
        await executor(approved);
        final = await this.prisma.pendingApproval.update({
          where: { id: approvalId },
          data: { state: ApprovalState.EXECUTED, executedAt: new Date(), error: null },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Exécution ${approved.actionType} (${approvalId}) échouée : ${message}`);
        final = await this.markFailed(approvalId, message);
      }
    }

    await this.audit.log({
      actorUserId: checkerId,
      actorRole: checker.role,
      action: final.state === ApprovalState.EXECUTED ? 'APPROVAL_EXECUTED' : 'APPROVAL_FAILED',
      entityType: 'PendingApproval',
      entityId: approvalId,
      before: { state: ApprovalState.APPROVED },
      after: { state: final.state, error: final.error, actionType: final.actionType, entityType: final.entityType, entityId: final.entityId },
    });
    await this.events.publish('ApprovalExecuted', {
      entityType: 'PendingApproval',
      entityId: approvalId,
      actor: checkerId,
      payload: {
        approvalId,
        actionType: final.actionType,
        state: final.state,
        error: final.error,
        entityType: final.entityType,
        entityId: final.entityId,
        makerId: final.makerId,
      },
    });
    return final;
  }

  async reject(approvalId: string, checkerId: string, note: string): Promise<PendingApproval> {
    const approval = await this.getOrThrow(approvalId);
    const checker = await this.assertChecker(approval, checkerId);
    if (approval.state !== ApprovalState.PENDING) {
      throw new ConflictException('Cette demande a déjà été traitée.');
    }
    if (!note || !note.trim()) throw new BadRequestException('Un motif de refus est requis.');
    const claimed = await this.prisma.pendingApproval.updateMany({
      where: { id: approvalId, state: ApprovalState.PENDING },
      data: { state: ApprovalState.REJECTED, checkerId, decisionNote: note.trim(), decidedAt: new Date() },
    });
    if (claimed.count === 0) throw new ConflictException('Cette demande a déjà été traitée.');
    const rejected = await this.getOrThrow(approvalId);
    await this.audit.log({
      actorUserId: checkerId,
      actorRole: checker.role,
      action: 'APPROVAL_REJECTED',
      entityType: 'PendingApproval',
      entityId: approvalId,
      before: { state: ApprovalState.PENDING },
      after: { state: ApprovalState.REJECTED, note: note.trim(), actionType: rejected.actionType },
    });
    await this.events.publish('ApprovalDecided', {
      entityType: 'PendingApproval',
      entityId: approvalId,
      actor: checkerId,
      payload: { approvalId, actionType: rejected.actionType, decision: 'REJECTED', makerId: rejected.makerId, note: note.trim() },
    });
    return rejected;
  }

  listPending(actionType?: ApprovalActionType): Promise<PendingApproval[]> {
    return this.prisma.pendingApproval.findMany({
      where: { state: ApprovalState.PENDING, ...(actionType && { actionType }) },
      orderBy: { createdAt: 'asc' },
    });
  }

  list(filter: { state?: ApprovalState; actionType?: string }) {
    return this.prisma.pendingApproval.findMany({
      where: {
        ...(filter.state && { state: filter.state }),
        ...(filter.actionType && { actionType: filter.actionType }),
      },
      include: APPROVAL_SUMMARY,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async getDetail(id: string) {
    const approval = await this.prisma.pendingApproval.findUnique({ where: { id }, include: APPROVAL_SUMMARY });
    if (!approval) throw new NotFoundException('Demande de validation introuvable.');
    return approval;
  }

  countPending(): Promise<number> {
    return this.prisma.pendingApproval.count({ where: { state: ApprovalState.PENDING } });
  }

  // ------------------------------------------------------------- internals

  private async getOrThrow(id: string): Promise<PendingApproval> {
    const approval = await this.prisma.pendingApproval.findUnique({ where: { id } });
    if (!approval) throw new NotFoundException('Demande de validation introuvable.');
    return approval;
  }

  private async assertChecker(approval: PendingApproval, checkerId: string): Promise<{ id: string; role: UserRole }> {
    if (approval.makerId === checkerId) {
      throw new ForbiddenException('Un demandeur ne peut pas valider sa propre action.');
    }
    const checker = await this.prisma.user.findUnique({ where: { id: checkerId }, select: { id: true, role: true, isBlocked: true } });
    if (!checker || !CHECKER_ROLES.has(checker.role) || checker.isBlocked) {
      throw new ForbiddenException('Seul un administrateur ou un agent conformité peut valider une demande.');
    }
    return checker;
  }

  private markFailed(id: string, error: string): Promise<PendingApproval> {
    return this.prisma.pendingApproval.update({
      where: { id },
      data: { state: ApprovalState.FAILED, error: error.slice(0, 2000) },
    });
  }

  private async linkAudit(approvalId: string, auditRow: unknown): Promise<void> {
    const auditId = auditRow && typeof auditRow === 'object' && 'id' in auditRow ? String((auditRow as { id: unknown }).id) : null;
    if (!auditId) return;
    await this.prisma.pendingApproval.update({ where: { id: approvalId }, data: { auditLogId: auditId } }).catch(() => undefined);
  }
}
