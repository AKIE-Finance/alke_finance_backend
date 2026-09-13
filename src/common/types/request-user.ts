import { KycStatus, SupportedCountry, UserRole } from '@prisma/client';

/**
 * Shape of `request.user` after `JwtAuthGuard` (see JwtStrategy.validate).
 * Deliberately excludes `passwordHash` and anything not needed by controllers.
 */
export type RequestUser = {
  id: string;
  email: string;
  phone: string;
  fullName: string;
  role: UserRole;
  kycStatus: KycStatus;
  tokenVersion: number;
  country: SupportedCountry;
  isBlocked: boolean;
};
