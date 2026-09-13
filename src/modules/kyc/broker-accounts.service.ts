import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BrokerAccount, BrokerAccountState } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EventBus } from '../../common/events/event-bus.service';
import { AuditService } from '../../common/services/audit.service';
import { UpdateBrokerAccountDto } from './dto/update-broker-account.dto';

const ACCOUNT_INCLUDE = {
  user: { select: { id: true, fullName: true, email: true, phone: true, country: true, kycStatus: true } },
  partner: { select: { id: true, name: true, code: true, market: { select: { code: true, name: true } } } },
} as const;

/** Comptes-titres ouverts chez la SDB à partir du dossier KYC ALKÉ (A4). */
@Injectable()
export class BrokerAccountsService {
  constructor(private readonly prisma: PrismaService, private readonly events: EventBus, private readonly audit: AuditService) {}

  list(state?: BrokerAccountState) {
    return this.prisma.brokerAccount.findMany({
      where: state ? { state } : undefined,
      include: ACCOUNT_INCLUDE,
      orderBy: { requestedAt: 'asc' },
      take: 500,
    });
  }

  /** CSV handed to the SDB back-office (one line per requested account). */
  async exportCsv(state: BrokerAccountState = BrokerAccountState.REQUESTED): Promise<string> {
    const rows = await this.list(state);
    const header = ['broker_account_id', 'state', 'requested_at', 'partner', 'external_account_no', 'full_name', 'email', 'phone', 'country', 'kyc_status'];
    const lines = rows.map((r) =>
      [
        r.id, r.state, r.requestedAt.toISOString(), r.partner.name, r.externalAccountNo ?? '',
        r.user.fullName, r.user.email, r.user.phone, r.user.country, r.user.kycStatus,
      ].map(csvCell).join(';'),
    );
    return [header.join(';'), ...lines].join('\n') + '\n';
  }

  async update(adminId: string, id: string, dto: UpdateBrokerAccountDto): Promise<BrokerAccount> {
    const before = await this.prisma.brokerAccount.findUnique({ where: { id }, include: { partner: true } });
    if (!before) throw new NotFoundException('Compte-titres introuvable.');
    if (before.state === BrokerAccountState.CLOSED) throw new BadRequestException('Ce compte-titres est clôturé.');
    if (dto.state === 'OPEN' && !(dto.externalAccountNo ?? before.externalAccountNo)) {
      throw new BadRequestException('Le numéro de compte SDB est requis pour ouvrir le compte-titres.');
    }
    const now = new Date();
    const after = await this.prisma.brokerAccount.update({
      where: { id },
      data: {
        ...(dto.externalAccountNo !== undefined && { externalAccountNo: dto.externalAccountNo }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
        ...(dto.state === 'OPEN' && { state: BrokerAccountState.OPEN, openedAt: before.openedAt ?? now, suspendedAt: null }),
        ...(dto.state === 'SUSPENDED' && { state: BrokerAccountState.SUSPENDED, suspendedAt: now }),
      },
    });
    await this.audit.log({
      actorUserId: adminId,
      action: 'BROKER_ACCOUNT_UPDATED',
      entityType: 'BrokerAccount',
      entityId: id,
      before: { state: before.state, externalAccountNo: before.externalAccountNo },
      after: { state: after.state, externalAccountNo: after.externalAccountNo },
    });
    if (dto.state === 'OPEN' && before.state !== BrokerAccountState.OPEN) {
      await this.events.publish('BrokerAccountOpened', {
        entityType: 'BrokerAccount', entityId: id, actor: adminId,
        payload: { userId: after.userId, partnerId: after.partnerId, partnerName: before.partner.name, externalAccountNo: after.externalAccountNo },
      });
    }
    return after;
  }
}

function csvCell(v: string): string {
  return /[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
