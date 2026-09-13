import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { OtpPurpose, ReferralStatus, SupportedCountry, UserRole } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import dayjs from 'dayjs';
import { PrismaService } from '../../prisma/prisma.service';
import { EventBus } from '../../common/events/event-bus.service';
import { OtpService } from './otp.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { LogoutDto } from './dto/logout.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { AccessTokenPayload } from './strategies/jwt.strategy';

/** Blueprint §4.10 : accès court (JWT_EXPIRES_IN, 15 min par défaut) + refresh 30 jours. */
const REFRESH_TOKEN_DAYS = 30;
const DEFAULT_ACCESS_TTL = '15m';
const BCRYPT_ROUNDS = 10;

const CEMAC: ReadonlySet<SupportedCountry> = new Set<SupportedCountry>(['CMR', 'GAB', 'COG', 'GNQ']);
const UEMOA: ReadonlySet<SupportedCountry> = new Set<SupportedCountry>(['CIV', 'SEN', 'TGO', 'BEN', 'BFA', 'MLI']);

export function displayCurrencyFor(country: SupportedCountry): string {
  if (CEMAC.has(country)) return 'XAF';
  if (UEMOA.has(country)) return 'XOF';
  return 'USD';
}

/** "15m" | "900" | "2h" | "7d" → seconds. */
export function ttlToSeconds(ttl: string): number {
  const m = /^(\d+)\s*([smhd])?$/i.exec(ttl.trim());
  if (!m) return 15 * 60;
  const n = Number(m[1]);
  switch ((m[2] ?? 's').toLowerCase()) {
    case 'm': return n * 60;
    case 'h': return n * 3600;
    case 'd': return n * 86400;
    default: return n;
  }
}

export interface SessionMeta {
  deviceId?: string;
  deviceLabel?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Durée de vie du jeton d'accès, en secondes. */
  expiresIn: number;
}

type TokenSubject = { id: string; role: UserRole; tokenVersion: number };

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private otp: OtpService,
    private config: ConfigService,
    private events: EventBus,
  ) {}

  // ------------------------------------------------------------- Helpers
  static hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private get accessTtlSeconds(): number {
    return ttlToSeconds(this.config.get<string>('JWT_EXPIRES_IN') || DEFAULT_ACCESS_TTL);
  }

  private async generateUniqueReferralCode(fullName: string): Promise<string> {
    const base = fullName.replace(/[^a-zA-Z]/g, '').slice(0, 5).toUpperCase() || 'ALKE';
    for (let i = 0; i < 20; i++) {
      const candidate = `${base}${Math.floor(1000 + Math.random() * 9000)}`;
      const exists = await this.prisma.user.findUnique({ where: { referralCode: candidate }, select: { id: true } });
      if (!exists) return candidate;
    }
    return `ALKE${Date.now()}`;
  }

  private findByIdentifier(identifier: string) {
    return this.prisma.user.findFirst({ where: { OR: [{ email: identifier }, { phone: identifier }] } });
  }

  /**
   * Émet un couple accès/refresh et enregistre la session. Seul
   * sha256(refreshToken) est stocké ; le jeton en clair n'existe que dans la réponse.
   */
  async issueTokens(user: TokenSubject, meta: SessionMeta = {}): Promise<TokenPair> {
    const payload: AccessTokenPayload = { sub: user.id, role: user.role, tv: user.tokenVersion };
    const accessToken = await this.jwt.signAsync(payload);
    const refreshToken = randomBytes(48).toString('base64url');
    await this.prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: AuthService.hashRefreshToken(refreshToken),
        deviceId: meta.deviceId,
        deviceLabel: meta.deviceLabel,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent?.slice(0, 512),
        expiresAt: dayjs().add(REFRESH_TOKEN_DAYS, 'day').toDate(),
      },
    });
    return { accessToken, refreshToken, expiresIn: this.accessTtlSeconds };
  }

  /** Compatibilité : anciens appelants qui ne connaissent que (userId, role). */
  async issueSession(userId: string, _role?: string, meta: SessionMeta = {}): Promise<TokenPair> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, tokenVersion: true, isBlocked: true },
    });
    if (!user || user.isBlocked) throw new UnauthorizedException('Identifiants invalides.');
    return this.issueTokens(user, meta);
  }

  // -------------------------------------------------------- Inscription
  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, { phone: dto.phone }] },
      select: { id: true },
    });
    if (existing) throw new BadRequestException('Un compte existe déjà avec cet e-mail ou ce numéro.');

    let referredById: string | undefined;
    if (dto.referralCode) {
      const referrer = await this.prisma.user.findUnique({ where: { referralCode: dto.referralCode }, select: { id: true } });
      if (referrer) referredById = referrer.id;
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const referralCode = await this.generateUniqueReferralCode(dto.fullName);

    // Aucun compte "wallet" n'est créé ici : les soldes vivent dans le grand livre (LedgerEntry).
    const user = await this.prisma.user.create({
      data: {
        fullName: dto.fullName,
        email: dto.email,
        phone: dto.phone,
        country: dto.country,
        displayCurrency: displayCurrencyFor(dto.country),
        passwordHash,
        referralCode,
        referredById,
        notificationPref: { create: {} },
      },
    });

    if (referredById && dto.referralCode) {
      await this.prisma.referral.create({
        data: { referrerUserId: referredById, refereeUserId: user.id, code: dto.referralCode, status: ReferralStatus.SIGNED_UP },
      });
    }

    const otp = await this.otp.issue(dto.email, OtpPurpose.REGISTER);

    await this.events.publish('UserRegistered', {
      entityType: 'User',
      entityId: user.id,
      actor: user.id,
      payload: { country: user.country, displayCurrency: user.displayCurrency, referredById: referredById ?? null },
    });

    return { userId: user.id, email: user.email, phone: user.phone, referralCode: user.referralCode, otp };
  }

  // ----------------------------------------------------------- Connexion
  async login(dto: LoginDto, meta: SessionMeta = {}) {
    const user = await this.findByIdentifier(dto.identifier);
    if (!user) throw new UnauthorizedException('Identifiants invalides.');
    if (user.isBlocked) throw new UnauthorizedException('Ce compte est bloqué. Contactez le support.');

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Identifiants invalides.');

    const tokens = await this.issueTokens(user, { ...meta, deviceId: dto.deviceId ?? meta.deviceId, deviceLabel: dto.deviceLabel ?? meta.deviceLabel });
    await this.events.publish('UserLoggedIn', {
      entityType: 'User',
      entityId: user.id,
      actor: user.id,
      payload: { deviceId: dto.deviceId ?? null, ipAddress: meta.ipAddress ?? null },
    });
    return tokens;
  }

  // --------------------------------------------------------------- OTP
  async requestOtp(destination: string, purpose: OtpPurpose) {
    return this.otp.issue(destination, purpose);
  }

  /**
   * Vérifie un code. Pour REGISTER, la destination identifie le compte
   * fraîchement créé : on ouvre directement la première session.
   */
  async verifyOtp(destination: string, purpose: OtpPurpose, code: string, meta: SessionMeta = {}) {
    await this.otp.verify(destination, purpose, code);
    if (purpose !== OtpPurpose.REGISTER && purpose !== OtpPurpose.LOGIN) return { verified: true as const };

    const user = await this.findByIdentifier(destination);
    if (!user || user.isBlocked) return { verified: true as const };
    const tokens = await this.issueTokens(user, meta);
    return { verified: true as const, ...tokens };
  }

  // ---------------------------------------------------------- Sessions
  async refresh(refreshToken: string, meta: SessionMeta = {}): Promise<TokenPair> {
    const hash = AuthService.hashRefreshToken(refreshToken);
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hash },
      include: { user: { select: { id: true, role: true, tokenVersion: true, isBlocked: true } } },
    });
    const now = new Date();
    if (!session || session.revokedAt || session.expiresAt <= now) {
      throw new UnauthorizedException('Session expirée, veuillez vous reconnecter.');
    }
    if (session.user.isBlocked) throw new UnauthorizedException('Ce compte est bloqué. Contactez le support.');

    // Rotation : l'ancien jeton est révoqué de façon atomique ; s'il l'a déjà été
    // par une requête concurrente, on refuse (détection de rejeu).
    const revoked = await this.prisma.session.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: now, lastUsedAt: now },
    });
    if (revoked.count === 0) throw new UnauthorizedException('Session expirée, veuillez vous reconnecter.');

    return this.issueTokens(session.user, {
      deviceId: session.deviceId ?? meta.deviceId,
      deviceLabel: session.deviceLabel ?? meta.deviceLabel,
      ipAddress: meta.ipAddress ?? session.ipAddress ?? undefined,
      userAgent: meta.userAgent ?? session.userAgent ?? undefined,
    });
  }

  async logout(userId: string, dto: LogoutDto) {
    const now = new Date();
    if (dto.all) {
      const { count } = await this.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
      return { success: true, revoked: count };
    }
    if (dto.refreshToken) {
      const { count } = await this.prisma.session.updateMany({
        where: { userId, refreshTokenHash: AuthService.hashRefreshToken(dto.refreshToken), revokedAt: null },
        data: { revokedAt: now },
      });
      return { success: true, revoked: count };
    }
    return { success: true, revoked: 0 };
  }

  listSessions(userId: string) {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: {
        id: true, deviceId: true, deviceLabel: true, ipAddress: true, userAgent: true,
        createdAt: true, lastUsedAt: true, expiresAt: true,
      },
      orderBy: { lastUsedAt: 'desc' },
    });
  }

  async revokeSession(userId: string, sessionId: string) {
    const { count } = await this.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) throw new NotFoundException('Session introuvable.');
    return { success: true };
  }

  // -------------------------------------------------------- Mots de passe
  /**
   * Réinitialisation par OTP : nouveau hash, tokenVersion++ (tous les JWT
   * d'accès en cours deviennent invalides) et révocation de toutes les sessions.
   */
  async resetPassword(destination: string, code: string, newPassword: string) {
    await this.otp.verify(destination, OtpPurpose.RESET_PASSWORD, code);
    const user = await this.findByIdentifier(destination);
    if (!user) throw new BadRequestException('Utilisateur introuvable.');

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash, tokenVersion: { increment: 1 }, passwordChangedAt: new Date() },
      }),
      this.prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);

    await this.events.publish('PasswordReset', {
      entityType: 'User',
      entityId: user.id,
      actor: user.id,
      payload: { method: 'OTP', destination: destination.includes('@') ? 'email' : 'phone' },
    });
    return { success: true };
  }

  /**
   * Changement par un utilisateur connecté : même effet de sécurité que la
   * réinitialisation (révocation globale), puis une nouvelle session est
   * ouverte pour l'appareil courant afin de ne pas le déconnecter.
   */
  async changePassword(userId: string, dto: ChangePasswordDto, meta: SessionMeta = {}) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('Session invalide.');
    const valid = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!valid) throw new ForbiddenException('Mot de passe actuel incorrect.');
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException("Le nouveau mot de passe doit être différent de l'actuel.");
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    const [updated] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash, tokenVersion: { increment: 1 }, passwordChangedAt: new Date() },
        select: { id: true, role: true, tokenVersion: true },
      }),
      this.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);

    await this.events.publish('PasswordReset', {
      entityType: 'User',
      entityId: userId,
      actor: userId,
      payload: { method: 'CHANGE', ipAddress: meta.ipAddress ?? null },
    });
    return this.issueTokens(updated, meta);
  }

  // ----------------------------------------------------------------- Me
  async me(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, fullName: true, email: true, phone: true, country: true,
        displayCurrency: true, role: true, kycStatus: true, riskProfile: true,
        twoFactorEnabled: true, biometricEnabled: true, referralCode: true,
        passwordChangedAt: true, createdAt: true,
      },
    });
  }
}
