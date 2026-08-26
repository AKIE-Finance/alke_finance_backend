import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Journal d'audit — Module 9.4 du CDC : "Journal d'audit complet et non
 * modifiable de toutes les opérations sensibles." Chaque action back-office
 * sensible (validation KYC, changement de statut d'ordre, modification des
 * frais, blocage de compte...) doit passer par ce service.
 */
@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  async log(params: {
    actorUserId?: string;
    actorRole?: string;
    action: string;
    entityType: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
    ipAddress?: string;
  }) {
    return this.prisma.auditLog.create({
      data: {
        actorUserId: params.actorUserId,
        actorRole: params.actorRole,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        beforeJson: params.before as any,
        afterJson: params.after as any,
        ipAddress: params.ipAddress,
      },
    });
  }
}
