import { Injectable, NotFoundException } from '@nestjs/common';
import { KycStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/services/audit.service';
import { BlockUserDto } from './dto/block-user.dto';

/** Gestion des utilisateurs - Module 9.1 du CDC. */
@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  list(params: { search?: string; kycStatus?: KycStatus; page?: number; pageSize?: number }) {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 25;
    const where = {
      ...(params.kycStatus && { kycStatus: params.kycStatus }),
      ...(params.search && {
        OR: [
          { fullName: { contains: params.search, mode: 'insensitive' as const } },
          { email: { contains: params.search, mode: 'insensitive' as const } },
          { phone: { contains: params.search } },
        ],
      }),
    };
    return Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true, fullName: true, email: true, phone: true, country: true,
          kycStatus: true, role: true, isBlocked: true, createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count({ where }),
    ]).then(([items, total]) => ({ items, total, page, pageSize }));
  }

  async detail(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        kycSubmissions: { orderBy: { submittedAt: 'desc' } },
        accounts: true,
        positions: { include: { instrument: true } },
        orders: { orderBy: { submittedAt: 'desc' }, take: 20, include: { instrument: true } },
        subscription: true,
      },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    const { passwordHash, ...safe } = user;
    return safe;
  }

  async setBlocked(adminId: string, id: string, dto: BlockUserDto) {
    const before = await this.prisma.user.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Utilisateur introuvable.');
    const after = await this.prisma.user.update({
      where: { id },
      data: { isBlocked: dto.isBlocked, blockedReason: dto.isBlocked ? dto.blockedReason : null },
    });
    await this.audit.log({
      actorUserId: adminId, actorRole: 'ADMIN',
      action: dto.isBlocked ? 'USER_BLOCKED' : 'USER_UNBLOCKED',
      entityType: 'User', entityId: id,
      before: { isBlocked: before.isBlocked }, after: { isBlocked: after.isBlocked, reason: dto.blockedReason },
    });
    return after;
  }
}
