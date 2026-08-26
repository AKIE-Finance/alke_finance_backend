import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import dayjs from 'dayjs';
import { OtpPurpose } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Génération/vérification des codes OTP.
 *
 * Tant qu'Africa's Talking (SMS) et SendGrid (e-mail) ne sont pas branchés
 * (voir Guide Backend & Back-office, section 5.4), le code est généré et
 * stocké normalement en base, mais jamais réellement envoyé — il est
 * renvoyé dans la réponse API en mode "OTP_DEMO_MODE" (comme le mode démo
 * déjà en place côté application mobile : code fixe 123456). Le jour où
 * les clés sont configurées, il suffit de brancher l'envoi réel ici, sans
 * toucher au reste du flux d'inscription/connexion.
 */
@Injectable()
export class OtpService {
  constructor(private prisma: PrismaService, private config: ConfigService) {}

  private get demoMode(): boolean {
    return this.config.get<string>('OTP_DEMO_MODE') === 'true';
  }

  async issue(destination: string, purpose: OtpPurpose) {
    const code = this.demoMode
      ? this.config.get<string>('OTP_DEMO_CODE') || '123456'
      : String(Math.floor(100000 + Math.random() * 900000));

    const otp = await this.prisma.otpCode.create({
      data: {
        destination,
        purpose,
        code,
        expiresAt: dayjs().add(10, 'minute').toDate(),
      },
    });

    // eslint-disable-next-line no-console
    console.log(`[OTP] ${purpose} pour ${destination} : ${code} (mode démo=${this.demoMode})`);

    return {
      otpId: otp.id,
      expiresAt: otp.expiresAt,
      // Uniquement exposé en mode démo — jamais en production réelle une fois
      // un vrai fournisseur SMS/e-mail branché (OTP_DEMO_MODE=false).
      debugCode: this.demoMode ? code : undefined,
    };
  }

  async verify(destination: string, purpose: OtpPurpose, code: string) {
    const otp = await this.prisma.otpCode.findFirst({
      where: { destination, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp) throw new BadRequestException('Aucun code en attente pour cette destination.');
    if (dayjs().isAfter(otp.expiresAt)) throw new BadRequestException('Code expiré, veuillez en redemander un.');
    if (otp.attempts >= 5) throw new BadRequestException('Trop de tentatives, veuillez redemander un code.');

    if (otp.code !== code) {
      await this.prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      throw new BadRequestException('Code invalide.');
    }

    await this.prisma.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
    return true;
  }
}
