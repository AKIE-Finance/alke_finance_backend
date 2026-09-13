import { IsEmail, IsEnum, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { SupportedCountry } from '@prisma/client';

/** E.164 : indicatif international obligatoire, 8 à 15 chiffres au total. */
export const E164_REGEX = /^\+[1-9]\d{7,14}$/;

export class RegisterDto {
  @IsString()
  @MinLength(2)
  fullName: string;

  @IsEmail()
  email: string;

  @Matches(E164_REGEX, { message: 'Le numéro doit être au format international (ex. +2376XXXXXXXX).' })
  phone: string;

  @IsEnum(SupportedCountry)
  country: SupportedCountry;

  @IsString()
  @MinLength(8)
  password: string;

  @IsOptional()
  @IsString()
  referralCode?: string;

  @IsOptional()
  @IsString()
  deviceId?: string;

  @IsOptional()
  @IsString()
  deviceLabel?: string;
}
