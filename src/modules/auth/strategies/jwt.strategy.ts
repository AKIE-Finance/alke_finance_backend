import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RequestUser } from '../../../common/types/request-user';

export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
  /** User.tokenVersion at issue time; bumped on password reset / global revocation. */
  tv: number;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService, private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET'),
    });
  }

  async validate(payload: AccessTokenPayload): Promise<RequestUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true, email: true, phone: true, fullName: true, role: true,
        kycStatus: true, tokenVersion: true, country: true, isBlocked: true,
      },
    });
    if (!user || user.isBlocked) throw new UnauthorizedException('Session invalide.');
    if ((payload.tv ?? 0) < user.tokenVersion) throw new UnauthorizedException('Session expirée, veuillez vous reconnecter.');
    return user;
  }
}
