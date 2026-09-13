import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OtpPurpose } from '@prisma/client';
import { createHash, randomInt, timingSafeEqual } from 'crypto';
import dayjs from 'dayjs';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Codes OTP (blueprint §4.10) : seul `sha256(code:destination:purpose)` est
 * stocké, le code n'est jamais journalisé. Les plafonds viennent de ConfigValue
 * (`otp.max_requests_per_hour`, `otp.max_attempts`, repli 5) et les compteurs
 * sont incrémentés atomiquement.
 *
 * Tant qu'aucun fournisseur SMS/e-mail n'est branché, le mode démo
 * (OTP_DEMO_MODE=true, autorisé uniquement avec APP_ENV=local — voir
 * src/config/env.validation.ts) utilise OTP_DEMO_CODE et le renvoie dans
 * `debugCode`.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  static readonly VALIDITY_MINUTES = 10;

  constructor(private prisma: PrismaService, private config: ConfigService) {}

  private get demoMode(): boolean {
    return this.config.get<string>('OTP_DEMO_MODE') === 'true';
  }

  static hashCode(code: string, destination: string, purpose: OtpPurpose): string {
    return createHash('sha256').update(`${code}:${destination}:${purpose}`).digest('hex');
  }

  /** Latest effective ConfigValue for `key`, parsed as a positive integer, else `fallback`. */
  private async limit(key: string, fallback: number): Promise<number> {
    const row = await this.prisma.configValue.findFirst({
      where: { key, effectiveFrom: { lte: new Date() }, effectiveTo: null },
      orderBy: { effectiveFrom: 'desc' },
      select: { value: true },
    });
    const n = Number(row?.value);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  }

  async issue(destination: string, purpose: OtpPurpose) {
    const maxPerHour = await this.limit('otp.max_requests_per_hour', 5);
    const recent = await this.prisma.otpCode.count({
      where: { destination, createdAt: { gte: dayjs().subtract(1, 'hour').toDate() } },
    });
    if (recent >= maxPerHour) {
      throw new HttpException('Trop de demandes de code. Réessayez dans une heure.', HttpStatus.TOO_MANY_REQUESTS);
    }

    const code = this.demoMode
      ? this.config.get<string>('OTP_DEMO_CODE') || '123456'
      : String(randomInt(0, 1_000_000)).padStart(6, '0');

    const otp = await this.prisma.otpCode.create({
      data: {
        destination,
        purpose,
        codeHash: OtpService.hashCode(code, destination, purpose),
        expiresAt: dayjs().add(OtpService.VALIDITY_MINUTES, 'minute').toDate(),
      },
    });

    // Jamais le code : uniquement le fait qu'un OTP a été émis.
    this.logger.log(`OTP ${purpose} émis pour ${maskDestination(destination)} (démo=${this.demoMode})`);

    return {
      otpId: otp.id,
      expiresAt: otp.expiresAt,
      // Exposé uniquement en mode démo (interdit hors APP_ENV=local).
      debugCode: this.demoMode ? code : undefined,
    };
  }

  async verify(destination: string, purpose: OtpPurpose, code: string): Promise<true> {
    const otp = await this.prisma.otpCode.findFirst({
      where: { destination, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) throw new BadRequestException('Aucun code en attente pour cette destination.');
    if (dayjs().isAfter(otp.expiresAt)) throw new BadRequestException('Code expiré, veuillez en redemander un.');

    const maxAttempts = await this.limit('otp.max_attempts', 5);
    // Incrément atomique : refuse dès que le plafond est atteint, même sous concurrence.
    const claimed = await this.prisma.otpCode.updateMany({
      where: { id: otp.id, attempts: { lt: maxAttempts } },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count === 0) throw new BadRequestException('Trop de tentatives, veuillez redemander un code.');

    const expected = Buffer.from(otp.codeHash, 'hex');
    const provided = Buffer.from(OtpService.hashCode(code, destination, purpose), 'hex');
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      throw new BadRequestException('Code invalide.');
    }

    // Consommation atomique : un code ne sert qu'une seule fois.
    const consumed = await this.prisma.otpCode.updateMany({
      where: { id: otp.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count === 0) throw new BadRequestException('Ce code a déjà été utilisé.');
    return true;
  }
}

function maskDestination(destination: string): string {
  if (destination.includes('@')) {
    const [local, domain] = destination.split('@');
    return `${local.slice(0, 2)}***@${domain}`;
  }
  return `${destination.slice(0, 4)}***${destination.slice(-2)}`;
}
