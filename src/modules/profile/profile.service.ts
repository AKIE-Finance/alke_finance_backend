import { BadRequestException, Injectable } from '@nestjs/common';
import dayjs from 'dayjs';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateExternalHoldingDto } from './dto/external-holding.dto';
import { UpdateNotificationPrefDto } from './dto/notification-pref.dto';
import { SubscribeDto } from './dto/subscribe.dto';
import { SubmitNpsDto } from './dto/nps.dto';

@Injectable()
export class ProfileService {
  constructor(private prisma: PrismaService) {}

  // ------------------------------------------------------- Portefeuille externe
  listExternalHoldings(userId: string) {
    return this.prisma.externalHolding.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }

  addExternalHolding(userId: string, dto: CreateExternalHoldingDto) {
    return this.prisma.externalHolding.create({ data: { ...dto, userId } });
  }

  removeExternalHolding(userId: string, id: string) {
    return this.prisma.externalHolding.deleteMany({ where: { id, userId } });
  }

  // ------------------------------------------------------------------ Parrainage
  async myReferrals(userId: string) {
    const [user, referrals] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { referralCode: true } }),
      this.prisma.referral.findMany({
        where: { referrerUserId: userId },
        include: { referee: { select: { fullName: true, createdAt: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      code: user.referralCode,
      stats: {
        invited: referrals.length,
        joined: referrals.filter((r) => r.status !== 'INVITED').length,
        rewarded: referrals.filter((r) => r.status === 'REWARDED').length,
      },
      referrals,
    };
  }

  // ------------------------------------------------------------------ AlKE Pro
  async subscribe(userId: string, dto: SubscribeDto) {
    const renewsAt = dayjs().add(dto.plan === 'YEARLY' ? 12 : 1, 'month').toDate();
    return this.prisma.subscription.upsert({
      where: { userId },
      create: { userId, plan: dto.plan, renewsAt },
      update: { plan: dto.plan, status: 'ACTIVE', renewsAt, cancelledAt: null },
    });
  }

  async cancelSubscription(userId: string) {
    const sub = await this.prisma.subscription.findUnique({ where: { userId } });
    if (!sub) throw new BadRequestException("Aucun abonnement actif.");
    return this.prisma.subscription.update({
      where: { userId },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }

  getSubscription(userId: string) {
    return this.prisma.subscription.findUnique({ where: { userId } });
  }

  // ---------------------------------------------------------- Notifications
  getPrefs(userId: string) {
    return this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
  }

  updatePrefs(userId: string, dto: UpdateNotificationPrefDto) {
    return this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, ...dto },
      update: dto,
    });
  }

  listNotifications(userId: string) {
    return this.prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 50 });
  }

  async markNotificationRead(userId: string, id: string) {
    return this.prisma.notification.updateMany({ where: { id, userId }, data: { readAt: new Date() } });
  }

  // ------------------------------------------------------------------------ NPS
  submitNps(userId: string, dto: SubmitNpsDto) {
    return this.prisma.npsResponse.create({ data: { userId, score: dto.score, comment: dto.comment } });
  }

  // -------------------------------------------------------------------- Devices
  listDevices(userId: string) {
    return this.prisma.userDevice.findMany({ where: { userId }, orderBy: { lastActiveAt: 'desc' } });
  }

  removeDevice(userId: string, id: string) {
    return this.prisma.userDevice.deleteMany({ where: { id, userId } });
  }
}
