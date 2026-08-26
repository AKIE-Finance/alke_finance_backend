import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { OtpPurpose } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OtpService } from './otp.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

const DEFAULT_CURRENCY_BY_COUNTRY: Record<string, string> = {
  CIV: 'XOF', SEN: 'XOF', TGO: 'XOF', BEN: 'XOF', BFA: 'XOF', MLI: 'XOF',
  CMR: 'XAF', GAB: 'XAF', COG: 'XAF',
  INTL: 'USD',
};

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private jwt: JwtService, private otp: OtpService) {}

  private async generateUniqueReferralCode(fullName: string): Promise<string> {
    const base = fullName.replace(/[^a-zA-Z]/g, '').slice(0, 5).toUpperCase() || 'ALKE';
    for (let i = 0; i < 20; i++) {
      const candidate = `${base}${Math.floor(1000 + Math.random() * 9000)}`;
      const exists = await this.prisma.user.findUnique({ where: { referralCode: candidate } });
      if (!exists) return candidate;
    }
    return `ALKE${Date.now()}`;
  }

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, { phone: dto.phone }] },
    });
    if (existing) throw new BadRequestException('Un compte existe déjà avec cet e-mail ou ce numéro.');

    let referredById: string | undefined;
    if (dto.referralCode) {
      const referrer = await this.prisma.user.findUnique({ where: { referralCode: dto.referralCode } });
      if (referrer) referredById = referrer.id;
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const referralCode = await this.generateUniqueReferralCode(dto.fullName);
    const currency = DEFAULT_CURRENCY_BY_COUNTRY[dto.country] ?? 'XOF';

    const user = await this.prisma.user.create({
      data: {
        fullName: dto.fullName,
        email: dto.email,
        phone: dto.phone,
        country: dto.country,
        displayCurrency: currency,
        passwordHash,
        referralCode,
        referredById,
        accounts: { create: { currency } },
        notificationPref: { create: {} },
      },
    });

    if (referredById) {
      await this.prisma.referral.create({
        data: {
          referrerUserId: referredById,
          refereeUserId: user.id,
          code: dto.referralCode!,
          status: 'SIGNED_UP',
        },
      });
    }

    const otp = await this.otp.issue(dto.email, OtpPurpose.REGISTER);

    return {
      userId: user.id,
      email: user.email,
      phone: user.phone,
      referralCode: user.referralCode,
      otp,
    };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.identifier }, { phone: dto.identifier }] },
    });
    if (!user) throw new UnauthorizedException('Identifiants invalides.');
    if (user.isBlocked) throw new UnauthorizedException('Ce compte est bloqué. Contactez le support.');

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Identifiants invalides.');

    return this.issueSession(user.id, user.role);
  }

  async issueSession(userId: string, role: string) {
    const accessToken = await this.jwt.signAsync({ sub: userId, role });
    return { accessToken };
  }

  async requestOtp(destination: string, purpose: OtpPurpose) {
    return this.otp.issue(destination, purpose);
  }

  async verifyOtp(destination: string, purpose: OtpPurpose, code: string) {
    await this.otp.verify(destination, purpose, code);
    return { verified: true };
  }

  async resetPassword(destination: string, code: string, newPassword: string) {
    await this.otp.verify(destination, OtpPurpose.RESET_PASSWORD, code);
    const user = await this.prisma.user.findFirst({ where: { OR: [{ email: destination }, { phone: destination }] } });
    if (!user) throw new BadRequestException('Utilisateur introuvable.');
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    return { success: true };
  }

  async me(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, fullName: true, email: true, phone: true, country: true,
        displayCurrency: true, role: true, kycStatus: true, riskProfile: true,
        twoFactorEnabled: true, biometricEnabled: true, referralCode: true,
        createdAt: true,
      },
    });
  }
}
