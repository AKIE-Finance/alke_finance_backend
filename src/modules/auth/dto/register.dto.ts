import { IsEmail, IsEnum, IsOptional, IsPhoneNumber, IsString, MinLength } from 'class-validator';
import { SupportedCountry } from '@prisma/client';

export class RegisterDto {
  @IsString()
  @MinLength(2)
  fullName: string;

  @IsEmail()
  email: string;

  @IsString()
  phone: string;

  @IsEnum(SupportedCountry)
  country: SupportedCountry;

  @IsString()
  @MinLength(8)
  password: string;

  @IsOptional()
  @IsString()
  referralCode?: string;
}
